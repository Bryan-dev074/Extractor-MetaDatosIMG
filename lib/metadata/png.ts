import pako from "pako";
import { AI_PNG_TEXT_KEYWORDS, scanForAi } from "../signatures";
import type { CleanResult, Finding, PreservedItem } from "../types";
import {
  assertRange,
  byteArraysEqual,
  checkedSlice,
  checkedView,
  concatBytes,
  crc32,
  decodeLatin1,
  payloadFingerprint,
  readAscii,
  readUint32BE,
  readUint8,
  snippet,
} from "./bytes";
import { cleanExifTiff, inspectExifTiff } from "./exif";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const KNOWN_CRITICAL = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const C2PA_CHUNKS = new Set(["caBX", "caMs", "caSt"]);
const TEXT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt"]);
const COLOR_BEFORE_IDAT = new Set(["cHRM", "gAMA", "iCCP", "sBIT", "sRGB"]);
const VISUAL_CHUNKS = new Set([
  "IHDR",
  "PLTE",
  "tRNS",
  "iCCP",
  "sRGB",
  "gAMA",
  "cHRM",
  "sBIT",
  "pHYs",
  "bKGD",
  "hIST",
  "sPLT",
  "acTL",
  "fcTL",
]);
const KNOWN_ANCILLARY = new Set([
  ...C2PA_CHUNKS,
  ...TEXT_CHUNKS,
  ...VISUAL_CHUNKS,
  "eXIf",
  "tIME",
]);
const MAX_TEXT_BYTES = 1_048_576;
const SINGLETON_CHUNKS = new Set([
  "IHDR",
  "PLTE",
  "IEND",
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "pHYs",
  "tRNS",
  "bKGD",
  "hIST",
  "tIME",
  "eXIf",
  "acTL",
]);

interface ParsedText {
  keyword: string;
  text: string;
}

interface PngChunk {
  type: string;
  start: number;
  end: number;
  dataStart: number;
  dataEnd: number;
  raw: Uint8Array;
  data: Uint8Array;
  text?: ParsedText;
}

interface ParsedPng {
  chunks: PngChunk[];
  pixelPayloads: Uint8Array[];
  visualChunks: Uint8Array[];
  unknownAncillary: Uint8Array[];
  exifCritical: Uint8Array[];
  dimensions: { width: number; height: number; depth: number; colorType: number };
  hasIcc: boolean;
  hasSrgb: boolean;
  density: number | null;
}

function truncated(): never {
  throw new Error("PNG truncado.");
}

function pngRange(bytes: Uint8Array, offset: number, length: number): void {
  try {
    assertRange(bytes, offset, length, "PNG");
  } catch {
    truncated();
  }
}

function findNull(data: Uint8Array, start: number, label: string): number {
  if (start < 0 || start > data.length) throw new Error(`Texto PNG inválido: ${label}.`);
  for (let offset = start; offset < data.length; offset += 1) {
    if (readUint8(data, offset, "Texto PNG") === 0) return offset;
  }
  throw new Error(`Texto PNG inválido: ${label}.`);
}

function validateKeyword(data: Uint8Array, separator: number): string {
  if (separator < 1 || separator > 79) throw new Error("Texto PNG inválido: keyword.");
  return decodeLatin1(data, 0, separator, "Texto PNG");
}

