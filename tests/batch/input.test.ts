import { describe, expect, it, vi } from "vitest";
import { MAX_INPUT_BYTES } from "@/lib/metadata";
import { normalizeFiles, readDroppedItems } from "@/lib/batch/input";

const JPEG_HEADER = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0);
const PNG_HEADER = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function makeFile(
  name: string,
  options: {
    bytes?: Uint8Array;
    lastModified?: number;
    type?: string;
    webkitRelativePath?: string;
  } = {},
): File {
  const bytes = options.bytes ?? JPEG_HEADER;
  const contents = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const file = new File([contents], name, {
    lastModified: options.lastModified ?? 123,
    type: options.type ?? "application/octet-stream",
  });
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    value: options.webkitRelativePath ?? "",
  });
  return file;
}

function fakeFile(overrides: Partial<File> & Pick<File, "name">): File {
  return {
    lastModified: 123,
    size: 8,
    type: "",
    webkitRelativePath: "",
    slice: () => new Blob([JPEG_HEADER.buffer as ArrayBuffer]),
    ...overrides,
  } as File;
}

type TestEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, error?: (reason: DOMException) => void) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: TestEntry[]) => void,
      error?: (reason: DOMException) => void,
    ) => void;
  };
};

function fileEntry(file: File, delayMs = 0): TestEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    file: (success) => {
      if (delayMs > 0) setTimeout(() => success(file), delayMs);
      else queueMicrotask(() => success(file));
    },
  };
}

function directoryEntry(
  name: string,
  batches: TestEntry[][],
  onRead?: () => void,
  delayMs = 0,
): TestEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (success) => {
        onRead?.();
        const batch = batches.shift() ?? [];
        if (delayMs > 0) setTimeout(() => success(batch), delayMs);
        else queueMicrotask(() => success(batch));
      },
    }),
  };
}

function droppedItems(
  items: Array<{ entry?: TestEntry | null; file?: File | null; exposeEntry?: boolean }>,
): DataTransferItemList {
  const list: Record<number, DataTransferItem> & { length: number; item(index: number): DataTransferItem | null } = {
    length: items.length,
    item(index) {
      return this[index] ?? null;
    },
  };

  items.forEach((value, index) => {
    const item: {
      kind: string;
      type: string;
      getAsFile: () => File | null;
      webkitGetAsEntry?: () => TestEntry | null;
    } = {
      kind: "file",
      type: value.file?.type ?? "",
      getAsFile: () => value.file ?? null,
    };
    if (value.exposeEntry !== false) item.webkitGetAsEntry = () => value.entry ?? null;
    list[index] = item as unknown as DataTransferItem;
  });

  return list as unknown as DataTransferItemList;
}

