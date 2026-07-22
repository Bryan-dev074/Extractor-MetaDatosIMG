# Batch Folders and TikTok Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reliable browser-only JPEG/PNG metadata cleaner with recursive folder ingestion, structure-preserving ZIP downloads, bounded batch processing, and a separate adaptive TikTok Photo Max export.

**Architecture:** Keep binary cleaning in pure, testable modules and run expensive work through a bounded worker queue. Normalize every selected file into a stable relative-path model, then use one archive planner for individual and folder ZIP output. TikTok output is a separate sRGB PNG pipeline with deterministic one-level dither restricted to smooth regions.

**Tech Stack:** Next.js 15, React 19, TypeScript 5, Vitest, ESLint, JSZip, Pako, Web Workers, Canvas/OffscreenCanvas, File System Access API with Blob fallback.

## Global Constraints

- Processing remains 100% local; no image bytes are uploaded or persisted remotely.
- The normal JPEG/PNG clean path never recompresses pixels.
- TikTok Photo Max is visibly separate and may change eligible pixels by at most one 8-bit channel level.
- Only JPEG and PNG are guaranteed in this release; unsupported formats fail visibly.
- Malformed files fail closed and never become downloadable successes.
- Folder ZIP output preserves every non-empty relative directory containing successful images.
- Empty source directories are not preserved.
- Direct-to-disk ZIP streaming is preferred when supported; Blob generation is guarded by a memory estimate.
- All production behavior is introduced through a witnessed red-green TDD cycle.
- Push only after tests, lint, TypeScript, build, browser checks, and production dependency audit have fresh evidence.

---

## File Structure

- `lib/metadata/format.ts`: magic-byte detection and output extensions.
- `lib/metadata/jpeg.ts`: strict JPEG traversal and lossless metadata surgery.
- `lib/metadata/png.ts`: strict PNG traversal, CRC checks, and metadata filtering.
- `lib/metadata/bytes.ts`: bounded binary reads, concatenation, CRC32, and hashing helpers.
- `lib/metadata/index.ts`: public `cleanBytes`/`cleanImage` facade.
- `lib/batch/types.ts`: source, item, progress, and worker contracts.
- `lib/batch/input.ts`: file/folder/drop normalization and recursive entry traversal.
- `lib/batch/archive-path.ts`: portable relative paths and collision resolution.
- `lib/batch/reducer.ts`: stale-safe batch state transitions.
- `lib/batch/queue.ts`: bounded cancellable worker scheduler.
- `lib/archive/zip.ts`: archive plan, Blob fallback, and direct writer streaming.
- `lib/archive/report.ts`: deterministic text report.
- `lib/tiktok/anti-banding.ts`: smooth mask and deterministic bounded dither.
- `lib/tiktok/export.ts`: orientation, sRGB canvas, PNG output, and approximate preview.
- `workers/image-worker.ts`: metadata and TikTok worker messages.
- `hooks/useBatchProcessor.ts`: React orchestration.
- `components/SourcePicker.tsx`: separate file and folder inputs plus drag/drop.
- `components/BatchToolbar.tsx`: progress, cancellation, retry, and ZIP actions.
- `components/ResultCard.tsx`: lazy preview and per-item outputs.
- `app/page.tsx`: page composition only.
- `tests/fixtures/images.ts`: deterministic valid and malformed JPEG/PNG builders.
- `tests/**/*.test.ts`: unit and integration coverage.

---

### Task 1: Non-interactive Quality Tooling and Format Facade

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `eslint.config.mjs`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`
- Create: `lib/metadata/format.ts`
- Create: `tests/metadata/format.test.ts`

**Interfaces:**
- Produces: `detectImageFormat(bytes: Uint8Array): "jpeg" | "png" | null`
- Produces: `extensionForFormat(format: "jpeg" | "png"): ".jpg" | ".png"`

- [ ] **Step 1: Write the failing format test**

```ts
import { describe, expect, it } from "vitest";
import { detectImageFormat, extensionForFormat } from "@/lib/metadata/format";