function inflateBounded(compressed: Uint8Array): Uint8Array {
  if (compressed.length > MAX_TEXT_BYTES) {
    throw new Error("Texto PNG excede el límite seguro.");
  }
  const inflater = new pako.Inflate({ chunkSize: 16_384 });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  inflater.onData = (chunk: Uint8Array) => {
    if (chunk.length > MAX_TEXT_BYTES - total) {
      overflow = true;
      throw new Error("Texto PNG excede el límite seguro.");
    }
    total += chunk.length;
    chunks.push(chunk.slice());
  };
  let completed: boolean;
  try {
    completed = inflater.push(compressed, true);
  } catch (error) {
    if (overflow || (error instanceof Error && error.message.includes("límite seguro"))) {
      throw new Error("Texto PNG excede el límite seguro.");
    }
    throw new Error("Texto PNG inválido: datos zlib corruptos.");
  }
  if (overflow) throw new Error("Texto PNG excede el límite seguro.");
  if (!completed || inflater.err !== 0) {
    throw new Error("Texto PNG inválido: datos zlib corruptos.");
  }
  const stream = (
    inflater as typeof inflater & { strm: { next_in: number; avail_in: number } }
  ).strm;
  if (stream.next_in !== compressed.length || stream.avail_in !== 0) {
    throw new Error("Texto PNG inválido: datos después del stream zlib.");
  }
  return concatBytes(chunks, "Texto PNG");
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Texto PNG inválido: UTF-8 inválido.");
  }
}

function parseTextChunk(type: string, data: Uint8Array): ParsedText {
  const separator = findNull(data, 0, "falta separador de keyword");
  const keyword = validateKeyword(data, separator);

  if (type === "tEXt") {
    const length = data.length - separator - 1;
    if (length > MAX_TEXT_BYTES) throw new Error("Texto PNG excede el límite seguro.");
    return { keyword, text: decodeLatin1(data, separator + 1, length, "Texto PNG") };
  }

  if (type === "zTXt") {
    if (separator + 2 > data.length) throw new Error("Texto PNG inválido: zTXt truncado.");
    const method = readUint8(data, separator + 1, "Texto PNG");
    if (method !== 0) throw new Error("Texto PNG inválido: método de compresión.");
    const compressed = checkedView(
      data,
      separator + 2,
      data.length - separator - 2,
      "Texto PNG",
    );
    const inflated = inflateBounded(compressed);
    return { keyword, text: decodeLatin1(inflated, 0, inflated.length, "Texto PNG") };
  }

  if (separator + 3 > data.length) throw new Error("Texto PNG inválido: iTXt truncado.");
  const compressionFlag = readUint8(data, separator + 1, "Texto PNG");
  const method = readUint8(data, separator + 2, "Texto PNG");
  if (compressionFlag !== 0 && compressionFlag !== 1) {
    throw new Error("Texto PNG inválido: bandera de compresión.");
  }
  if (method !== 0) throw new Error("Texto PNG inválido: método de compresión.");
  const languageEnd = findNull(data, separator + 3, "falta separador de idioma");
  const translatedEnd = findNull(data, languageEnd + 1, "falta separador traducido");
  const textBytes = checkedView(
    data,
    translatedEnd + 1,
    data.length - translatedEnd - 1,
    "Texto PNG",
  );
  if (compressionFlag === 1) {
    return { keyword, text: decodeUtf8(inflateBounded(textBytes)) };
  }
  if (textBytes.length > MAX_TEXT_BYTES) throw new Error("Texto PNG excede el límite seguro.");
  return { keyword, text: decodeUtf8(textBytes) };
}

function validBitDepth(colorType: number, depth: number): boolean {
  const allowed: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return allowed[colorType]?.includes(depth) ?? false;
}

