// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cleanBytes, cleanImage, crc32 } from "@/lib/metadata";
import { jpegWithComment, pngWithText } from "@/tests/fixtures/images";

describe("metadata cleaning facade", () => {
  it("rejects unsupported magic bytes", () => {
    expect(() => cleanBytes(Uint8Array.of(0x47, 0x49, 0x46, 0x38))).toThrow(
      "Formato no soportado. Usa JPEG o PNG.",
    );
  });

  it("cleans File-like input based on bytes and derives its output extension", async () => {
    const bytes = pngWithText("parameters", "Steps: 30");
    const file = { arrayBuffer: async () => bytes.slice().buffer } as File;
    const result = await cleanImage(file);

    expect(result.format).toBe("png");
    expect(result.outputExtension).toBe(".png");
    expect(result.originalSize).toBe(bytes.length);
  });

  it("exposes a deterministic unsigned CRC32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("uses byte length in the display hash instead of trusting a digest alone", () => {
    const source = jpegWithComment("ordinary comment");
    const result = cleanBytes(source.bytes);
    const payloadLength = result.pixelPayloadHash.split(":")[2];

    expect(payloadLength).toBe("7");
    expect(result.qualityVerified).toBe(true);
  });
});

