import { detectImageFormat, type SupportedFormat } from "../metadata/format";
import { MAX_INPUT_BYTES } from "../metadata/limits";
import { assertRetainedByteBudget } from "../archive/zip";
import { sanitizeArchiveSegment } from "./archive-path";
import type { InputImage, InputSelection, InputSource, SkippedInput } from "./types";

const FALLBACK_ARCHIVE_BASE = "imagenes-procesadas";

interface Candidate {
  file: File;
  ordinal: number;
  relativePath: string;
}

interface CandidateDraft {
  file: File;
  relativePath: string;
}

interface RankedSkipped extends SkippedInput {
  ordinal: number;
}

interface EntryResult {
  candidates: CandidateDraft[];
  skipped: SkippedInput[];
}

interface BrowserFileEntry {
  isFile: true;
  isDirectory: false;
  name: string;
  file(
    success: (file: File) => void,
    error?: (reason: DOMException) => void,
  ): void;
}

interface BrowserDirectoryReader {
  readEntries(
    success: (entries: BrowserFileSystemEntry[]) => void,
    error?: (reason: DOMException) => void,
  ): void;
}

interface BrowserDirectoryEntry {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader(): BrowserDirectoryReader;
}

type BrowserFileSystemEntry = BrowserFileEntry | BrowserDirectoryEntry;

type EntryDataTransferItem = Pick<DataTransferItem, "kind" | "getAsFile"> & {
  webkitGetAsEntry?: () => BrowserFileSystemEntry | null;
};

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").normalize("NFC");
}

function looseFilePath(file: File): string {
  const segments = normalizedPath(file.name).split("/").filter(Boolean);
  return segments.at(-1) ?? "archivo-sin-nombre";
}

function compareText(left: string, right: string): number {
  const a = left.normalize("NFC");
  const b = right.normalize("NFC");
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareByRelativePath<T extends { relativePath: string }>(left: T, right: T): number {
  return compareText(left.relativePath, right.relativePath);
}

function fingerprint(candidate: Candidate): string {
  return JSON.stringify([
    candidate.relativePath.normalize("NFC"),
    candidate.file.size,
    candidate.file.lastModified,
  ]);
}

function errorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message
  ) {
    return error.message;
  }
  return "Error de lectura desconocido";
}

function safeArchiveBase(root: string): string {
  try {
    return sanitizeArchiveSegment(root);
  } catch {
    return FALLBACK_ARCHIVE_BASE;
  }
}

function firstPathSegment(path: string): string {
  return normalizedPath(path).split("/").filter(Boolean)[0] ?? "";
}

function archiveBaseFor(
  candidates: Candidate[],
  skipped: SkippedInput[],
  folderRoots: string[],
): string {
  const paths = [
    ...candidates.map((candidate) => candidate.relativePath),
    ...skipped.map((item) => item.relativePath),
  ];

  if (folderRoots.length > 0) {
    if (folderRoots.length !== 1) return FALLBACK_ARCHIVE_BASE;
    const onlyRoot = normalizedPath(folderRoots[0]);
    const containsLooseFile = paths.some((path) => firstPathSegment(path) !== onlyRoot);
    return containsLooseFile ? FALLBACK_ARCHIVE_BASE : safeArchiveBase(onlyRoot);
  }

  const roots = new Set<string>();
  let hasLooseFile = false;
  for (const path of paths) {
    const segments = normalizedPath(path).split("/").filter(Boolean);
    if (segments.length < 2) hasLooseFile = true;
    else roots.add(segments[0]);
  }

  if (!hasLooseFile && roots.size === 1) return safeArchiveBase(Array.from(roots)[0]);
  return FALLBACK_ARCHIVE_BASE;
}

