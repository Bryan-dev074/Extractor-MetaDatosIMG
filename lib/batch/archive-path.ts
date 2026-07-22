const WINDOWS_INVALID_CHARACTERS = /[<>:"|?*]/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const RESERVED_WINDOWS_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

type ArchiveMode = "clean" | "tiktok";
type OutputExtension = ".jpg" | ".png";

function collisionKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function sanitizeSegment(segment: string): string {
  const portable = segment
    .normalize("NFC")
    .replace(WINDOWS_INVALID_CHARACTERS, "_")
    .replace(/[. ]+$/u, "");
  const nonEmpty = portable || "_";
  const deviceBasename = nonEmpty.split(".", 1)[0];
  return RESERVED_WINDOWS_BASENAME.test(deviceBasename) ? `_${nonEmpty}` : nonEmpty;
}

function sourceStem(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

function inferCleanExtension(filename: string): OutputExtension {
  return filename.toLocaleLowerCase("en-US").endsWith(".png") ? ".png" : ".jpg";
}

export function createArchivePath(
  relativePath: string,
  mode: ArchiveMode,
  used: Set<string>,
  outputExtension?: OutputExtension,
): string {
  const normalized = relativePath.replace(/\\/g, "/").normalize("NFC");

  if (CONTROL_CHARACTERS.test(normalized)) {
    throw new Error("La ruta contiene caracteres de control no permitidos.");
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("No se permite una ruta absoluta ni con prefijo de unidad.");
  }

  const rawSegments = normalized.split("/").filter((segment) => {
    return segment !== "" && segment !== "." && segment !== "..";
  });
  if (rawSegments.length === 0) {
    throw new Error("La ruta no contiene un nombre de archivo válido.");
  }

  const rawFilename = rawSegments.pop()!;
  const directories = rawSegments.map(sanitizeSegment);
  const stem = sanitizeSegment(sourceStem(rawFilename));
  const extension = mode === "tiktok" ? ".png" : outputExtension ?? inferCleanExtension(rawFilename);
  const label = mode === "tiktok" ? "tiktok" : "limpio";
  const occupied = new Set(Array.from(used, collisionKey));

  let sequence = 1;
  let candidate: string;
  do {
    const collisionSuffix = sequence === 1 ? "" : ` (${sequence})`;
    const basename = `${stem}-${label}${collisionSuffix}${extension}`;
    candidate = [...directories, basename].join("/").normalize("NFC");
    sequence += 1;
  } while (occupied.has(collisionKey(candidate)));

  used.add(collisionKey(candidate));
  return candidate;
}
