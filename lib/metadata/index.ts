import type { CleanResult } from "../types";
import { detectImageFormat } from "./format";
import { cleanJpeg } from "./jpeg";
import { cleanPng } from "./png";
import { assertInputSize } from "./limits";

export { crc32 } from "./bytes";
export { detectImageFormat, extensionForFormat } from "./format";
export type { SupportedFormat } from "./format";
export type { CleanResult, Finding, PreservedItem } from "../types";
export { MAX_INPUT_BYTES, assertInputSize } from "./limits";

const PIXEL_WATERMARK_NOTICE =
  "Las marcas de agua invisibles a nivel de píxel (p. ej. Google SynthID) no son metadatos y no se eliminan, porque hacerlo degradaría la imagen.";

export function cleanBytes(bytes: Uint8Array): CleanResult {
  assertInputSize(bytes.length);
  const format = detectImageFormat(bytes);
  if (!format) throw new Error("Formato no soportado. Usa JPEG o PNG.");
  const result = format === "jpeg" ? cleanJpeg(bytes) : cleanPng(bytes);
  if (result.isAi) result.notices.push(PIXEL_WATERMARK_NOTICE);
  return result;
}

export async function cleanImage(file: File): Promise<CleanResult> {
  assertInputSize(file.size);
  return cleanBytes(new Uint8Array(await file.arrayBuffer()));
}
