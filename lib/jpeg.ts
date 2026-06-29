import type { CleanResult, Finding, PreservedItem } from "./types";
import { scanForAi, hasAi } from "./signatures";
import {
  concat,
  decodeLoose,
  readUint16BE,
  startsWithAscii,
  snippet,
} from "./bytes";

/* ──────────────────────────────────────────────────────────────────────────
 * Limpieza de JPEG a nivel de bytes.
 *
 * Estrategia: recorremos los segmentos APPn / COM ANTES del scan (SOS). Todo
 * lo demás (DQT, DHT, SOFn, SOS y los datos entrópicos = los píxeles) se copia
 * tal cual: NO se decodifica ni se recomprime → cero pérdida de calidad.
 *
 * Se eliminan/limpian solo los rastros de IA:
 *   · APP11  → contenedor JUMBF de C2PA (siempre, ahí solo vive C2PA).
 *   · APP1   → XMP con firmas de IA/procedencia (se descarta el paquete entero).
 *   · APP1   → EXIF: se ponen a cero SOLO los valores de los tags con firmas
 *              de IA (Software, ImageDescription, MakerNote, …) conservando
 *              Orientation, XResolution/YResolution y ColorSpace.
 *   · APP13  → IPTC/Photoshop con firmas de IA.
 *   · APPn/COM genéricos → solo si contienen firmas de IA.
 *
 * Se preserva siempre: APP0 (JFIF/DPI), APP2 (ICC), APP14 (Adobe color),
 * y EXIF Orientation/Resolution/ColorSpace.
 * ────────────────────────────────────────────────────────────────────────── */

let uid = 0;
const nextId = () => `f${++uid}`;