describe("normalizeFiles", () => {
  it("classifies wrong and missing extensions only from the first eight bytes", async () => {
    const jpegNamedPng = makeFile("equivocada.png", { bytes: JPEG_HEADER, type: "image/png" });
    const extensionlessPng = makeFile("imagen", { bytes: PNG_HEADER, type: "text/plain" });

    const result = await normalizeFiles([extensionlessPng, jpegNamedPng], "files");

    expect(result.accepted.map(({ relativePath, format }) => ({ relativePath, format }))).toEqual([
      { relativePath: "equivocada.png", format: "jpeg" },
      { relativePath: "imagen", format: "png" },
    ]);
  });

  it("reads no more than the first eight bytes", async () => {
    const slice = vi.fn(() => new Blob([PNG_HEADER.buffer as ArrayBuffer]));
    const file = fakeFile({ name: "foto.bin", slice });

    await normalizeFiles([file], "files");

    expect(slice).toHaveBeenCalledOnce();
    expect(slice).toHaveBeenCalledWith(0, 8);
  });

  it("uses webkitRelativePath for selected folders", async () => {
    const file = makeFile("foto.jpg", { webkitRelativePath: "Raíz/Sub/foto.jpg" });

    await expect(normalizeFiles([file], "folder")).resolves.toMatchObject({
      archiveBase: "Raíz",
      accepted: [{ relativePath: "Raíz/Sub/foto.jpg", format: "jpeg" }],
    });
  });

  it("reports unsupported, unreadable, and oversized files with actionable reasons", async () => {
    const fakeJpeg = makeFile("falsa.jpg", { bytes: Uint8Array.of(1, 2, 3) });
    const unreadable = fakeFile({
      name: "rota.png",
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error("permiso denegado")) }) as Blob,
    });
    const slice = vi.fn(() => new Blob([JPEG_HEADER.buffer as ArrayBuffer]));
    const oversized = fakeFile({ name: "gigante.jpg", size: MAX_INPUT_BYTES + 1, slice });

    const result = await normalizeFiles([unreadable, fakeJpeg, oversized], "files");

    expect(result.accepted).toEqual([]);
    expect(result.skipped.map(({ relativePath }) => relativePath)).toEqual([
      "falsa.jpg",
      "gigante.jpg",
      "rota.png",
    ]);
    expect(result.skipped.find((item) => item.relativePath === "falsa.jpg")?.reason).toMatch(
      /JPEG o PNG/i,
    );
    expect(result.skipped.find((item) => item.relativePath === "gigante.jpg")?.reason).toMatch(
      /256 MB/i,
    );
    expect(result.skipped.find((item) => item.relativePath === "rota.png")?.reason).toMatch(
      /No se pudo leer.*permiso denegado/i,
    );
    expect(slice).not.toHaveBeenCalled();
  });

  it("deduplicates the NFC relative path, size, and lastModified fingerprint", async () => {
    const decomposed = makeFile("cafe.jpg", {
      lastModified: 99,
      webkitRelativePath: "Cafe\u0301/foto.jpg",
    });
    const composed = makeFile("foto.jpg", {
      lastModified: 99,
      webkitRelativePath: "Café/foto.jpg",
    });

    const first = await normalizeFiles([decomposed, composed], "folder");
    const second = await normalizeFiles([composed], "folder");

    expect(first.accepted).toHaveLength(1);
    expect(first.accepted[0].relativePath).toBe("Café/foto.jpg");
    expect(first.accepted[0].id).toBe(second.accepted[0].id);
    expect(first.skipped).toEqual([
      expect.objectContaining({ relativePath: "Café/foto.jpg", reason: expect.stringMatching(/duplicado/i) }),
    ]);
  });

  it("uses the single safe folder root and falls back for multiple roots or loose files", async () => {
    const oneRoot = await normalizeFiles(
      [
        makeFile("b.jpg", { webkitRelativePath: "Álbum/b.jpg" }),
        makeFile("a.jpg", { webkitRelativePath: "Álbum/a.jpg" }),
      ],
      "folder",
    );
    const multipleRoots = await normalizeFiles(
      [
        makeFile("a.jpg", { webkitRelativePath: "Uno/a.jpg" }),
        makeFile("b.jpg", { webkitRelativePath: "Dos/b.jpg" }),
      ],
      "folder",
    );
    const mixed = await normalizeFiles(
      [makeFile("suelta.jpg"), makeFile("a.jpg", { webkitRelativePath: "Uno/a.jpg" })],
      "folder",
    );

    expect(oneRoot.archiveBase).toBe("Álbum");
    expect(oneRoot.accepted.map((item) => item.relativePath)).toEqual([
      "Álbum/a.jpg",
      "Álbum/b.jpg",
    ]);
    expect(multipleRoots.archiveBase).toBe("imagenes-procesadas");
    expect(multipleRoots.accepted.map((item) => item.relativePath)).toEqual([
      "Dos/b.jpg",
      "Uno/a.jpg",
    ]);
    expect(mixed.archiveBase).toBe("imagenes-procesadas");
  });

  it("makes a reserved single folder root portable", async () => {
    const result = await normalizeFiles(
      [makeFile("foto.jpg", { webkitRelativePath: "CON.archivo. /foto.jpg" })],
      "folder",
    );

    expect(result.archiveBase).toBe("_CON.archivo");
  });

  it("uses the shared portable-segment rules for invalid and trailing root names", async () => {
    const result = await normalizeFiles(
      [makeFile("foto.jpg", { webkitRelativePath: "AUX<>. /foto.jpg" })],
      "folder",
    );

    expect(result.archiveBase).toBe("AUX__");
  });

  it.each(["\u0000", "\u001f", "\u0085"])(
    "rejects a %s control-bearing folder root as an archive base",
    async (control) => {
      const result = await normalizeFiles(
        [makeFile("foto.jpg", { webkitRelativePath: `Raíz${control}/foto.jpg` })],
        "folder",
      );

      expect(result.archiveBase).toBe("imagenes-procesadas");
    },
  );
});

