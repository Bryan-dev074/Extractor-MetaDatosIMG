import {
  assertRange,
  bytesEqual,
  concatBytes,
  crc32,
  readAscii,
  readUint32BE,
} from "../metadata/bytes";

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const encoder = new TextEncoder();
const REMOVED_COLOR_CHUNKS = new Set([
  "iCCP",
  "sRGB",
  "gAMA",
  "cHRM",
  "cICP",
  "mDCV",
  "cLLI",
  "eXIf",
]);
const KNOWN_CRITICAL = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const APNG_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);
const BEFORE_PLTE_AND_IDAT = new Set([
  "cHRM",
  "cICP",
  "gAMA",
  "iCCP",
  "mDCV",
  "cLLI",
  "sBIT",
  "sRGB",
]);
const BEFORE_IDAT = new Set([
  ...BEFORE_PLTE_AND_IDAT,
  "bKGD",
  "eXIf",
  "hIST",
  "pHYs",
  "sPLT",
  "tRNS",
]);
const PRESERVED_SINGLETON_CHUNKS = new Set([
  "bKGD",
  "hIST",
  "pHYs",
  "sBIT",
  "tIME",
  "tRNS",
]);

function uint32(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

export const CANONICAL_CHRM = concatBytes(
  [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000].map(uint32),
  "cHRM canónico",
);
export const CANONICAL_GAMA = uint32(45455);
export const CANONICAL_SRGB = Uint8Array.of(0);

export interface TikTokPngChunk {
  type: string;
  data: Uint8Array;
  raw: Uint8Array;
}

export interface ParsedTikTokPng {
  width: number;
  height: number;
  chunks: TikTokPngChunk[];
  idatPayloads: Uint8Array[];
}

export interface TikTokPngExpectations {
  width?: number;
  height?: number;
  canonical?: boolean;
}

function isAsciiLetter(value: number): boolean {
  return (value >= 65 && value <= 90) || (value >= 97 && value <= 122);
}

function isCritical(type: string): boolean {
  return type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = encoder.encode(type);
  const body = concatBytes([typeBytes, data], `Chunk ${type}`);
  return concatBytes([uint32(data.length), body, uint32(crc32(body))], `Chunk ${type}`);
}

export function parseTikTokPng(
  bytes: Uint8Array,
  expected: TikTokPngExpectations = {},
): ParsedTikTokPng {
  if (!(bytes instanceof Uint8Array) || bytes.length < PNG_SIGNATURE.length) {
    throw new Error("PNG truncado.");
  }
  if (!bytesEqual(bytes.subarray(0, 8), PNG_SIGNATURE)) {
    throw new Error("Firma PNG inválida.");
  }

  const chunks: TikTokPngChunk[] = [];
  const idatPayloads: Uint8Array[] = [];
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let paletteEntries = 0;
  let sawIhdr = false;
  let sawPlte = false;
  let sawIdat = false;
  let leftIdatRun = false;
  let sawIend = false;
  let sawPaletteDependent = false;
  const singletonChunks = new Set<string>();

  while (offset < bytes.length) {
    if (chunks.length >= 100_000) throw new Error("PNG contiene demasiados chunks.");
    assertRange(bytes, offset, 12, "Chunk PNG");
    const length = readUint32BE(bytes, offset, "Longitud PNG");
    if (length > 0x7fffffff) throw new Error("Longitud PNG fuera del límite seguro.");
    const type = readAscii(bytes, offset + 4, 4, "Tipo PNG");
    for (let index = offset + 4; index < offset + 8; index += 1) {
      if (!isAsciiLetter(bytes[index])) throw new Error("Tipo de chunk PNG inválido.");
    }
    if (type.charCodeAt(2) >= 97 && type.charCodeAt(2) <= 122) {
      throw new Error(`Chunk PNG ${type} usa el bit reservado.`);
    }
    if (length > bytes.length - offset - 12) throw new Error("PNG truncado.");
    const end = offset + 12 + length;
    assertRange(bytes, offset, 12 + length, `Chunk PNG ${type}`);
    const data = bytes.slice(offset + 8, offset + 8 + length);
    const expectedCrc = readUint32BE(bytes, offset + 8 + length, `CRC PNG ${type}`);
    const actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (expectedCrc !== actualCrc) throw new Error(`CRC PNG inválido en ${type}.`);

    if (!sawIhdr && type !== "IHDR") throw new Error("IHDR debe ser el primer chunk PNG.");
    if (sawIend) throw new Error("Hay datos después de IEND.");
    if (isCritical(type) && !KNOWN_CRITICAL.has(type)) {
      throw new Error(`Chunk crítico PNG no soportado: ${type}.`);
    }
    if (APNG_CHUNKS.has(type)) {
      throw new Error("APNG animado no es compatible con TikTok Photo Max.");
    }
    if (sawIdat && BEFORE_IDAT.has(type)) {
      throw new Error(`El chunk ${type} debe aparecer antes de IDAT.`);
    }
    if (sawPlte && BEFORE_PLTE_AND_IDAT.has(type)) {
      throw new Error(`El chunk ${type} debe aparecer antes de PLTE.`);
    }
    if (PRESERVED_SINGLETON_CHUNKS.has(type)) {
      if (singletonChunks.has(type)) throw new Error(`Chunk PNG ${type} duplicado.`);
      singletonChunks.add(type);
    }

    if (type === "IHDR") {
      if (sawIhdr) throw new Error("IHDR duplicado.");
      if (length !== 13) throw new Error("IHDR debe tener 13 bytes.");
      width = readUint32BE(data, 0, "Ancho PNG");
      height = readUint32BE(data, 4, "Alto PNG");
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
        throw new Error("Dimensiones PNG inválidas.");
      }
      if (data[8] !== 8) throw new Error("TikTok Photo Max requiere PNG de 8 bits.");
      colorType = data[9];
      if (colorType !== 2 && colorType !== 6) {
        throw new Error("TikTok Photo Max requiere PNG RGB o RGBA.");
      }
      if (data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) {
        throw new Error("Método PNG no soportado.");
      }
      sawIhdr = true;
    } else if (type === "PLTE") {
      if (sawPlte || sawIdat || sawPaletteDependent) {
        throw new Error("Orden PLTE inválido.");
      }
      if (length === 0 || length % 3 !== 0 || length > 768) {
        throw new Error("PLTE inválido.");
      }
      sawPlte = true;
      paletteEntries = length / 3;
    } else if (type === "bKGD") {
      if (length !== 6) throw new Error("bKGD RGB inválido.");
      sawPaletteDependent = true;
    } else if (type === "tRNS") {
      if (colorType === 6) throw new Error("tRNS no es válido para PNG RGBA.");
      if (length !== 6) throw new Error("tRNS RGB inválido.");
      sawPaletteDependent = true;
    } else if (type === "hIST") {
      if (!sawPlte) throw new Error("hIST requiere un PLTE anterior.");
      if (length !== paletteEntries * 2) {
        throw new Error("hIST debe contener una entrada por cada color PLTE.");
      }
      sawPaletteDependent = true;
    } else if (type === "pHYs") {
      if (length !== 9) throw new Error("pHYs inválido.");
    } else if (type === "sBIT") {
      const expectedLength = colorType === 2 ? 3 : 4;
      if (
        length !== expectedLength ||
        data.some((value) => value < 1 || value > 8)
      ) {
        throw new Error("sBIT inválido para el tipo de color PNG.");
      }
    } else if (type === "IDAT") {
      if (leftIdatRun) throw new Error("Los chunks IDAT deben ser contiguos.");
      sawIdat = true;
      idatPayloads.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || !sawIdat) throw new Error("IEND inválido.");
      sawIend = true;
    } else if (sawIdat) {
      leftIdatRun = true;
    }

    chunks.push({ type, data, raw: bytes.slice(offset, end) });
    offset = end;
    if (type === "IEND") break;
  }

  if (!sawIhdr || !sawIdat || !sawIend) throw new Error("PNG incompleto.");
  if (offset !== bytes.length) throw new Error("Hay datos después de IEND.");
  if (expected.width !== undefined && width !== expected.width) {
    throw new Error(`Ancho PNG inesperado: ${width}.`);
  }
  if (expected.height !== undefined && height !== expected.height) {
    throw new Error(`Alto PNG inesperado: ${height}.`);
  }

  if (expected.canonical) {
    const colorTypes = chunks.slice(1, 4).map((chunk) => chunk.type);
    if (colorTypes.join(",") !== "cHRM,gAMA,sRGB") {
      throw new Error("La declaración sRGB canónica debe seguir inmediatamente a IHDR.");
    }
    const expectedData = [CANONICAL_CHRM, CANONICAL_GAMA, CANONICAL_SRGB];
    for (let index = 0; index < 3; index += 1) {
      if (!bytesEqual(chunks[index + 1].data, expectedData[index])) {
        throw new Error(`Declaración ${colorTypes[index]} no canónica.`);
      }
    }
    const counts = new Map<string, number>();
    for (const chunk of chunks) counts.set(chunk.type, (counts.get(chunk.type) ?? 0) + 1);
    for (const type of REMOVED_COLOR_CHUNKS) {
      const expectedCount = type === "cHRM" || type === "gAMA" || type === "sRGB" ? 1 : 0;
      if ((counts.get(type) ?? 0) !== expectedCount) {
        throw new Error(`Declaración de color PNG duplicada o incompatible: ${type}.`);
      }
    }
  }

  return { width, height, chunks, idatPayloads };
}

