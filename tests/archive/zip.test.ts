import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeFiles } from "@/lib/batch/input";
import {
  assertBlobBudget,
  estimateArchiveSize,
  generateArchive,
  getSafeMemoryBudget,
  planArchive,
  preflightArchive,
  requestArchiveWriter,
  type ArchiveOutput,
  type ArchivePlan,
  type ArchiveWriter,
} from "@/lib/archive/zip";

function output(overrides: Partial<ArchiveOutput> = {}): ArchiveOutput {
  return {
    id: "id-1",
    relativePath: "Raíz/Sub/foto.jpg",
    bytes: Uint8Array.of(1, 2, 3, 4),
    outputExtension: ".jpg",
    qualityVerified: true,
    ...overrides,
  };
}

function plan(outputs: ArchiveOutput[] = [output()]): ArchivePlan {
  return planArchive(
    {
      archiveBase: "Raíz",
      outputs,
      skipped: [{ relativePath: "Raíz/no-imagen.txt", reason: "No soportado" }],
      failed: [{ id: "bad", relativePath: "Raíz/rota.jpg", error: "JPEG truncado" }],
    },
    "clean",
  );
}

function setDeviceMemory(value: unknown): void {
  Object.defineProperty(navigator, "deviceMemory", {
    configurable: true,
    value,
  });
}

function clearPicker(): void {
  Reflect.deleteProperty(window, "showSaveFilePicker");
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "deviceMemory");
  clearPicker();
});

