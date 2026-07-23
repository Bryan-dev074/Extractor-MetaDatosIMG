import { describe, expect, it } from "vitest";
import {
  BLUE_NOISE_CHECKSUM,
  BLUE_NOISE_RANKS,
  applyAdaptiveDither,
  createSmoothMask,
} from "@/lib/tiktok/anti-banding";
import { crc32 } from "@/lib/metadata/bytes";

function image(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  return { width, height, data, colorSpace: "srgb" } as ImageData;
}

function rankBytes(): Uint8Array {
  const bytes = new Uint8Array(BLUE_NOISE_RANKS.length * 2);
  for (let index = 0; index < BLUE_NOISE_RANKS.length; index += 1) {
    bytes[index * 2] = BLUE_NOISE_RANKS[index] >>> 8;
    bytes[index * 2 + 1] = BLUE_NOISE_RANKS[index] & 0xff;
  }
  return bytes;
}

describe("createSmoothMask", () => {
  it("validates dimensions and the exact checked RGBA length", () => {
    expect(() =>
      createSmoothMask({
        width: 0,
        height: 1,
        data: new Uint8ClampedArray(),
        colorSpace: "srgb",
      } as ImageData),
    ).toThrow(/dimensiones/i);
    expect(() =>
      createSmoothMask({
        width: 2,
        height: 2,
        data: new Uint8ClampedArray(15),
        colorSpace: "srgb",
      } as ImageData),
    ).toThrow(/RGBA/i);
  });

  it("keeps borders out and accepts exact luma and RGB thresholds", () => {
    const source = image(5, 5, (x, y) => {
      if (x === 2 && y === 1) return [106, 106, 106, 255];
      return [100, 100, 100, 255];
    });
    const mask = createSmoothMask(source);

    expect(mask[2 * 5 + 2]).toBe(1);
    expect(mask.slice(0, 5)).toEqual(new Uint8Array(5));
    expect(mask[2 * 5]).toBe(0);
    expect(mask[2 * 5 + 4]).toBe(0);
  });

  it("accepts RGB delta 12 and rejects 13 independently of luma and chroma", () => {
    const atLimit = image(5, 5, (x, y) =>
      x === 2 && y === 1 ? [112, 104, 104, 255] : [100, 100, 100, 255],
    );
    const overLimit = image(5, 5, (x, y) =>
      x === 2 && y === 1 ? [113, 105, 105, 255] : [100, 100, 100, 255],
    );

    expect(createSmoothMask(atLimit)[2 * 5 + 2]).toBe(1);
    expect(createSmoothMask(overLimit)[2 * 5 + 2]).toBe(0);
  });

  it("accepts chroma delta 8 and rejects 9", () => {
    const atLimit = image(5, 5, (x, y) =>
      x === 2 && y === 1 ? [108, 100, 100, 255] : [100, 100, 100, 255],
    );
    const overLimit = image(5, 5, (x, y) =>
      x === 2 && y === 1 ? [109, 100, 100, 255] : [100, 100, 100, 255],
    );

    expect(createSmoothMask(atLimit)[2 * 5 + 2]).toBe(1);
    expect(createSmoothMask(overLimit)[2 * 5 + 2]).toBe(0);
  });

  it("accepts local 3x3 luma range 12 and rejects 13", () => {
    const atLimit = image(5, 5, (x, y) => {
      const value = x === 1 && y === 1 ? 112 : 100;
      return [value, value, value, 255];
    });
    const overLimit = image(5, 5, (x, y) => {
      const value = x === 1 && y === 1 ? 113 : 100;
      return [value, value, value, 255];
    });

    expect(createSmoothMask(atLimit)[2 * 5 + 2]).toBe(1);
    expect(createSmoothMask(overLimit)[2 * 5 + 2]).toBe(0);
  });

  it("rejects one-level threshold excess, transparency, and isoluminant chroma edges", () => {
    const lumaEdge = image(5, 5, (x, y) =>
      x === 2 && y === 1 ? [107, 107, 107, 255] : [100, 100, 100, 255],
    );
    expect(createSmoothMask(lumaEdge)[2 * 5 + 2]).toBe(0);

    const transparentNeighbor = image(5, 5, (x, y) =>
      x === 1 && y === 1 ? [100, 100, 100, 254] : [100, 100, 100, 255],
    );
    expect(createSmoothMask(transparentNeighbor)[2 * 5 + 2]).toBe(0);

    const chromaEdge = image(7, 5, (x) =>
      x < 3 ? [100, 100, 100, 255] : [112, 97, 95, 255],
    );
    const chromaMask = createSmoothMask(chromaEdge);
    expect(chromaMask[2 * 7 + 2]).toBe(0);
    expect(chromaMask[2 * 7 + 3]).toBe(0);
  });

  it("rejects checker, text-like, and textured regions", () => {
    const checker = image(9, 9, (x, y) => {
      const value = (x + y) % 2 ? 70 : 150;
      return [value, value, value, 255];
    });
    expect([...createSmoothMask(checker)].some(Boolean)).toBe(false);

    const text = image(9, 9, (x, y) => {
      const value = x === 4 || y === 4 ? 10 : 240;
      return [value, value, value, 255];
    });
    expect(createSmoothMask(text)[4 * 9 + 4]).toBe(0);
  });
});

