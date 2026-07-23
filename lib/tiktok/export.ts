import { crc32 } from "../metadata/bytes";
import {
  applyAdaptiveDither,
  type DitherStatistics,
} from "./anti-banding";
import { isApng, normalizeTikTokPng } from "./png-color";

export const DEFAULT_TIKTOK_LIMITS = Object.freeze({
  maxInputBytes: 100 * 1024 * 1024,
  maxPixels: 40_000_000,
});

export interface TikTokBitmap {
  width: number;
  height: number;
  native: unknown;
  close(): void;
}

export interface TikTokCanvasAdapter {
  kind: "offscreen" | "main";
  decode(
    input: Blob,
    options: {
      imageOrientation: "from-image";
      colorSpaceConversion: "default";
    },
  ): Promise<TikTokBitmap>;
  read(
    bitmap: TikTokBitmap,
    request: { width: number; height: number; colorSpace: "srgb" },
  ): Promise<ImageData>;
  encodePng(
    image: ImageData,
    request: { colorSpace: "srgb" },
  ): Promise<Blob>;
  encodeJpeg(
    image: ImageData,
    request: { quality: 0.75; matte: readonly [255, 255, 255] },
  ): Promise<Blob>;
}

export interface TikTokExportLimits {
  maxInputBytes: number;
  maxPixels: number;
}

export interface TikTokExportOptions {
  adapter?: TikTokCanvasAdapter;
  limits?: TikTokExportLimits;
}

export interface TikTokExportResult extends DitherStatistics {
  png: Uint8Array<ArrayBuffer>;
  preview: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  seed: number;
  outputExtension: ".png";
  approximate: true;
}

export class TikTokMainThreadFallbackRequiredError extends Error {
  readonly fallbackRequired = true;

  constructor(message = "TikTok Photo Max requiere el fallback del hilo principal.") {
    super(message);
    this.name = "TikTokMainThreadFallbackRequiredError";
  }
}

function abortError(reason?: unknown): DOMException {
  if (reason instanceof DOMException && reason.name === "AbortError") return reason;
  return new DOMException(
    typeof reason === "string" && reason ? reason : "La exportación fue cancelada.",
    "AbortError",
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal.reason);
}

function validateLimits(limits: TikTokExportLimits): void {
  if (
    !Number.isSafeInteger(limits.maxInputBytes) ||
    limits.maxInputBytes <= 0 ||
    !Number.isSafeInteger(limits.maxPixels) ||
    limits.maxPixels <= 0 ||
    limits.maxPixels > Math.floor(Number.MAX_SAFE_INTEGER / 4)
  ) {
    throw new RangeError("Los límites de TikTok Photo Max no son seguros.");
  }
}

function validateDimensions(
  width: number,
  height: number,
  maxPixels: number,
): number {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > Math.floor(Number.MAX_SAFE_INTEGER / height)
  ) {
    throw new RangeError("El bitmap decodificado tiene dimensiones inválidas.");
  }
  const pixels = width * height;
  if (pixels > maxPixels) {
    throw new RangeError(
      `La imagen decodificada excede el límite de ${maxPixels.toLocaleString("es")} píxeles.`,
    );
  }
  if (pixels > Math.floor(Number.MAX_SAFE_INTEGER / 4)) {
    throw new RangeError("La imagen decodificada excede el límite RGBA seguro.");
  }
  return pixels;
}

function exactBytes(buffer: ArrayBuffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer);
}

type Canvas2DWithColor = CanvasRenderingContext2D & {
  getImageData(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    settings?: { colorSpace?: "srgb" },
  ): ImageData;
};

function getContext2d(
  canvas: OffscreenCanvas | HTMLCanvasElement,
): Canvas2DWithColor {
  const context = canvas.getContext("2d", {
    colorSpace: "srgb",
    willReadFrequently: true,
  } as CanvasRenderingContext2DSettings) as Canvas2DWithColor | null;
  if (!context) throw new Error("No se pudo crear un contexto Canvas 2D sRGB.");
  return context;
}

function nativeImageData(image: ImageData): ImageData {
  if (typeof ImageData !== "undefined" && image instanceof ImageData) return image;
  if (typeof ImageData === "undefined") return image;
  try {
    return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height, {
      colorSpace: "srgb",
    });
  } catch {
    return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  }
}

export function compositeRgbaOnWhite(image: ImageData): ImageData {
  const output = new Uint8ClampedArray(image.data.length);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const alpha = image.data[offset + 3];
    const inverseAlpha = 255 - alpha;
    for (let channel = 0; channel < 3; channel += 1) {
      output[offset + channel] = Math.round(
        (image.data[offset + channel] * alpha + 255 * inverseAlpha) / 255,
      );
    }
    output[offset + 3] = 255;
  }
  return {
    data: output,
    width: image.width,
    height: image.height,
    colorSpace: "srgb",
  } as ImageData;
}

function offscreenFailure(stage: string, error: unknown): TikTokMainThreadFallbackRequiredError {
  const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
  return new TikTokMainThreadFallbackRequiredError(
    `OffscreenCanvas falló durante ${stage}.${detail}`,
  );
}