describe("image format detection", () => {
  it("uses magic bytes instead of the filename", () => {
    expect(detectImageFormat(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
    expect(
      detectImageFormat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    ).toBe("png");
    expect(detectImageFormat(Uint8Array.of(0x52, 0x49, 0x46, 0x46))).toBeNull();
    expect(extensionForFormat("jpeg")).toBe(".jpg");
  });
});
```

- [ ] **Step 2: Install and configure test/lint tooling, then verify RED**

Run:

```powershell
npm install --save-dev vitest@3.2.4 eslint eslint-config-next @testing-library/react @testing-library/jest-dom jsdom
npm test -- tests/metadata/format.test.ts
```

Expected: FAIL because `@/lib/metadata/format` does not exist.

- [ ] **Step 3: Add scripts and the minimal format implementation**

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint . --max-warnings=0",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

```ts
export type SupportedFormat = "jpeg" | "png";

export function detectImageFormat(bytes: Uint8Array): SupportedFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= png.length && png.every((value, index) => bytes[index] === value)
    ? "png"
    : null;
}

export const extensionForFormat = (format: SupportedFormat) =>
  format === "jpeg" ? ".jpg" : ".png";
```

- [ ] **Step 4: Verify GREEN and all baseline build checks**

Run:

```powershell
npm test -- tests/metadata/format.test.ts
npm run lint
npx tsc --noEmit --incremental false
npm run build
```

Expected: all commands exit 0 without interactive prompts.

The Vitest configuration must keep binary/unit tests in the Node environment and make `jsdom` plus `@testing-library/jest-dom` available to later `tests/ui/**/*.test.tsx` files. Pin tooling to versions whose engines support the project's active Node runtime and whose peer dependencies remain compatible with Next 15.

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json eslint.config.mjs vitest.config.ts tests/setup.ts lib/metadata/format.ts tests/metadata/format.test.ts
git commit -m "test: add non-interactive quality tooling"
```

---

### Task 2: Strict Lossless JPEG and PNG Core

**Files:**
- Create: `lib/metadata/bytes.ts`
- Create: `lib/metadata/jpeg.ts`
- Create: `lib/metadata/png.ts`
- Create: `lib/metadata/index.ts`
- Modify: `lib/types.ts`
- Modify: `lib/cleaner.ts`
- Delete after facade migration: `lib/bytes.ts`
- Delete after facade migration: `lib/jpeg.ts`
- Delete after facade migration: `lib/png.ts`
- Create: `tests/fixtures/images.ts`
- Create: `tests/metadata/jpeg.test.ts`
- Create: `tests/metadata/png.test.ts`
- Create: `tests/metadata/facade.test.ts`

**Interfaces:**
- Consumes: `SupportedFormat` from Task 1.
- Produces: `cleanBytes(bytes: Uint8Array): CleanResult`
- Produces: `cleanImage(file: File): Promise<CleanResult>`
- Produces: `crc32(bytes: Uint8Array): number`
- `CleanResult` adds `pixelPayloadHash`, `qualityVerified`, and `outputExtension`.

- [ ] **Step 1: Build deterministic fixtures and write failing structural tests**

```ts
it("rejects a truncated JPEG instead of returning a prefix", () => {
  expect(() => cleanBytes(Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40))).toThrow(
    "JPEG truncado",
  );
});

it("preserves JPEG scan bytes while removing an AI comment", () => {
  const source = jpegWithComment("Generated by Midjourney");
  const result = cleanBytes(source.bytes);
  expect(extractJpegScan(result.cleaned)).toEqual(source.scan);
  expect(result.qualityVerified).toBe(true);
});

it("rejects a PNG with an invalid CRC", () => {
  const png = pngWithText("parameters", "Steps: 30");
  png[png.length - 5] ^= 0xff;
  expect(() => cleanBytes(png)).toThrow("CRC PNG inválido");
});

it("preserves every IDAT byte and APNG fdAT byte", () => {
  const source = apngWithAiText();
  const result = cleanBytes(source.bytes);
  expect(extractPngPayloads(result.cleaned)).toEqual(source.pixelPayloads);
});
```

Also cover progressive JPEG metadata between scans, non-JUMBF APP11 preservation, multipart ICC, orientation-bearing mixed EXIF rejection, unknown PNG ancillary preservation, unknown PNG critical rejection, compressed-text expansion limits, and cleaned-output reparsing. Decoding equality is a release browser check; mandatory unit tests compare the exact canonical pixel-bearing payloads and visual-critical structures.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm test -- tests/metadata/jpeg.test.ts tests/metadata/png.test.ts tests/metadata/facade.test.ts
```

Expected: FAIL because malformed input is currently truncated silently and the new facade fields do not exist.

- [ ] **Step 3: Implement bounded readers, CRC32, and strict parsers**

Use one checked range helper for every binary read:

```ts
export function assertRange(bytes: Uint8Array, offset: number, length: number, label: string) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new Error(`${label}: rango inválido.`);
  }
  if (offset + length > bytes.length) throw new Error(`${label}: archivo truncado.`);
}
```

JPEG completion is valid only after SOI, at least one SOS, complete scan traversal, and EOI. Parse markers between progressive scans; preserve unknown APP markers and remove APP11 only after positive JUMBF classification. PNG completion is valid only after valid signature, ordered `IHDR`, at least one `IDAT`, valid CRC for every chunk, and `IEND`. Preserve `acTL`, `fcTL`, `fdAT`, and unknown ancillary chunks without text scanning; reject unknown critical chunks. Limit both scanned text and decompressed text before allocating unbounded output. Reject unsafe mixed or aliased/cyclic EXIF surgery rather than dropping orientation-bearing APP1.

After surgery, run the cleaned bytes through the same strict structural parser and compare canonical JPEG scan bytes or PNG `IDAT`/`fdAT` bytes plus ICC, dimensions, orientation/density, palette/transparency/animation, and color-critical structures byte-for-byte. Only then set `qualityVerified: true`. `pixelPayloadHash` is a deterministic `crc32:<8-hex>:<byte-length>` display fingerprint; correctness relies on the byte comparison, not on hash collision resistance.

- [ ] **Step 4: Add the public facade and compatibility exports**

```ts
export function cleanBytes(bytes: Uint8Array): CleanResult {
  const format = detectImageFormat(bytes);
  if (!format) throw new Error("Formato no soportado. Usa JPEG o PNG.");
  return format === "jpeg" ? cleanJpeg(bytes) : cleanPng(bytes);
}