describe("readDroppedItems", () => {
  it("reads every directory-reader batch and preserves the root and subtree", async () => {
    let readCount = 0;
    const nested = directoryEntry("Sub", [[fileEntry(makeFile("b.png", { bytes: PNG_HEADER }))], []]);
    const root = directoryEntry(
      "Raíz",
      [[fileEntry(makeFile("c.jpg"))], [nested, fileEntry(makeFile("a.jpg"))], []],
      () => readCount++,
    );

    const result = await readDroppedItems(droppedItems([{ entry: root }]));

    expect(readCount).toBe(3);
    expect(result.archiveBase).toBe("Raíz");
    expect(result.accepted.map(({ relativePath, format }) => ({ relativePath, format }))).toEqual([
      { relativePath: "Raíz/Sub/b.png", format: "png" },
      { relativePath: "Raíz/a.jpg", format: "jpeg" },
      { relativePath: "Raíz/c.jpg", format: "jpeg" },
    ]);
  });

  it("falls back to getAsFile when webkitGetAsEntry is absent", async () => {
    const fallback = makeFile("suelta-sin-extension", { bytes: PNG_HEADER });

    const result = await readDroppedItems(
      droppedItems([{ file: fallback, exposeEntry: false }]),
    );

    expect(result.archiveBase).toBe("imagenes-procesadas");
    expect(result.accepted).toEqual([
      expect.objectContaining({ relativePath: "suelta-sin-extension", format: "png" }),
    ]);
  });

  it("retains the archive base for an empty dropped directory", async () => {
    const empty = directoryEntry("Vacía", [[]]);

    const result = await readDroppedItems(droppedItems([{ entry: empty }]));

    expect(result).toEqual({ archiveBase: "Vacía", accepted: [], skipped: [] });
  });

  it("keeps same-named dropped roots distinct using stable item order", async () => {
    const first = directoryEntry(
      "Fotos",
      [[fileEntry(makeFile("foto.bin", { bytes: JPEG_HEADER }), 15)], []],
      undefined,
      10,
    );
    const second = directoryEntry(
      "Fotos",
      [[fileEntry(makeFile("foto.bin", { bytes: PNG_HEADER }))], []],
    );

    const result = await readDroppedItems(
      droppedItems([{ entry: first }, { entry: second }]),
    );

    expect(result.archiveBase).toBe("imagenes-procesadas");
    expect(result.accepted.map(({ relativePath, format }) => ({ relativePath, format }))).toEqual([
      { relativePath: "Fotos (2)/foto.bin", format: "png" },
      { relativePath: "Fotos/foto.bin", format: "jpeg" },
    ]);
    expect(new Set(result.accepted.map((item) => item.relativePath))).toHaveLength(2);
  });

  it("chooses the same duplicate winner regardless of callback completion order", async () => {
    const run = async (firstDelay: number, secondDelay: number) => {
      const jpeg = makeFile("igual.bin", { bytes: JPEG_HEADER, lastModified: 77 });
      const png = makeFile("igual.bin", { bytes: PNG_HEADER, lastModified: 77 });
      const root = directoryEntry(
        "Orden",
        [[fileEntry(jpeg, firstDelay), fileEntry(png, secondDelay)], []],
      );
      return readDroppedItems(droppedItems([{ entry: root }]));
    };

    const slowFirst = await run(15, 0);
    const fastFirst = await run(0, 15);

    expect(slowFirst.accepted).toEqual([
      expect.objectContaining({ relativePath: "Orden/igual.bin", format: "jpeg" }),
    ]);
    expect(fastFirst.accepted).toEqual([
      expect.objectContaining({ relativePath: "Orden/igual.bin", format: "jpeg" }),
    ]);
    expect(slowFirst.skipped).toEqual(fastFirst.skipped);
  });

  it("reports a directory-reader callback error without rejecting the selection", async () => {
    const brokenDirectory: TestEntry = {
      isFile: false,
      isDirectory: true,
      name: "Inaccesible",
      createReader: () => ({
        readEntries: (_success, error) => {
          queueMicrotask(() => error?.(new DOMException("Lector bloqueado")));
        },
      }),
    };

    const result = await readDroppedItems(droppedItems([{ entry: brokenDirectory }]));

    expect(result.archiveBase).toBe("Inaccesible");
    expect(result.accepted).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        relativePath: "Inaccesible",
        reason: expect.stringMatching(/Lector bloqueado/),
      }),
    ]);
  });

  it("combines multiple dropped roots deterministically and reports entry read errors", async () => {
    const broken: TestEntry = {
      isFile: true,
      isDirectory: false,
      name: "rota.jpg",
      file: (_success, error) => queueMicrotask(() => error?.(new DOMException("Sin acceso"))),
    };
    const zeta = directoryEntry("Zeta", [[fileEntry(makeFile("z.jpg")), broken], []]);
    const alfa = directoryEntry("Alfa", [[fileEntry(makeFile("a.jpg"))], []]);

    const result = await readDroppedItems(
      droppedItems([{ entry: zeta }, { entry: alfa }]),
    );

    expect(result.archiveBase).toBe("imagenes-procesadas");
    expect(result.accepted.map((item) => item.relativePath)).toEqual([
      "Alfa/a.jpg",
      "Zeta/z.jpg",
    ]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ relativePath: "Zeta/rota.jpg", reason: expect.stringMatching(/Sin acceso/) }),
    ]);
  });
});
