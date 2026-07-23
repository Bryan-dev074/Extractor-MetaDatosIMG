import JSZip from "jszip";
import { createArchivePath, sanitizeArchiveSegment } from "../batch/archive-path";
import {
  formatProcessingReport,
  type ProcessingMode,
  type ReportFailure,
  type ReportSkipped,
} from "./report";

const FIXED_ZIP_DATE = new Date(Date.UTC(1980, 0, 1));
const ZIP32_LIMIT = 0xffff_ffff;
const ZIP32_MAX_ENTRIES = 65_535;
const ZIP32_MAX_NAME_BYTES = 65_535;
const GIB = 1024 ** 3;
const FALLBACK_MEMORY_BUDGET = 512 * 1024 ** 2;

export interface ArchiveOutput {
  id: string;
  relativePath: string;
  bytes: Uint8Array;
  qualityVerified?: boolean;
  outputExtension?: ".jpg" | ".png";
}

export interface ArchivePlanningInput {
  archiveBase: string;
  outputs: ArchiveOutput[];
  skipped: ReportSkipped[];
  failed: ReportFailure[];
}

export interface ArchiveEntry extends ArchiveOutput {
  path: string;
}

export interface ArchiveReportEntry {
  path: string;
  bytes: Uint8Array;
}

export interface ArchivePlan {
  archiveBase: string;
  suggestedName: string;
  mode: ProcessingMode;
  entries: ArchiveEntry[];
  report: ArchiveReportEntry;
}

export interface ArchiveSizeEstimate {
  payloadBytes: number;
  estimatedZipBytes: number;
  peakBlobBytes: number;
}

export interface ArchiveWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export type ArchiveWriterRequest =
  | { kind: "writer"; writer: ArchiveWriter }
  | { kind: "unsupported" }
  | { kind: "cancelled" };

export type ArchiveDestination =
  | { kind: "writer"; writer: ArchiveWriter }
  | { kind: "blob" };

export type ArchiveResult =
  | {
      kind: "writer";
      suggestedName: string;
      size: number;
    }
  | {
      kind: "blob";
      suggestedName: string;
      size: number;
      blob: Blob;
    };

export interface GenerateArchiveOptions {
  destination: ArchiveDestination;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

interface NativeArchiveWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface NativeSaveHandle {
  createWritable(): Promise<NativeArchiveWriter>;
}

interface SavePickerOptions {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}

type SavePicker = (options: SavePickerOptions) => Promise<NativeSaveHandle>;

function compareText(left: string, right: string): number {
  const a = left.normalize("NFC");
  const b = right.normalize("NFC");
  return a < b ? -1 : a > b ? 1 : 0;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function abortError(): DOMException {
  return new DOMException("La generación del ZIP fue cancelada.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function awaitWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(abortError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError()));

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function checkedAdd(left: number, right: number, label: string): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new Error(
      `${label} excede los enteros seguros; divide la selección en lotes más pequeños.`,
    );
  }
  return left + right;
}

function byteLength(value: Uint8Array, label: string): number {
  const length = value?.byteLength;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`${label} informa un tamaño no seguro.`);
  }
  return length;
}

function encodedNameLength(path: string): number {
  return new TextEncoder().encode(path).byteLength;
}

function zipEntries(plan: ArchivePlan): Array<{ path: string; bytes: Uint8Array }> {
  return [...plan.entries, plan.report];
}

function ensureZip32Value(value: number, label: string): void {
  if (value >= ZIP32_LIMIT) {
    throw new Error(`${label} se acerca al límite de ZIP32; usa un lote más pequeño.`);
  }
}

export function planArchive(
  input: ArchivePlanningInput,
  mode: ProcessingMode,
): ArchivePlan {
  const archiveBase = sanitizeArchiveSegment(input.archiveBase);
  const outputs = [...input.outputs].sort(
    (left, right) =>
      compareText(left.relativePath, right.relativePath) ||
      compareText(left.id, right.id),
  );
  const used = new Set<string>();
  const entries = outputs.map((item): ArchiveEntry => {
    if (!(item.bytes instanceof Uint8Array)) {
      throw new Error(`La salida ${item.relativePath} no contiene bytes válidos.`);
    }
    if (mode === "clean" && item.qualityVerified !== true) {
      throw new Error(
        `La calidad de ${item.relativePath} no fue verificada; no se incluirá en el ZIP limpio.`,
      );
    }
    const path =
      mode === "clean"
        ? createArchivePath(
            item.relativePath,
            "clean",
            used,
            item.outputExtension as ".jpg" | ".png",
          )
        : createArchivePath(item.relativePath, "tiktok", used);
    return { ...item, path };
  });

  const reportText = formatProcessingReport({
    mode,
    outputs: entries.map((entry) => ({
      id: entry.id,
      relativePath: entry.relativePath,
      archivePath: entry.path,
      byteLength: byteLength(entry.bytes, entry.relativePath),
    })),
    skipped: input.skipped,
    failed: input.failed,
  });
  const report: ArchiveReportEntry = {
    path: `${archiveBase}/_reporte-procesamiento.txt`,
    bytes: Uint8Array.from(new TextEncoder().encode(reportText)),
  };

  return {
    archiveBase,
    suggestedName: `${archiveBase}-${mode === "clean" ? "limpia" : "tiktok"}.zip`,
    mode,
    entries,
    report,
  };
}

