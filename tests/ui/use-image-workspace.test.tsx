import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeInputSelections,
  useImageWorkspace,
  type ImageWorkspaceOptions,
} from "../../hooks/useImageWorkspace";
import type { BatchProcessorApi } from "../../hooks/useBatchProcessor";
import type { ArchiveWriterRequest } from "../../lib/archive/zip";
import type { BatchItem, BatchState } from "../../lib/batch/reducer";
import type { InputImage, InputSelection } from "../../lib/batch/types";
import type { CleanResult } from "../../lib/types";

function input(id: string, path: string): InputImage {
  return {
    id,
    file: new File([Uint8Array.from([0xff, 0xd8])], path.split("/").at(-1)!),
    relativePath: path,
    format: "jpeg",
  };
}

function result(): CleanResult {
  return {
    format: "jpeg",
    mime: "image/jpeg",
    cleaned: Uint8Array.from([0xff, 0xd8]),
    originalSize: 2,
    cleanedSize: 2,
    findings: [],
    preserved: [],
    isAi: false,
    notices: [],
    pixelPayloadHash: "hash",
    qualityVerified: true,
    outputExtension: ".jpg",
  };
}

function completed(id = "one", path = "Raíz/Sub/foto.jpg"): BatchItem {
  return {
    ...input(id, path),
    status: "completed",
    progress: 1,
    result: result(),
  };
}

function fakeBatch(items: BatchItem[] = []): BatchProcessorApi {
  const state: BatchState = {
    generation: 1,
    order: items.map((item) => item.id),
    itemsById: Object.fromEntries(items.map((item) => [item.id, item])),
  };
  return {
    state,
    items,
    summary: {
      total: items.length,
      queued: 0,
      processing: 0,
      completed: items.length,
      failed: 0,
      cancelled: 0,
      originalBytes: items.reduce((sum, item) => sum + item.file.size, 0),
      cleanedBytes: items.reduce(
        (sum, item) => sum + (item.result?.cleanedSize ?? 0),
        0,
      ),
      removedBytes: 0,
    },
    ready: true,
    mode: "main-thread",
    start: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    retry: vi.fn(),
  };
}