function parsePng(bytes: Uint8Array): ParsedPng {
  pngRange(bytes, 0, PNG_SIGNATURE.length);
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (readUint8(bytes, index, "PNG") !== PNG_SIGNATURE[index]) {
      throw new Error("PNG inválido: firma incorrecta.");
    }
  }

  const chunks: PngChunk[] = [];
  const pixelPayloads: Uint8Array[] = [];
  const visualChunks: Uint8Array[] = [];
  const unknownAncillary: Uint8Array[] = [];
  const exifCritical: Uint8Array[] = [];
  let dimensions: ParsedPng["dimensions"] | null = null;
  let hasIcc = false;
  let hasSrgb = false;
  let density: number | null = null;
  let offset = 8;
  let seenIhdr = false;
  let seenPlte = false;
  let paletteEntries = 0;
  let seenIdat = false;
  let idatClosed = false;
  let seenIend = false;
  let seenActl = false;
  let expectedApngSequence = 0;
  let expectedApngFrames = 0;
  let frameControlCount = 0;
  let pendingFrameData = false;
  let activeFrameDataKind: "idat" | "fdat" | null = null;
  const chunkCounts = new Map<string, number>();

  while (offset < bytes.length) {
    pngRange(bytes, offset, 8);
    const length = readUint32BE(bytes, offset, "PNG");
    if (length > 0x7fffffff) throw new Error("PNG fuera del rango de 31 bits: longitud de chunk.");
    const type = readAscii(bytes, offset + 4, 4, "PNG");
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("PNG inválido: tipo de chunk inválido.");
    const reservedCode = type.charCodeAt(2);
    if (reservedCode < 65 || reservedCode > 90) {
      throw new Error("PNG inválido: bit reservado del tipo de chunk.");
    }
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (!Number.isSafeInteger(dataEnd)) throw new Error("PNG inválido: longitud de chunk.");
    pngRange(bytes, dataStart, length + 4);
    const chunkEnd = dataEnd + 4;
    const storedCrc = readUint32BE(bytes, dataEnd, "PNG");
    const crcInput = checkedView(bytes, offset + 4, 4 + length, "PNG");
    if (crc32(crcInput) !== storedCrc) throw new Error(`CRC PNG inválido en ${type}.`);

    const critical = type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
    if (critical && !KNOWN_CRITICAL.has(type)) {
      throw new Error(`Chunk crítico PNG desconocido: ${type}.`);
    }
    const count = (chunkCounts.get(type) ?? 0) + 1;
    chunkCounts.set(type, count);
    if (SINGLETON_CHUNKS.has(type) && count > 1) {
      throw new Error(`PNG inválido: chunk ${type} duplicado.`);
    }
    if (!seenIhdr && type !== "IHDR") throw new Error("Orden PNG inválido: IHDR debe ser primero.");
    if (seenIend) throw new Error("PNG inválido: chunk después de IEND.");
    if (seenIdat && type !== "IDAT") idatClosed = true;
    if (type === "IDAT" && idatClosed) throw new Error("Orden PNG inválido: IDAT no contiguos.");

    const raw = checkedView(bytes, offset, chunkEnd - offset, "PNG");
    const data = checkedView(bytes, dataStart, length, "PNG");
    const chunk: PngChunk = { type, start: offset, end: chunkEnd, dataStart, dataEnd, raw, data };

    if (type === "IHDR") {
      if (seenIhdr || chunks.length !== 0 || length !== 13) {
        throw new Error("IHDR PNG inválido o duplicado.");
      }
      const width = readUint32BE(data, 0, "PNG IHDR");
      const height = readUint32BE(data, 4, "PNG IHDR");
      if (width > 0x7fffffff || height > 0x7fffffff) {
        throw new Error("PNG fuera del rango de 31 bits: dimensiones IHDR.");
      }
      const depth = readUint8(data, 8, "PNG IHDR");
      const colorType = readUint8(data, 9, "PNG IHDR");
      const compression = readUint8(data, 10, "PNG IHDR");
      const filter = readUint8(data, 11, "PNG IHDR");
      const interlace = readUint8(data, 12, "PNG IHDR");
      if (
        width === 0 ||
        height === 0 ||
        !validBitDepth(colorType, depth) ||
        compression !== 0 ||
        filter !== 0 ||
        (interlace !== 0 && interlace !== 1)
      ) {
        throw new Error("IHDR PNG inválido.");
      }
      dimensions = { width, height, depth, colorType };
      seenIhdr = true;
    } else if (type === "PLTE") {
      if (seenPlte || seenIdat || length === 0 || length % 3 !== 0 || length > 768) {
        throw new Error("Orden o longitud PLTE PNG inválida.");
      }
      if (dimensions?.colorType === 0 || dimensions?.colorType === 4) {
        throw new Error("PLTE PNG no permitido para este tipo de color.");
      }
      paletteEntries = length / 3;
      if (dimensions?.colorType === 3 && paletteEntries > 2 ** dimensions.depth) {
        throw new Error("PLTE PNG excede la profundidad de bits.");
      }
      seenPlte = true;
    } else if (type === "IDAT") {
      if (dimensions?.colorType === 3 && !seenPlte) throw new Error("PNG indexado sin PLTE.");
      seenIdat = true;
      if (activeFrameDataKind === "idat") pendingFrameData = false;
      pixelPayloads.push(checkedView(data, 0, data.length, "PNG IDAT"));
    } else if (type === "IEND") {
      if (length !== 0) throw new Error("IEND PNG inválido.");
      if (!seenIdat) throw new Error("PNG sin datos de imagen.");
      if (dimensions?.colorType === 3 && !seenPlte) throw new Error("PNG indexado sin PLTE.");
      seenIend = true;
      if (chunkEnd !== bytes.length) throw new Error("PNG inválido: bytes después de IEND.");
    }

    if (COLOR_BEFORE_IDAT.has(type) && (seenPlte || seenIdat)) {
      throw new Error(`Orden PNG inválido para ${type}.`);
    }
    if ((type === "pHYs" || type === "tRNS" || type === "bKGD" || type === "eXIf") && seenIdat) {
      throw new Error(`Orden PNG inválido para ${type}.`);
    }
    if (type === "hIST" && (!seenPlte || seenIdat)) throw new Error("Orden PNG inválido para hIST.");
    if (type === "gAMA" && (length !== 4 || readUint32BE(data, 0, "PNG gAMA") === 0)) {
      throw new Error("gAMA PNG inválido.");
    }
    if (type === "cHRM" && length !== 32) throw new Error("cHRM PNG inválido.");
    if (type === "tRNS") {
      const colorType = dimensions?.colorType;
      if (colorType === 3 && (!seenPlte || length > paletteEntries)) {
        throw new Error("tRNS PNG inválido para imagen indexada.");
      }
      if ((colorType === 0 && length !== 2) || (colorType === 2 && length !== 6)) {
        throw new Error("tRNS PNG inválido.");
      }
      if (colorType === 4 || colorType === 6) {
        throw new Error("tRNS PNG no permitido con canal alfa.");
      }
    }
    if (type === "iCCP") {
      if (hasIcc || hasSrgb) throw new Error("Perfil de color PNG inválido.");
      hasIcc = true;
    }
    if (type === "sRGB") {
      if (hasSrgb || hasIcc || length !== 1) throw new Error("Perfil sRGB PNG inválido.");
      hasSrgb = true;
    }
    if (type === "pHYs") {
      if (length !== 9) throw new Error("pHYs PNG inválido.");
      const x = readUint32BE(data, 0, "PNG pHYs");
      const unit = readUint8(data, 8, "PNG pHYs");
      if (unit > 1) throw new Error("pHYs PNG inválido.");
      density = unit === 1 ? x : null;
    }

    if (type === "acTL") {
      if (seenActl || seenIdat || length !== 8 || readUint32BE(data, 0, "PNG acTL") === 0) {
        throw new Error("APNG acTL inválido.");
      }
      seenActl = true;
      expectedApngFrames = readUint32BE(data, 0, "PNG acTL");
    } else if (type === "fcTL") {
      if (!seenActl || length !== 26) throw new Error("APNG fcTL inválido.");
      if (pendingFrameData) throw new Error("APNG inválido: frame sin datos.");
      const sequence = readUint32BE(data, 0, "PNG fcTL");
      if (sequence !== expectedApngSequence) throw new Error("Secuencia APNG inválida.");
      expectedApngSequence += 1;
      frameControlCount += 1;
      pendingFrameData = true;
      activeFrameDataKind = seenIdat ? "fdat" : "idat";
      const width = readUint32BE(data, 4, "PNG fcTL");
      const height = readUint32BE(data, 8, "PNG fcTL");
      const x = readUint32BE(data, 12, "PNG fcTL");
      const y = readUint32BE(data, 16, "PNG fcTL");
      if (
        width === 0 ||
        height === 0 ||
        !dimensions ||
        width > dimensions.width - x ||
        height > dimensions.height - y
      ) {
        throw new Error("APNG fcTL fuera de dimensiones.");
      }
      const disposeOperation = readUint8(data, 24, "PNG fcTL");
      const blendOperation = readUint8(data, 25, "PNG fcTL");
      if (disposeOperation > 2 || blendOperation > 1) {
        throw new Error("APNG fcTL contiene operaciones inválidas.");
      }
    } else if (type === "fdAT") {
      if (!seenActl || !seenIdat || length < 4 || activeFrameDataKind !== "fdat") {
        throw new Error("APNG fdAT inválido: falta un fcTL activo.");
      }
      const sequence = readUint32BE(data, 0, "PNG fdAT");
      if (sequence !== expectedApngSequence) throw new Error("Secuencia APNG inválida.");
      expectedApngSequence += 1;
      pendingFrameData = false;
      pixelPayloads.push(checkedView(data, 0, data.length, "PNG fdAT"));
    }

    if (TEXT_CHUNKS.has(type)) chunk.text = parseTextChunk(type, data);
    if (type === "eXIf") {
      const inspected = inspectExifTiff(data);
      exifCritical.push(...inspected.critical);
    }
    if (VISUAL_CHUNKS.has(type)) visualChunks.push(raw);
    if (!critical && !KNOWN_ANCILLARY.has(type)) unknownAncillary.push(raw);

    chunks.push(chunk);
    offset = chunkEnd;
    if (type === "IEND") break;
  }

  if (!seenIend) truncated();
  if (!seenIhdr || !dimensions) throw new Error("PNG inválido: falta IHDR.");
  if (!seenIdat) throw new Error("PNG sin datos de imagen.");
  if (seenActl && frameControlCount !== expectedApngFrames) {
    throw new Error("APNG inválido: cantidad de frames no coincide con acTL.");
  }
  if (pendingFrameData) throw new Error("APNG inválido: frame sin datos.");
  return {
    chunks,
    pixelPayloads,
    visualChunks,
    unknownAncillary,
    exifCritical,
    dimensions,
    hasIcc,
    hasSrgb,
    density,
  };
}