export async function cleanImage(file: File): Promise<CleanResult> {
  return cleanBytes(new Uint8Array(await file.arrayBuffer()));
}
```

Keep `lib/cleaner.ts` as a small re-export plus filename helpers so existing UI imports remain valid during later tasks.

- [ ] **Step 5: Verify GREEN, payload invariants, and regression suite**

Run:

```powershell
npm test -- tests/metadata
npm test
npx tsc --noEmit --incremental false
```

Expected: all tests pass; corrupt fixtures throw; JPEG scans and PNG pixel chunks hash identically.

- [ ] **Step 6: Commit**

```powershell
git add lib tests/metadata tests/fixtures
git commit -m "fix: harden lossless JPEG and PNG cleaning"
```

---

### Task 3: Folder Inputs and Portable Archive Paths

**Files:**
- Create: `lib/batch/types.ts`
- Create: `lib/batch/input.ts`
- Create: `lib/batch/archive-path.ts`
- Create: `tests/batch/input.test.ts`
- Create: `tests/batch/archive-path.test.ts`

**Interfaces:**
- Produces: `normalizeFiles(files: Iterable<File>, source: InputSource): Promise<InputSelection>`
- Produces: `readDroppedItems(items: DataTransferItemList): Promise<InputSelection>`
- Produces overloads: clean mode requires `outputExtension: ".jpg" | ".png"`; TikTok mode always emits `.png` and needs no extension argument.

`InputSelection` contains deterministic `accepted: InputImage[]` and `skipped: SkippedInput[]`. Classification reads at most the first eight bytes and uses `detectImageFormat`; it never trusts the filename or MIME type. `InputImage` records the detected format so later archive naming can use the real clean output extension.

- [ ] **Step 1: Write failing path and folder tests**

```ts
it("keeps safe nested directories and renames only the basename", () => {
  expect(createArchivePath("Campaña/Sub/foto.jpg", "clean", new Set(), ".jpg")).toBe(
    "Campaña/Sub/foto-limpio.jpg",
  );
});

