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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

function cancelled(id: string, path: string): BatchItem {
  return {
    ...input(id, path),
    status: "cancelled",
    progress: 0,
  };
}

function tiktokResult() {
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
  vi.useRealTimers();
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

  it("returns to idle when a cancelled archive generator ignores abort and resolves", async () => {
    const pending = deferred<{
      kind: "blob";
      suggestedName: string;
      size: number;
      blob: Blob;
    }>();
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([completed()]),
        requestArchiveWriter: () => Promise.resolve({ kind: "unsupported" }),
        generateArchive: () => pending.promise,
      }),
    );

    let operation!: Promise<void>;
    act(() => {
      operation = workspace.current.downloadCleanArchive();
    });
    await waitFor(() => expect(workspace.current.archive.kind).toBe("running"));

    act(() => workspace.current.cancelArchive());
    expect(workspace.current.archive.kind).toBe("idle");

    pending.resolve({
      kind: "blob",
      suggestedName: "Raíz-limpia.zip",
      size: 1,
      blob: new Blob(["x"]),
    });
    await act(() => operation);
    expect(workspace.current.archive.kind).toBe("idle");
  });

  it("invalidates a pending picker on reset and aborts its unused writer exactly once", async () => {
    const requested = deferred<ArchiveWriterRequest>();
    const writer = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const generateArchive = vi.fn();
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([completed()]),
        requestArchiveWriter: () => requested.promise,
        generateArchive,
      }),
    );

    let operation!: Promise<void>;
    act(() => {
      operation = workspace.current.downloadCleanArchive();
      workspace.current.reset();
    });
    requested.resolve({ kind: "writer", writer });
    await act(() => operation);

    expect(generateArchive).not.toHaveBeenCalled();
    expect(writer.abort).toHaveBeenCalledOnce();
    expect(workspace.current.archive).toEqual({
      kind: "idle",
      mode: null,
      progress: 0,
    });
  });

  it.each([
    {
      label: "there are no output entries",
      items: [] as BatchItem[],
    },
    {
      label: "archive planning throws",
      items: [
        {
          ...completed(),
          result: {
            ...result(),
            cleaned: undefined,
          },
        } as unknown as BatchItem,
      ],
    },
  ])("aborts an opened writer once when $label", async ({ items }) => {
    const writer = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const generateArchive = vi.fn();
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch(items),
        requestArchiveWriter: () => Promise.resolve({ kind: "writer", writer }),
        generateArchive,
      }),
    );

    await act(() => workspace.current.downloadCleanArchive());

    expect(generateArchive).not.toHaveBeenCalled();
    expect(writer.abort).toHaveBeenCalledOnce();
    expect(workspace.current.archive.kind).toBe("error");
  });

  it("keeps a newer ZIP operation isolated from a late failure in the old one", async () => {
    const first = deferred<never>();
    const second = deferred<never>();
    const signals: AbortSignal[] = [];
    const generateArchive = vi
      .fn()
      .mockImplementationOnce(
        (
          _plan: unknown,
          options: { signal: AbortSignal },
        ): Promise<never> => {
          signals.push(options.signal);
          options.signal.addEventListener(
            "abort",
            () => first.reject(new DOMException("reemplazado", "AbortError")),
            { once: true },
          );
          return first.promise;
        },
      )
      .mockImplementationOnce(
        (
          _plan: unknown,
          options: { signal: AbortSignal },
        ): Promise<never> => {
          signals.push(options.signal);
          options.signal.addEventListener(
            "abort",
            () => second.reject(new DOMException("cancelado", "AbortError")),
            { once: true },
          );
          return second.promise;
        },
      );
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([completed()]),
        requestArchiveWriter: () => Promise.resolve({ kind: "unsupported" }),
        generateArchive:
          generateArchive as ImageWorkspaceOptions["generateArchive"],
      }),
    );

    let oldOperation!: Promise<void>;
    let newOperation!: Promise<void>;
    act(() => {
      oldOperation = workspace.current.downloadCleanArchive();
    });
    await waitFor(() => expect(generateArchive).toHaveBeenCalledTimes(1));
    act(() => {
      newOperation = workspace.current.downloadCleanArchive();
    });
    await waitFor(() => expect(generateArchive).toHaveBeenCalledTimes(2));
    await act(() => oldOperation);

    expect(workspace.current.archive).toMatchObject({
      kind: "running",
      mode: "clean",
    });
    act(() => workspace.current.cancelArchive());
    await act(() => newOperation);

    expect(signals[1].aborted).toBe(true);
    expect(workspace.current.archive.kind).toBe("idle");
  });

  it("opens the replacement save picker before aborting the previous ZIP operation", async () => {
    const order: string[] = [];
    let pickerCall = 0;
    const requestArchiveWriter = vi.fn(() => {
      pickerCall += 1;
      order.push(`picker-${pickerCall}`);
      return Promise.resolve({ kind: "unsupported" as const });
    });
    const first = deferred<never>();
    const generateArchive = vi
      .fn()
      .mockImplementationOnce(
        (
          _plan: unknown,
          options: { signal: AbortSignal },
        ): Promise<never> => {
          options.signal.addEventListener(
            "abort",
            () => {
              order.push("abort-old");
              first.reject(new DOMException("reemplazado", "AbortError"));
            },
            { once: true },
          );
          return first.promise;
        },
      )
      .mockResolvedValueOnce({
        kind: "blob" as const,
        suggestedName: "Raíz-limpia.zip",
        size: 1,
        blob: new Blob(["x"]),
      });
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([completed()]),
        requestArchiveWriter,
        generateArchive:
          generateArchive as ImageWorkspaceOptions["generateArchive"],
      }),
    );

    let oldOperation!: Promise<void>;
    act(() => {
      oldOperation = workspace.current.downloadCleanArchive();
    });
    await waitFor(() => expect(generateArchive).toHaveBeenCalledOnce());
    order.length = 0;

    await act(() => workspace.current.downloadCleanArchive());
    await act(() => oldOperation);

    expect(order.slice(0, 2)).toEqual(["picker-2", "abort-old"]);
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
      return tiktokResult();
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
    expect(workspace.current.tiktokBatchStatus).toBe("settled");
    expect(workspace.current.tiktokById.a.status).toBe("ready");
    expect(workspace.current.tiktokById.b.status).toBe("ready");
  });

  it("drains manual retries queued during batch preparation before marking it settled", async () => {
    const retry = completed("b", "Raíz/B.jpg");
    const last = completed("c", "Raíz/C.jpg");
    const pendingC = deferred<ReturnType<typeof tiktokResult>>();
    const pendingManualRetry = deferred<ReturnType<typeof tiktokResult>>();
    let bAttempts = 0;
    const exportTikTok = vi.fn(
      async (
        _blob: Blob,
        _signal: AbortSignal,
        correlation: { id: string },
      ) => {
        if (correlation.id === "c") return pendingC.promise;
        bAttempts += 1;
        if (bAttempts <= 2) throw new Error(`falló B ${bAttempts}`);
        return pendingManualRetry.promise;
      },
    );
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([retry, last]),
        exportTikTok,
      }),
    );

    await act(() => workspace.current.generateTikTok("b"));
    expect(workspace.current.tiktokById.b.status).toBe("error");

    let preparationSettled = false;
    let preparation!: Promise<void>;
    act(() => {
      preparation = workspace.current.prepareAllTikTok();
      void preparation.then(() => {
        preparationSettled = true;
      });
    });
    await waitFor(() =>
      expect(workspace.current.tiktokById.c.status).toBe("processing"),
    );

    let manualRetry!: Promise<void>;
    act(() => {
      manualRetry = workspace.current.generateTikTok("b");
    });
    expect(workspace.current.tiktokById.b.status).toBe("queued");
    pendingC.resolve(tiktokResult());
    await waitFor(() =>
      expect(workspace.current.tiktokById.b.status).toBe("processing"),
    );

    expect(preparationSettled).toBe(false);
    expect(workspace.current.tiktokBatchStatus).toBe("busy");

    pendingManualRetry.resolve(tiktokResult());
    await act(() => Promise.all([preparation, manualRetry]));
    expect(workspace.current.tiktokBatchStatus).toBe("settled");
    expect(workspace.current.tiktokById.b.status).toBe("ready");
  });

  it("deduplicates two immediate TikTok requests for the same item", async () => {
    const item = completed();
    const exportTikTok = vi.fn(async () => tiktokResult());
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

  it("releases a TikTok controller cancelled while it is still queued", async () => {
    const first = completed("a", "Raíz/A.jpg");
    const second = completed("b", "Raíz/B.jpg");
    const pending = deferred<ReturnType<typeof tiktokResult>>();
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const exportTikTok = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(tiktokResult());
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([first, second]),
        exportTikTok,
      }),
    );

    let firstOperation!: Promise<void>;
    let queuedOperation!: Promise<void>;
    act(() => {
      firstOperation = workspace.current.generateTikTok("a");
      queuedOperation = workspace.current.generateTikTok("b");
    });
    await waitFor(() =>
      expect(workspace.current.tiktokById.b.status).toBe("queued"),
    );
    act(() => workspace.current.cancelTikTok("b"));
    pending.resolve(tiktokResult());
    await act(() => Promise.all([firstOperation, queuedOperation]));
    act(() => workspace.current.reset());

    expect(exportTikTok).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
  });

  it.each(["reset", "remove"] as const)(
    "%s invalidates an in-flight batch preparation without resurrecting queued ids",
    async (action) => {
      const first = completed("a", "Raíz/A.jpg");
      const second = completed("b", "Raíz/B.jpg");
      const exportTikTok = vi.fn(
        async (_blob: Blob, signal: AbortSignal) =>
          new Promise<ReturnType<typeof tiktokResult>>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("cancelado", "AbortError")),
              { once: true },
            );
          }),
      );
      const { result: workspace } = renderHook(() =>
        useImageWorkspace({
          batchApi: fakeBatch([first, second]),
          exportTikTok,
        }),
      );

      let operation!: Promise<void>;
      act(() => {
        operation = workspace.current.prepareAllTikTok();
      });
      await waitFor(() =>
        expect(workspace.current.tiktokById.a.status).toBe("processing"),
      );
      act(() => {
        if (action === "reset") workspace.current.reset();
        else workspace.current.remove("a");
      });
      await act(() => operation);

      expect(exportTikTok).toHaveBeenCalledOnce();
      expect(workspace.current.tiktokById.a).toBeUndefined();
      expect(workspace.current.tiktokById.b).toBeUndefined();
      expect(workspace.current.tiktokBatchStatus).toBe("idle");
    },
  );

  it("does not resurrect stale batch items when preparation is requested right after reset", async () => {
    const exportTikTok = vi.fn(async () => tiktokResult());
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([
          completed("a", "Raíz/A.jpg"),
          completed("b", "Raíz/B.jpg"),
        ]),
        exportTikTok,
      }),
    );

    act(() => workspace.current.reset());
    await act(() => workspace.current.prepareAllTikTok());

    expect(exportTikTok).not.toHaveBeenCalled();
    expect(workspace.current.tiktokById).toEqual({});
  });

  it("blocks a partial TikTok ZIP until the requested batch is settled", async () => {
    const first = completed("a", "Raíz/A.jpg");
    const second = completed("b", "Raíz/B.jpg");
    const pending = deferred<ReturnType<typeof tiktokResult>>();
    const requestArchiveWriter = vi.fn(() =>
      Promise.resolve({ kind: "unsupported" as const }),
    );
    const generateArchive = vi.fn();
    const exportTikTok = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(tiktokResult());
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([first, second]),
        requestArchiveWriter,
        generateArchive,
        exportTikTok,
      }),
    );

    expect(workspace.current.tiktokBatchStatus).toBe("idle");
    await act(() => workspace.current.downloadTikTokArchive());
    expect(requestArchiveWriter).not.toHaveBeenCalled();
    expect(generateArchive).not.toHaveBeenCalled();

    let preparation!: Promise<void>;
    act(() => {
      preparation = workspace.current.prepareAllTikTok();
    });
    await waitFor(() =>
      expect(workspace.current.tiktokBatchStatus).toBe("busy"),
    );
    await act(() => workspace.current.downloadTikTokArchive());
    expect(requestArchiveWriter).not.toHaveBeenCalled();
    expect(generateArchive).not.toHaveBeenCalled();

    pending.resolve(tiktokResult());
    await act(() => preparation);
    expect(workspace.current.tiktokBatchStatus).toBe("settled");
  });

  it("includes TikTok errors and cancellations in a settled ZIP report", async () => {
    const first = completed("a", "Raíz/A.jpg");
    const second = completed("b", "Raíz/B.jpg");
    const third = completed("c", "Raíz/C.jpg");
    const exportTikTok = vi.fn(
      async (
        _blob: Blob,
        signal: AbortSignal,
        correlation: { id: string },
      ) => {
        if (correlation.id === "a") return tiktokResult();
        if (correlation.id === "b") throw new Error("falló TikTok B");
        return new Promise<ReturnType<typeof tiktokResult>>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("cancelado", "AbortError")),
            { once: true },
          );
        });
      },
    );
    let capturedPlan: Parameters<
      NonNullable<ImageWorkspaceOptions["generateArchive"]>
    >[0] | undefined;
    const generateArchive = vi.fn(async (plan) => {
      capturedPlan = plan;
      return {
        kind: "blob" as const,
        suggestedName: plan.suggestedName,
        size: 1,
        blob: new Blob(["x"]),
      };
    });
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([first, second, third]),
        exportTikTok,
        requestArchiveWriter: () => Promise.resolve({ kind: "unsupported" }),
        generateArchive,
      }),
    );

    let preparation!: Promise<void>;
    act(() => {
      preparation = workspace.current.prepareAllTikTok();
    });
    await waitFor(() =>
      expect(workspace.current.tiktokById.c.status).toBe("processing"),
    );
    act(() => workspace.current.cancelTikTok("c"));
    await act(() => preparation);

    expect(workspace.current.tiktokBatchStatus).toBe("settled");
    await act(() => workspace.current.downloadTikTokArchive());
    const report = new TextDecoder().decode(capturedPlan?.report.bytes);
    expect(report).toContain("Raíz/B.jpg");
    expect(report).toContain("falló TikTok B");
    expect(report).toContain("Raíz/C.jpg");
    expect(report).toMatch(/cancelad/i);
  });

  it("invalidates a settled TikTok batch when a skipped clean item is retried", async () => {
    const ready = completed("a", "Raíz/A.jpg");
    const omitted = cancelled("b", "Raíz/B.jpg");
    const batch = fakeBatch([ready, omitted]);
    const requestArchiveWriter = vi.fn(() =>
      Promise.resolve({ kind: "unsupported" as const }),
    );
    const generateArchive = vi.fn(async (plan) => ({
      kind: "blob" as const,
      suggestedName: plan.suggestedName,
      size: 1,
      blob: new Blob(["x"]),
    }));
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: batch,
        exportTikTok: async () => tiktokResult(),
        requestArchiveWriter,
        generateArchive,
      }),
    );

    await act(() => workspace.current.prepareAllTikTok());
    expect(workspace.current.tiktokBatchStatus).toBe("settled");

    act(() => workspace.current.retry("b"));
    expect(batch.retry).toHaveBeenCalledWith("b");
    expect(workspace.current.tiktokBatchStatus).toBe("idle");

    await act(() => workspace.current.downloadTikTokArchive());
    expect(requestArchiveWriter).not.toHaveBeenCalled();
    expect(generateArchive).not.toHaveBeenCalled();
  });

  it("records cancelled clean items in the processing report", async () => {
    const ready = completed("a", "Raíz/A.jpg");
    const omitted = cancelled("b", "Raíz/B.jpg");
    let capturedPlan: Parameters<
      NonNullable<ImageWorkspaceOptions["generateArchive"]>
    >[0] | undefined;
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({
        batchApi: fakeBatch([ready, omitted]),
        requestArchiveWriter: () => Promise.resolve({ kind: "unsupported" }),
        generateArchive: async (plan) => {
          capturedPlan = plan;
          return {
            kind: "blob",
            suggestedName: plan.suggestedName,
            size: 1,
            blob: new Blob(["x"]),
          };
        },
      }),
    );

    await act(() => workspace.current.downloadCleanArchive());
    const report = new TextDecoder().decode(capturedPlan?.report.bytes);
    expect(report).toContain("Raíz/B.jpg");
    expect(report).toMatch(/cancelad/i);
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

  it("keeps a Blob download URL alive long enough for Safari/WebKit", async () => {
    vi.useFakeTimers();
    const item = completed();
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({ batchApi: fakeBatch([item]) }),
    );

    act(() => workspace.current.downloadClean(item.id));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1_499));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:workspace");
  });

  it("keeps two rapid Blob download URLs alive on independent timers", async () => {
    vi.useFakeTimers();
    vi.mocked(URL.createObjectURL)
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const item = completed();
    const { result: workspace } = renderHook(() =>
      useImageWorkspace({ batchApi: fakeBatch([item]) }),
    );

    act(() => {
      workspace.current.downloadClean(item.id);
      workspace.current.downloadClean(item.id);
    });
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:first");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:second");
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