export function normalizeTikTokPng(
  bytes: Uint8Array,
  expected: { width: number; height: number },
): Uint8Array<ArrayBuffer> {
  const parsed = parseTikTokPng(bytes, expected);
  const parts: Uint8Array[] = [PNG_SIGNATURE, parsed.chunks[0].raw];
  parts.push(
    buildChunk("cHRM", CANONICAL_CHRM),
    buildChunk("gAMA", CANONICAL_GAMA),
    buildChunk("sRGB", CANONICAL_SRGB),
  );
  for (const chunk of parsed.chunks.slice(1)) {
    if (!REMOVED_COLOR_CHUNKS.has(chunk.type)) parts.push(chunk.raw);
  }
  const output = Uint8Array.from(concatBytes(parts, "PNG sRGB"));
  const verified = parseTikTokPng(output, {
    width: expected.width,
    height: expected.height,
    canonical: true,
  });
  if (
    verified.idatPayloads.length !== parsed.idatPayloads.length ||
    !verified.idatPayloads.every((payload, index) =>
      bytesEqual(payload, parsed.idatPayloads[index]),
    )
  ) {
    throw new Error("Los bytes IDAT cambiaron durante la normalización.");
  }
  return output;
}

export function isApng(bytes: Uint8Array): boolean {
  if (bytes.length < 8 || !bytesEqual(bytes.subarray(0, 8), PNG_SIGNATURE)) return false;
  let offset = 8;
  while (offset < bytes.length) {
    assertRange(bytes, offset, 12, "Chunk PNG");
    const length = readUint32BE(bytes, offset, "Longitud PNG");
    if (length > bytes.length - offset - 12) throw new Error("PNG truncado.");
    const type = readAscii(bytes, offset + 4, 4, "Tipo PNG");
    if (APNG_CHUNKS.has(type)) return true;
    offset += length + 12;
    if (type === "IEND") return false;
  }
  throw new Error("PNG incompleto.");
}