it("removes traversal and resolves collisions case-insensitively", () => {
  const used = new Set<string>();
  expect(createArchivePath("../A/CON.jpg", "clean", used, ".jpg")).toBe("A/_CON-limpio.jpg");
  expect(createArchivePath("a/con.jpg", "clean", used, ".jpg")).toBe("a/_con-limpio (2).jpg");
});

it("uses webkitRelativePath for selected folders", () => {
  const file = makeFile("foto.jpg", { webkitRelativePath: "Raíz/Sub/foto.jpg" });
  return expect(normalizeFiles([file], "folder")).resolves.toMatchObject({
    accepted: [{ relativePath: "Raíz/Sub/foto.jpg", format: "jpeg" }],
  });
});
```

Add wrong-extension, extensionless JPEG/PNG, fake image, skipped-report, duplicate fingerprint, root-name, and multiple-root tests. Clean archive names use the detected extension; TikTok names always use `.png`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/batch/input.test.ts tests/batch/archive-path.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement normalization, recursive dropped entries, and safe names**

`readDroppedItems` must repeatedly call `FileSystemDirectoryReader.readEntries()` until it returns an empty array. Sort accepted and skipped entries by normalized relative path plus a stable source ordinal to make UI, deduplication, and reports independent of callback completion order. A single selected folder retains its safe root; mixed loose files or multiple folder roots use the deterministic archive label `imagenes-procesadas` while preserving every safe root path within the ZIP. Distinct top-level roots with the same safe name are disambiguated deterministically (`Fotos`, `Fotos (2)`) before recursion and still count as multiple roots.

Collision keys use `path.normalize("NFC").toLocaleLowerCase("en-US")`; a loop increments suffixes until the complete path is unique.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
npm test -- tests/batch
npm run lint
```

Expected: all input/path tests pass and no unsafe path remains.

- [ ] **Step 5: Commit**

```powershell
git add lib/batch tests/batch
git commit -m "feat: normalize recursive folder inputs"
```

---

### Task 4: Cancellable Batch State and Worker Queue

**Files:**
- Create: `lib/batch/reducer.ts`
- Create: `lib/batch/queue.ts`
- Create: `lib/batch/worker-pool.ts`
- Create: `workers/image-worker.ts`
- Create: `hooks/useBatchProcessor.ts`
- Create: `tests/batch/reducer.test.ts`
- Create: `tests/batch/queue.test.ts`
- Create: `tests/batch/worker-pool.test.ts`
- Create: `tests/batch/use-batch-processor.test.tsx`

**Interfaces:**
- Consumes: `InputImage`, `cleanBytes`.
- Produces: `batchReducer(state: BatchState, action: BatchAction): BatchState`
- Produces: `createTaskQueue<T, R>({ concurrency, run }): TaskQueue<T, R>`
- Produces: `createImageWorkerPool({ size, createWorker }): ImageWorkerPool`
- Produces: `useBatchProcessor(): BatchProcessorApi`

The generic queue owns scheduling only. Each queued task has a stable key and per-task `AbortSignal`; queued cancellation rejects before `run`, while active cancellation aborts the runner and keeps its concurrency slot occupied until the runner settles. `cancelAll` is reusable and `dispose` is terminal. Reject duplicate explicit keys.

- [ ] **Step 1: Write failing stale-result, cancellation, and concurrency tests**

```ts
it("ignores a result from a cancelled generation", () => {
  const started = reduce(initialState, { type: "batch/started", generation: 4, items });
  const cancelled = reduce(started, { type: "batch/cancelled", generation: 4 });
  const late = reduce(cancelled, { type: "item/completed", generation: 4, id: "a", result });
  expect(late.itemsById.a.status).toBe("cancelled");
});

it("never runs more tasks than the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const queue = createTaskQueue<number, number>({
    concurrency: 2,
    run: async (value) => {
      peak = Math.max(peak, ++active);
      await gate.wait();
      active--;
      return value;
    },
  });
  const pending = [queue.add(1), queue.add(2), queue.add(3)];
  expect(peak).toBe(2);
  gate.open();
  await Promise.all(pending);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/batch/reducer.test.ts tests/batch/queue.test.ts tests/batch/worker-pool.test.ts tests/batch/use-batch-processor.test.tsx`

Expected: FAIL with missing reducer/queue.

