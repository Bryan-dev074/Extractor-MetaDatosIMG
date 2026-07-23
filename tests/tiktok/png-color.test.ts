import { describe, expect, it } from "vitest";
import {
  CANONICAL_CHRM,
  normalizeTikTokPng,
  parseTikTokPng,
} from "@/lib/tiktok/png-color";
import { PNG_SIGNATURE, chunk, concat, png, u32 } from "./fixtures";

describe("normalizeTikTokPng", () => {
  it("replaces conflicting and duplicate color/HDR/EXIF chunks canonically", () => {
    const idat = Uint8Array.of(9, 8, 7, 6, 5);
    const source = png(
      [
        chunk("sRGB", Uint8Array.of(2)),
        chunk("gAMA", u32(100000)),
        chunk("cHRM", new Uint8Array(32).fill(3)),
        chunk("sRGB", Uint8Array.of(1)),
        chunk("iCCP", Uint8Array.of(1, 0, 0, 1)),
        chunk("cICP", Uint8Array.of(9, 16, 0, 1)),
        chunk("mDCV", new Uint8Array(24)),
        chunk("cLLI", new Uint8Array(8)),
        chunk("eXIf", Uint8Array.of(1, 2)),
      ],
      idat,
    );

    const normalized = normalizeTikTokPng(source, { width: 3, height: 2 });
    const parsed = parseTikTokPng(normalized, { width: 3, height: 2, canonical: true });

    expect(parsed.chunks.map((entry) => entry.type)).toEqual([
      "IHDR",
      "cHRM",
      "gAMA",
      "sRGB",
      "IDAT",
      "IEND",
    ]);
    expect(parsed.idatPayloads).toEqual([idat]);
    expect(parsed.chunks.find((entry) => entry.type === "cHRM")?.data).toEqual(
      CANONICAL_CHRM,
    );
    expect(parsed.chunks.find((entry) => entry.type === "gAMA")?.data).toEqual(u32(45455));
    expect(parsed.chunks.find((entry) => entry.type === "sRGB")?.data).toEqual(
      Uint8Array.of(0),
    );
  });

  it("preserves IDAT bytes and safe ancillary chunks exactly", () => {
    const first = Uint8Array.of(1, 2, 3);
    const second = Uint8Array.of(4, 5, 6);
    const source = concat(
      PNG_SIGNATURE,
      chunk("IHDR", concat(u32(3), u32(2), Uint8Array.of(8, 2, 0, 0, 0))),
      chunk("pHYs", concat(u32(1), u32(1), Uint8Array.of(0))),
      chunk("IDAT", first),
      chunk("IDAT", second),
      chunk("IEND"),
    );

    const normalized = normalizeTikTokPng(source, { width: 3, height: 2 });
    const parsed = parseTikTokPng(normalized, { width: 3, height: 2, canonical: true });
    expect(parsed.idatPayloads).toEqual([first, second]);
    expect(parsed.chunks.find((entry) => entry.type === "pHYs")?.data).toEqual(
      concat(u32(1), u32(1), Uint8Array.of(0)),
    );
  });

  it.each([
    ["corrupt CRC", () => {
      const bytes = png();
      bytes[bytes.length - 1] ^= 0xff;
      return bytes;
    }],
    ["truncation", () => png().slice(0, -3)],
    ["unknown critical", () => png([chunk("ABCD", Uint8Array.of(1))])],
    ["bad order", () => concat(PNG_SIGNATURE, chunk("IDAT", Uint8Array.of(1)), chunk("IEND"))],
    ["noncontiguous IDAT", () =>
      concat(
        PNG_SIGNATURE,
        chunk("IHDR", concat(u32(3), u32(2), Uint8Array.of(8, 6, 0, 0, 0))),
        chunk("IDAT", Uint8Array.of(1)),
        chunk("tEXt", Uint8Array.of(1)),
        chunk("IDAT", Uint8Array.of(2)),
        chunk("IEND"),
      )],
    ["trailing data", () => concat(png(), Uint8Array.of(0))],
    ["color declaration after IDAT", () =>
      concat(
        PNG_SIGNATURE,
        chunk("IHDR", concat(u32(3), u32(2), Uint8Array.of(8, 6, 0, 0, 0))),
        chunk("IDAT", Uint8Array.of(1)),
        chunk("gAMA", u32(45455)),
        chunk("IEND"),
      )],
  ] as const)("rejects %s", (_label, makeBytes) => {
    expect(() => normalizeTikTokPng(makeBytes(), { width: 3, height: 2 })).toThrow();
  });

  it.each([
    ["bKGD after IDAT", () =>
      concat(
        png().slice(0, 33),
        chunk("IDAT", Uint8Array.of(1)),
        chunk("bKGD", new Uint8Array(6)),
        chunk("IEND"),
      )],
    ["tRNS after IDAT", () =>
      concat(
        png([], undefined, 2).slice(0, 33),
        chunk("IDAT", Uint8Array.of(1)),
        chunk("tRNS", new Uint8Array(6)),
        chunk("IEND"),
      )],
    ["pHYs after IDAT", () =>
      concat(
        png().slice(0, 33),
        chunk("IDAT", Uint8Array.of(1)),
        chunk("pHYs", concat(u32(1), u32(1), Uint8Array.of(0))),
        chunk("IEND"),
      )],
    ["sPLT after IDAT", () =>
      concat(
        png().slice(0, 33),
        chunk("IDAT", Uint8Array.of(1)),
        chunk("sPLT", Uint8Array.of(110, 0, 8, 1, 2, 3, 4, 5, 0, 1)),
        chunk("IEND"),
      )],
    ["sBIT after PLTE", () =>
      png([
        chunk("PLTE", Uint8Array.of(1, 2, 3)),
        chunk("sBIT", Uint8Array.of(8, 8, 8, 8)),
      ])],
    ["bKGD before PLTE", () =>
      png([
        chunk("bKGD", new Uint8Array(6)),
        chunk("PLTE", Uint8Array.of(1, 2, 3)),
      ])],
    ["hIST without PLTE", () => png([chunk("hIST", Uint8Array.of(0, 1))])],
    ["hIST before PLTE", () =>
      png([
        chunk("hIST", Uint8Array.of(0, 1)),
        chunk("PLTE", Uint8Array.of(1, 2, 3)),
      ])],
    ["hIST length not matching PLTE", () =>
      png([
        chunk("PLTE", Uint8Array.of(1, 2, 3, 4, 5, 6)),
        chunk("hIST", Uint8Array.of(0, 1)),
      ])],
    ["tRNS with RGBA", () => png([chunk("tRNS", new Uint8Array(6))])],
    ["duplicate pHYs", () =>
      png([
        chunk("pHYs", concat(u32(1), u32(1), Uint8Array.of(0))),
        chunk("pHYs", concat(u32(1), u32(1), Uint8Array.of(0))),
      ])],
  ] as const)("rejects known ancillary violation: %s", (_label, makeBytes) => {
    expect(() => normalizeTikTokPng(makeBytes(), { width: 3, height: 2 })).toThrow();
  });

  it.each([
    ["bit depth", png([], undefined, 6).map((value, index) => (index === 24 ? 16 : value))],
    ["indexed color", png([], undefined, 3)],
  ] as const)("rejects unsupported static PNG %s", (_label, bytes) => {
    // Rebuild CRC when mutating the IHDR bit depth so this fails semantically.
    if (_label === "bit depth") {
      const source = png([], undefined, 6);
      const ihdr = source.slice(16, 29);
      ihdr[8] = 16;
      expect(() =>
        normalizeTikTokPng(
          concat(PNG_SIGNATURE, chunk("IHDR", ihdr), source.slice(33)),
          { width: 3, height: 2 },
        ),
      ).toThrow(/8 bits/i);
      return;
    }
    expect(() => normalizeTikTokPng(bytes, { width: 3, height: 2 })).toThrow(/RGB/i);
  });
});
