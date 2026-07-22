import { describe, expect, it } from "vitest";
import {
  batchReducer,
  initialBatchState,
  summarizeBatch,
  type BatchState,
} from "@/lib/batch/reducer";
import type { InputImage } from "@/lib/batch/types";
import type { CleanResult } from "@/lib/types";

function input(id: string, size = 10): InputImage {
  return {
    id,
    file: new File([new Uint8Array(size)], `${id}.jpg`),
    relativePath: `Raiz/${id}.jpg`,
    format: "jpeg",
  };
}

function result(originalSize = 10, cleanedSize = 7): CleanResult {
  return {
    format: "jpeg",
    mime: "image/jpeg",
    cleaned: new Uint8Array(cleanedSize),
    originalSize,
    cleanedSize,
    findings: [],
    preserved: [],
    isAi: false,
    notices: [],
    pixelPayloadHash: "hash",
    qualityVerified: true,
    outputExtension: ".jpg",
  };
}

function start(generation = 4, items = [input("a")]): BatchState {
  return batchReducer(initialBatchState, {
    type: "batch/started",
    generation,
    items,
  });
}

describe("batchReducer", () => {
  it("ignores a result from a cancelled generation", () => {
    const started = start();
    const processing = batchReducer(started, {
      type: "item/started",
      generation: 4,
      id: "a",
    });
    const cancelled = batchReducer(processing, {
      type: "batch/cancelled",
      generation: 5,
    });
    const late = batchReducer(cancelled, {
      type: "item/completed",
      generation: 4,
      id: "a",
      result: result(),
    });

    expect(late.generation).toBe(5);
    expect(late.itemsById.a.status).toBe("cancelled");
    expect(late.itemsById.a.result).toBeUndefined();
  });

  it("accepts only legal item transitions for the current generation", () => {
    const started = start();
    const illegalCompletion = batchReducer(started, {
      type: "item/completed",
      generation: 4,
      id: "a",
      result: result(),
    });
    expect(illegalCompletion).toBe(started);

    const processing = batchReducer(started, {
      type: "item/started",
      generation: 4,
      id: "a",
    });
    const progressed = batchReducer(processing, {
      type: "item/progress",
      generation: 4,
      id: "a",
      progress: 0.75,
    });
    const completed = batchReducer(progressed, {
      type: "item/completed",
      generation: 4,
      id: "a",
      result: result(),
    });
    const lateFailure = batchReducer(completed, {
      type: "item/failed",
      generation: 4,
      id: "a",
      error: "demasiado tarde",
    });

    expect(progressed.itemsById.a.progress).toBe(0.75);
    expect(completed.itemsById.a.status).toBe("completed");
    expect(completed.itemsById.a.progress).toBe(1);
    expect(lateFailure).toBe(completed);
  });

  it("ignores stale, missing, and duplicate additions", () => {
    const started = start(2, [input("a")]);
    const stale = batchReducer(started, {
      type: "batch/added",
      generation: 1,
      items: [input("b")],
    });
    const added = batchReducer(stale, {
      type: "batch/added",
      generation: 2,
      items: [input("a"), input("b")],
    });
    const missing = batchReducer(added, {
      type: "item/started",
      generation: 2,
      id: "missing",
    });

    expect(stale).toBe(started);
    expect(added.order).toEqual(["a", "b"]);
    expect(missing).toBe(added);
  });

  it("ignores stale actions after remove and reset", () => {
    const started = start(8, [input("a"), input("b")]);
    const removed = batchReducer(started, {
      type: "item/removed",
      generation: 8,
      id: "a",
    });
    const removedLate = batchReducer(removed, {
      type: "item/failed",
      generation: 8,
      id: "a",
      error: "late",
    });
    const reset = batchReducer(removedLate, {
      type: "batch/reset",
      generation: 9,
    });
    const resetLate = batchReducer(reset, {
      type: "item/started",
      generation: 8,
      id: "b",
    });

    expect(removed.order).toEqual(["b"]);
    expect(removedLate).toBe(removed);
    expect(reset).toEqual({ generation: 9, order: [], itemsById: {} });
    expect(resetLate).toBe(reset);
  });

  it("retries only failed or cancelled items and clears terminal data", () => {
    const started = start();
    const processing = batchReducer(started, {
      type: "item/started",
      generation: 4,
      id: "a",
    });
    const failed = batchReducer(processing, {
      type: "item/failed",
      generation: 4,
      id: "a",
      error: "roto",
    });
    const retried = batchReducer(failed, {
      type: "item/retried",
      generation: 4,
      id: "a",
    });
    const illegalRetry = batchReducer(retried, {
      type: "item/retried",
      generation: 4,
      id: "a",
    });

    expect(retried.itemsById.a).toMatchObject({ status: "queued", progress: 0 });
    expect(retried.itemsById.a.error).toBeUndefined();
    expect(illegalRetry).toBe(retried);
  });

  it("replaces only with a newer generation and summarizes counts and bytes deterministically", () => {
    const started = start(3, [input("a", 10), input("b", 20), input("c", 30)]);
    const aRunning = batchReducer(started, {
      type: "item/started",
      generation: 3,
      id: "a",
    });
    const aDone = batchReducer(aRunning, {
      type: "item/completed",
      generation: 3,
      id: "a",
      result: result(10, 7),
    });
    const bRunning = batchReducer(aDone, {
      type: "item/started",
      generation: 3,
      id: "b",
    });
    const bFailed = batchReducer(bRunning, {
      type: "item/failed",
      generation: 3,
      id: "b",
      error: "fallo",
    });
    const summary = summarizeBatch(bFailed);
    const sameGenerationStart = batchReducer(bFailed, {
      type: "batch/started",
      generation: 3,
      items: [input("z")],
    });

    expect(summary).toEqual({
      total: 3,
      queued: 1,
      processing: 0,
      completed: 1,
      failed: 1,
      cancelled: 0,
      originalBytes: 10,
      cleanedBytes: 7,
      removedBytes: 3,
    });
    expect(sameGenerationStart).toBe(bFailed);
  });
});
