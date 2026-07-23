import { crc32 } from "@/lib/metadata/bytes";

const encoder = new TextEncoder();
export const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

type Bytes = Uint8Array<ArrayBufferLike>;

export function concat(...parts: Bytes[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function u32(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

export function chunk(type: string, data: Bytes = new Uint8Array()): Uint8Array<ArrayBuffer> {
  const typeBytes = encoder.encode(type);
  const body = concat(typeBytes, data);
  return concat(u32(data.length), body, u32(crc32(body)));
}

export function png(
  extras: Bytes[] = [],
  idat: Bytes = Uint8Array.of(120, 156, 1, 2, 3),
  colorType = 6,
  width = 3,
  height = 2,
): Uint8Array<ArrayBuffer> {
  return concat(
    PNG_SIGNATURE,
    chunk("IHDR", concat(u32(width), u32(height), Uint8Array.of(8, colorType, 0, 0, 0))),
    ...extras,
    chunk("IDAT", idat),
    chunk("IEND"),
  );
}
