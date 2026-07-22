# Batch Folders and TikTok Quality Design

**Date:** 2026-07-22
**Repository:** `Bryan-dev074/Extractor-MetaDatosIMG`
**Status:** Approved for implementation

## Context

The application currently cleans AI-related metadata from JPEG and PNG files in the browser. Its lossless download path copies JPEG scan data and PNG `IDAT` chunks without recompressing them, but it has no automated tests, no recursive folder ingestion, no bounded processing queue, and it may return truncated output for malformed files.

The existing TikTok export decodes every image through a canvas, fits it inside a `1080 x 1920` box, and writes a JPEG. It therefore adds a lossy generation and does not actually guarantee `1080 x 1920` output.

The production example supplied by the user was inspected directly. The three local source designs are `1536 x 2752` JPEGs. Their observed chain was approximately:

`JPEG quality 100 (1.4-1.6 MB) -> JPEG quality 90 (542-626 KB) -> TikTok JPEG quality 75, 4:2:0 (245-292 KB)`

The visible patches occur mainly in smooth peach gradients. The new design must keep the normal cleaning path strictly lossless while providing a clearly separate TikTok-specific output that can make tiny, intentional pixel changes to reduce banding and block visibility.

## Goals

1. Accept individual images or a complete folder tree and preserve relative paths.
2. Download successful results as one ZIP that mirrors the selected folder structure.
3. Keep the normal cleaned JPEG/PNG pixel payload byte-identical to the source.
4. Fail closed for malformed or unsupported files; never present truncated output as successful.
5. Add an optional TikTok Photo Max pipeline that avoids an intermediate JPEG and applies adaptive anti-banding only to low-detail regions.
6. Keep all processing on the user's device.
7. Bound concurrency and memory use, support cancellation, and keep the UI responsive for large batches.
8. Add automated regression coverage and evidence-based browser verification.

## Non-goals

- Removing pixel-level watermarks such as SynthID.
- Uploading files to a backend or storing user images remotely.
- Losslessly cleaning WebP, AVIF, HEIC/HEIF, TIFF, GIF, RAW, or SVG in this release.
- Preserving empty directories, because standard browser folder inputs expose files and their relative paths, not empty directory entries.
- Guaranteeing that TikTok will not recompress an upload. The application can only prepare a more compression-resistant source.
- Treating every C2PA credential as proof that an image was AI-generated.

## Product Modes

### Clean, lossless

- Supports JPEG and PNG detected by magic bytes, independent of filename extension.
- Removes only supported AI/provenance metadata structures.
- Preserves JPEG entropy-coded scan bytes, quantization and Huffman tables, ICC segments, orientation, density, dimensions, and color-related markers.
- Preserves PNG `IDAT`, `PLTE`, transparency, ICC/sRGB/color chunks, physical resolution, dimensions, bit depth, and animation chunks.
- Uses structural parsing rather than scanning arbitrary pixel-bearing chunks as text.
- Derives the output extension from the detected format.
- Verifies the rewritten structure before marking an item complete.

### TikTok Photo Max

- Is visibly labeled as an adaptive export that changes pixels; it is never confused with the lossless download.
- Starts from the highest-quality selected source and applies EXIF orientation before processing.
- Uses an explicit sRGB canvas when supported and a safe sRGB fallback otherwise.
- Preserves native pixel dimensions and aspect ratio by default. It does not force `1080 x 1920` and does not upscale.
- Detects low-detail opaque regions using local luminance gradients. It excludes edges, text, product contours, transparent pixels, and high-frequency texture.
- Adds deterministic, zero-mean micro-dither with a maximum per-channel amplitude of one 8-bit level in eligible regions. The seed is derived from the file content so repeated exports are stable.
- Exports a lossless PNG as the default TikTok handoff, avoiding an intermediate JPEG generation.
- Inserts explicit sRGB intent into the PNG when the browser encoder omits it.
- Generates an optional approximate TikTok preview using a quality-75 JPEG simulation. The UI labels the preview as an approximation, not a promise of TikTok's exact output.
- Offers individual TikTok downloads and a complete `<folder>-tiktok.zip`.

## Folder Ingestion

The UI provides separate controls for `Select images` and `Select folder`, plus drag-and-drop.

Each accepted input becomes:

```ts
interface InputImage {
  id: string;
  file: File;
  relativePath: string;
  rootName: string | null;
  source: "files" | "folder" | "drop";
}
```

- Folder selection uses `webkitdirectory` and `File.webkitRelativePath`, with feature detection and a multiple-file fallback.
- Dropped directories use `DataTransferItem.webkitGetAsEntry()` recursively and repeatedly call `readEntries()` until the directory is exhausted.
- Only JPEG and PNG candidates enter processing. Other files are counted as skipped and reported before work starts.
- Re-adding the same source uses `relativePath + size + lastModified` to avoid accidental duplicate work.

## Safe Archive Paths

Archive paths are handled by one pure module and tested independently.

- Convert backslashes to `/` and normalize Unicode to NFC.
- Remove empty, `.` and `..` segments.
- Reject absolute paths, UNC prefixes, drive prefixes, NUL, and control characters.
- Replace Windows-invalid characters and reserved basenames such as `CON`, `NUL`, and `COM1`.
- Apply `-limpio` or `-tiktok` only to the basename.
- Resolve collisions case-insensitively on the complete normalized path with ` (2)`, ` (3)`, and so on.
- Produce `<root>-limpia.zip` and `<root>-tiktok.zip` with matching root directories inside each archive.

## Processing Architecture

The page becomes a thin composition layer around focused modules:

