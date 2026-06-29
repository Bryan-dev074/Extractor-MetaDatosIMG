import pako from "pako";
import type { CleanResult, Finding, PreservedItem } from "./types";
import { scanForAi, AI_PNG_TEXT_KEYWORDS } from "./signatures";
import {
  concat,
  decodeLoose,
  decodeUtf8,
  readChunkType,
  readUint32BE,
  snippet,
} from "./bytes";

/* ──────────────────────────────────────────────────────────────────────────
 * Limpieza de PNG a nivel de chunks.
 *
 * Se conservan los chunks críticos/de calidad (IHDR, PLTE, IDAT, IEND, iCCP,
 * sRGB, gAMA, cHRM, sBIT, pHYs, bKGD, tRNS, hIST, sPLT). Los píxeles (IDAT)
 * jamás se tocan → cero pérdida.
 *
 * Se eliminan los rastros de IA:
 *   · caBX / caMs / caSt → contenedores C2PA en PNG.
 *   · tEXt / zTXt / iTXt → si el keyword o el texto delatan IA / datos de
 *     generación (Stable Diffusion "parameters", ComfyUI "workflow", XMP, …).
 *   · Chunks desconocidos cuyo contenido contenga firmas de IA.
 *
 * Como los chunks conservados no se modifican, sus CRC siguen siendo válidos;
 * no hay que recalcular nada.
 * ────────────────────────────────────────────────────────────────────────── */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const QUALITY_CHUNKS = new Set([
  "IHDR", "PLTE", "IDAT", "IEND",
  "iCCP", "sRGB", "gAMA", "cHRM", "sBIT", "pHYs", "bKGD", "tRNS", "hIST", "sPLT",
]);

const C2PA_CHUNKS = new Set(["caBX", "caMs", "caSt"]);

let uid = 0;
const nextId = () => `p${++uid}`;

interface TextChunk {
  keyword: string;
  text: string;
}

/** Extrae keyword + texto (descomprimiendo si hace falta) de tEXt/zTXt/iTXt. */
function parseTextChunk(type: string, data: Uint8Array): TextChunk {
  // keyword = bytes hasta el primer NUL.
  let nul = data.indexOf(0);
  if (nul < 0) nul = data.length;
  const keyword = decodeLoose(data, 0, nul);

  try {
    if (type === "tEXt") {
      return { keyword, text: decodeLoose(data, nul + 1) };
    }
    if (type === "zTXt") {
      // keyword \0 method(1) compressed...
      const comp = data.subarray(nul + 2);
      const inflated = pako.inflate(comp);
      return { keyword, text: decodeLoose(inflated) };
    }
    if (type === "iTXt") {
      // keyword \0 compFlag(1) compMethod(1) lang \0 transKeyword \0 text
      let p = nul + 1;
      const compFlag = data[p++];
      p++; // compMethod
      let langEnd = data.indexOf(0, p);
      if (langEnd < 0) langEnd = p;
      p = langEnd + 1;
      let transEnd = data.indexOf(0, p);
      if (transEnd < 0) transEnd = p;
      p = transEnd + 1;
      const textBytes = data.subarray(p);
      if (compFlag === 1) {
        const inflated = pako.inflate(textBytes);
        return { keyword, text: decodeUtf8(inflated) };
      }
      return { keyword, text: decodeUtf8(textBytes) };
    }
  } catch {
    // Si falla la descompresión, decidimos solo por el keyword.
    return { keyword, text: "" };
  }
  return { keyword, text: "" };
}

