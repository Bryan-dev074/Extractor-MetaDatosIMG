import {
  BLUE_NOISE_CHECKSUM,
  BLUE_NOISE_RANKS,
} from "./blue-noise-ranks.generated";

export { BLUE_NOISE_CHECKSUM, BLUE_NOISE_RANKS };

const TILE_SIZE = 64;
const TILE_AREA = TILE_SIZE * TILE_SIZE;
const FOUR_NEIGHBORS = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
] as const;

export interface DitherStatistics {
  eligiblePixels: number;
  eligibleFraction: number;
  changedSamples: number;
  sumDelta: number;
  meanDelta: number;
}

export interface DitherResult extends DitherStatistics {
  image: ImageData;
  mask: Uint8Array;
  seed: number;
}

function validateImage(image: ImageData): { width: number; height: number; pixels: number } {
  const { width, height, data } = image;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RangeError("La imagen necesita dimensiones enteras positivas.");
  }
  if (width > Math.floor(Number.MAX_SAFE_INTEGER / height)) {
    throw new RangeError("Las dimensiones de la imagen exceden el límite seguro.");
  }
  const pixels = width * height;
  if (pixels > Math.floor(Number.MAX_SAFE_INTEGER / 4)) {
    throw new RangeError("La longitud RGBA excede el límite seguro.");
  }
  const expectedLength = pixels * 4;
  if (!(data instanceof Uint8ClampedArray) || data.length !== expectedLength) {
    throw new RangeError(`La imagen requiere exactamente ${expectedLength} bytes RGBA.`);
  }
  return { width, height, pixels };
}

function luma(data: Uint8ClampedArray, pixelIndex: number): number {
  const offset = pixelIndex * 4;
  return (54 * data[offset] + 183 * data[offset + 1] + 19 * data[offset + 2]) >> 8;
}

export function createSmoothMask(image: ImageData): Uint8Array {
  const { width, height, pixels } = validateImage(image);
  const { data } = image;
  const mask = new Uint8Array(pixels);
  if (width < 3 || height < 3) return mask;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const centerPixel = y * width + x;
      const centerOffset = centerPixel * 4;
      const centerLuma = luma(data, centerPixel);
      const centerRg = data[centerOffset] - data[centerOffset + 1];
      const centerBg = data[centerOffset + 2] - data[centerOffset + 1];
      let localMin = 255;
      let localMax = 0;
      let eligible = true;

      for (let localY = -1; localY <= 1 && eligible; localY += 1) {
        for (let localX = -1; localX <= 1; localX += 1) {
          const pixel = (y + localY) * width + x + localX;
          const offset = pixel * 4;
          if (data[offset + 3] !== 255) {
            eligible = false;
            break;
          }
          const value = luma(data, pixel);
          if (value < localMin) localMin = value;
          if (value > localMax) localMax = value;
        }
      }
      if (!eligible || localMax - localMin > 12) continue;

      for (const [dx, dy] of FOUR_NEIGHBORS) {
        const neighborPixel = (y + dy) * width + x + dx;
        const neighborOffset = neighborPixel * 4;
        if (Math.abs(luma(data, neighborPixel) - centerLuma) > 6) {
          eligible = false;
          break;
        }
        for (let channel = 0; channel < 3; channel += 1) {
          if (Math.abs(data[neighborOffset + channel] - data[centerOffset + channel]) > 12) {
            eligible = false;
            break;
          }
        }
        if (!eligible) break;
        const neighborRg = data[neighborOffset] - data[neighborOffset + 1];
        const neighborBg = data[neighborOffset + 2] - data[neighborOffset + 1];
        if (
          Math.abs(neighborRg - centerRg) > 8 ||
          Math.abs(neighborBg - centerBg) > 8
        ) {
          eligible = false;
          break;
        }
      }
      if (eligible) mask[centerPixel] = 1;
    }
  }
  return mask;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function transformedRank(
  localX: number,
  localY: number,
  seed: number,
  tileX: number,
  tileY: number,
): number {
  const mixed = mix32(
    seed ^
      Math.imul(tileX + 1, 0x9e3779b1) ^
      Math.imul(tileY + 1, 0x85ebca77) ^
      0xc2b2ae3d,
  );
  let x = (localX + ((mixed >>> 8) & 63)) & 63;
  let y = (localY + ((mixed >>> 16) & 63)) & 63;
  if (mixed & 1) x = 63 - x;
  if (mixed & 2) y = 63 - y;
  if (mixed & 4) [x, y] = [y, x];
  const rank = BLUE_NOISE_RANKS[y * TILE_SIZE + x];
  return (rank + (mixed & 4095)) & 4095;
}

function makeImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  colorSpace: PredefinedColorSpace,
): ImageData {
  if (typeof ImageData !== "undefined") {
    const nativeData = Uint8ClampedArray.from(data);
    try {
      return new ImageData(nativeData, width, height, { colorSpace });
    } catch {
      // Older engines may not accept the color-space options object.
      try {
        return new ImageData(nativeData, width, height);
      } catch {
        // Tests and non-DOM runtimes use the structural fallback below.
      }
    }
  }
  return { data, width, height, colorSpace } as ImageData;
}

export function applyAdaptiveDither(image: ImageData, seed: number): DitherResult {
  const { width, height, pixels } = validateImage(image);
  if (!Number.isFinite(seed) || !Number.isInteger(seed)) {
    throw new RangeError("La semilla debe ser un entero finito.");
  }
  const normalizedSeed = seed >>> 0;
  const mask = createSmoothMask(image);
  const output = new Uint8ClampedArray(image.data);
  let eligiblePixels = 0;
  for (const value of mask) eligiblePixels += value;
  let changedPixels = 0;
  let sumDelta = 0;

  const canShiftTogether = (pixel: number): boolean => {
    const offset = pixel * 4;
    return (
      mask[pixel] === 1 &&
      image.data[offset] > 0 &&
      image.data[offset] < 255 &&
      image.data[offset + 1] > 0 &&
      image.data[offset + 1] < 255 &&
      image.data[offset + 2] > 0 &&
      image.data[offset + 2] < 255
    );
  };
  const boundaryUsed = new Uint8Array(pixels);
  const bridgeBoundary = (
    first: number,
    second: number,
    coherentSign: number,
  ): void => {
    if (
      (mix32(normalizedSeed ^ Math.imul(first + 1, 0x9e3779b1)) & 7) === 7
    ) {
      return;
    }
    if (
      boundaryUsed[first] ||
      boundaryUsed[second] ||
      !canShiftTogether(first) ||
      !canShiftTogether(second)
    ) {
      return;
    }
    const firstLuma = luma(image.data, first);
    const secondLuma = luma(image.data, second);
    const signedStep = secondLuma - firstLuma;
    if (signedStep === 0 || Math.sign(signedStep) !== coherentSign) return;
    const firstDelta = firstLuma < secondLuma ? 1 : -1;
    const firstOffset = first * 4;
    const secondOffset = second * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      output[firstOffset + channel] = image.data[firstOffset + channel] + firstDelta;
      output[secondOffset + channel] = image.data[secondOffset + channel] - firstDelta;
      sumDelta += firstDelta;
      sumDelta -= firstDelta;
    }
    boundaryUsed[first] = 1;
    boundaryUsed[second] = 1;
    changedPixels += 2;
  };

  // In smooth regions, gently bridge existing one-level steps that coincide
  // with common JPEG boundaries. Pairs stay inside a 64x64 tile, are
  // achromatic, and contribute an exact zero RGB sum.
  for (let x = 7; x + 1 < width; x += 8) {
    if ((x & 63) === 63) continue;
    for (let segmentY = 0; segmentY < height; segmentY += 8) {
      const startY = Math.max(1, segmentY);
      const endY = Math.min(height - 1, segmentY + 8);
      let signedSum = 0;
      for (let y = startY; y < endY; y += 1) {
        const first = y * width + x;
        const second = first + 1;
        if (canShiftTogether(first) && canShiftTogether(second)) {
          signedSum += luma(image.data, second) - luma(image.data, first);
        }
      }
      const coherentSign = Math.sign(signedSum);
      if (coherentSign === 0) continue;
      for (let y = startY; y < endY; y += 1) {
        bridgeBoundary(y * width + x, y * width + x + 1, coherentSign);
      }
    }
  }
  for (let y = 7; y + 1 < height; y += 8) {
    if ((y & 63) === 63) continue;
    for (let segmentX = 0; segmentX < width; segmentX += 8) {
      const startX = Math.max(1, segmentX);
      const endX = Math.min(width - 1, segmentX + 8);
      let signedSum = 0;
      for (let x = startX; x < endX; x += 1) {
        const first = y * width + x;
        const second = first + width;
        if (canShiftTogether(first) && canShiftTogether(second)) {
          signedSum += luma(image.data, second) - luma(image.data, first);
        }
      }
      const coherentSign = Math.sign(signedSum);
      if (coherentSign === 0) continue;
      for (let x = startX; x < endX; x += 1) {
        bridgeBoundary(y * width + x, (y + 1) * width + x, coherentSign);
      }
    }
  }

  const tileRows = Math.ceil(height / TILE_SIZE);
  const tileColumns = Math.ceil(width / TILE_SIZE);
  for (let tileY = 0; tileY < tileRows; tileY += 1) {
    const startY = tileY * TILE_SIZE;
    const endY = Math.min(height, startY + TILE_SIZE);
    for (let tileX = 0; tileX < tileColumns; tileX += 1) {
      const startX = tileX * TILE_SIZE;
      const endX = Math.min(width, startX + TILE_SIZE);
      const pixelByRank = new Int32Array(TILE_AREA);
      const blockByRank = new Uint8Array(TILE_AREA);
      pixelByRank.fill(-1);
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const pixel = y * width + x;
          if (!mask[pixel] || boundaryUsed[pixel]) continue;
          const offset = pixel * 4;
          // A shared RGB delta keeps both chroma axes exactly unchanged before
          // 4:2:0 subsampling. If any channel is saturated, skip the pixel.
          if (
            image.data[offset] === 0 ||
            image.data[offset] === 255 ||
            image.data[offset + 1] === 0 ||
            image.data[offset + 1] === 255 ||
            image.data[offset + 2] === 0 ||
            image.data[offset + 2] === 255
          ) {
            continue;
          }
          const rank = transformedRank(
            x - startX,
            y - startY,
            normalizedSeed,
            tileX,
            tileY,
          );
          pixelByRank[rank] = pixel;
          blockByRank[rank] =
            ((y - startY) >>> 3) * 8 + ((x - startX) >>> 3);
        }
      }
      // Pair inside each 8x8 encoder cell. Every cell and every RGB channel
      // retain an exact zero delta sum, so the cell DC and chroma stay stable.
      const pendingByBlock = new Int32Array(64);
      const pairIndexByBlock = new Uint16Array(64);
      pendingByBlock.fill(-1);
      for (let rank = 0; rank < TILE_AREA; rank += 1) {
        const pixel = pixelByRank[rank];
        if (pixel < 0) continue;
        const block = blockByRank[rank];
        const pendingPixel = pendingByBlock[block];
        if (pendingPixel < 0) {
          pendingByBlock[block] = pixel;
          continue;
        }
        const phase =
          mix32(
            normalizedSeed ^
              Math.imul(tileX + 1, 0x27d4eb2d) ^
              Math.imul(tileY + 1, 0x165667b1) ^
              Math.imul(block + 1, 0x9e3779b1),
          ) & 1;
        const firstDelta = (pairIndexByBlock[block] + phase) & 1 ? -1 : 1;
        const firstOffset = pendingPixel * 4;
        const secondOffset = pixel * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          output[firstOffset + channel] = image.data[firstOffset + channel] + firstDelta;
          output[secondOffset + channel] = image.data[secondOffset + channel] - firstDelta;
          sumDelta += firstDelta;
          sumDelta -= firstDelta;
        }
        changedPixels += 2;
        pendingByBlock[block] = -1;
        pairIndexByBlock[block] += 1;
      }
    }
  }

  const colorSpace = image.colorSpace === "display-p3" ? "display-p3" : "srgb";
  const changedSamples = changedPixels * 3;
  return {
    image: makeImageData(output, width, height, colorSpace),
    mask,
    seed: normalizedSeed,
    eligiblePixels,
    eligibleFraction: eligiblePixels / pixels,
    changedSamples,
    sumDelta,
    meanDelta: changedSamples === 0 ? 0 : sumDelta / changedSamples,
  };
}