- `lib/metadata/*`: binary parsers, validators, and lossless cleaners.
- `lib/batch/*`: input normalization, queue state, cancellation, path handling, and progress.
- `lib/tiktok/*`: smooth-region detection, deterministic dither, sRGB PNG preparation, and preview generation.
- `lib/archive/*`: ZIP entry planning, in-memory fallback, and direct-to-disk streaming.
- `workers/image-worker.ts`: CPU-heavy cleaning and TikTok preparation.
- `hooks/useBatchProcessor.ts`: reducer-based orchestration for React.
- focused UI components for source selection, batch toolbar, summary, virtualized/lazy result cards, and error reporting.

The worker pool runs at a default concurrency of two and reduces to one when estimated memory pressure is high. Every task carries a batch generation and abort token so reset, remove, and cancel operations cannot commit stale results.

State is stored as `order: string[]` plus `itemsById: Record<string, BatchItem>` to avoid repeatedly scanning and copying the full list for every progress event.

## ZIP Generation and Memory

- JPEG and PNG entries use ZIP `STORE`; recompressing already-compressed images wastes CPU and can enlarge output.
- When `showSaveFilePicker` is available, the application asks for the destination immediately from the user's download gesture and streams JSZip output chunks to the writable file.
- The cross-browser fallback uses a Blob with `streamFiles: true`.
- Before using the Blob fallback, the application estimates cleaned bytes plus ZIP overhead. If the estimate exceeds a conservative device-dependent budget, it explains that direct-to-disk saving in a compatible desktop browser is required instead of attempting an unsafe allocation.
- ZIP progress reports processed bytes, current file, and completion percentage.
- Cancellation closes or aborts the writer and does not report success.
- `_reporte-procesamiento.txt` records skipped and failed paths, while successful images retain their directory layout.

## Parser Hardening

### JPEG

- Validate SOI, segment lengths, marker order, SOS presence, scan traversal, and EOI.
- Continue parsing markers between progressive scans without decoding or changing entropy-coded bytes.
- Preserve unknown APP markers unless they are structurally identified as supported removable metadata.
- Identify JUMBF before classifying APP11; report C2PA separately from an AI-generator match.
- Parse EXIF IFD chains safely and redact only values that can be changed without dropping orientation, resolution, or color fields.
- If safe surgery is impossible, report an error instead of deleting a mixed metadata block that affects visual presentation.

### PNG

- Validate signature, chunk lengths, critical order, CRC, at least one `IDAT`, and `IEND`.
- Preserve APNG `acTL`, `fcTL`, and `fdAT` as pixel-bearing structures.
- Limit compressed text expansion and textual scan length.
- Inspect only known text/metadata chunks for AI signatures.
- Recalculate CRC only for chunks intentionally rewritten; copied chunks remain byte-identical.

## User Experience

- The empty state clearly offers images or a folder.
- Once processing starts, the toolbar shows total, completed, skipped, failed, and active counts plus processed bytes.
- The user can cancel the batch, retry failures, remove an item, clear results, download one clean file, generate one TikTok version, download the clean ZIP, or build the TikTok ZIP.
- TikTok generation is explicit and never runs automatically for every folder image.
- Result cards display the relative path, detected format, source and output sizes, removed structures, preserved quality data, and error reason.
- Preview object URLs are created only for visible cards and revoked when no longer needed.
- Errors are visible and actionable; ZIP failures cannot leave the UI stuck in a loading state.

## Testing Strategy

The project adds a non-interactive lint configuration and Vitest.

### Binary invariants

- JPEG baseline and progressive fixtures, EXIF little/big endian, orientation 1-8, multipart ICC, CMYK, C2PA JUMBF, XMP, malformed lengths, missing SOS/EOI, and metadata between scans.
- PNG indexed/RGBA/16-bit/interlaced fixtures, ICC/sRGB, transparency, APNG, text variants, C2PA chunks, bad CRC, missing `IDAT`/`IEND`, truncated chunks, and bounded compressed-text expansion.
- Hash JPEG scan payloads, PNG `IDAT`/`fdAT`, and ICC data before and after clean output.
- Decode source and clean output and assert zero changed pixels for valid fixtures.

### Batch and archive

- Folder paths, deep nesting, Unicode normalization, duplicates, reserved names, unsafe paths, skipped formats, retry, cancellation, progress, and stale worker responses.
- ZIP filenames, root directory, stored entries, report contents, and error cleanup.

### TikTok

- Smooth-region mask excludes edges and alpha.
- Dither is deterministic, zero-mean, bounded to one channel level, and changes no ineligible pixel.
- Output dimensions equal the source dimensions and PNG output is sRGB.
- The Amazonian Clay fixture demonstrates that the prepared preview reduces visible smooth-region banding/block metrics compared with the observed JPEG-intermediate path without harming text-edge metrics.

### Release verification

- `npm test`
- `npm run lint`
- `npx tsc --noEmit --incremental false`
- `npm run build`
- Browser verification for files, folders, cancellation, individual downloads, clean ZIP, TikTok ZIP, responsive layout, and visible error states.
- `npm audit --omit=dev`, with unresolved production advisories reported before push.

## Acceptance Criteria

1. A nested JPEG/PNG folder can be selected and downloaded as a ZIP with the same non-empty directory structure.
2. Lossless outputs preserve pixel payload hashes and decode to exactly the same pixels.
3. Invalid images never produce a downloadable success result.
4. Batch cancellation prevents late results from reappearing.
5. Large-folder fallback refuses unsafe memory use with a clear path to direct disk streaming.
6. TikTok Photo Max produces native-size sRGB PNG output with bounded adaptive dither and no JPEG intermediary.
7. The supplied Amazonian Clay sources are covered by regression evidence.
8. All automated and browser checks pass before commits are pushed to `origin/main`.
