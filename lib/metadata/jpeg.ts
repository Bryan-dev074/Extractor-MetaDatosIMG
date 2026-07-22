import { scanForAi } from "../signatures";
import type { CleanResult, Finding, PreservedItem } from "../types";
import {
  assertRange,
  byteArraysEqual,
  checkedSlice,
  checkedView,
  concatBytes,
  decodeLatin1,
  payloadFingerprint,
  readAscii,
  readUint16BE,
  readUint32BE,
  readUint8,
  snippet,
  startsWithAscii,
} from "./bytes";
import { cleanExifTiff, inspectExifTiff } from "./exif";

const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);
const STRUCTURAL_CRITICAL_MARKERS = new Set([
  ...SOF_MARKERS,
  0xc4,
  0xcc,
  0xda,
  0xdb,
  0xdc,
  0xdd,
  0xe0,
  0xe2,
  0xee,
]);
const MAX_METADATA_SCAN = 1_048_576;

interface SegmentToken {
  kind: "segment";
  marker: number;
  start: number;
  end: number;
  payloadStart: number;
  payloadEnd: number;
  raw: Uint8Array;
  payload: Uint8Array;
}

interface ScanToken {
  kind: "scan";
  start: number;
  end: number;
  raw: Uint8Array;
}

interface StandaloneToken {
  kind: "standalone" | "eoi";
  marker: number;
  start: number;
  end: number;
  raw: Uint8Array;
}

type JpegToken = SegmentToken | ScanToken | StandaloneToken;

interface ParsedJpeg {
  tokens: JpegToken[];
  scans: Uint8Array[];
  criticalSegments: Uint8Array[];
  exifCritical: Uint8Array[];
  dimensions: { width: number; height: number };
  density: number | null;
  orientation: number | null;
  iccBytes: number;
}

function truncated(): never {
  throw new Error("JPEG truncado.");
}

function jpegRange(bytes: Uint8Array, offset: number, length: number): void {
  try {
    assertRange(bytes, offset, length, "JPEG");
  } catch {
    truncated();
  }
}