export function estimateArchiveSize(plan: ArchivePlan): ArchiveSizeEstimate {
  const entries = zipEntries(plan);
  if (entries.length > ZIP32_MAX_ENTRIES) {
    throw new Error(
      "El plan supera 65.535 entradas y no es compatible con ZIP32.",
    );
  }

  let payloadBytes = 0;
  let localBytes = 0;
  let centralBytes = 0;
  const paths = new Set<string>();

  for (const entry of entries) {
    const normalizedPath = entry.path.normalize("NFC");
    if (paths.has(normalizedPath)) {
      throw new Error(`El ZIP contiene una ruta duplicada: ${normalizedPath}.`);
    }
    paths.add(normalizedPath);

    const nameBytes = encodedNameLength(normalizedPath);
    if (nameBytes > ZIP32_MAX_NAME_BYTES) {
      throw new Error(
        `El nombre ${normalizedPath.slice(0, 80)} excede el límite de ZIP32.`,
      );
    }
    const size = byteLength(entry.bytes, normalizedPath);
    ensureZip32Value(size, `El tamaño de ${normalizedPath}`);
    payloadBytes = checkedAdd(payloadBytes, size, "El tamaño total retenido");

    const usesUnicodePathExtra = nameBytes !== normalizedPath.length;
    const unicodeExtra = usesUnicodePathExtra
      ? checkedAdd(9, nameBytes, "El campo Unicode del ZIP")
      : 0;
    if (unicodeExtra > ZIP32_MAX_NAME_BYTES) {
      throw new Error(
        `El campo extra Unicode de ${normalizedPath.slice(0, 80)} excede el límite de ZIP32.`,
      );
    }
    const localOverhead = checkedAdd(
      checkedAdd(46, nameBytes, "La cabecera local del ZIP"),
      unicodeExtra,
      "La cabecera local del ZIP",
    );
    const centralOverhead = checkedAdd(
      checkedAdd(46, nameBytes, "El directorio central del ZIP"),
      unicodeExtra,
      "El directorio central del ZIP",
    );
    localBytes = checkedAdd(
      localBytes,
      checkedAdd(size, localOverhead, "La entrada local del ZIP"),
      "Los offsets locales del ZIP",
    );
    ensureZip32Value(localBytes, "Los offsets locales del ZIP");
    centralBytes = checkedAdd(
      centralBytes,
      centralOverhead,
      "El directorio central del ZIP",
    );
  }

  const estimatedZipBytes = checkedAdd(
    checkedAdd(localBytes, centralBytes, "El tamaño estimado del ZIP"),
    22,
    "El tamaño estimado del ZIP",
  );
  ensureZip32Value(estimatedZipBytes, "El tamaño estimado del ZIP");
  const peakBlobBytes = checkedAdd(
    payloadBytes,
    estimatedZipBytes,
    "El pico estimado del fallback Blob",
  );

  return { payloadBytes, estimatedZipBytes, peakBlobBytes };
}

export function preflightArchive(plan: ArchivePlan): ArchiveSizeEstimate {
  return estimateArchiveSize(plan);
}

export function getSafeMemoryBudget(): number {
  const memory =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { deviceMemory?: unknown }).deviceMemory
      : undefined;
  const deviceBudget =
    typeof memory === "number" && Number.isFinite(memory) && memory > 0
      ? memory * 128 * 1024 ** 2
      : FALLBACK_MEMORY_BUDGET;
  return Math.min(GIB, deviceBudget);
}

export function assertRetainedByteBudget(
  byteLengths: Iterable<number>,
  safeBudget = getSafeMemoryBudget(),
): number {
  let retainedBytes = 0;
  for (const length of byteLengths) {
    retainedBytes = checkedAdd(
      retainedBytes,
      length,
      "El tamaño total retenido",
    );
  }
  if (retainedBytes > safeBudget) {
    throw new Error(
      "La selección excede la memoria segura disponible. Procesa las imágenes en lotes más pequeños.",
    );
  }
  return retainedBytes;
}

export function assertBlobBudget(
  plan: ArchivePlan,
  safeBudget = getSafeMemoryBudget(),
): ArchiveSizeEstimate {
  const estimate = preflightArchive(plan);
  if (estimate.peakBlobBytes > safeBudget) {
    throw new Error(
      "El ZIP excede la memoria segura del navegador. Descárgalo directamente a disco o procesa un lote más pequeño.",
    );
  }
  return estimate;
}