export function createOffscreenTikTokAdapter(): TikTokCanvasAdapter {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
    throw new TikTokMainThreadFallbackRequiredError();
  }
  const createCanvas = (width: number, height: number): OffscreenCanvas =>
    new OffscreenCanvas(width, height);
  return {
    kind: "offscreen",
    async decode(input, options) {
      const bitmap = await createImageBitmap(input, options);
      return {
        width: bitmap.width,
        height: bitmap.height,
        native: bitmap,
        close: () => bitmap.close(),
      };
    },
    async read(bitmap, request) {
      try {
        const canvas = createCanvas(request.width, request.height);
        const context = getContext2d(canvas);
        context.drawImage(bitmap.native as CanvasImageSource, 0, 0);
        return context.getImageData(0, 0, request.width, request.height, {
          colorSpace: "srgb",
        });
      } catch (error) {
        throw offscreenFailure("la lectura sRGB", error);
      }
    },
    async encodePng(image) {
      try {
        const canvas = createCanvas(image.width, image.height);
        getContext2d(canvas).putImageData(nativeImageData(image), 0, 0);
        return await canvas.convertToBlob({ type: "image/png" });
      } catch (error) {
        throw offscreenFailure("la codificación PNG", error);
      }
    },
    async encodeJpeg(image, request) {
      try {
        const canvas = createCanvas(image.width, image.height);
        getContext2d(canvas).putImageData(
          nativeImageData(compositeRgbaOnWhite(image)),
          0,
          0,
        );
        return await canvas.convertToBlob({
          type: "image/jpeg",
          quality: request.quality,
        });
      } catch (error) {
        throw offscreenFailure("la vista previa JPEG", error);
      }
    },
  };
}

function htmlCanvasBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`El navegador no pudo codificar ${type}.`));
      },
      type,
      quality,
    );
  });
}

export function createHtmlTikTokAdapter(): TikTokCanvasAdapter {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    throw new Error("El navegador no ofrece Canvas HTML para TikTok Photo Max.");
  }
  const createCanvas = (width: number, height: number): HTMLCanvasElement => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
  return {
    kind: "main",
    async decode(input, options) {
      const bitmap = await createImageBitmap(input, options);
      return {
        width: bitmap.width,
        height: bitmap.height,
        native: bitmap,
        close: () => bitmap.close(),
      };
    },
    async read(bitmap, request) {
      const canvas = createCanvas(request.width, request.height);
      const context = getContext2d(canvas);
      context.drawImage(bitmap.native as CanvasImageSource, 0, 0);
      return context.getImageData(0, 0, request.width, request.height, {
        colorSpace: "srgb",
      });
    },
    async encodePng(image) {
      const canvas = createCanvas(image.width, image.height);
      getContext2d(canvas).putImageData(nativeImageData(image), 0, 0);
      return htmlCanvasBlob(canvas, "image/png");
    },
    async encodeJpeg(image, request) {
      const canvas = createCanvas(image.width, image.height);
      getContext2d(canvas).putImageData(
        nativeImageData(compositeRgbaOnWhite(image)),
        0,
        0,
      );
      return htmlCanvasBlob(canvas, "image/jpeg", request.quality);
    },
  };
}

function defaultAdapter(): TikTokCanvasAdapter {
  if (typeof OffscreenCanvas !== "undefined") return createOffscreenTikTokAdapter();
  if (typeof document !== "undefined") return createHtmlTikTokAdapter();
  throw new TikTokMainThreadFallbackRequiredError();
}

export async function exportForTikTok(
  input: Blob,
  signal?: AbortSignal,
  options: TikTokExportOptions = {},
): Promise<TikTokExportResult> {
  throwIfAborted(signal);
  if (!(input instanceof Blob)) throw new TypeError("La entrada debe ser un Blob de imagen.");
  const limits = options.limits ?? DEFAULT_TIKTOK_LIMITS;
  validateLimits(limits);
  if (input.size > limits.maxInputBytes) {
    throw new RangeError(
      `La imagen excede el tamaño máximo de ${limits.maxInputBytes.toLocaleString("es")} bytes.`,
    );
  }

  const inputBuffer = await input.arrayBuffer();
  throwIfAborted(signal);
  const inputBytes = new Uint8Array(inputBuffer);
  if (isApng(inputBytes)) {
    throw new Error("APNG animado no es compatible con TikTok Photo Max.");
  }
  throwIfAborted(signal);
  const seed = crc32(inputBytes);
  throwIfAborted(signal);

  const adapter = options.adapter ?? defaultAdapter();
  let bitmap: TikTokBitmap | undefined;
  try {
    bitmap = await adapter.decode(input, {
      imageOrientation: "from-image",
      colorSpaceConversion: "default",
    });
    throwIfAborted(signal);
    const { width, height } = bitmap;
    validateDimensions(width, height, limits.maxPixels);
    const rgba = await adapter.read(bitmap, { width, height, colorSpace: "srgb" });
    throwIfAborted(signal);
    if (rgba.width !== width || rgba.height !== height) {
      throw new Error("Canvas devolvió dimensiones distintas al bitmap orientado.");
    }

    const dithered = applyAdaptiveDither(rgba, seed);
    throwIfAborted(signal);
    const pngBlob = await adapter.encodePng(dithered.image, { colorSpace: "srgb" });
    throwIfAborted(signal);
    const encodedPng = new Uint8Array(await pngBlob.arrayBuffer());
    throwIfAborted(signal);
    const png = normalizeTikTokPng(encodedPng, { width, height });
    throwIfAborted(signal);

    const previewBlob = await adapter.encodeJpeg(dithered.image, {
      quality: 0.75,
      matte: [255, 255, 255],
    });
    throwIfAborted(signal);
    const preview = exactBytes(await previewBlob.arrayBuffer());
    throwIfAborted(signal);

    return {
      png,
      preview,
      width,
      height,
      seed,
      outputExtension: ".png",
      approximate: true,
      eligiblePixels: dithered.eligiblePixels,
      eligibleFraction: dithered.eligibleFraction,
      changedSamples: dithered.changedSamples,
      sumDelta: dithered.sumDelta,
      meanDelta: dithered.meanDelta,
    };
  } finally {
    bitmap?.close();
  }
}
