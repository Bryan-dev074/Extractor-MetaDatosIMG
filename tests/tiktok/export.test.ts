import { describe, expect, it, vi } from "vitest";
import {
  createOffscreenTikTokAdapter,
  DEFAULT_TIKTOK_LIMITS,
  exportForTikTok,
  TikTokMainThreadFallbackRequiredError,
  type TikTokBitmap,
  type TikTokCanvasAdapter,
} from "@/lib/tiktok/export";
import { chunk, concat, png, u32 } from "./fixtures";

function decodedImage(width = 6, height = 5): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 100 + (index % width);
    data[index * 4 + 1] = 101 + (index % width);
    data[index * 4 + 2] = 102 + (index % width);
    data[index * 4 + 3] = index === 0 ? 0 : 255;
  }
  return { width, height, data, colorSpace: "srgb" } as ImageData;
}

function fakeAdapter(options: {
  width?: number;
  height?: number;
  onStage?: (stage: string) => void;
} = {}) {
  const width = options.width ?? 6;
  const height = options.height ?? 5;
  const bitmap: TikTokBitmap = {
    width,
    height,
    close: vi.fn(),
    native: {},
  };
  const calls: Array<{ stage: string; value?: unknown }> = [];
  const adapter: TikTokCanvasAdapter = {
    kind: "offscreen",
    async decode(blob, decodeOptions) {
      calls.push({ stage: "decode", value: { blob, decodeOptions } });
      options.onStage?.("decode");
      return bitmap;
    },
    async read(bitmapValue, request) {
      calls.push({ stage: "read", value: { bitmapValue, request } });
      options.onStage?.("read");
      return decodedImage(width, height);
    },
    async encodePng(image, request) {
      calls.push({ stage: "png", value: { image, request } });
      options.onStage?.("png");
      return new Blob([png([], undefined, 6, width, height)], { type: "image/png" });
    },
    async encodeJpeg(image, request) {
      calls.push({ stage: "jpeg", value: { image, request } });
      options.onStage?.("jpeg");
      return new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)], { type: "image/jpeg" });
    },
  };
  return { adapter, bitmap, calls };
}

describe("exportForTikTok", () => {
  it("keeps oriented native dimensions, uses sRGB, white matte, and JPEG quality 0.75", async () => {
    const runtime = fakeAdapter();
    const source = new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 1, 2, 3)], {
      type: "image/jpeg",
    });

    const result = await exportForTikTok(source, undefined, { adapter: runtime.adapter });

    expect(runtime.calls[0]).toMatchObject({
      stage: "decode",
      value: {
        decodeOptions: {
          imageOrientation: "from-image",
          colorSpaceConversion: "default",
        },
      },
    });
    expect(runtime.calls[1]).toMatchObject({
      stage: "read",
      value: { request: { width: 6, height: 5, colorSpace: "srgb" } },
    });
    expect(runtime.calls.find((call) => call.stage === "png")?.value).toMatchObject({
      request: { colorSpace: "srgb" },
    });
    expect(runtime.calls.find((call) => call.stage === "jpeg")?.value).toMatchObject({
      request: { quality: 0.75, matte: [255, 255, 255] },
    });
    expect(result).toMatchObject({
      width: 6,
      height: 5,
      outputExtension: ".png",
      approximate: true,
    });
    expect(result.png.byteLength).toBe(result.png.buffer.byteLength);
    expect(result.preview.byteLength).toBe(result.preview.buffer.byteLength);
    expect(runtime.bitmap.close).toHaveBeenCalledOnce();
  });

  it("rejects APNG before decode", async () => {
    const runtime = fakeAdapter();
    const animated = concat(
      png().slice(0, 33),
      chunk("acTL", concat(u32(1), u32(0))),
      png().slice(33),
    );
    await expect(
      exportForTikTok(new Blob([animated], { type: "image/png" }), undefined, {
        adapter: runtime.adapter,
      }),
    ).rejects.toThrow(/APNG/i);
    expect(runtime.calls).toHaveLength(0);
  });

  it("enforces checked input-byte and decoded-pixel limits", async () => {
    const runtime = fakeAdapter({ width: 100, height: 100 });
    await expect(
      exportForTikTok(new Blob([new Uint8Array(9)]), undefined, {
        adapter: runtime.adapter,
        limits: { maxInputBytes: 8, maxPixels: 20_000 },
      }),
    ).rejects.toThrow(/tamaño/i);
    expect(runtime.calls).toHaveLength(0);

    await expect(
      exportForTikTok(new Blob([Uint8Array.of(0xff, 0xd8, 0xff)]), undefined, {
        adapter: runtime.adapter,
        limits: { maxInputBytes: 8, maxPixels: 9_999 },
      }),
    ).rejects.toThrow(/píxeles/i);
    expect(runtime.bitmap.close).toHaveBeenCalledOnce();
  });

  it("exports with conservative documented default limits", () => {
    expect(DEFAULT_TIKTOK_LIMITS.maxInputBytes).toBeGreaterThan(0);
    expect(DEFAULT_TIKTOK_LIMITS.maxPixels).toBeGreaterThan(0);
    expect(Number.isSafeInteger(DEFAULT_TIKTOK_LIMITS.maxPixels * 4)).toBe(true);
  });

  it.each(["before", "decode", "read", "png", "jpeg"] as const)(
    "aborts cleanly at the %s checkpoint and always closes a decoded bitmap",
    async (stage) => {
      const controller = new AbortController();
      if (stage === "before") controller.abort("stop");
      const runtime = fakeAdapter({
        onStage(current) {
          if (current === stage) controller.abort("stop");
        },
      });
      await expect(
        exportForTikTok(
          new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 1)]),
          controller.signal,
          { adapter: runtime.adapter },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      if (stage === "before") expect(runtime.bitmap.close).not.toHaveBeenCalled();
      else expect(runtime.bitmap.close).toHaveBeenCalledOnce();
    },
  );

  it("closes the bitmap when decoding, readback, or encoding fails", async () => {
    const runtime = fakeAdapter();
    runtime.adapter.read = vi.fn().mockRejectedValue(new Error("canvas roto"));
    await expect(
      exportForTikTok(new Blob([Uint8Array.of(0xff, 0xd8, 0xff)]), undefined, {
        adapter: runtime.adapter,
      }),
    ).rejects.toThrow("canvas roto");
    expect(runtime.bitmap.close).toHaveBeenCalledOnce();
  });

  it("marks an OffscreenCanvas API failure for the main-thread retry", async () => {
    class BrokenOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return null;
      }
    }
    vi.stubGlobal("OffscreenCanvas", BrokenOffscreenCanvas);
    vi.stubGlobal("createImageBitmap", vi.fn());
    try {
      const adapter = createOffscreenTikTokAdapter();
      await expect(
        adapter.read(
          { width: 2, height: 2, native: {}, close: vi.fn() },
          { width: 2, height: 2, colorSpace: "srgb" },
        ),
      ).rejects.toBeInstanceOf(TikTokMainThreadFallbackRequiredError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