export async function requestArchiveWriter(
  suggestedName: string,
): Promise<ArchiveWriterRequest> {
  const picker =
    typeof window !== "undefined"
      ? (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker
      : undefined;
  if (typeof picker !== "function") return { kind: "unsupported" };

  let handle: NativeSaveHandle;
  try {
    handle = await picker({
      suggestedName,
      types: [
        {
          description: "Archivo ZIP",
          accept: { "application/zip": [".zip"] },
        },
      ],
    });
  } catch (error) {
    if (isAbortError(error)) return { kind: "cancelled" };
    throw error;
  }

  const nativeWriter = await handle.createWritable();
  return {
    kind: "writer",
    writer: {
      write: (chunk) => nativeWriter.write(chunk),
      close: () => nativeWriter.close(),
      abort: (reason) => nativeWriter.abort(reason),
    },
  };
}

function createZip(plan: ArchivePlan): JSZip {
  const zip = new JSZip();
  for (const entry of zipEntries(plan)) {
    zip.file(entry.path, entry.bytes, {
      binary: true,
      compression: "STORE",
      createFolders: false,
      date: FIXED_ZIP_DATE,
    });
  }
  return zip;
}

async function generateArchiveInternal(
  plan: ArchivePlan,
  options: GenerateArchiveOptions,
): Promise<ArchiveResult> {
  throwIfAborted(options.signal);
  if (options.destination.kind === "blob") assertBlobBudget(plan);
  else preflightArchive(plan);
  throwIfAborted(options.signal);

  const zip = createZip(plan);
  const stream = zip.generateInternalStream({
    type: "uint8array",
    compression: "STORE",
    streamFiles: true,
    platform: "DOS",
  });
  const chunks: ArrayBuffer[] = [];
  let writtenBytes = 0;
  let pendingWrites = Promise.resolve();
  let ended = false;
  let terminal = false;
  let lastProgress = 0;
  let resolveStream!: () => void;
  let rejectStream!: (error: unknown) => void;
  const streamDone = new Promise<void>((resolve, reject) => {
    resolveStream = resolve;
    rejectStream = reject;
  });

  const fail = (error: unknown): void => {
    if (terminal) return;
    terminal = true;
    stream.pause();
    rejectStream(error);
  };
  const abortListener = (): void => fail(abortError());
  options.signal?.addEventListener("abort", abortListener, { once: true });

  stream.on("data", (chunk, metadata) => {
    if (terminal) return;
    stream.pause();
    pendingWrites = pendingWrites
      .then(async () => {
        throwIfAborted(options.signal);
        if (options.destination.kind === "writer") {
          await options.destination.writer.write(chunk);
        } else {
          const copy = Uint8Array.from(chunk);
          chunks.push(copy.buffer);
        }
        throwIfAborted(options.signal);
        writtenBytes = checkedAdd(
          writtenBytes,
          chunk.byteLength,
          "El tamaño generado del ZIP",
        );
        const progress = Math.max(
          lastProgress,
          Math.min(99, Math.max(0, metadata.percent)),
        );
        lastProgress = progress;
        options.onProgress?.(progress);
        throwIfAborted(options.signal);
      })
      .then(() => {
        if (!terminal && !ended) stream.resume();
      })
      .catch(fail);
  });
  stream.on("end", () => {
    ended = true;
    pendingWrites.then(() => {
      if (!terminal) resolveStream();
    }, fail);
  });
  stream.on("error", fail);

  try {
    stream.resume();
    await streamDone;
    await pendingWrites;
    throwIfAborted(options.signal);

    let result: ArchiveResult;
    if (options.destination.kind === "writer") {
      await awaitWithAbort(
        options.destination.writer.close(),
        options.signal,
      );
      result = {
        kind: "writer",
        suggestedName: plan.suggestedName,
        size: writtenBytes,
      };
    } else {
      const blob = new Blob(chunks, { type: "application/zip" });
      result = {
        kind: "blob",
        suggestedName: plan.suggestedName,
        size: blob.size,
        blob,
      };
    }

    options.onProgress?.(100);
    throwIfAborted(options.signal);
    terminal = true;
    return result;
  } catch (error) {
    terminal = true;
    stream.pause();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abortListener);
  }
}

export async function generateArchive(
  plan: ArchivePlan,
  options: GenerateArchiveOptions,
): Promise<ArchiveResult> {
  try {
    return await generateArchiveInternal(plan, options);
  } catch (error) {
    if (options.destination.kind === "writer") {
      try {
        await options.destination.writer.abort(error);
      } catch {
        // Preserve the error that actually terminated archive generation.
      }
    }
    throw error;
  }
}
