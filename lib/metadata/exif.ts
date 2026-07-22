import { hasAi, scanForAi } from "../signatures";
import type { FindingCategory } from "../types";
import {
  assertRange,
  byteArraysEqual,
  checkedView,
  decodeLatin1,
  readAscii,
  readUint16,
  readUint32,
} from "./bytes";

const TIFF_TYPE_SIZE: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  13: 4,
};

const CRITICAL_TAGS = new Set([
  0x0112,
  0x011a,
  0x011b,
  0x0128,
  0x0213,
  0x829a,
  0x829d,
  0xa001,
  0xa002,
  0xa003,
]);

const SUSPECT_TAGS = new Set([
  0x010e,
  0x010f,
  0x0110,
  0x0131,
  0x013b,
  0x8298,
  0x9c9b,
  0x9c9c,
  0x9c9d,
  0x9c9e,
  0x9c9f,
  0x9286,
  0x927c,
  0xa420,
  0xa433,
  0xa434,
]);

const POINTER_TAGS = new Set([0x8769, 0x8825, 0xa005]);
const INDIRECT_VISUAL_TAGS = new Set([0x0111, 0x0117, 0x0201, 0x0202]);
const MAX_IFD_ENTRIES = 4096;
const MAX_IFD_DEPTH = 16;
const MAX_EXIF_TEXT = 1_048_576;

const TAG_NAMES: Readonly<Record<number, string>> = {
  0x010e: "ImageDescription",
  0x010f: "Make",
  0x0110: "Model",
  0x0131: "Software",
  0x013b: "Artist",
  0x8298: "Copyright",
  0x9c9b: "XPTitle",
  0x9c9c: "XPComment",
  0x9c9d: "XPAuthor",
  0x9c9e: "XPKeywords",
  0x9c9f: "XPSubject",
  0x9286: "UserComment",
  0x927c: "MakerNote",
  0xa420: "ImageUniqueID",
  0xa433: "LensMake",
  0xa434: "LensModel",
};

interface ValueReference {
  tag: number;
  type: number;
  count: number;
  offset: number;
  length: number;
  entryOffset: number;
  critical: boolean;
  suspect: boolean;
}

interface ExifMatch extends ValueReference {
  category: FindingCategory;
  label: string;
  detail: string;
}

interface ParsedExif {
  references: ValueReference[];
  matches: ExifMatch[];
  critical: Uint8Array[];
  orientation: number | null;
}

export interface ExifCleanResult {
  cleaned: Uint8Array;
  matches: Array<{
    tag: number;
    name: string;
    category: FindingCategory;
    label: string;
    detail: string;
    bytes: number;
  }>;
  critical: Uint8Array[];
  orientation: number | null;
}

function unsafe(message: string): never {
  throw new Error(`EXIF no se puede limpiar de forma segura: ${message}.`);
}

function checkedProduct(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) unsafe("longitud de valor inválida");
  return result;
}

function overlaps(left: ValueReference, right: ValueReference): boolean {
  return left.offset < right.offset + right.length && right.offset < left.offset + left.length;
}