beforeEach(() => {
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:workspace"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mergeInputSelections", () => {
  it("preserves one common root and falls back for multiple roots", () => {
    const first: InputSelection = {
      archiveBase: "Raíz",
      accepted: [input("a", "Raíz/A.jpg")],
      skipped: [],
    };
    const sameRoot: InputSelection = {
      archiveBase: "Raíz",
      accepted: [input("b", "Raíz/Sub/B.jpg")],
      skipped: [],
    };
    const otherRoot: InputSelection = {
      archiveBase: "Otra",
      accepted: [input("c", "Otra/C.jpg")],
      skipped: [],
    };

    expect(mergeInputSelections(first, sameRoot).archiveBase).toBe("Raíz");
    expect(
      mergeInputSelections(mergeInputSelections(first, sameRoot), otherRoot)
        .archiveBase,
    ).toBe("imagenes-procesadas");
  });

  it("deduplicates repeated selections deterministically", () => {
    const selected: InputSelection = {
      archiveBase: "Raíz",
      accepted: [input("a", "Raíz/A.jpg")],
      skipped: [],
    };
    const merged = mergeInputSelections(selected, selected);

    expect(merged.accepted).toHaveLength(1);
    expect(merged.skipped.at(-1)?.reason).toMatch(/ya se agregó/i);
  });

  it("refuses a combined selection above the retained-byte budget", () => {
    const largeA = input("a", "Raíz/A.jpg");
    const largeB = input("b", "Raíz/B.jpg");
    Object.defineProperty(largeA.file, "size", { value: 300 * 1024 ** 2 });
    Object.defineProperty(largeB.file, "size", { value: 300 * 1024 ** 2 });

    expect(() =>
      mergeInputSelections(
        { archiveBase: "Raíz", accepted: [largeA], skipped: [] },
        { archiveBase: "Raíz", accepted: [largeB], skipped: [] },
      ),
    ).toThrow(/memoria segura/i);
  });
});

describe("useImageWorkspace", () => {
  it("invokes the save picker synchronously and only falls back when unsupported", async () => {
    const order: string[] = [];
    const requestWriter = vi.fn(
      (): Promise<ArchiveWriterRequest> => {
        order.push("picker");
        return Promise.resolve({ kind: "unsupported" });
      },
    );
    const generateArchive = vi.fn(async () => {
      order.push("archive");
      return {
        kind: "blob" as const,
        suggestedName: "Raíz-limpia.zip",
        size: 1,
        blob: new Blob(["x"]),
      };
    });
    const options: ImageWorkspaceOptions = {
      batchApi: fakeBatch([completed()]),
      requestArchiveWriter: requestWriter,
      generateArchive,
    };
    const { result: workspace } = renderHook(() => useImageWorkspace(options));

    let operation!: Promise<void>;
    act(() => {
      operation = workspace.current.downloadCleanArchive();
      order.push("returned");
    });
    expect(order.slice(0, 2)).toEqual(["picker", "returned"]);
    await act(() => operation);
    expect(generateArchive).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destination: { kind: "blob" } }),
    );
  });

  it("treats picker cancellation as idle without creating an archive", async () => {
    const generateArchive = vi.fn();
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([completed()]),
        requestArchiveWriter: () => Promise.resolve({ kind: "cancelled" }),
        generateArchive,
      }),
    );

    await act(() => workspace.current.downloadCleanArchive());

    expect(generateArchive).not.toHaveBeenCalled();
    expect(workspace.current.archive.kind).toBe("idle");
  });

  it("uses an opened direct writer and returns cancellation to idle", async () => {
    const writer = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const generateArchive = vi.fn(
      async (
        _plan: unknown,
        options: { signal?: AbortSignal; destination: unknown },
      ) =>
        new Promise<never>((_resolve, reject) => {
          expect(options.destination).toEqual({ kind: "writer", writer });
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelado", "AbortError")),
            { once: true },
          );
        }),
    );
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([completed()]),
        requestArchiveWriter: () =>
          Promise.resolve({ kind: "writer", writer }),
        generateArchive: generateArchive as ImageWorkspaceOptions["generateArchive"],
      }),
    );

    let operation!: Promise<void>;
    act(() => {
      operation = workspace.current.downloadCleanArchive();
    });
    await waitFor(() => expect(workspace.current.archive.kind).toBe("running"));
    act(() => workspace.current.cancelArchive());
    await act(() => operation);

    expect(generateArchive).toHaveBeenCalledOnce();
    expect(workspace.current.archive.kind).toBe("idle");
  });

  it("runs TikTok exports sequentially and exposes ready output", async () => {
    const first = completed("a", "Raíz/A.jpg");
    const second = completed("b", "Raíz/B.jpg");
    let running = 0;
    let peak = 0;
    const exportTikTok = vi.fn(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running -= 1;
      return {
        png: Uint8Array.from([1]),
        preview: Uint8Array.from([2]),
        width: 10,
        height: 20,
        seed: 1,
        outputExtension: ".png" as const,
        approximate: true as const,
        eligiblePixels: 1,
        eligibleFraction: 1,
        changedSamples: 6,
        sumDelta: 0,
        meanDelta: 0 as const,
      };
    });
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([first, second]),
        exportTikTok,
      }),
    );

    await act(() => workspace.current.prepareAllTikTok());

    expect(peak).toBe(1);
    expect(exportTikTok).toHaveBeenCalledTimes(2);
    expect(workspace.current.tiktokById.a.status).toBe("ready");
    expect(workspace.current.tiktokById.b.status).toBe("ready");
  });

  it("deduplicates two immediate TikTok requests for the same item", async () => {
    const item = completed();
    const exportTikTok = vi.fn(async () => ({
      png: Uint8Array.from([1]),
      preview: Uint8Array.from([2]),
      width: 10,
      height: 20,
      seed: 1,
      outputExtension: ".png" as const,
      approximate: true as const,
      eligiblePixels: 1,
      eligibleFraction: 1,
      changedSamples: 6,
      sumDelta: 0,
      meanDelta: 0 as const,
    }));
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([item]),
        exportTikTok,
      }),
    );

    await act(() =>
      Promise.all([
        workspace.current.generateTikTok(item.id),
        workspace.current.generateTikTok(item.id),
      ]),
    );

    expect(exportTikTok).toHaveBeenCalledOnce();
  });

  it("cancels one TikTok export without removing its clean result", async () => {
    const item = completed();
    const exportTikTok = vi.fn(
      async (_blob: Blob, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("cancelado", "AbortError")),
            { once: true },
          );
        }),
    );
    const batch = fakeBatch([item]);
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({ batchApi: batch, exportTikTok }),
    );

    let operation!: Promise<void>;
    act(() => {
      operation = workspace.current.generateTikTok(item.id);
    });
    await waitFor(() =>
      expect(workspace.current.tiktokById[item.id].status).toBe("processing"),
    );
    act(() => workspace.current.cancelTikTok(item.id));
    await act(() => operation);

    expect(workspace.current.tiktokById[item.id].status).toBe("cancelled");
    expect(batch.remove).not.toHaveBeenCalled();
  });

  it("creates and revokes preview URLs only while a row is visible", async () => {
    const item = completed();
    const { result: workspace, unmount } = renderHook(() =>
      useImageWorkspace({ batchApi: fakeBatch([item]) }),
    );

    act(() => workspace.current.setPreviewVisible(item.id, true));
    await waitFor(() =>
      expect(workspace.current.previewUrls[item.id]).toBe("blob:workspace"),
    );
    act(() => workspace.current.setPreviewVisible(item.id, false));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:workspace");
    expect(workspace.current.previewUrls[item.id]).toBeUndefined();

    unmount();
  });
});
