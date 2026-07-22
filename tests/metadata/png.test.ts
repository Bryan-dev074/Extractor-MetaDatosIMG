// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cleanBytes } from "@/lib/metadata";
import {
  apngWithAiText,
  extractPngPayloads,
  pngChunks,
  pngWithC2pa,
  pngWithColorAndDensity,
  pngWithCompressedInternationalText,
  pngWithCompressedText,
  pngWithInvalidOrder,
  pngWithHighBitField,
  pngWithMalformedText,
  pngWithText,
  pngWithUnknownChunk,
} from "@/tests/fixtures/images";

describe("strict lossless PNG cleaning", () => {
  it("rejects a PNG with an invalid CRC", () => {
    const png = pngWithText("parameters", "Steps: 30");
    png[png.length - 1] ^= 0xff;
    expect(() => cleanBytes(png)).toThrow("CRC PNG inválido");
  });

  it("preserves every IDAT byte and APNG fdAT byte", () => {
    const source = apngWithAiText();
    const result = cleanBytes(source.bytes);

    expect(extractPngPayloads(result.cleaned)).toEqual(source.pixelPayloads);
    expect(result.findings).toHaveLength(1);
    expect(result.qualityVerified).toBe(true);
    expect(result.outputExtension).toBe(".png");
    expect(result.pixelPayloadHash).toMatch(/^crc32:[0-9a-f]{8}:12$/);
  });

  it("preserves APNG structures and color/density structures byte-for-byte", () => {
    const apng = apngWithAiText();
    const apngResult = cleanBytes(apng.bytes);
    for (const type of ["acTL", "fcTL", "fdAT"]) {
      expect(pngChunks(apngResult.cleaned, type)).toEqual(pngChunks(apng.bytes, type));
    }

    const color = pngWithColorAndDensity();
    const colorResult = cleanBytes(color);
    for (const type of ["sRGB", "gAMA", "pHYs"]) {
      expect(pngChunks(colorResult.cleaned, type)).toEqual(pngChunks(color, type));
    }
  });

  it("preserves unknown ancillary chunks byte-for-byte without text scanning", () => {
    const source = pngWithUnknownChunk("vpAg", "Midjourney private payload");
    const result = cleanBytes(source);

    expect(pngChunks(result.cleaned, "vpAg")).toEqual(pngChunks(source, "vpAg"));
    expect(result.findings).toHaveLength(0);
  });

  it("rejects unknown critical chunks", () => {
    expect(() => cleanBytes(pngWithUnknownChunk("VpAg", "private"))).toThrow(
      "Chunk crítico PNG desconocido",
    );
  });

  it("bounds compressed metadata expansion", () => {
    for (const source of [
      pngWithCompressedText(1_048_576),
      pngWithCompressedInternationalText(1_048_576),
    ]) {
      expect(() => cleanBytes(source)).toThrow("Texto PNG excede el límite seguro");
    }
  });

  it("rejects malformed compressed text before deciding whether to remove it", () => {
    for (const kind of [
      "ztxt-corrupt",
      "ztxt-method",
      "ztxt-separator",
      "itxt-method",
      "itxt-separator",
      "ztxt-trailing",
      "itxt-trailing",
      "ztxt-concatenated",
    ] as const) {
      expect(() => cleanBytes(pngWithMalformedText(kind))).toThrow("Texto PNG inválido");
    }
  });

  it("removes supported C2PA and AI text chunks, then strictly reparses output", () => {
    for (const source of [pngWithC2pa(), pngWithText("parameters", "Steps: 30")]) {
      const result = cleanBytes(source);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(() => cleanBytes(result.cleaned)).not.toThrow();
      expect(result.qualityVerified).toBe(true);
    }
  });

  it("rejects truncation and missing required critical chunks", () => {
    const source = pngWithText("comment", "ordinary");
    expect(() => cleanBytes(source.slice(0, -3))).toThrow("PNG truncado");

    const noIdat = new Uint8Array([
      ...source.slice(0, 8 + 25),
      ...source.slice(source.length - 12),
    ]);
    expect(() => cleanBytes(noIdat)).toThrow("PNG sin datos de imagen");
  });

  it("validates CRC even for a chunk that would otherwise be removed", () => {
    const source = pngWithC2pa();
    const chunk = pngChunks(source, "caBX")[0];
    const chunkOffset = source.findIndex((_, index) =>
      source.slice(index, index + chunk.length).every((value, inner) => value === chunk[inner]),
    );
    source[chunkOffset + chunk.length - 1] ^= 0xff;
    expect(() => cleanBytes(source)).toThrow("CRC PNG inválido");
  });

  it("enforces IHDR, PLTE, contiguous IDAT, IEND, and trailing-byte rules", () => {
    for (const kind of [
      "duplicate-ihdr",
      "plte-after-idat",
      "noncontiguous-idat",
      "missing-plte",
      "trailing",
      "color-after-plte",
      "duplicate-phys",
      "reserved-bit",
      "apng-frame-count",
      "plte-too-large",
      "trns-before-plte",
      "trns-with-alpha",
      "invalid-gama-length",
      "apng-frame-without-data",
      "fdat-without-active-fctl",
      "invalid-dispose-op",
      "invalid-blend-op",
    ] as const) {
      expect(() => cleanBytes(pngWithInvalidOrder(kind))).toThrow(/PNG/);
    }
  });

  it("rejects PNG chunk lengths and IHDR dimensions with the unsigned high bit set", () => {
    for (const kind of ["chunk-length", "width", "height"] as const) {
      expect(() => cleanBytes(pngWithHighBitField(kind))).toThrow(
        "PNG fuera del rango de 31 bits",
      );
    }
  });
});