async function classify(candidate: Candidate): Promise<InputImage | SkippedInput> {
  const { file, relativePath } = candidate;
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    return { relativePath, reason: "El archivo informa un tamaño inválido." };
  }
  if (file.size > MAX_INPUT_BYTES) {
    return { relativePath, reason: "El archivo supera el límite seguro de 256 MB." };
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  } catch (error) {
    return {
      relativePath,
      reason: `No se pudo leer el archivo: ${errorMessage(error)}.`,
    };
  }

  const format: SupportedFormat | null = detectImageFormat(bytes);
  if (!format) {
    return {
      relativePath,
      reason: "Formato no soportado. Selecciona una imagen JPEG o PNG válida.",
    };
  }

  return { id: fingerprint(candidate), file, relativePath, format };
}

async function normalizeCandidates(
  candidates: Candidate[],
  initialSkipped: SkippedInput[] = [],
  folderRoots: string[] = [],
): Promise<InputSelection> {
  assertRetainedByteBudget(
    candidates
      .map((candidate) => candidate.file.size)
      .filter((size) => Number.isSafeInteger(size) && size >= 0),
  );
  const normalizedCandidates = candidates
    .map((candidate) => ({ ...candidate, relativePath: normalizedPath(candidate.relativePath) }))
    .sort((left, right) => {
      return (
        compareByRelativePath(left, right) ||
        compareText(left.file.name, right.file.name) ||
        left.file.size - right.file.size ||
        left.file.lastModified - right.file.lastModified ||
        left.ordinal - right.ordinal
      );
    });
  const normalizedSkipped = initialSkipped.map((item) => ({
    ...item,
    relativePath: normalizedPath(item.relativePath),
  }));
  const archiveBase = archiveBaseFor(normalizedCandidates, normalizedSkipped, folderRoots);
  const uniqueCandidates: Candidate[] = [];
  const skipped: RankedSkipped[] = normalizedSkipped.map((item, index) => ({
    ...item,
    ordinal: candidates.length + index,
  }));
  const seen = new Set<string>();

  for (const candidate of normalizedCandidates) {
    const id = fingerprint(candidate);
    if (seen.has(id)) {
      skipped.push({
        ordinal: candidate.ordinal,
        relativePath: candidate.relativePath,
        reason: "Archivo duplicado: ya se agregó la misma ruta, tamaño y fecha de modificación.",
      });
    } else {
      seen.add(id);
      uniqueCandidates.push(candidate);
    }
  }

  const classified = await Promise.all(
    uniqueCandidates.map(async (candidate) => ({ candidate, result: await classify(candidate) })),
  );
  const accepted: Array<{ ordinal: number; value: InputImage }> = [];
  for (const { candidate, result } of classified) {
    if ("format" in result) accepted.push({ ordinal: candidate.ordinal, value: result });
    else skipped.push({ ...result, ordinal: candidate.ordinal });
  }

  accepted.sort((left, right) => {
    return compareByRelativePath(left.value, right.value) || left.ordinal - right.ordinal;
  });
  skipped.sort((left, right) => {
    return (
      compareByRelativePath(left, right) ||
      compareText(left.reason, right.reason) ||
      left.ordinal - right.ordinal
    );
  });
  return {
    archiveBase,
    accepted: accepted.map((item) => item.value),
    skipped: skipped.map(({ ordinal: _ordinal, ...item }) => item),
  };
}

export async function normalizeFiles(
  files: Iterable<File>,
  source: InputSource,
): Promise<InputSelection> {
  const candidates = Array.from(files, (file, ordinal): Candidate => ({
    file,
    ordinal,
    relativePath:
      source === "folder" && file.webkitRelativePath
        ? file.webkitRelativePath
        : looseFilePath(file),
  }));
  return normalizeCandidates(candidates);
}

function joinEntryPath(parentPath: string, name: string): string {
  return normalizedPath(parentPath ? `${parentPath}/${name}` : name);
}

