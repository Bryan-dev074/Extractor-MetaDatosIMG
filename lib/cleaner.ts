export { cleanBytes, cleanImage } from "./metadata";
export type { CleanResult, Finding, PreservedItem } from "./types";

/** Crea un nombre de archivo de salida: `foto.jpg` → `foto-limpio.jpg`. */
export function cleanFileName(original: string): string {
  const dot = original.lastIndexOf(".");
  if (dot <= 0) return `${original}-limpio`;
  return `${original.slice(0, dot)}-limpio${original.slice(dot)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
