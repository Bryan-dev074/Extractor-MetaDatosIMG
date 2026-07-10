/* Export opcional "optimizado para TikTok / redes con recompresión agresiva".
 *
 * A diferencia de la limpieza de metadatos (que NO toca los píxeles), esto SÍ
 * recodifica: redimensiona a un máximo (1080×1920 por defecto, solo reducir),
 * convierte a sRGB al dibujar en canvas y exporta JPEG de alta calidad.
 *
 * ¿Por qué ayuda en TikTok? TikTok recomprime cada imagen en su servidor hacia
 * ~100 KB. Si le das el tamaño nativo del marco (1080 de ancho) y sRGB, se salta
 * su paso de reescalado —la principal causa de que se vea borroso— y su pase de
 * compresión parte de una base limpia. */

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo cargar la imagen."));
    img.src = url;
  });
}

export interface OptimizeResult {
  blob: Blob;
  width: number;
  height: number;
  size: number;
  resized: boolean;
}

export async function optimizeForSocial(
  bytes: Uint8Array,
  mime: string,
  { maxW = 1080, maxH = 1920, quality = 0.92 } = {},
): Promise<OptimizeResult> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const img = await loadImage(url);
    const ow = img.naturalWidth || img.width;
    const oh = img.naturalHeight || img.height;

    // Solo reducir, nunca ampliar (ampliar no añade calidad).
    const scale = Math.min(1, maxW / ow, maxH / oh);
    const w = Math.max(1, Math.round(ow * scale));
    const h = Math.max(1, Math.round(oh * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas no disponible.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // Fondo blanco por si el original tiene transparencia (JPEG no la soporta).
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Fallo al exportar JPEG."))),
        "image/jpeg",
        quality,
      ),
    );

    return { blob, width: w, height: h, size: blob.size, resized: scale < 1 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Nombre de salida para la versión optimizada: `foto.jpg` → `foto-tiktok.jpg`. */
export function tiktokFileName(original: string): string {
  const dot = original.lastIndexOf(".");
  const base = dot > 0 ? original.slice(0, dot) : original;
  return `${base}-tiktok.jpg`;
}
