/** Shared checked binary primitives for metadata parsers. */

export function assertRange(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0
  ) {
    throw new Error(`${label}: rango inválido.`);
  }
  if (offset > bytes.length || length > bytes.length - offset) {
    throw new Error(`${label}: archivo truncado.`);
  }
}

export function checkedSlice(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): Uint8Array {
  assertRange(bytes, offset, length, label);
  return bytes.slice(offset, offset + length);
}

export function checkedView(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): Uint8Array {
  assertRange(bytes, offset, length, label);
  return bytes.subarray(offset, offset + length);
}

export function readUint8(bytes: Uint8Array, offset: number, label: string): number {
  assertRange(bytes, offset, 1, label);
  return bytes[offset];
}

export function readUint16BE(bytes: Uint8Array, offset: number, label: string): number {
  assertRange(bytes, offset, 2, label);
  return (bytes[offset] << 8) | bytes[offset + 1];
}

export function readUint32BE(bytes: Uint8Array, offset: number, label: string): number {
  assertRange(bytes, offset, 4, label);
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

export function readUint16(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
  label: string,
): number {
  assertRange(bytes, offset, 2, label);
  return littleEndian
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];
}

export function readUint32(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
  label: string,
): number {
  assertRange(bytes, offset, 4, label);
  return littleEndian
    ? (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>>
        0
    : ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
        0;
}

export function readAscii(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): string {
  assertRange(bytes, offset, length, label);
  let result = "";
  for (let index = offset; index < offset + length; index += 1) {
    result += String.fromCharCode(bytes[index]);
  }
  return result;
}

export function startsWithAscii(
  bytes: Uint8Array,
  signature: string,
  offset = 0,
): boolean {
  if (offset < 0 || offset + signature.length > bytes.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature.charCodeAt(index)) return false;
  }
  return true;
}

export function decodeLatin1(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): string {
  assertRange(bytes, offset, length, label);
  let result = "";
  for (let index = offset; index < offset + length; index += 1) {
    const value = bytes[index];
    if (value !== 0) result += String.fromCharCode(value);
  }
  return result;
}

export function concatBytes(parts: readonly Uint8Array[], label = "Datos binarios"): Uint8Array {
  let total = 0;
  for (const part of parts) {
    if (part.length > Number.MAX_SAFE_INTEGER - total) {
      throw new Error(`${label}: tamaño inválido.`);
    }
    total += part.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function byteArraysEqual(
  left: readonly Uint8Array[],
  right: readonly Uint8Array[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => bytesEqual(value, right[index]))
  );
}

export function snippet(text: string, maximum = 90): string {
  const clean = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > maximum ? `${clean.slice(0, maximum - 1)}…` : clean;
}

let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current >>> 1) ^ (current & 1 ? 0xedb88320 : 0);
    }
    crcTable[value] = current >>> 0;
  }
  return crcTable;
}

export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

export function payloadFingerprint(parts: readonly Uint8Array[]): string {
  const payload = concatBytes(parts, "Payload de píxeles");
  return `crc32:${crc32(payload).toString(16).padStart(8, "0")}:${payload.length}`;
}