function parseJpeg(bytes: Uint8Array): ParsedJpeg {
  jpegRange(bytes, 0, 2);
  if (readUint8(bytes, 0, "JPEG") !== 0xff || readUint8(bytes, 1, "JPEG") !== 0xd8) {
    throw new Error("JPEG inválido: falta SOI.");
  }

  const tokens: JpegToken[] = [];
  const scans: Uint8Array[] = [];
  const criticalSegments: Uint8Array[] = [];
  const exifCritical: Uint8Array[] = [];
  const iccParts: Array<{ sequence: number; total: number; bytes: number }> = [];
  let dimensions: { width: number; height: number } | null = null;
  let density: number | null = null;
  let orientation: number | null = null;
  let offset = 2;
  let sawSof = false;
  let sawSos = false;
  let sawEoi = false;

  while (offset < bytes.length) {
    jpegRange(bytes, offset, 2);
    if (readUint8(bytes, offset, "JPEG") !== 0xff) {
      throw new Error("Estructura JPEG inválida: se esperaba un marcador.");
    }
    const markerStart = offset;
    let codeOffset = offset + 1;
    while (true) {
      jpegRange(bytes, codeOffset, 1);
      if (readUint8(bytes, codeOffset, "JPEG") !== 0xff) break;
      codeOffset += 1;
    }
    const marker = readUint8(bytes, codeOffset, "JPEG");
    if (marker === 0x00) throw new Error("Estructura JPEG inválida: marcador nulo fuera del scan.");
    const markerEnd = codeOffset + 1;

    if (marker === 0xd8) throw new Error("Estructura JPEG inválida: SOI duplicado.");
    if (marker === 0xd9) {
      if (!sawSos) throw new Error("JPEG sin datos de imagen.");
      if (markerEnd !== bytes.length) {
        throw new Error("Estructura JPEG inválida: bytes después de EOI.");
      }
      tokens.push({
        kind: "eoi",
        marker,
        start: markerStart,
        end: markerEnd,
        raw: checkedSlice(bytes, markerStart, markerEnd - markerStart, "JPEG"),
      });
      sawEoi = true;
      offset = markerEnd;
      break;
    }

    if (STANDALONE.has(marker)) {
      if (marker >= 0xd0 && marker <= 0xd7) {
        throw new Error("Estructura JPEG inválida: reinicio fuera del scan.");
      }
      tokens.push({
        kind: "standalone",
        marker,
        start: markerStart,
        end: markerEnd,
        raw: checkedSlice(bytes, markerStart, markerEnd - markerStart, "JPEG"),
      });
      offset = markerEnd;
      continue;
    }

    jpegRange(bytes, markerEnd, 2);
    const segmentLength = readUint16BE(bytes, markerEnd, "JPEG");
    if (segmentLength < 2) throw new Error("Longitud JPEG inválida.");
    const segmentEnd = markerEnd + segmentLength;
    jpegRange(bytes, markerEnd, segmentLength);
    const payloadStart = markerEnd + 2;
    const payloadEnd = segmentEnd;
    const token: SegmentToken = {
      kind: "segment",
      marker,
      start: markerStart,
      end: segmentEnd,
      payloadStart,
      payloadEnd,
      raw: checkedSlice(bytes, markerStart, segmentEnd - markerStart, "JPEG"),
      payload: checkedView(bytes, payloadStart, payloadEnd - payloadStart, "JPEG"),
    };
    tokens.push(token);

    if (SOF_MARKERS.has(marker)) {
      if (sawSof || sawSos) throw new Error("Orden de marcadores JPEG inválido.");
      if (segmentLength < 11) throw new Error("Cabecera SOF JPEG inválida.");
      const componentCount = readUint8(bytes, payloadStart + 5, "JPEG");
      if (componentCount === 0 || segmentLength !== 8 + componentCount * 3) {
        throw new Error("Cabecera SOF JPEG inválida.");
      }
      const height = readUint16BE(bytes, payloadStart + 1, "JPEG");
      const width = readUint16BE(bytes, payloadStart + 3, "JPEG");
      if (width === 0 || height === 0) throw new Error("Dimensiones JPEG inválidas.");
      dimensions = { width, height };
      sawSof = true;
    }

    if (marker === 0xe0 && startsWithAscii(token.payload, "JFIF\0")) {
      if (token.payload.length < 12) throw new Error("APP0 JFIF JPEG truncado.");
      const unit = readUint8(token.payload, 7, "JPEG JFIF");
      const horizontal = readUint16BE(token.payload, 8, "JPEG JFIF");
      if ((unit === 1 || unit === 2) && horizontal > 0) density = horizontal;
    }

    if (marker === 0xe1 && startsWithAscii(token.payload, "Exif\0\0")) {
      const tiff = checkedView(token.payload, 6, token.payload.length - 6, "JPEG EXIF");
      const inspected = inspectExifTiff(tiff);
      exifCritical.push(...inspected.critical);
      if (inspected.orientation !== null) orientation = inspected.orientation;
    }

    if (marker === 0xe2 && startsWithAscii(token.payload, "ICC_PROFILE\0")) {
      if (token.payload.length < 14) throw new Error("Secuencia ICC JPEG inválida.");
      const sequence = readUint8(token.payload, 12, "JPEG ICC");
      const total = readUint8(token.payload, 13, "JPEG ICC");
      if (sequence === 0 || total === 0 || sequence > total) {
        throw new Error("Secuencia ICC JPEG inválida.");
      }
      iccParts.push({ sequence, total, bytes: token.payload.length - 14 });
    }

    if (STRUCTURAL_CRITICAL_MARKERS.has(marker)) criticalSegments.push(token.raw);

    if (marker !== 0xda) {
      offset = segmentEnd;
      continue;
    }

    if (!sawSof) throw new Error("Orden de marcadores JPEG inválido: SOS antes de SOF.");
    const componentCount = readUint8(bytes, payloadStart, "JPEG SOS");
    if (componentCount === 0 || segmentLength !== 6 + componentCount * 2) {
      throw new Error("Cabecera SOS JPEG inválida.");
    }
    sawSos = true;
    let cursor = segmentEnd;
    while (true) {
      jpegRange(bytes, cursor, 1);
      if (readUint8(bytes, cursor, "JPEG") !== 0xff) {
        cursor += 1;
        continue;
      }
      const prefix = cursor;
      let next = cursor + 1;
      while (true) {
        jpegRange(bytes, next, 1);
        if (readUint8(bytes, next, "JPEG") !== 0xff) break;
        next += 1;
      }
      const nextMarker = readUint8(bytes, next, "JPEG");
      if (nextMarker === 0x00 || (nextMarker >= 0xd0 && nextMarker <= 0xd7)) {
        cursor = next + 1;
        continue;
      }
      const scan = checkedSlice(bytes, segmentEnd, prefix - segmentEnd, "JPEG scan");
      scans.push(scan);
      tokens.push({ kind: "scan", start: segmentEnd, end: prefix, raw: scan });
      offset = prefix;
      break;
    }
  }

  if (!sawEoi) truncated();
  if (!sawSof || !sawSos || scans.length === 0) throw new Error("JPEG sin datos de imagen.");

  if (iccParts.length > 0) {
    const total = iccParts[0].total;
    const seen = new Set<number>();
    if (iccParts.some((part) => part.total !== total) || iccParts.length !== total) {
      throw new Error("Secuencia ICC JPEG inválida.");
    }
    for (const part of iccParts) {
      if (seen.has(part.sequence)) throw new Error("Secuencia ICC JPEG inválida.");
      seen.add(part.sequence);
    }
    for (let sequence = 1; sequence <= total; sequence += 1) {
      if (!seen.has(sequence)) throw new Error("Secuencia ICC JPEG inválida.");
    }
  }

  return {
    tokens,
    scans,
    criticalSegments,
    exifCritical,
    dimensions: dimensions!,
    density,
    orientation,
    iccBytes: iccParts.reduce((total, part) => total + part.bytes, 0),
  };
}

