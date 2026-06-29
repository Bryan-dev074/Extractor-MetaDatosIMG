import type { CleanResult, ImageFormat } from "./types";
import { cleanJpeg } from "./jpeg";
import { cleanPng } from "./png";

export type { CleanResult, Finding, PreservedItem } from "./types";

function detectFormat(b: Uint8Array): ImageFormat | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (
    b.length > 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47
  ) {
    return "png";
  }
  return null;
}

/**
 * Limpia los metadatos de IA de una imagen en el navegador, preservando la
 * estructura/calidad. Devuelve los bytes limpios + el desglose de lo eliminado.
 */
export async function cleanImage(file: File): Promise<CleanResult> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const format = detectFormat(buf);

  if (!format) {
    throw new Error(
      "Formato no soportado. Sube una imagen JPEG (.jpg/.jpeg) o PNG (.png).",
    );
  }

  const result = format === "jpeg" ? cleanJpeg(buf, file.size) : cleanPng(buf, file.size);

  // Aviso honesto: las marcas de agua invisibles (a nivel de píxel) NO son
  // metadatos y este limpiador no las toca (tocarlas degradaría la imagen).
  if (result.isAi) {
    result.notices.push(
      "Las marcas de agua invisibles a nivel de píxel (p. ej. Google SynthID en Imagen/Gemini/Nano Banana) NO son metadatos: viven en los píxeles y no se eliminan aquí, porque hacerlo degradaría la imagen.",
    );
  }

  return result;
}

/** Crea un nombre de archivo de salida: `foto.jpg` → `foto-limpio.jpg`. */
export function cleanFileName(original: string): string {
  const dot = original.lastIndexOf(".");
  if (dot <= 0) return `${original}-limpio`;
  return `${original.slice(0, dot)}-limpio${original.slice(dot)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