function parseExif(tiff: Uint8Array): ParsedExif {
  try {
    assertRange(tiff, 0, 8, "EXIF");
  } catch {
    unsafe("encabezado truncado");
  }
  const byteOrder = readAscii(tiff, 0, 2, "EXIF");
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") unsafe("orden de bytes desconocido");
  if (readUint16(tiff, 2, littleEndian, "EXIF") !== 42) unsafe("cabecera TIFF inválida");

  const references: ValueReference[] = [];
  const matches: ExifMatch[] = [];
  const critical: Uint8Array[] = [];
  const visited = new Set<number>();
  let orientation: number | null = null;
  let hasUncertainFieldType = false;
  const structuralRanges: ValueReference[] = [
    { tag: -1, type: 0, count: 1, offset: 0, length: 8, entryOffset: -1, critical: true, suspect: false },
  ];
  const visualPayloadRanges: ValueReference[] = [];
  critical.push(checkedView(tiff, 0, 8, "EXIF"));

  const readOffsetValue = (reference: ValueReference, index: number): number => {
    const offset = reference.offset + index * 4;
    return readUint32(tiff, offset, littleEndian, "EXIF");
  };

  const readUnsignedValues = (reference: ValueReference, label: string): number[] => {
    if (reference.type !== 3 && reference.type !== 4) unsafe(`${label} usa un tipo inválido`);
    if (reference.count === 0 || reference.count > MAX_IFD_ENTRIES) {
      unsafe(`${label} tiene una cantidad inválida`);
    }
    const values: number[] = [];
    const width = reference.type === 3 ? 2 : 4;
    for (let index = 0; index < reference.count; index += 1) {
      const valueOffset = reference.offset + index * width;
      values.push(
        reference.type === 3
          ? readUint16(tiff, valueOffset, littleEndian, "EXIF")
          : readUint32(tiff, valueOffset, littleEndian, "EXIF"),
      );
    }
    return values;
  };

  const visitIfd = (ifdOffset: number, depth: number): void => {
    if (depth > MAX_IFD_DEPTH) unsafe("cadena IFD demasiado profunda");
    if (ifdOffset === 0) return;
    if (visited.has(ifdOffset)) unsafe("cadena IFD cíclica o aliased");
    visited.add(ifdOffset);

    let entryCount: number;
    try {
      entryCount = readUint16(tiff, ifdOffset, littleEndian, "EXIF");
    } catch {
      unsafe("IFD truncado");
    }
    if (entryCount > MAX_IFD_ENTRIES) unsafe("demasiadas entradas IFD");
    const entriesLength = checkedProduct(entryCount, 12);
    try {
      assertRange(tiff, ifdOffset + 2, entriesLength + 4, "EXIF");
    } catch {
      unsafe("IFD truncado");
    }
    const topologyLength = 2 + entriesLength + 4;
    const topology: ValueReference = {
      tag: -2,
      type: 0,
      count: 1,
      offset: ifdOffset,
      length: topologyLength,
      entryOffset: -2 - structuralRanges.length,
      critical: true,
      suspect: false,
    };
    structuralRanges.push(topology);
    for (const visual of visualPayloadRanges) {
      if (overlaps(topology, visual)) unsafe("un payload visual invade la topología IFD");
    }
    critical.push(checkedView(tiff, ifdOffset, 2, "EXIF"));
    const localReferences: ValueReference[] = [];

    for (let index = 0; index < entryCount; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      const tag = readUint16(tiff, entryOffset, littleEndian, "EXIF");
      const type = readUint16(tiff, entryOffset + 2, littleEndian, "EXIF");
      const count = readUint32(tiff, entryOffset + 4, littleEndian, "EXIF");
      const typeSize = TIFF_TYPE_SIZE[type];
      if (!typeSize) {
        if (
          SUSPECT_TAGS.has(tag) ||
          CRITICAL_TAGS.has(tag) ||
          POINTER_TAGS.has(tag) ||
          INDIRECT_VISUAL_TAGS.has(tag)
        ) {
          unsafe("tipo TIFF desconocido en un campo relevante");
        }
        hasUncertainFieldType = true;
        references.push({
          tag,
          type,
          count,
          offset: entryOffset + 8,
          length: 4,
          entryOffset,
          critical: false,
          suspect: false,
        });
        const possibleOffset = readUint32(tiff, entryOffset + 8, littleEndian, "EXIF");
        if (count > 0 && possibleOffset < tiff.length) {
          references.push({
            tag,
            type,
            count,
            offset: possibleOffset,
            length: Math.min(count, tiff.length - possibleOffset),
            entryOffset,
            critical: false,
            suspect: false,
          });
        }
        critical.push(checkedView(tiff, entryOffset, 12, "EXIF"));
        continue;
      }
      const length = checkedProduct(count, typeSize);
      const offset =
        length <= 4
          ? entryOffset + 8
          : readUint32(tiff, entryOffset + 8, littleEndian, "EXIF");
      try {
        assertRange(tiff, offset, length, "EXIF");
      } catch {
        unsafe("valor IFD truncado");
      }
      const reference: ValueReference = {
        tag,
        type,
        count,
        offset,
        length,
        entryOffset,
        critical: CRITICAL_TAGS.has(tag),
        suspect: SUSPECT_TAGS.has(tag),
      };
      references.push(reference);
      localReferences.push(reference);
      critical.push(checkedView(tiff, entryOffset, 8, "EXIF"));
      if (length > 4) critical.push(checkedView(tiff, entryOffset + 8, 4, "EXIF"));

      if (reference.critical) {
        critical.push(checkedView(tiff, entryOffset, 12, "EXIF"));
        if (length > 4) critical.push(checkedView(tiff, offset, length, "EXIF"));
      }
      if (tag === 0x0112) {
        if (type !== 3 || count !== 1) unsafe("Orientation inválida");
        orientation = readUint16(tiff, offset, littleEndian, "EXIF");
        if (orientation < 1 || orientation > 8) unsafe("Orientation fuera de rango");
      }
      if (reference.suspect && length > 0) {
        if (length > MAX_EXIF_TEXT) unsafe("texto EXIF excede el límite seguro");
        const text = decodeLatin1(tiff, offset, length, "EXIF");
        const hit = scanForAi(text)[0];
        if (hit) {
          matches.push({
            ...reference,
            category: hit.category,
            label: hit.label,
            detail: text,
          });
        }
      }

      if (POINTER_TAGS.has(tag)) {
        if ((type !== 4 && type !== 13) || count !== 1) unsafe("puntero IFD inválido");
        visitIfd(readOffsetValue(reference, 0), depth + 1);
      } else if (tag === 0x014a) {
        if ((type !== 4 && type !== 13) || count > MAX_IFD_ENTRIES) {
          unsafe("SubIFDs inválidos");
        }
        for (let child = 0; child < count; child += 1) {
          visitIfd(readOffsetValue(reference, child), depth + 1);
        }
      }
    }

    const resolvePayloadPairs = (
      offsetTag: number,
      lengthTag: number,
      label: string,
      requireLongSingle: boolean,
    ): void => {
      const offsetEntries = localReferences.filter((reference) => reference.tag === offsetTag);
      const lengthEntries = localReferences.filter((reference) => reference.tag === lengthTag);
      if (offsetEntries.length === 0 && lengthEntries.length === 0) return;
      if (offsetEntries.length !== 1 || lengthEntries.length !== 1) {
        unsafe(`${label} tiene pares incompletos o duplicados`);
      }
      const offsetEntry = offsetEntries[0];
      const lengthEntry = lengthEntries[0];
      if (
        requireLongSingle &&
        (offsetEntry.type !== 4 || lengthEntry.type !== 4 ||
          offsetEntry.count !== 1 || lengthEntry.count !== 1)
      ) {
        unsafe(`${label} tiene tipos o cantidades inválidos`);
      }
      const offsets = readUnsignedValues(offsetEntry, label);
      const lengths = readUnsignedValues(lengthEntry, label);
      if (offsets.length !== lengths.length) unsafe(`${label} tiene cantidades distintas`);
      offsets.forEach((payloadOffset, index) => {
        const payloadLength = lengths[index];
        if (payloadLength === 0) unsafe(`${label} declara un payload vacío`);
        try {
          assertRange(tiff, payloadOffset, payloadLength, "EXIF");
        } catch {
          unsafe(`${label} apunta fuera del bloque TIFF`);
        }
        const payloadRange: ValueReference = {
          tag: offsetTag,
          type: 7,
          count: payloadLength,
          offset: payloadOffset,
          length: payloadLength,
          entryOffset: -1000 - visualPayloadRanges.length,
          critical: true,
          suspect: false,
        };
        for (const structural of structuralRanges) {
          if (overlaps(payloadRange, structural)) unsafe(`${label} invade la topología IFD`);
        }
        for (const existing of visualPayloadRanges) {
          if (overlaps(payloadRange, existing)) unsafe(`${label} tiene payloads superpuestos`);
        }
        visualPayloadRanges.push(payloadRange);
        references.push(payloadRange);
        critical.push(checkedView(tiff, payloadOffset, payloadLength, "EXIF"));
      });
    };

    resolvePayloadPairs(0x0111, 0x0117, "StripOffsets/StripByteCounts", false);
    resolvePayloadPairs(0x0201, 0x0202, "JPEGInterchangeFormat", true);

    const nextOffsetPosition = ifdOffset + 2 + entriesLength;
    critical.push(checkedView(tiff, nextOffsetPosition, 4, "EXIF"));
    const nextOffset = readUint32(tiff, nextOffsetPosition, littleEndian, "EXIF");
    if (nextOffset !== 0) visitIfd(nextOffset, depth + 1);
  };

  const firstIfd = readUint32(tiff, 4, littleEndian, "EXIF");
  visitIfd(firstIfd, 0);

  if (tiff.length <= MAX_EXIF_TEXT) {
    const rawHasAi = hasAi(decodeLatin1(tiff, 0, tiff.length, "EXIF"));
    if (rawHasAi && matches.length === 0) unsafe("rastro de IA en una estructura no editable");
  } else if (matches.length === 0) {
    unsafe("bloque demasiado grande para inspeccionarlo");
  }

  if (matches.length > 0 && hasUncertainFieldType) {
    unsafe("un tipo TIFF desconocido impide probar que la cirugía no tiene alias");
  }

  for (const match of matches) {
    if (match.length > 4) {
      for (const structural of structuralRanges) {
        if (overlaps(match, structural)) unsafe("un valor sospechoso invade la topología IFD");
      }
    }
    for (const reference of references) {
      if (reference.entryOffset === match.entryOffset || reference.length === 0) continue;
      if (overlaps(match, reference)) unsafe("valores IFD superpuestos o aliased");
    }
  }

  return { references, matches, critical, orientation };
}

export function cleanExifTiff(tiff: Uint8Array): ExifCleanResult {
  const source = parseExif(tiff);
  if (source.matches.length === 0) {
    return { cleaned: tiff.slice(), matches: [], critical: source.critical, orientation: source.orientation };
  }

  const cleaned = tiff.slice();
  for (const match of source.matches) cleaned.fill(0, match.offset, match.offset + match.length);
  const reparsed = parseExif(cleaned);
  if (!byteArraysEqual(source.critical, reparsed.critical) || source.orientation !== reparsed.orientation) {
    unsafe("la verificación alteró datos de presentación");
  }

  return {
    cleaned,
    critical: source.critical,
    orientation: source.orientation,
    matches: source.matches.map((match) => ({
      tag: match.tag,
      name: TAG_NAMES[match.tag] ?? `0x${match.tag.toString(16)}`,
      category: match.category,
      label: match.label,
      detail: match.detail,
      bytes: match.length,
    })),
  };
}

export function inspectExifTiff(tiff: Uint8Array): Pick<ExifCleanResult, "critical" | "orientation"> {
  const parsed = parseExif(tiff);
  return { critical: parsed.critical, orientation: parsed.orientation };
}