const STANDALONE = new Set([0x01, 0xd8, 0xd9, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

// Tipos TIFF → tamaño en bytes.
const TIFF_TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

// Tags EXIF que NUNCA tocamos (relevantes para calidad/visualización).
const KEEP_TAGS = new Set([
  0x0112, // Orientation
  0x011a, // XResolution
  0x011b, // YResolution
  0x0128, // ResolutionUnit
  0xa001, // ColorSpace
  0x0213, // YCbCrPositioning
  0xa002, // PixelXDimension
  0xa003, // PixelYDimension
]);

// Tags EXIF candidatos a contener firmas de IA (los inspeccionamos).
const SUSPECT_TAGS = new Set([
  0x010e, // ImageDescription
  0x010f, // Make
  0x0110, // Model
  0x0131, // Software
  0x013b, // Artist
  0x8298, // Copyright
  0x9c9b, // XPTitle
  0x9c9c, // XPComment
  0x9c9d, // XPAuthor
  0x9c9e, // XPKeywords
  0x9c9f, // XPSubject
  0x9286, // UserComment
  0x927c, // MakerNote
  0xa420, // ImageUniqueID
  0xa433, // LensMake
  0xa434, // LensModel
]);

const TAG_NAMES: Record<number, string> = {
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

interface ExifClean {
  /** Copia (mutable) del segmento APP1 ya con los valores de IA puestos a cero. */
  segment: Uint8Array;
  findings: Finding[];
  /** Si no se pudo parsear pero había IA en bruto → conviene descartar el EXIF. */
  dropInstead: boolean;
}

/** Limpia un segmento EXIF poniendo a cero solo los valores de tags con IA. */
function cleanExifSegment(seg: Uint8Array): ExifClean {
  const findings: Finding[] = [];
  // Trabajamos sobre una copia mutable.
  const out = seg.slice();
  const tiff = 10; // 4 (marcador+longitud) + 6 ("Exif\0\0")

  if (out.length < tiff + 8) {
    // EXIF truncado/raro: si hay IA en bruto, descartar.
    const raw = decodeLoose(out, 4);
    return { segment: out, findings, dropInstead: hasAi(raw) };
  }

  const bo = String.fromCharCode(out[tiff], out[tiff + 1]);
  const little = bo === "II";
  if (!little && bo !== "MM") {
    const raw = decodeLoose(out, 4);
    return { segment: out, findings, dropInstead: hasAi(raw) };
  }

  const r16 = (i: number) =>
    little ? out[i] | (out[i + 1] << 8) : (out[i] << 8) | out[i + 1];
  const r32 = (i: number) =>
    little
      ? (out[i] | (out[i + 1] << 8) | (out[i + 2] << 16) | (out[i + 3] << 24)) >>> 0
      : ((out[i] << 24) | (out[i + 1] << 16) | (out[i + 2] << 8) | out[i + 3]) >>> 0;

  let matchedAny = false;

  const parseIfd = (ifdAbs: number, depth: number) => {
    if (depth > 4 || ifdAbs < tiff || ifdAbs + 2 > out.length) return;
    const count = r16(ifdAbs);
    const entriesEnd = ifdAbs + 2 + count * 12;
    if (entriesEnd > out.length) return;

    for (let e = 0; e < count; e++) {
      const base = ifdAbs + 2 + e * 12;
      const tag = r16(base);
      const type = r16(base + 2);
      const num = r32(base + 4);
      const size = TIFF_TYPE_SIZE[type] ?? 1;
      const byteLen = num * size;
      const inline = byteLen <= 4;
      const valueAbs = inline ? base + 8 : tiff + r32(base + 8);

      // Sub-IFD de EXIF (0x8769) y GPS (0x8825): seguir solo el de EXIF.
      if (tag === 0x8769) {
        parseIfd(tiff + r32(base + 8), depth + 1);
        continue;
      }
      if (tag === 0x8825) continue; // GPS: se deja intacto (no es rastro de IA)
      if (KEEP_TAGS.has(tag)) continue;
      if (!SUSPECT_TAGS.has(tag)) continue;
      if (valueAbs < tiff || valueAbs + byteLen > out.length) continue;

      const text = decodeLoose(out, valueAbs, valueAbs + byteLen);
      const hits = scanForAi(text);
      if (hits.length === 0) continue;

      // Poner a cero el valor del tag (estructura/offsets intactos).
      for (let i = valueAbs; i < valueAbs + byteLen; i++) out[i] = 0;
      matchedAny = true;

      const name = TAG_NAMES[tag] ?? `0x${tag.toString(16)}`;
      findings.push({
        id: nextId(),
        category: hits[0].category,
        label: hits[0].label,
        source: `EXIF · ${name}`,
        detail: snippet(text, 80),
        bytes: byteLen,
        removed: true,
      });
    }
  };

  try {
    parseIfd(tiff + r32(tiff + 4), 0);
  } catch {
    const raw = decodeLoose(out, 4);
    return { segment: out, findings, dropInstead: hasAi(raw) };
  }

  // Si el parser no encontró nada pero el blob crudo sí tiene IA (p. ej. dentro
  // de un MakerNote propietario con estructura rara), mejor descartar el EXIF.
  if (!matchedAny && hasAi(decodeLoose(out, 4))) {
    return { segment: out, findings, dropInstead: true };
  }

  return { segment: out, findings, dropInstead: false };
}

export function cleanJpeg(bytes: Uint8Array, originalSize: number): CleanResult {
  uid = 0;
  const findings: Finding[] = [];
  const preserved: PreservedItem[] = [];
  const notices: string[] = [];
  const parts: Uint8Array[] = [];

  // SOI
  parts.push(bytes.subarray(0, 2));
  let pos = 2;
  let iccBytes = 0;
  let dims: { w: number; h: number } | null = null;
  let dpi: number | null = null;
  let hasOrientation = false;
  let hasExifKept = false;

  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) break; // estructura corrupta: cortamos
    const marker = bytes[pos + 1];

    if (marker === 0xda) {
      // SOS: el resto del archivo (cabecera + datos entrópicos + EOI) se copia tal cual.
      parts.push(bytes.subarray(pos));
      pos = bytes.length;
      break;
    }

    if (STANDALONE.has(marker)) {
      parts.push(bytes.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }

    if (pos + 4 > bytes.length) break;
    const segLen = readUint16BE(bytes, pos + 2);
    const segEnd = pos + 2 + segLen;
    if (segEnd > bytes.length) break;

    const seg = bytes.subarray(pos, segEnd);
    const payloadStart = 4; // dentro de `seg`
    let keep = true;

    if (marker === 0xe0) {
      // APP0 / JFIF → resolución (DPI). Conservar.
      if (startsWithAscii(seg, "JFIF\0", payloadStart) && seg.length >= payloadStart + 9) {
        const unit = seg[payloadStart + 7];
        const xden = readUint16BE(seg, payloadStart + 8);
        if (unit === 1 && xden > 0) dpi = xden; // ppp
      }
    } else if (marker === 0xe1) {
      // APP1 → EXIF o XMP.
      if (startsWithAscii(seg, "Exif\0\0", payloadStart)) {
        const res = cleanExifSegment(seg);
        if (res.dropInstead) {
          keep = false;
          findings.push({
            id: nextId(),
            category: "Generador de IA",
            label: "Bloque EXIF con rastros de IA",
            source: "JPEG · APP1 (EXIF)",
            detail: "Estructura no editable de forma segura — segmento eliminado.",
            bytes: seg.length,
            removed: true,
          });
        } else {
          for (const f of res.findings) findings.push(f);
          parts.push(res.segment); // EXIF saneado (orientación/DPI/ICC intactos)
          hasExifKept = true;
          hasOrientation = detectOrientation(res.segment);
          keep = false; // ya lo añadimos manualmente
        }
      } else if (
        startsWithAscii(seg, "http://ns.adobe.com/xap/1.0/\0", payloadStart) ||
        startsWithAscii(seg, "http://ns.adobe.com/xmp/extension/\0", payloadStart)
      ) {
        const xmp = decodeLoose(seg, payloadStart);
        const hits = scanForAi(xmp);
        if (hits.length > 0) {
          keep = false;
          for (const h of hits) {
            findings.push({
              id: nextId(),
              category: h.category,
              label: h.label,
              source: "JPEG · APP1 (XMP)",
              detail: snippet(h.match, 60),
              bytes: seg.length,
              removed: true,
            });
          }
        }
      }
    } else if (marker === 0xe2) {
      // APP2 → ICC profile o MPF. Conservar (color).
      if (startsWithAscii(seg, "ICC_PROFILE\0", payloadStart)) {
        iccBytes += seg.length - payloadStart - 14; // descuenta cabecera ICC_PROFILE + idx/total
      }
    } else if (marker === 0xeb) {
      // APP11 → JUMBF (C2PA / Content Credentials). Eliminar siempre.
      keep = false;
      findings.push({
        id: nextId(),
        category: "C2PA / Content Credentials",
        label: "Manifiesto C2PA (JUMBF)",
        source: "JPEG · APP11",
        detail: "Credencial de contenido firmada (procedencia de IA).",
        bytes: seg.length,
        removed: true,
      });
    } else if (marker === 0xed) {
      // APP13 → IPTC / Photoshop 8BIM.
      const txt = decodeLoose(seg, payloadStart);
      const hits = scanForAi(txt);
      if (hits.length > 0) {
        keep = false;
        findings.push({
          id: nextId(),
          category: hits[0].category,
          label: hits[0].label,
          source: "JPEG · APP13 (IPTC)",
          detail: snippet(hits[0].match, 60),
          bytes: seg.length,
          removed: true,
        });
      }
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
      // SOFn → dimensiones (no se modifica).
      if (seg.length >= payloadStart + 5) {
        const h = readUint16BE(seg, payloadStart + 1);
        const w = readUint16BE(seg, payloadStart + 3);
        dims = { w, h };
      }
    } else if (marker >= 0xe3 && marker <= 0xef && marker !== 0xee) {
      // Otros APPn (excepto APP14/Adobe que conservamos): eliminar solo si hay IA.
      const txt = decodeLoose(seg, payloadStart);
      const hits = scanForAi(txt);
      if (hits.length > 0) {
        keep = false;
        findings.push({
          id: nextId(),
          category: hits[0].category,
          label: hits[0].label,
          source: `JPEG · APP${marker - 0xe0}`,
          detail: snippet(hits[0].match, 60),
          bytes: seg.length,
          removed: true,
        });
      }
    } else if (marker === 0xfe) {
      // COM (comentario): eliminar solo si hay IA.
      const txt = decodeLoose(seg, payloadStart);
      const hits = scanForAi(txt);
      if (hits.length > 0) {
        keep = false;
        findings.push({
          id: nextId(),
          category: hits[0].category,
          label: hits[0].label,
          source: "JPEG · COM",
          detail: snippet(hits[0].match, 60),
          bytes: seg.length,
          removed: true,
        });
      }
    }

    if (keep) parts.push(seg);
    pos = segEnd;
  }

  const cleaned = concat(parts);

  // ── Datos preservados ─────────────────────────────────────────────────────
  if (iccBytes > 0) {
    preserved.push({
      icon: "color",
      label: "Perfil de color ICC",
      detail: `Intacto (${formatBytes(iccBytes)}) · color fiel en redes`,
    });
  } else {
    preserved.push({
      icon: "color",
      label: "Perfil de color",
      detail: "Sin ICC incrustado (se asumirá sRGB) — sin cambios",
    });
  }
  if (dims) {
    preserved.push({
      icon: "dimensions",
      label: "Dimensiones originales",
      detail: `${dims.w} × ${dims.h}px · sin reescalar`,
    });
  }
  preserved.push({
    icon: "resolution",
    label: "Resolución",
    detail: dpi ? `${dpi} ppp · conservada` : "Densidad original conservada",
  });
  if (hasExifKept) {
    preserved.push({
      icon: "orientation",
      label: "Orientación EXIF",
      detail: hasOrientation
        ? "Conservada — la imagen no rotará"
        : "Bloque EXIF útil conservado",
    });
  }
  preserved.push({
    icon: "pixels",
    label: "Píxeles sin recomprimir",
    detail: "Mismos DQT/DHT/SOS — calidad idéntica al original",
  });

  return {
    format: "jpeg",
    mime: "image/jpeg",
    cleaned,
    originalSize,
    cleanedSize: cleaned.length,
    findings,
    preserved,
    isAi: findings.length > 0,
    notices,
  };
}

/** Detecta si el EXIF saneado conserva un tag Orientation con valor != 0. */
function detectOrientation(seg: Uint8Array): boolean {
  const tiff = 10;
  if (seg.length < tiff + 8) return false;
  const bo = String.fromCharCode(seg[tiff], seg[tiff + 1]);
  const little = bo === "II";
  if (!little && bo !== "MM") return false;
  const r16 = (i: number) =>
    little ? seg[i] | (seg[i + 1] << 8) : (seg[i] << 8) | seg[i + 1];
  const r32 = (i: number) =>
    little
      ? (seg[i] | (seg[i + 1] << 8) | (seg[i + 2] << 16) | (seg[i + 3] << 24)) >>> 0
      : ((seg[i] << 24) | (seg[i + 1] << 16) | (seg[i + 2] << 8) | seg[i + 3]) >>> 0;
  try {
    const ifd = tiff + r32(tiff + 4);
    const count = r16(ifd);
    for (let e = 0; e < count; e++) {
      const base = ifd + 2 + e * 12;
      if (r16(base) === 0x0112) return r16(base + 8) !== 0;
    }
  } catch {
    return false;
  }
  return false;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
