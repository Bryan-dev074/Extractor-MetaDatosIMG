// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { cleanImage } from "@/lib/metadata";
import { MAX_INPUT_BYTES, assertInputSize } from "@/lib/metadata/limits";

describe("metadata core input limit", () => {
  it("checks numeric lengths without allocating a buffer at the ceiling", () => {
    expect(() => assertInputSize(MAX_INPUT_BYTES)).not.toThrow();
    expect(() => assertInputSize(MAX_INPUT_BYTES + 1)).toThrow(
      "La imagen excede el límite seguro de 256 MB",
    );
  });

  it("rejects an oversized File before reading its ArrayBuffer", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const file = { size: MAX_INPUT_BYTES + 1, arrayBuffer } as unknown as File;

    await expect(cleanImage(file)).rejects.toThrow(
      "La imagen excede el límite seguro de 256 MB",
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