function hasCompleteJumbfBox(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  let size = readUint32BE(bytes, 0, "JPEG JUMBF");
  const type = readAscii(bytes, 4, 4, "JPEG JUMBF");
  let header = 8;
  if (size === 1) {
    if (bytes.length < 16) return false;
    const high = readUint32BE(bytes, 8, "JPEG JUMBF");
    const low = readUint32BE(bytes, 12, "JPEG JUMBF");
    if (high !== 0) return false;
    size = low;
    header = 16;
  } else if (size === 0) {
    size = bytes.length;
  }
  return type === "jumb" && size >= header && size <= bytes.length;
}

interface JumbfGroup {
  indices: number[];
  payload: Uint8Array;
}

function classifyJumbf(tokens: readonly JpegToken[]): JumbfGroup[] {
  const direct: JumbfGroup[] = [];
  const fragments = new Map<number, Array<{ index: number; sequence: number; data: Uint8Array }>>();
  tokens.forEach((token, index) => {
    if (token.kind !== "segment" || token.marker !== 0xeb) return;
    if (hasCompleteJumbfBox(token.payload)) {
      direct.push({ indices: [index], payload: token.payload });
      return;
    }
    if (token.payload.length < 8 || !startsWithAscii(token.payload, "JP")) return;
    const instance = readUint16BE(token.payload, 2, "JPEG JUMBF");
    const sequence = readUint32BE(token.payload, 4, "JPEG JUMBF");
    const list = fragments.get(instance) ?? [];
    list.push({
      index,
      sequence,
      data: checkedSlice(token.payload, 8, token.payload.length - 8, "JPEG JUMBF"),
    });
    fragments.set(instance, list);
  });

  for (const parts of fragments.values()) {
    parts.sort((left, right) => left.sequence - right.sequence);
    if (parts.length === 0 || (parts[0].sequence !== 0 && parts[0].sequence !== 1)) continue;
    const first = parts[0].sequence;
    if (parts.some((part, index) => part.sequence !== first + index)) continue;
    const payload = concatBytes(parts.map((part) => part.data), "JPEG JUMBF");
    if (hasCompleteJumbfBox(payload)) {
      direct.push({ indices: parts.map((part) => part.index), payload });
    }
  }
  return direct;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function cleanJpeg(bytes: Uint8Array): CleanResult {
  const source = parseJpeg(bytes);
  const findings: Finding[] = [];
  const preserved: PreservedItem[] = [];
  const pieces: Uint8Array[] = [checkedSlice(bytes, 0, 2, "JPEG")];
  let findingId = 0;
  const nextId = () => `j${++findingId}`;
  const jumbfGroups = classifyJumbf(source.tokens);
  const removedJumbfIndices = new Set(jumbfGroups.flatMap((group) => group.indices));

  for (const group of jumbfGroups) {
    findings.push({
      id: nextId(),
      category: "C2PA / Content Credentials",
      label: "Manifiesto C2PA (JUMBF)",
      source: "JPEG · APP11 (JUMBF)",
      detail: "Contenedor JUMBF identificado estructuralmente.",
      bytes: group.indices.reduce((total, index) => total + source.tokens[index].raw.length, 0),
      removed: true,
    });
    const scanLength = Math.min(group.payload.length, MAX_METADATA_SCAN);
    const text = decodeLatin1(group.payload, 0, scanLength, "JPEG JUMBF");
    for (const hit of scanForAi(text).filter((candidate) => candidate.category !== "C2PA / Content Credentials")) {
      findings.push({
        id: nextId(),
        category: hit.category,
        label: hit.label,
        source: "JPEG · APP11 (contenido JUMBF)",
        detail: snippet(hit.match),
        removed: true,
      });
    }
  }

  source.tokens.forEach((token, tokenIndex) => {
    if (removedJumbfIndices.has(tokenIndex)) return;
    if (token.kind !== "segment") {
      pieces.push(token.raw);
      return;
    }

    if (token.marker === 0xe1 && startsWithAscii(token.payload, "Exif\0\0")) {
      const tiff = checkedView(token.payload, 6, token.payload.length - 6, "JPEG EXIF");
      const result = cleanExifTiff(tiff);
      if (result.matches.length === 0) {
        pieces.push(token.raw);
        return;
      }
      const rewritten = token.raw.slice();
      rewritten.set(result.cleaned, token.payloadStart - token.start + 6);
      pieces.push(rewritten);
      for (const match of result.matches) {
        findings.push({
          id: nextId(),
          category: match.category,
          label: match.label,
          source: `EXIF · ${match.name}`,
          detail: snippet(match.detail, 80),
          bytes: match.bytes,
          removed: true,
        });
      }
      return;
    }

    let inspectKnownMetadata = false;
    let sourceLabel = "";
    if (
      token.marker === 0xe1 &&
      (startsWithAscii(token.payload, "http://ns.adobe.com/xap/1.0/\0") ||
        startsWithAscii(token.payload, "http://ns.adobe.com/xmp/extension/\0"))
    ) {
      inspectKnownMetadata = true;
      sourceLabel = "JPEG · APP1 (XMP)";
    } else if (token.marker === 0xed && startsWithAscii(token.payload, "Photoshop 3.0\0")) {
      inspectKnownMetadata = true;
      sourceLabel = "JPEG · APP13 (IPTC)";
    } else if (token.marker === 0xfe) {
      inspectKnownMetadata = true;
      sourceLabel = "JPEG · COM";
    }

    if (inspectKnownMetadata) {
      if (token.payload.length > MAX_METADATA_SCAN) {
        throw new Error("Metadatos JPEG exceden el límite seguro.");
      }
      const text = decodeLatin1(token.payload, 0, token.payload.length, "JPEG metadata");
      const hits = scanForAi(text);
      if (hits.length > 0) {
        for (const hit of hits) {
          findings.push({
            id: nextId(),
            category: hit.category,
            label: hit.label,
            source: sourceLabel,
            detail: snippet(hit.match),
            bytes: token.raw.length,
            removed: true,
          });
        }
        return;
      }
    }
    pieces.push(token.raw);
  });

  const cleaned = concatBytes(pieces, "JPEG limpio");
  const verified = parseJpeg(cleaned);
  if (
    !byteArraysEqual(source.scans, verified.scans) ||
    !byteArraysEqual(source.criticalSegments, verified.criticalSegments) ||
    !byteArraysEqual(source.exifCritical, verified.exifCritical) ||
    source.dimensions.width !== verified.dimensions.width ||
    source.dimensions.height !== verified.dimensions.height ||
    source.density !== verified.density ||
    source.orientation !== verified.orientation
  ) {
    throw new Error("La verificación JPEG detectó cambios de calidad.");
  }

  preserved.push(
    source.iccBytes > 0
      ? {
          icon: "color",
          label: "Perfil de color ICC",
          detail: `Multipart intacto (${formatBytes(source.iccBytes)})`,
        }
      : {
          icon: "color",
          label: "Perfil de color",
          detail: "Sin ICC incrustado — sin cambios",
        },
    {
      icon: "dimensions",
      label: "Dimensiones originales",
      detail: `${source.dimensions.width} × ${source.dimensions.height}px · sin reescalar`,
    },
    {
      icon: "resolution",
      label: "Resolución",
      detail: source.density ? `${source.density} · conservada` : "Densidad original conservada",
    },
  );
  if (source.orientation !== null) {
    preserved.push({
      icon: "orientation",
      label: "Orientación EXIF",
      detail: `${source.orientation} · conservada`,
    });
  }
  preserved.push({
    icon: "pixels",
    label: "Píxeles sin recomprimir",
    detail: "Scans, DQT y DHT verificados byte por byte",
  });

  return {
    format: "jpeg",
    mime: "image/jpeg",
    cleaned,
    originalSize: bytes.length,
    cleanedSize: cleaned.length,
    findings,
    preserved,
    isAi: findings.length > 0,
    notices: [],
    pixelPayloadHash: payloadFingerprint(source.scans),
    qualityVerified: true,
    outputExtension: ".jpg",
  };
}