describe("archive generation", () => {
  it("round-trips nested successful bytes and the deterministic report using STORE", async () => {
    const archive = await generateArchive(plan(), {
      destination: { kind: "blob" },
    });

    expect(archive.kind).toBe("blob");
    if (archive.kind !== "blob") throw new Error("Expected Blob archive");
    const bytes = new Uint8Array(await archive.blob.arrayBuffer());
    const opened = await JSZip.loadAsync(bytes);

    expect(
      await opened.file("Raíz/Sub/foto-limpio.jpg")!.async("uint8array"),
    ).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(
      await opened.file("Raíz/_reporte-procesamiento.txt")!.async("string"),
    ).toContain("ERROR\tRaíz/rota.jpg\tJPEG truncado");

    for (let offset = 0; offset + 10 < bytes.length; offset += 1) {
      if (
        bytes[offset] === 0x50 &&
        bytes[offset + 1] === 0x4b &&
        bytes[offset + 2] === 0x03 &&
        bytes[offset + 3] === 0x04
      ) {
        expect(bytes[offset + 8]).toBe(0);
        expect(bytes[offset + 9]).toBe(0);
      }
      if (
        bytes[offset] === 0x50 &&
        bytes[offset + 1] === 0x4b &&
        bytes[offset + 2] === 0x01 &&
        bytes[offset + 3] === 0x02
      ) {
        expect(bytes[offset + 10]).toBe(0);
        expect(bytes[offset + 11]).toBe(0);
      }
    }
  });

  it("generates identical bytes for equivalent plans", async () => {
    const first = await generateArchive(plan(), { destination: { kind: "blob" } });
    const second = await generateArchive(plan(), { destination: { kind: "blob" } });
    if (first.kind !== "blob" || second.kind !== "blob") {
      throw new Error("Expected Blob archives");
    }

    expect(new Uint8Array(await first.blob.arrayBuffer())).toEqual(
      new Uint8Array(await second.blob.arrayBuffer()),
    );
  });

  it("writes direct and Blob destinations with equivalent entries", async () => {
    const chunks: Uint8Array[] = [];
    const writer: ArchiveWriter = {
      write: async (chunk) => {
        chunks.push(chunk.slice());
      },
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };

    const direct = await generateArchive(plan(), {
      destination: { kind: "writer", writer },
    });
    const blob = await generateArchive(plan(), {
      destination: { kind: "blob" },
    });
    if (blob.kind !== "blob") throw new Error("Expected Blob archive");

    const directZip = await JSZip.loadAsync(
      new Blob(chunks.map((chunk) => Uint8Array.from(chunk).buffer)).arrayBuffer(),
    );
    const blobZip = await JSZip.loadAsync(blob.blob);
    expect(Object.keys(directZip.files)).toEqual(Object.keys(blobZip.files));
    expect(direct.kind).toBe("writer");
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(writer.abort).not.toHaveBeenCalled();
  });

  it("serializes direct writes with backpressure and emits 100 only after close", async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    const events: string[] = [];
    const progress: number[] = [];
    const writer: ArchiveWriter = {
      write: async () => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
      close: async () => {
        events.push("close");
      },
      abort: vi.fn().mockResolvedValue(undefined),
    };

    await generateArchive(
      plan([
        output({ id: "a", bytes: new Uint8Array(200_000).fill(1) }),
        output({
          id: "b",
          relativePath: "Raíz/Sub/otra.png",
          outputExtension: ".png",
          bytes: new Uint8Array(200_000).fill(2),
        }),
      ]),
      {
        destination: { kind: "writer", writer },
        onProgress(value) {
          progress.push(value);
          if (value === 100) events.push("100");
        },
      },
    );

    expect(maximumInFlight).toBe(1);
    expect(progress.at(-1)).toBe(100);
    expect(progress.slice(0, -1).every((value) => value < 100)).toBe(true);
    expect(events.slice(-2)).toEqual(["close", "100"]);
  });

  it("aborts exactly once and settles promptly when cancellation occurs during a write", async () => {
    const controller = new AbortController();
    let resolveWrite!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writer: ArchiveWriter = {
      write: () => {
        resolveWrite();
        return pendingWrite;
      },
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const progress = vi.fn();

    const pending = generateArchive(plan(), {
      destination: { kind: "writer", writer },
      signal: controller.signal,
      onProgress: progress,
    });
    await writeStarted;
    controller.abort();

    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 100),
        ),
      ]),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(writer.abort).toHaveBeenCalledTimes(1);
    expect(writer.close).not.toHaveBeenCalled();
    const terminalCount = progress.mock.calls.length;
    releaseWrite();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(progress).toHaveBeenCalledTimes(terminalCount);
  });

  it("aborts an already-open writer when cancellation or preflight failure happens before streaming", async () => {
    const cancelledWriter: ArchiveWriter = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new AbortController();
    controller.abort();

    await expect(
      generateArchive(plan(), {
        destination: { kind: "writer", writer: cancelledWriter },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelledWriter.abort).toHaveBeenCalledTimes(1);

    const invalidWriter: ArchiveWriter = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const basePlan = plan();
    const invalidPlan = {
      ...basePlan,
      entries: Array.from({ length: 65_535 }, () => basePlan.entries[0]),
    };
    await expect(
      generateArchive(invalidPlan, {
        destination: { kind: "writer", writer: invalidWriter },
      }),
    ).rejects.toThrow(/ZIP32|65.?535/i);
    expect(invalidWriter.abort).toHaveBeenCalledTimes(1);
  });

  it("closes once before final progress and aborts once if final progress fails", async () => {
    const error = new Error("falló progreso final");
    const writer: ArchiveWriter = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      generateArchive(plan(), {
        destination: { kind: "writer", writer },
        onProgress(value) {
          if (value === 100) throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(writer.abort).toHaveBeenCalledTimes(1);
  });

  it("does not report success when final progress triggers cancellation", async () => {
    const controller = new AbortController();
    const writer: ArchiveWriter = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      generateArchive(plan(), {
        destination: { kind: "writer", writer },
        signal: controller.signal,
        onProgress(value) {
          if (value === 100) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(writer.abort).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["write", "falló escritura"],
    ["close", "falló cierre"],
    ["progress", "falló progreso"],
  ] as const)("aborts once and preserves a %s error", async (failure, message) => {
    const error = new Error(message);
    const writer: ArchiveWriter = {
      write: failure === "write" ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(undefined),
      close: failure === "close" ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockRejectedValue(new Error("falló abort")),
    };

    await expect(
      generateArchive(plan(), {
        destination: { kind: "writer", writer },
        onProgress:
          failure === "progress"
            ? () => {
                throw error;
              }
            : undefined,
      }),
    ).rejects.toBe(error);
    expect(writer.abort).toHaveBeenCalledTimes(1);
    expect(writer.close).toHaveBeenCalledTimes(failure === "close" ? 1 : failure === "progress" ? 0 : 0);
  });
});

describe("archive preflight", () => {
  it("allows an exact Blob peak budget and rejects one byte above it", () => {
    const archivePlan = plan();
    const estimate = estimateArchiveSize(archivePlan);

    expect(() => assertBlobBudget(archivePlan, estimate.peakBlobBytes)).not.toThrow();
    expect(() =>
      assertBlobBudget(archivePlan, estimate.peakBlobBytes - 1),
    ).toThrow(/memoria|lote/i);
  });

  it("uses the conservative device-memory budget and falls back for invalid values", () => {
    const fallback = 512 * 1024 ** 2;
    for (const value of [undefined, Number.NaN, Infinity, -1, 0, "8"]) {
      setDeviceMemory(value);
      expect(getSafeMemoryBudget()).toBe(fallback);
    }

    setDeviceMemory(2);
    expect(getSafeMemoryBudget()).toBe(256 * 1024 ** 2);
    setDeviceMemory(32);
    expect(getSafeMemoryBudget()).toBe(1024 ** 3);
  });

  it("rejects ZIP32 entry-count, UTF-8-name, size and safe-integer overflow", () => {
    const base = plan();
    const entry = base.entries[0];

    expect(() =>
      preflightArchive({
        ...base,
        entries: Array.from({ length: 65_535 }, () => entry),
      }),
    ).toThrow(/65.?535|ZIP32/i);

    expect(() =>
      preflightArchive({
        ...base,
        entries: [{ ...entry, path: `${"á".repeat(32_768)}.jpg` }],
      }),
    ).toThrow(/nombre|ZIP32/i);

    expect(() =>
      preflightArchive({
        ...base,
        entries: [
          {
            ...entry,
            bytes: { byteLength: 0xffff_ffff } as Uint8Array,
          },
        ],
      }),
    ).toThrow(/tamaño|ZIP32/i);

    expect(() =>
      preflightArchive({
        ...base,
        entries: [
          {
            ...entry,
            bytes: { byteLength: Number.MAX_SAFE_INTEGER } as Uint8Array,
          },
          {
            ...entry,
            path: "Raíz/otra.jpg",
            bytes: { byteLength: 1 } as Uint8Array,
          },
        ],
      }),
    ).toThrow(/seguro|ZIP32/i);
  });

  it("rejects Blob fallback before generation when the conservative budget is exceeded", async () => {
    setDeviceMemory(Number.MIN_VALUE);
    await expect(
      generateArchive(plan(), { destination: { kind: "blob" } }),
    ).rejects.toThrow(/lote|memoria/i);
  });

  it("refuses ingestion that exceeds the retained-byte budget", async () => {
    setDeviceMemory(0.000_001);
    const fakeFile = (name: string): File =>
      ({
        name,
        size: 100,
        lastModified: 1,
        type: "",
        webkitRelativePath: "",
        slice: () => new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)]),
      }) as File;

    await expect(
      normalizeFiles([fakeFile("a.jpg"), fakeFile("b.jpg")], "files"),
    ).rejects.toThrow(/lotes más pequeños/i);
  });
});

describe("requestArchiveWriter", () => {
  it("invokes the picker synchronously and adapts its writer", async () => {
    const nativeWriter = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const picker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue(nativeWriter),
    });
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: picker,
    });

    const pending = requestArchiveWriter("Raíz.zip");
    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: "Raíz.zip" }),
    );

    const result = await pending;
    expect(result.kind).toBe("writer");
    if (result.kind !== "writer") throw new Error("Expected writer");
    await result.writer.write(Uint8Array.of(1));
    await result.writer.close();
    await result.writer.abort("cancel");
    expect(nativeWriter.write).toHaveBeenCalledTimes(1);
    expect(nativeWriter.close).toHaveBeenCalledTimes(1);
    expect(nativeWriter.abort).toHaveBeenCalledWith("cancel");
  });

  it("distinguishes unsupported browsers and user cancellation", async () => {
    clearPicker();
    await expect(requestArchiveWriter("salida.zip")).resolves.toEqual({
      kind: "unsupported",
    });

    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: vi.fn().mockRejectedValue(new DOMException("cancel", "AbortError")),
    });
    await expect(requestArchiveWriter("salida.zip")).resolves.toEqual({
      kind: "cancelled",
    });
  });

  it("does not disguise picker failures as unsupported", async () => {
    const error = new Error("permiso denegado");
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: vi.fn().mockRejectedValue(error),
    });

    await expect(requestArchiveWriter("salida.zip")).rejects.toBe(error);
  });
});
