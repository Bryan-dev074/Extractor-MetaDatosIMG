/** Utilidades para leer/decodificar buffers binarios sin dependencias. */

/** Decodificación "laxa": cada byte → char y se quitan los NUL. Sirve para
 *  ASCII y para UCS-2/UTF-16 (los tags XP* de EXIF) a la vez, lo justo para
 *  poder buscar firmas de texto. No es una decodificación fiel a Unicode. */
export function decodeLoose(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = "";
  const stop = Math.min(end, bytes.length);
  for (let i = start; i < stop; i++) {
    const c = bytes[i];
    if (c !== 0) out += String.fromCharCode(c);
  }
  return out;
}

/** Decodifica UTF-8 (para texto de chunks PNG iTXt). */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return decodeLoose(bytes);
  }
}

/** ¿`bytes` empieza por la firma ASCII `sig` en la posición `at`? */
export function startsWithAscii(bytes: Uint8Array, sig: string, at = 0): boolean {
  if (at + sig.length > bytes.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[at + i] !== sig.charCodeAt(i)) return false;
  }
  return true;
}

export function readUint16BE(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1];
}

export function readUint32BE(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

/** Concatena varios buffers en uno solo. */
export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Lee 4 chars ASCII como tipo de chunk PNG. */
export function readChunkType(b: Uint8Array, i: number): string {
  return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
}

/** Trunca un fragmento (quitando caracteres de control) para mostrarlo en la UI. */
export function snippet(text: string, max = 90): string {
  let clean = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    clean += code < 0x20 || code === 0x7f ? " " : text[i];
  }
  clean = clean.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}