export function cleanPng(bytes: Uint8Array): CleanResult {
  const source = parsePng(bytes);
  const pieces: Uint8Array[] = [checkedSlice(bytes, 0, 8, "PNG")];
  const expectedCopied: Uint8Array[] = [];
  const findings: Finding[] = [];
  const preserved: PreservedItem[] = [];
  let findingId = 0;
  const nextId = () => `p${++findingId}`;

  for (const chunk of source.chunks) {
    if (C2PA_CHUNKS.has(chunk.type)) {
      findings.push({
        id: nextId(),
        category: "C2PA / Content Credentials",
        label: `Manifiesto C2PA (${chunk.type})`,
        source: `PNG · ${chunk.type}`,
        detail: "Estructura de credenciales de contenido.",
        bytes: chunk.raw.length,
        removed: true,
      });
      continue;
    }

    if (chunk.text) {
      const combined = `${chunk.text.keyword}\n${chunk.text.text}`;
      const hits = scanForAi(combined);
      const keywordMatch = AI_PNG_TEXT_KEYWORDS.has(chunk.text.keyword.trim().toLowerCase());
      if (hits.length > 0 || keywordMatch) {
        const hit = hits[0];
        findings.push({
          id: nextId(),
          category: hit?.category ?? "Datos de generación",
          label: hit?.label ?? `Datos de generación (${chunk.text.keyword})`,
          source: `PNG · ${chunk.type} (${chunk.text.keyword})`,
          detail: snippet(chunk.text.text || hit?.match || "Parámetros de generación"),
          bytes: chunk.raw.length,
          removed: true,
        });
        continue;
      }
    }

    if (chunk.type === "eXIf") {
      const result = cleanExifTiff(chunk.data);
      if (result.matches.length > 0) {
        const rewrittenData = result.cleaned;
        const typeBytes = checkedView(chunk.raw, 4, 4, "PNG eXIf");
        const crcInput = concatBytes([typeBytes, rewrittenData], "PNG eXIf");
        const rewritten = chunk.raw.slice();
        rewritten.set(rewrittenData, 8);
        const crc = crc32(crcInput);
        rewritten[rewritten.length - 4] = (crc >>> 24) & 0xff;
        rewritten[rewritten.length - 3] = (crc >>> 16) & 0xff;
        rewritten[rewritten.length - 2] = (crc >>> 8) & 0xff;
        rewritten[rewritten.length - 1] = crc & 0xff;
        pieces.push(rewritten);
        for (const match of result.matches) {
          findings.push({
            id: nextId(),
            category: match.category,
            label: match.label,
            source: `PNG · eXIf · ${match.name}`,
            detail: snippet(match.detail),
            bytes: match.bytes,
            removed: true,
          });
        }
        continue;
      }
    }

    pieces.push(chunk.raw);
    if (chunk.type !== "eXIf") expectedCopied.push(chunk.raw);
  }

  const cleaned = concatBytes(pieces, "PNG limpio");
  const verified = parsePng(cleaned);
  const actualCopied = verified.chunks
    .filter((chunk) => chunk.type !== "eXIf")
    .map((chunk) => chunk.raw);
  if (
    !byteArraysEqual(source.pixelPayloads, verified.pixelPayloads) ||
    !byteArraysEqual(source.visualChunks, verified.visualChunks) ||
    !byteArraysEqual(source.unknownAncillary, verified.unknownAncillary) ||
    !byteArraysEqual(source.exifCritical, verified.exifCritical) ||
    !byteArraysEqual(expectedCopied, actualCopied) ||
    source.dimensions.width !== verified.dimensions.width ||
    source.dimensions.height !== verified.dimensions.height ||
    source.dimensions.depth !== verified.dimensions.depth ||
    source.dimensions.colorType !== verified.dimensions.colorType ||
    source.density !== verified.density
  ) {
    throw new Error("La verificación PNG detectó cambios de calidad.");
  }

  preserved.push(
    source.hasIcc
      ? { icon: "color", label: "Perfil de color ICC (iCCP)", detail: "Intacto" }
      : source.hasSrgb
        ? { icon: "color", label: "Espacio de color sRGB", detail: "Intacto" }
        : { icon: "color", label: "Color", detail: "Sin perfil incrustado — sin cambios" },
    {
      icon: "dimensions",
      label: "Dimensiones originales",
      detail: `${source.dimensions.width} × ${source.dimensions.height}px · ${source.dimensions.depth}-bit`,
    },
    {
      icon: "resolution",
      label: "Resolución",
      detail: source.density ? `${source.density} píxeles/m · conservada` : "Dimensiones de píxel intactas",
    },
    {
      icon: "pixels",
      label: "Píxeles sin recomprimir",
      detail: "IDAT y fdAT verificados byte por byte",
    },
  );

  return {
    format: "png",
    mime: "image/png",
    cleaned,
    originalSize: bytes.length,
    cleanedSize: cleaned.length,
    findings,
    preserved,
    isAi: findings.length > 0,
    notices: [],
    pixelPayloadHash: payloadFingerprint(source.pixelPayloads),
    qualityVerified: true,
    outputExtension: ".png",
  };
}
