// @vitest-environment node
import { describe, expect, it } from "vitest";
import { detectImageFormat, extensionForFormat } from "@/lib/metadata/format";

describe("image format detection", () => {
  it("uses magic bytes instead of the filename", () => {
    expect(detectImageFormat(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
    expect(
      detectImageFormat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    ).toBe("png");
    expect(detectImageFormat(Uint8Array.of(0x52, 0x49, 0x46, 0x46))).toBeNull();
    expect(detectImageFormat(Uint8Array.of(0xff, 0xd8))).toBeNull();
    expect(detectImageFormat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBeNull();
    expect(extensionForFormat("jpeg")).toBe(".jpg");
    expect(extensionForFormat("png")).toBe(".png");
  });
});