function readEntryFile(entry: BrowserFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    try {
      entry.file(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function readEntryBatch(reader: BrowserDirectoryReader): Promise<BrowserFileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    try {
      reader.readEntries(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

async function readAllDirectoryEntries(
  reader: BrowserDirectoryReader,
): Promise<BrowserFileSystemEntry[]> {
  const indexed: Array<{ entry: BrowserFileSystemEntry; ordinal: number }> = [];
  while (true) {
    const batch = await readEntryBatch(reader);
    if (batch.length === 0) break;
    for (const entry of batch) indexed.push({ entry, ordinal: indexed.length });
  }
  indexed.sort((left, right) => {
    return compareText(left.entry.name, right.entry.name) || left.ordinal - right.ordinal;
  });
  return indexed.map(({ entry }) => entry);
}

function mergeEntryResults(results: EntryResult[]): EntryResult {
  return {
    candidates: results.flatMap((result) => result.candidates),
    skipped: results.flatMap((result) => result.skipped),
  };
}

async function collectEntry(
  entry: BrowserFileSystemEntry,
  parentPath: string,
  rootPath?: string,
): Promise<EntryResult> {
  const relativePath = rootPath ?? joinEntryPath(parentPath, entry.name);
  if (entry.isFile) {
    try {
      return {
        candidates: [{ file: await readEntryFile(entry), relativePath }],
        skipped: [],
      };
    } catch (error) {
      return {
        candidates: [],
        skipped: [
          { relativePath, reason: `No se pudo leer el archivo: ${errorMessage(error)}.` },
        ],
      };
    }
  }

  let reader: BrowserDirectoryReader;
  try {
    reader = entry.createReader();
  } catch (error) {
    return {
      candidates: [],
      skipped: [
        { relativePath, reason: `No se pudo abrir la carpeta: ${errorMessage(error)}.` },
      ],
    };
  }

  try {
    const children = await readAllDirectoryEntries(reader);
    const results = await Promise.all(
      children.map((child) => collectEntry(child, relativePath)),
    );
    return mergeEntryResults(results);
  } catch (error) {
    return {
      candidates: [],
      skipped: [
        { relativePath, reason: `No se pudo leer la carpeta: ${errorMessage(error)}.` },
      ],
    };
  }
}

function rootCollisionKey(root: string): string {
  return root.normalize("NFC").toLocaleLowerCase("en-US");
}

function reserveDroppedRoot(name: string, used: Set<string>): string {
  let base: string;
  try {
    base = sanitizeArchiveSegment(name);
  } catch {
    base = "carpeta";
  }

  let sequence = 1;
  let candidate = base;
  while (used.has(rootCollisionKey(candidate))) {
    sequence += 1;
    candidate = `${base} (${sequence})`;
  }
  used.add(rootCollisionKey(candidate));
  return candidate;
}

export async function readDroppedItems(items: DataTransferItemList): Promise<InputSelection> {
  const folderRoots: string[] = [];
  const pending: Array<Promise<EntryResult>> = [];
  const usedRoots = new Set<string>();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] as EntryDataTransferItem | undefined;
    if (!item || item.kind !== "file") continue;

    let entry: BrowserFileSystemEntry | null = null;
    try {
      entry = item.webkitGetAsEntry?.() ?? null;
    } catch {
      entry = null;
    }

    if (entry) {
      if (entry.isDirectory) {
        const root = reserveDroppedRoot(entry.name, usedRoots);
        folderRoots.push(root);
        pending.push(collectEntry(entry, "", root));
      } else {
        pending.push(collectEntry(entry, ""));
      }
      continue;
    }

    try {
      const file = item.getAsFile();
      if (file) {
        pending.push(
          Promise.resolve({
            candidates: [{ file, relativePath: looseFilePath(file) }],
            skipped: [],
          }),
        );
      }
    } catch (error) {
      pending.push(
        Promise.resolve({
          candidates: [],
          skipped: [
            {
              relativePath: `elemento-${index + 1}`,
              reason: `No se pudo obtener el archivo: ${errorMessage(error)}.`,
            },
          ],
        }),
      );
    }
  }

  const collected = mergeEntryResults(await Promise.all(pending));
  const candidates = collected.candidates.map((candidate, ordinal) => ({
    ...candidate,
    ordinal,
  }));
  return normalizeCandidates(candidates, collected.skipped, folderRoots);
}

export type { InputImage, InputSelection, InputSource, SkippedInput } from "./types";