- [ ] **Step 3: Implement reducer, queue, worker protocol, and fallback**

```ts
export type WorkerRequest =
  { id: string; generation: number; kind: "clean"; bytes: ArrayBuffer };

export type WorkerResponse =
  | { id: string; generation: number; ok: true; kind: "clean"; result: CleanResult }
  | { id: string; generation: number; ok: false; kind: "clean"; error: string };
```

Task 4 is clean-only so it compiles independently; Task 6 extends this discriminated protocol with TikTok contracts.

Create two eager worker slots by default. Each slot owns at most one active request and validates the worker identity plus `{id, generation}` before settlement. Cancellation rejects queued work immediately. For active synchronous work, the pool terminates the owning worker and creates a replacement before accepting new work. Runtime `error`/`messageerror` also replace only that slot; an application `ok:false` response reuses the healthy worker. `destroy` terminates without replacement.

Transfer input and exact-sized output `ArrayBuffer`s rather than cloning them. Read `file.arrayBuffer()` only inside an active queue runner and reread it on retry because transfer detaches the original. Generation checks prevent late completion/error/progress dispatch, but are not treated as active cancellation. Worker errors become item errors and do not stop unrelated tasks.

Use the statically analyzable client factory `new Worker(new URL("../workers/image-worker.ts", import.meta.url), { type: "module" })`. Do not add global `WebWorker` libs to `tsconfig`; use narrow local worker types. The main-thread fallback uses concurrency one and yields/checks cancellation around `cleanBytes`, but explicitly cannot preempt the synchronous call itself.

The hook creates no Worker during React render. A monotonic generation ref is invalidated before cancel/reset/unmount rejection callbacks can dispatch. Remove cancels one keyed task; cancel marks live items cancelled; reset empties state under a newer generation; unmount disposes the queue and terminates the pool.

Add explicit tests for active cancellation and worker replacement, queued cancellation, item removal, reset, transferred buffers, retired-worker/mismatched messages, late error/progress, runtime vs application errors, concurrency, destroy, fallback, retry reread, and hook unmount. Use a fake Worker implementation for the unit contract.

- [ ] **Step 4: Verify GREEN and worker compilation**

Run:

```powershell
npm test -- tests/batch
npx tsc --noEmit --incremental false
npm run build
```

Expected: queue peak remains bounded, stale responses are ignored, and Next bundles the worker.

- [ ] **Step 5: Commit**

```powershell
git add lib/batch workers hooks tests/batch
git commit -m "feat: add cancellable image worker queue"
```

---

### Task 5: Structure-preserving ZIP and Direct-to-disk Streaming

**Files:**
- Create: `lib/archive/report.ts`
- Create: `lib/archive/zip.ts`
- Create: `tests/archive/report.test.ts`
- Create: `tests/archive/zip.test.ts`

**Interfaces:**
- Consumes: safe archive paths and completed batch items.
- Produces: `planArchive({ archiveBase, outputs, skipped, failed }, mode): ArchivePlan`
- Produces: `requestArchiveWriter(suggestedName): Promise<{ kind: "writer"; writer: ArchiveWriter } | { kind: "unsupported" } | { kind: "cancelled" }>`
- Produces: `generateArchive(plan, { destination: { kind: "writer"; writer } | { kind: "blob" }, signal, onProgress }): Promise<ArchiveResult>`
- Produces: `formatProcessingReport(summary): string`

`ArchiveWriter` is the narrow local `{ write(Uint8Array), close(), abort(reason?) }` contract, not the full native stream type. Unsupported picker and user cancellation are distinct: only `unsupported` may trigger Blob fallback.

- [ ] **Step 1: Write failing archive-plan and report tests**

```ts
it("preserves nested paths and stores successful bytes", async () => {
  const plan = planArchive(planningInput([completed("Raíz/Sub/foto.jpg", bytes)]), "clean");
  expect(plan.entries[0].path).toBe("Raíz/Sub/foto-limpio.jpg");
  const archive = await generateArchive(plan, { destination: { kind: "blob" } });
  const opened = await JSZip.loadAsync(archive.blob);
  expect(await opened.file("Raíz/Sub/foto-limpio.jpg")!.async("uint8array")).toEqual(bytes);
});

it("reports skipped and failed paths deterministically", () => {
  expect(formatProcessingReport(summary)).toContain("ERROR\tRaíz/rota.jpg\tJPEG truncado");
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/archive`