describe("applyAdaptiveDither", () => {
  it("uses a frozen 64x64 permutation containing every rank exactly once", () => {
    expect(BLUE_NOISE_RANKS).toHaveLength(4096);
    expect(new Set(BLUE_NOISE_RANKS).size).toBe(4096);
    expect(Math.min(...BLUE_NOISE_RANKS)).toBe(0);
    expect(Math.max(...BLUE_NOISE_RANKS)).toBe(4095);
    expect(`crc32:${crc32(rankBytes()).toString(16).padStart(8, "0")}`).toBe(
      BLUE_NOISE_CHECKSUM,
    );
    expect(BLUE_NOISE_CHECKSUM).toBe("crc32:85059c0a");
  });

  it("is deterministic by seed, non-mutating, bounded, and exactly zero mean", () => {
    const source = image(96, 80, (x) => {
      const value = 96 + Math.floor(x / 16);
      return [value, value + 1, value + 2, 255];
    });
    const before = source.data.slice();
    const first = applyAdaptiveDither(source, 42);
    const same = applyAdaptiveDither(source, 42);
    const other = applyAdaptiveDither(source, 43);

    expect(source.data).toEqual(before);
    expect(first.image.data).toEqual(same.image.data);
    expect(first.image.data).not.toEqual(other.image.data);
    expect(first.image.width).toBe(source.width);
    expect(first.image.height).toBe(source.height);
    expect(first.image.colorSpace).toBe("srgb");
    expect(first.changedSamples).toBeGreaterThan(0);
    expect(first.sumDelta).toBe(0);
    expect(first.meanDelta).toBe(0);

    let actualDeltaSum = 0;
    let actualChangedSamples = 0;
    for (let offset = 0; offset < source.data.length; offset += 4) {
      const pixelDeltas: number[] = [];
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = first.image.data[offset + channel] - source.data[offset + channel];
        expect([-1, 0, 1]).toContain(delta);
        if (!first.mask[offset / 4]) expect(delta).toBe(0);
        actualDeltaSum += delta;
        if (delta !== 0) actualChangedSamples += 1;
        pixelDeltas.push(delta);
      }
      expect(new Set(pixelDeltas).size).toBe(1);
      expect(first.image.data[offset + 3]).toBe(source.data[offset + 3]);
    }
    expect(actualDeltaSum).toBe(0);
    expect(actualChangedSamples).toBe(first.changedSamples);
  });

  it("leaves saturated pixels unchanged and never creates an unbalanced RGB pair", () => {
    const saturated = image(5, 5, (x, y) => [
      x === 2 && y === 2 ? 255 : 254,
      0,
      120,
      255,
    ]);
    const result = applyAdaptiveDither(saturated, 7);
    for (let offset = 0; offset < saturated.data.length; offset += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const original = saturated.data[offset + channel];
        if (original === 0 || original === 255) {
          expect(result.image.data[offset + channel]).toBe(original);
        }
      }
      expect(result.image.data[offset + 3]).toBe(255);
    }
    expect(result.changedSamples % 6).toBe(0);
    expect(result.sumDelta).toBe(0);
  });

  it("leaves one odd eligible sample unmatched and never reuses a changed sample", () => {
    const source = image(5, 5, () => [120, 121, 122, 255]);
    const result = applyAdaptiveDither(source, 17);
    let changedPixels = 0;

    for (let pixel = 0; pixel < source.width * source.height; pixel += 1) {
      const offset = pixel * 4;
      const deltas = [0, 1, 2].map(
        (channel) => result.image.data[offset + channel] - source.data[offset + channel],
      );
      if (deltas.some((delta) => delta !== 0)) {
        changedPixels += 1;
        expect(new Set(deltas).size).toBe(1);
        expect(Math.abs(deltas[0])).toBe(1);
      }
    }

    expect(result.eligiblePixels).toBe(9);
    expect(changedPixels).toBe(8);
    expect(result.changedSamples).toBe(changedPixels * 3);
    expect(result.sumDelta).toBe(0);
  });

  it("disperses changes across every 8x8 residue instead of imprinting a grid", () => {
    const source = image(67, 67, () => [120, 121, 122, 255]);
    const result = applyAdaptiveDither(source, 29);
    const changedByResidue = new Uint16Array(64);

    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const offset = (y * source.width + x) * 4;
        if (result.image.data[offset] !== source.data[offset]) {
          changedByResidue[(y & 7) * 8 + (x & 7)] += 1;
        }
      }
    }

    const counts = [...changedByResidue];
    const mean = counts.reduce((total, count) => total + count, 0) / counts.length;
    const variance =
      counts.reduce((total, count) => total + (count - mean) ** 2, 0) / counts.length;
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(Math.sqrt(variance) / mean).toBeLessThan(0.15);
  });

  it("normalizes integer seeds as uint32 and rejects invalid seeds", () => {
    const source = image(8, 8, () => [120, 121, 122, 255]);
    expect(applyAdaptiveDither(source, -1).image.data).toEqual(
      applyAdaptiveDither(source, 0xffffffff).image.data,
    );
    expect(() => applyAdaptiveDither(source, Number.NaN)).toThrow(/semilla/i);
    expect(() => applyAdaptiveDither(source, 1.5)).toThrow(/semilla/i);
  });
});
