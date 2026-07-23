import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import fixture from "@/tests/fixtures/amazonian.json";
import { applyAdaptiveDither } from "@/lib/tiktok/anti-banding";
import { crc32 } from "@/lib/metadata/bytes";

interface Crop {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DecodedRgb {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function validateCrop(crop: Crop, width: number, height: number, label: string): void {
  if (
    !Number.isInteger(crop.left) ||
    !Number.isInteger(crop.top) ||
    !Number.isInteger(crop.width) ||
    !Number.isInteger(crop.height) ||
    crop.left < 0 ||
    crop.top < 0 ||
    crop.width <= 1 ||
    crop.height <= 1 ||
    crop.left + crop.width > width ||
    crop.top + crop.height > height
  ) {
    throw new Error(`${label}: crop inválido.`);
  }
}

function luma(data: Uint8Array, offset: number): number {
  return (54 * data[offset] + 183 * data[offset + 1] + 19 * data[offset + 2]) >> 8;
}

async function decodeRgb(input: Uint8Array): Promise<DecodedRgb> {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

async function jpeg75(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const encoded = await sharp(input)
    .rotate()
    .jpeg({ quality: 75, chromaSubsampling: "4:2:0", mozjpeg: false })
    .toBuffer();
  return Uint8Array.from(encoded);
}

async function jpeg75FromRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const encoded = await sharp(Uint8Array.from(data), {
    raw: { width, height, channels: 4 },
  })
    .removeAlpha()
    .jpeg({ quality: 75, chromaSubsampling: "4:2:0", mozjpeg: false })
    .toBuffer();
  return Uint8Array.from(encoded);
}

function smoothMetrics(
  decoded: DecodedRgb,
  mask: Uint8Array,
  crop: Crop,
): {
  equalRatio: number;
  boundaryMean: number;
  interiorMean: number;
  blockiness: number;
  score: number;
  pairs: number;
} {
  let equal = 0;
  let pairs = 0;
  const compare = (x: number, y: number, nextX: number, nextY: number) => {
    const pixel = y * decoded.width + x;
    const nextPixel = nextY * decoded.width + nextX;
    if (!mask[pixel] || !mask[nextPixel]) return;
    const first = luma(decoded.data, pixel * decoded.channels);
    const second = luma(decoded.data, nextPixel * decoded.channels);
    const difference = Math.abs(first - second);
    pairs += 1;
    if (difference === 0) equal += 1;
  };

  for (let y = crop.top; y < crop.top + crop.height; y += 1) {
    for (let x = crop.left; x < crop.left + crop.width; x += 1) {
      if (x + 1 < crop.left + crop.width) {
        compare(x, y, x + 1, y);
      }
      if (y + 1 < crop.top + crop.height) {
        compare(x, y, x, y + 1);
      }
    }
  }

  // Blocking is a coherent 8x8 step, while the intentional ±1 blue noise is
  // stochastic. Average signed differences over each eight-pixel boundary
  // segment before taking magnitude so zero-mean dither is not misclassified
  // as a block edge.
  let boundaryTotal = 0;
  let boundaryCount = 0;
  let interiorTotal = 0;
  let interiorCount = 0;
  const recordSegment = (differenceSum: number, count: number, boundary: boolean) => {
    if (count < 4) return;
    const coherentStep = Math.abs(differenceSum / count);
    if (boundary) {
      boundaryTotal += coherentStep;
      boundaryCount += 1;
    } else {
      interiorTotal += coherentStep;
      interiorCount += 1;
    }
  };
  for (let x = crop.left; x < crop.left + crop.width - 1; x += 1) {
    for (let segmentY = crop.top; segmentY < crop.top + crop.height; segmentY += 8) {
      let sum = 0;
      let count = 0;
      const endY = Math.min(segmentY + 8, crop.top + crop.height);
      for (let y = segmentY; y < endY; y += 1) {
        const pixel = y * decoded.width + x;
        if (!mask[pixel] || !mask[pixel + 1]) continue;
        sum +=
          luma(decoded.data, (pixel + 1) * decoded.channels) -
          luma(decoded.data, pixel * decoded.channels);
        count += 1;
      }
      recordSegment(sum, count, (x + 1) % 8 === 0);
    }
  }
  for (let y = crop.top; y < crop.top + crop.height - 1; y += 1) {
    for (let segmentX = crop.left; segmentX < crop.left + crop.width; segmentX += 8) {
      let sum = 0;
      let count = 0;
      const endX = Math.min(segmentX + 8, crop.left + crop.width);
      for (let x = segmentX; x < endX; x += 1) {
        const pixel = y * decoded.width + x;
        if (!mask[pixel] || !mask[pixel + decoded.width]) continue;
        sum +=
          luma(decoded.data, (pixel + decoded.width) * decoded.channels) -
          luma(decoded.data, pixel * decoded.channels);
        count += 1;
      }
      recordSegment(sum, count, (y + 1) % 8 === 0);
    }
  }
  if (pairs === 0 || boundaryCount === 0 || interiorCount === 0) {
    throw new Error("El crop suave no contiene suficientes pares elegibles.");
  }
  const equalRatio = equal / pairs;
  const boundaryMean = boundaryTotal / boundaryCount;
  const interiorMean = interiorTotal / interiorCount;
  const blockiness = Math.max(0, boundaryMean - interiorMean);
  return {
    equalRatio,
    boundaryMean,
    interiorMean,
    blockiness,
    score: equalRatio + blockiness / 255,
    pairs,
  };
}

function textEdgeEnergy(
  direct: DecodedRgb,
  candidate: DecodedRgb,
  crop: Crop,
): number {
  let directEnergy = 0;
  let candidateEnergy = 0;
  let edges = 0;
  for (let y = crop.top; y < crop.top + crop.height - 1; y += 1) {
    for (let x = crop.left; x < crop.left + crop.width - 1; x += 1) {
      const pixel = y * direct.width + x;
      const right = pixel + 1;
      const down = pixel + direct.width;
      const directCenter = luma(direct.data, pixel * direct.channels);
      const directGradient =
        Math.abs(luma(direct.data, right * direct.channels) - directCenter) +
        Math.abs(luma(direct.data, down * direct.channels) - directCenter);
      if (directGradient < 16) continue;
      const candidateCenter = luma(candidate.data, pixel * candidate.channels);
      const candidateGradient =
        Math.abs(luma(candidate.data, right * candidate.channels) - candidateCenter) +
        Math.abs(luma(candidate.data, down * candidate.channels) - candidateCenter);
      directEnergy += directGradient;
      candidateEnergy += candidateGradient;
      edges += 1;
    }
  }
  if (edges === 0 || directEnergy === 0) throw new Error("El crop de texto no contiene bordes.");
  return candidateEnergy / directEnergy;
}

const sourceDirectory = process.env.AMAZONIAN_SOURCE_DIR;
const intermediateDirectory = process.env.AMAZONIAN_INTERMEDIATE_DIR;
const hasEitherDirectory = Boolean(sourceDirectory || intermediateDirectory);
const localEvidence = hasEitherDirectory ? it : it.skip;

describe.sequential("Amazonian local regression evidence", () => {
  localEvidence(
    "improves q90 and direct q100 JPEG-75 arms while retaining text edges",
    async () => {
      if (!sourceDirectory || !intermediateDirectory) {
        throw new Error(
          "AMAZONIAN_SOURCE_DIR y AMAZONIAN_INTERMEDIATE_DIR deben definirse juntos.",
        );
      }
      const rows: Array<Record<string, string | number>> = [];
      for (const pair of fixture.pairs) {
        const sourceBytes = Uint8Array.from(
          await readFile(path.join(sourceDirectory, pair.source)),
        );
        const intermediateBytes = Uint8Array.from(
          await readFile(path.join(intermediateDirectory, pair.intermediate)),
        );
        expect(sha256(sourceBytes), pair.source).toBe(pair.sourceSha256);
        expect(sha256(intermediateBytes), pair.intermediate).toBe(
          pair.intermediateSha256,
        );
        const intermediateMetadata = await sharp(intermediateBytes).metadata();
        expect(intermediateMetadata.width, pair.intermediate).toBe(fixture.width);
        expect(intermediateMetadata.height, pair.intermediate).toBe(fixture.height);

        const decodedSource = await sharp(sourceBytes)
          .rotate()
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect(decodedSource.info.width).toBe(fixture.width);
        expect(decodedSource.info.height).toBe(fixture.height);
        const sourceImage = {
          width: decodedSource.info.width,
          height: decodedSource.info.height,
          data: Uint8ClampedArray.from(decodedSource.data),
          colorSpace: "srgb",
        } as ImageData;
        validateCrop(pair.smoothCrop, fixture.width, fixture.height, pair.source);
        validateCrop(pair.textCrop, fixture.width, fixture.height, pair.source);

        const dithered = applyAdaptiveDither(sourceImage, crc32(sourceBytes));
        const q90Jpeg = await jpeg75(intermediateBytes);
        const directJpeg = await jpeg75(sourceBytes);
        const ditherJpeg = await jpeg75FromRgba(
          dithered.image.data,
          fixture.width,
          fixture.height,
        );
        const [q90, direct, dither] = await Promise.all([
          decodeRgb(q90Jpeg),
          decodeRgb(directJpeg),
          decodeRgb(ditherJpeg),
        ]);
        const q90Smooth = smoothMetrics(q90, dithered.mask, pair.smoothCrop);
        const directSmooth = smoothMetrics(direct, dithered.mask, pair.smoothCrop);
        const ditherSmooth = smoothMetrics(dither, dithered.mask, pair.smoothCrop);
        const edgeRetention = textEdgeEnergy(direct, dither, pair.textCrop);
        const q90EqualRatio = ditherSmooth.equalRatio / q90Smooth.equalRatio;
        const directEqualRatio = ditherSmooth.equalRatio / directSmooth.equalRatio;
        const q90BlockRatio = ditherSmooth.blockiness / q90Smooth.blockiness;
        const directBlockRatio = ditherSmooth.blockiness / directSmooth.blockiness;

        rows.push({
          pair: `${pair.source}/${pair.intermediate}`,
          eligible: Number(dithered.eligibleFraction.toFixed(6)),
          q90Equal: Number(q90Smooth.equalRatio.toFixed(6)),
          directEqual: Number(directSmooth.equalRatio.toFixed(6)),
          ditherEqual: Number(ditherSmooth.equalRatio.toFixed(6)),
          q90Block: Number(q90Smooth.blockiness.toFixed(6)),
          directBlock: Number(directSmooth.blockiness.toFixed(6)),
          ditherBlock: Number(ditherSmooth.blockiness.toFixed(6)),
          q90Boundary: Number(q90Smooth.boundaryMean.toFixed(6)),
          q90Interior: Number(q90Smooth.interiorMean.toFixed(6)),
          directBoundary: Number(directSmooth.boundaryMean.toFixed(6)),
          directInterior: Number(directSmooth.interiorMean.toFixed(6)),
          ditherBoundary: Number(ditherSmooth.boundaryMean.toFixed(6)),
          ditherInterior: Number(ditherSmooth.interiorMean.toFixed(6)),
          q90Score: Number(q90Smooth.score.toFixed(6)),
          directScore: Number(directSmooth.score.toFixed(6)),
          ditherScore: Number(ditherSmooth.score.toFixed(6)),
          q90EqualRatio: Number(q90EqualRatio.toFixed(6)),
          directEqualRatio: Number(directEqualRatio.toFixed(6)),
          q90BlockRatio: Number(q90BlockRatio.toFixed(6)),
          directBlockRatio: Number(directBlockRatio.toFixed(6)),
          edgeRetention: Number(edgeRetention.toFixed(6)),
          q90Bytes: q90Jpeg.byteLength,
          directBytes: directJpeg.byteLength,
          ditherBytes: ditherJpeg.byteLength,
        });

        expect.soft(dithered.eligibleFraction, pair.source).toBeGreaterThanOrEqual(
          fixture.thresholds.minEligibleFraction,
        );
        expect.soft(q90EqualRatio, pair.source).toBeLessThanOrEqual(
          fixture.thresholds.maxEqualNeighborRatioVsQ90,
        );
        expect.soft(directEqualRatio, pair.source).toBeLessThanOrEqual(
          fixture.thresholds.maxEqualNeighborRatioVsDirectQ100,
        );
        expect.soft(q90BlockRatio, pair.source).toBeLessThanOrEqual(
          fixture.thresholds.maxBlockinessRatioVsQ90,
        );
        expect.soft(directBlockRatio, pair.source).toBeLessThanOrEqual(
          fixture.thresholds.maxBlockinessRatioVsDirectQ100,
        );
        expect.soft(edgeRetention, pair.source).toBeGreaterThanOrEqual(
          fixture.thresholds.minTextEdgeRetention,
        );
      }
      console.info(`AMAZONIAN_METRICS ${JSON.stringify(rows)}`);
    },
    120_000,
  );
});