Expected: FAIL with missing archive modules.

- [ ] **Step 3: Implement STORE ZIP generation, progress, report, and safe memory preflight**

The UI click handler must call `requestArchiveWriter` immediately inside the user's activation, before awaiting archive planning. The picker itself is invoked before that async function's first `await`. Use narrow local capability types for `showSaveFilePicker` and `navigator.deviceMemory` so unsupported browsers still typecheck and fall back safely.

Plan entries deterministically by NFC source path then stable id. Clean entries require `qualityVerified === true` and use the detected `outputExtension`; TikTok entries always use `.png`. Use ZIP `STORE`, `createFolders: false`, and a fixed 1980 timestamp so equivalent plans generate identical bytes. The report lives at `<archive-root>/_reporte-procesamiento.txt`, escapes tabs/newlines/backslashes, uses LF plus final newline, and includes deterministic skipped/failed rows.

Reject ZIP32-incompatible plans before JSZip: more than 65,535 entries including the report, UTF-8 names over 65,535 bytes, unsafe integer sums, or offsets/sizes approaching `0xffffffff`.

Use `zip.generateInternalStream({ type: "uint8array", compression: "STORE", streamFiles: true })` for an already-opened `ArchiveWriter` or Blob chunk list. Register handlers before starting. Pause synchronously on data, serialize writes through one promise chain, and resume only after settlement. Await pending writes even if JSZip emits `end` first. Final progress 100 is emitted only after writer close or Blob construction. Always close exactly once on success and abort exactly once on cancellation/error; preserve the primary error if abort also fails. No progress or success occurs after a terminal state.

The Blob fallback budget is:

```ts
const gib = 1024 ** 3;
const memory = typeof navigator !== "undefined"
  ? (navigator as { deviceMemory?: number }).deviceMemory
  : undefined;
const deviceBudget = Number.isFinite(memory) && memory! > 0
  ? memory! * 128 * 1024 ** 2
  : 512 * 1024 ** 2;
const safeBudget = Math.min(gib, deviceBudget);
```

Estimate both ZIP size and Blob peak (`payloadBytes + estimatedZipBytes`) with safe-integer checks. Reject only when peak is strictly above `safeBudget`, before creating JSZip or accumulating chunks; exact budget is allowed. Also refuse batch ingestion that already exceeds the same conservative retained-byte budget and clearly explain that smaller batches are required. Test invalid device-memory values, exact boundaries, overflow, backpressure, cancellation/write/close/progress errors, picker states, deterministic bytes, STORE methods, and direct-vs-Blob entry equivalence. The browser release check must exercise direct writing and Blob fallback.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
npm test -- tests/archive
npm test
```

Expected: ZIP bytes round-trip, paths remain nested, reports are deterministic, and cancellation aborts the writer.

- [ ] **Step 5: Commit**

```powershell
git add lib/archive tests/archive
git commit -m "feat: preserve folder structure in ZIP downloads"
```

---

### Task 6: Adaptive TikTok Photo Max

**Files:**
- Create: `lib/tiktok/anti-banding.ts`
- Create: `lib/tiktok/export.ts`
- Modify: `workers/image-worker.ts`
- Create: `tests/tiktok/anti-banding.test.ts`
- Create: `tests/tiktok/export.test.ts`
- Add test fixture metadata only: `tests/fixtures/amazonian.json`

**Interfaces:**
- Produces: `createSmoothMask(image: ImageData): Uint8Array`
- Produces: `applyAdaptiveDither(image: ImageData, seed: number): DitherResult`
- Produces: `exportForTikTok(input: Blob, signal?: AbortSignal): Promise<TikTokExportResult>`

- [ ] **Step 1: Write failing mask and bounded-dither tests**

```ts
it("changes only opaque low-detail pixels by at most one level", () => {
  const source = syntheticGradientWithTextEdge();
  const result = applyAdaptiveDither(source, 1234);
  for (let i = 0; i < source.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(result.image.data[i + channel] - source.data[i + channel])).toBeLessThanOrEqual(1);
    }
    if (!result.mask[i / 4]) {
      expect(result.image.data.slice(i, i + 4)).toEqual(source.data.slice(i, i + 4));
    }
  }
});

