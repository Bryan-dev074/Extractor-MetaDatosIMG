import { detectImageFormat, type SupportedFormat } from "../metadata/format";
import { MAX_INPUT_BYTES } from "../metadata/limits";
import type { InputImage, InputSelection, InputSource, SkippedInput } from "./types";

const FALLBACK_ARCHIVE_BASE = "imagenes-procesadas";
const RESERVED_WINDOWS_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

interface Candidate {
  file: File;
  relativePath: string;
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

interface CollectedEntries {
  candidates: Candidate[];
  folderRoots: string[];
  skipped: SkippedInput[];
}

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
  const portable = root
    .normalize("NFC")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[. ]+$/u, "");
  if (!portable) return FALLBACK_ARCHIVE_BASE;
  const deviceBasename = portable.split(".", 1)[0];
  return RESERVED_WINDOWS_BASENAME.test(deviceBasename) ? `_${portable}` : portable;
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
  const roots = new Set(folderRoots.map((root) => normalizedPath(root).split("/")[0]));
  const knownFolderRoots = new Set(roots);
  let hasLooseFile = false;

  for (const path of paths) {
    const segments = normalizedPath(path).split("/").filter(Boolean);
    if (segments.length < 2) {
      if (!knownFolderRoots.has(segments[0])) hasLooseFile = true;
    } else {
      roots.add(segments[0]);
    }
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
  const normalizedCandidates = candidates
    .map((candidate) => ({ ...candidate, relativePath: normalizedPath(candidate.relativePath) }))
    .sort((left, right) => {
      return (
        compareByRelativePath(left, right) ||
        compareText(left.file.name, right.file.name) ||
        left.file.size - right.file.size ||
        left.file.lastModified - right.file.lastModified
      );
    });
  const archiveBase = archiveBaseFor(normalizedCandidates, initialSkipped, folderRoots);
  const uniqueCandidates: Candidate[] = [];
  const skipped = initialSkipped.map((item) => ({
    ...item,
    relativePath: normalizedPath(item.relativePath),
  }));
  const seen = new Set<string>();

  for (const candidate of normalizedCandidates) {
    const id = fingerprint(candidate);
    if (seen.has(id)) {
      skipped.push({
        relativePath: candidate.relativePath,
        reason: "Archivo duplicado: ya se agregó la misma ruta, tamaño y fecha de modificación.",
      });
    } else {
      seen.add(id);
      uniqueCandidates.push(candidate);
    }
  }

  const classified = await Promise.all(uniqueCandidates.map(classify));
  const accepted: InputImage[] = [];
  for (const item of classified) {
    if ("format" in item) accepted.push(item);
    else skipped.push(item);
  }

  accepted.sort(compareByRelativePath);
  skipped.sort((left, right) => compareByRelativePath(left, right) || compareText(left.reason, right.reason));
  return { archiveBase, accepted, skipped };
}

export async function normalizeFiles(
  files: Iterable<File>,
  source: InputSource,
): Promise<InputSelection> {
  const candidates = Array.from(files, (file): Candidate => ({
    file,
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

async function collectEntry(
  entry: BrowserFileSystemEntry,
  parentPath: string,
  collection: CollectedEntries,
): Promise<void> {
  const relativePath = joinEntryPath(parentPath, entry.name);
  if (entry.isFile) {
    try {
      collection.candidates.push({ file: await readEntryFile(entry), relativePath });
    } catch (error) {
      collection.skipped.push({
        relativePath,
        reason: `No se pudo leer el archivo: ${errorMessage(error)}.`,
      });
    }
    return;
  }

  let reader: BrowserDirectoryReader;
  try {
    reader = entry.createReader();
  } catch (error) {
    collection.skipped.push({
      relativePath,
      reason: `No se pudo abrir la carpeta: ${errorMessage(error)}.`,
    });
    return;
  }

  while (true) {
    let batch: BrowserFileSystemEntry[];
    try {
      batch = await readEntryBatch(reader);
    } catch (error) {
      collection.skipped.push({
        relativePath,
        reason: `No se pudo leer la carpeta: ${errorMessage(error)}.`,
      });
      return;
    }
    if (batch.length === 0) return;
    await Promise.all(batch.map((child) => collectEntry(child, relativePath, collection)));
  }
}

export async function readDroppedItems(items: DataTransferItemList): Promise<InputSelection> {
  const collection: CollectedEntries = { candidates: [], folderRoots: [], skipped: [] };
  const pending: Promise<void>[] = [];

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
      if (entry.isDirectory) collection.folderRoots.push(entry.name);
      pending.push(collectEntry(entry, "", collection));
      continue;
    }

    const file = item.getAsFile();
    if (file) collection.candidates.push({ file, relativePath: looseFilePath(file) });
  }

  await Promise.all(pending);
  return normalizeCandidates(collection.candidates, collection.skipped, collection.folderRoots);
}

export type { InputImage, InputSelection, InputSource, SkippedInput } from "./types";