export function cleanPng(bytes: Uint8Array, originalSize: number): CleanResult {
  uid = 0;
  const findings: Finding[] = [];
  const preserved: PreservedItem[] = [];
  const notices: string[] = [];

  // Validar firma.
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) {
      throw new Error("El archivo no es un PNG válido.");
    }
  }

  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let pos = 8;

  let hasIccp = false;
  let hasSrgb = false;
  let pHYs: { x: number; y: number; unit: number } | null = null;
  let dims: { w: number; h: number; depth: number; color: number } | null = null;

  while (pos + 8 <= bytes.length) {
    const length = readUint32BE(bytes, pos);
    const type = readChunkType(bytes, pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4; // + CRC
    if (chunkEnd > bytes.length) break;

    const data = bytes.subarray(dataStart, dataEnd);
    let keep = true;

    if (type === "IHDR" && length >= 13) {
      dims = {
        w: readUint32BE(data, 0),
        h: readUint32BE(data, 4),
        depth: data[8],
        color: data[9],
      };
    } else if (type === "iCCP") {
      hasIccp = true;
    } else if (type === "sRGB") {
      hasSrgb = true;
    } else if (type === "pHYs" && length >= 9) {
      pHYs = { x: readUint32BE(data, 0), y: readUint32BE(data, 4), unit: data[8] };
    }

    if (C2PA_CHUNKS.has(type)) {
      keep = false;
      findings.push({
        id: nextId(),
        category: "C2PA / Content Credentials",
        label: `Manifiesto C2PA (chunk ${type})`,
        source: `PNG · ${type}`,
        detail: "Credencial de contenido firmada (procedencia de IA).",
        bytes: chunkEnd - pos,
        removed: true,
      });
    } else if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const { keyword, text } = parseTextChunk(type, data);
      const combined = `${keyword}\n${text}`;
      const hits = scanForAi(combined);
      const kwHit = AI_PNG_TEXT_KEYWORDS.has(keyword.trim().toLowerCase());

      if (hits.length > 0 || kwHit) {
        keep = false;
        if (hits.length > 0) {
          findings.push({
            id: nextId(),
            category: hits[0].category,
            label: hits[0].label,
            source: `PNG · ${type} (${keyword || "—"})`,
            detail: snippet(text || hits[0].match, 90),
            bytes: chunkEnd - pos,
            removed: true,
          });
        } else {
          findings.push({
            id: nextId(),
            category: "Datos de generación",
            label: `Datos de generación (${keyword})`,
            source: `PNG · ${type}`,
            detail: snippet(text, 90) || "Parámetros de generación de IA.",
            bytes: chunkEnd - pos,
            removed: true,
          });
        }
      }
    } else if (type === "eXIf") {
      // EXIF dentro de PNG: si delata IA, se elimina el chunk completo.
      const txt = decodeLoose(data);
      const hits = scanForAi(txt);
      if (hits.length > 0) {
        keep = false;
        findings.push({
          id: nextId(),
          category: hits[0].category,
          label: hits[0].label,
          source: "PNG · eXIf",
          detail: snippet(hits[0].match, 60),
          bytes: chunkEnd - pos,
          removed: true,
        });
      }
    } else if (!QUALITY_CHUNKS.has(type)) {
      // Chunk desconocido/auxiliar: eliminar solo si contiene firmas de IA.
      const txt = decodeLoose(data);
      const hits = scanForAi(txt);
      if (hits.length > 0) {
        keep = false;
        findings.push({
          id: nextId(),
          category: hits[0].category,
          label: hits[0].label,
          source: `PNG · ${type}`,
          detail: snippet(hits[0].match, 60),
          bytes: chunkEnd - pos,
          removed: true,
        });
      }
    }

    if (keep) parts.push(bytes.subarray(pos, chunkEnd));
    pos = chunkEnd;

    if (type === "IEND") break;
  }

  const cleaned = concat(parts);

  // ── Datos preservados ─────────────────────────────────────────────────────
  if (hasIccp) {
    preserved.push({
      icon: "color",
      label: "Perfil de color ICC (iCCP)",
      detail: "Intacto · color fiel en redes",
    });
  } else if (hasSrgb) {
    preserved.push({
      icon: "color",
      label: "Espacio de color sRGB",
      detail: "Chunk sRGB conservado",
    });
  } else {
    preserved.push({
      icon: "color",
      label: "Color",
      detail: "Sin perfil incrustado — sin cambios",
    });
  }
  if (dims) {
    preserved.push({
      icon: "dimensions",
      label: "Dimensiones originales",
      detail: `${dims.w} × ${dims.h}px · ${dims.depth}-bit · sin reescalar`,
    });
  }
  if (pHYs) {
    const dpi =
      pHYs.unit === 1 ? `${Math.round(pHYs.x * 0.0254)} ppp` : "densidad original";
    preserved.push({
      icon: "resolution",
      label: "Resolución (pHYs)",
      detail: `${dpi} · conservada`,
    });
  } else {
    preserved.push({
      icon: "resolution",
      label: "Resolución",
      detail: "Dimensiones de píxel intactas",
    });
  }
  preserved.push({
    icon: "pixels",
    label: "Píxeles sin recomprimir",
    detail: "IDAT idéntico — calidad sin pérdida",
  });

  return {
    format: "png",
    mime: "image/png",
    cleaned,
    originalSize,
    cleanedSize: cleaned.length,
    findings,
    preserved,
    isAi: findings.length > 0,
    notices,
  };
}