it("is deterministic and approximately zero mean", () => {
  const a = applyAdaptiveDither(gradient, 42);
  const b = applyAdaptiveDither(gradient, 42);
  expect(a.image.data).toEqual(b.image.data);
  expect(Math.abs(a.meanDelta)).toBeLessThan(0.02);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/tiktok`

Expected: FAIL with missing TikTok modules.

- [ ] **Step 3: Implement edge-safe mask and deterministic blue-noise dither**

Compute integer luma as `(54 * r + 183 * g + 19 * b) >> 8`. Mark a non-border pixel eligible only when alpha is 255, maximum four-neighbor luma delta is at most 6, local 3x3 luma range is at most 12, and four-neighbor RGB/chroma deltas remain below the documented threshold so isoluminant color edges are excluded. Use a fixed 64x64 signed blue-noise ordering addressed with the content-derived seed, then pair eligible non-saturated channel samples into balanced `+1/-1` changes. Leave unmatched or saturated samples unchanged. `meanDelta` is computed over actual applied RGB deltas and must be exactly zero; preserve alpha.

Tests additionally cover sparse and odd masks, saturated channels, border pixels, isoluminant color edges, and assert that a sufficiently large smooth gradient receives nonzero changes.

- [ ] **Step 4: Implement native-size sRGB PNG and approximate preview**

Decode with `createImageBitmap(blob, { imageOrientation: "from-image", colorSpaceConversion: "default" })`, use an sRGB 2D context when supported with a documented HTMLCanvasElement fallback, keep `bitmap.width`/`height`, and never upscale. Export PNG, remove conflicting `iCCP`/duplicate `sRGB` and inconsistent `gAMA`/`cHRM` chunks from the browser-encoded result, insert exactly one valid `sRGB` intent chunk before the first `IDAT`, and strictly reparse/CRC-check the final bytes. Generate the preview as JPEG quality `0.75` and label its `approximate` field `true`. Cancellation is checked between decode, canvas readback, PNG rewrite, and preview; active worker cancellation still terminates/replaces the worker per Task 4.

- [ ] **Step 5: Add the Amazonian regression measurement**

Store only dimensions, expected file hashes, crop coordinates, and threshold metrics in `amazonian.json`; do not commit the user's source image. The test reads a locally supplied fixture only when `AMAZONIAN_FIXTURE_DIR` is set, while the deterministic synthetic gradient remains mandatory in CI.

Run:

```powershell
$env:AMAZONIAN_FIXTURE_DIR='D:\ElaBela\POST\99 - Archivo\Versiones duplicadas\01 - Carruseles\9x16\Tarte Amazonian Clay'
npm test -- tests/tiktok
Remove-Item Env:AMAZONIAN_FIXTURE_DIR
```

Expected: deterministic tests pass and the local evidence test reports lower smooth-region block/banding metrics without reducing text-edge contrast beyond the specified 1% tolerance. This local Amazonian run is a mandatory release gate on the documented source hashes, not an optional skipped check.

- [ ] **Step 6: Commit**

```powershell
git add lib/tiktok workers/image-worker.ts tests/tiktok tests/fixtures/amazonian.json
git commit -m "feat: add adaptive TikTok Photo Max export"
```

---

### Task 7: Batch UI Integration

**Files:**
- Create: `components/SourcePicker.tsx`
- Create: `components/BatchToolbar.tsx`
- Modify: `components/Dropzone.tsx`
- Modify: `components/ResultCard.tsx`
- Modify: `components/TikTokInfo.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Create: `tests/ui/source-picker.test.tsx`
- Create: `tests/ui/batch-toolbar.test.tsx`

**Interfaces:**
- Consumes: `BatchProcessorApi`, archive functions, and TikTok exporter.
- Produces: accessible file/folder controls, progress UI, cancellation, retry, clean ZIP, and TikTok ZIP actions.

- [ ] **Step 1: Add failing UI behavior tests**

```tsx
it("offers separate image and folder controls", () => {
  render(<SourcePicker onInput={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Seleccionar imágenes" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Seleccionar carpeta" })).toBeVisible();
});

it("keeps ZIP actions disabled until their required outputs exist", () => {
  render(<BatchToolbar summary={processingSummary} actions={actions} />);
  expect(screen.getByRole("button", { name: "Descargar carpeta limpia" })).toBeDisabled();
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/ui`

Expected: FAIL with missing components.

- [ ] **Step 3: Implement source selection and reducer-driven page composition**

`app/page.tsx` must not parse bytes or build ZIP paths. It wires `SourcePicker`, `BatchToolbar`, summary, and cards to `useBatchProcessor` only.

Source selection awaits the magic-byte `InputSelection`, displays skipped entries before processing, and enforces the retained-byte preflight. A clean ZIP click acquires the optional direct writer immediately inside the click handler, then passes it into asynchronous archive planning/generation; picker cancellation leaves the UI idle and usable.

Set the folder input property through its DOM ref to avoid relying on a non-standard JSX type:

```ts
useEffect(() => {
  if (folderInputRef.current) folderInputRef.current.webkitdirectory = true;
}, []);
```

- [ ] **Step 4: Implement lazy previews and explicit TikTok states**

Create preview URLs only after an IntersectionObserver marks a card visible. Revoke them on invisibility/removal/reset. The TikTok button labels output as `PNG sRGB · anti-parches adaptativo`; clean output labels `Sin recomprimir`.

- [ ] **Step 5: Verify UI GREEN and browser build**

Run:

```powershell
npm test -- tests/ui
npm test
npm run lint
npx tsc --noEmit --incremental false
npm run build
```

Expected: all commands exit 0 and the production route remains static.

- [ ] **Step 6: Commit**

```powershell
git add app components hooks tests/ui
git commit -m "feat: add folder batch and TikTok Max interface"
```

---

### Task 8: Documentation, Full Verification, and Push

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Documents exact supported formats, lossless guarantees, adaptive TikTok behavior, folder/ZIP limits, privacy, and commands.

- [ ] **Step 1: Update README claims against implemented behavior**

Remove unsupported fixed claims about Instagram thresholds and TikTok targeting a precise file size. State only measured behavior from the supplied example and link claims that rely on current public platform documentation.

- [ ] **Step 2: Run the complete fresh verification matrix**

```powershell
npm ci
npm test
$env:AMAZONIAN_FIXTURE_DIR='D:\ElaBela\POST\99 - Archivo\Versiones duplicadas\01 - Carruseles\9x16\Tarte Amazonian Clay'
npm test -- tests/tiktok
Remove-Item Env:AMAZONIAN_FIXTURE_DIR
npm run lint
npx tsc --noEmit --incremental false
npm run build
npm audit --omit=dev
git diff --check
git status --short --branch
```

Expected: tests/lint/typecheck/build/diff checks exit 0; audit has no unresolved high/critical production advisory. If audit reports one, update to the nearest compatible patched dependency and rerun the complete matrix.

- [ ] **Step 3: Browser verification**

Verify on the production build:

1. Select one JPEG and one PNG.
2. Select a nested folder and confirm relative paths.
3. Cancel a running batch and confirm no late results.
4. Download one clean image and compare pixel payload hashes.
5. Download the clean ZIP through direct-to-disk saving, inspect nested entries/report, cancel one picker, and separately exercise the Blob fallback plus oversized-memory refusal.
6. Generate TikTok PNG and approximate preview.
7. Download TikTok ZIP.
8. Trigger unsupported and corrupt-file errors.
9. Check phone and desktop breakpoints and keyboard focus.

- [ ] **Step 4: Request code review and resolve only actionable findings**

Use the requesting-code-review skill on the complete diff. Rerun the verification matrix after any code change.

- [ ] **Step 5: Commit release documentation**

```powershell
git add README.md package.json package-lock.json
git commit -m "docs: document reliable folder and TikTok workflows"
```

- [ ] **Step 6: Confirm and push exact destination**

```powershell
git remote get-url origin
git branch --show-current
git log --oneline origin/main..HEAD
git push origin main
git status --short --branch
```

Expected remote: `https://github.com/Bryan-dev074/Extractor-MetaDatosIMG.git`. Expected final branch: `main...origin/main` with a clean worktree.
