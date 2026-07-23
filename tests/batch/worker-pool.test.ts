import { describe, expect, it, vi } from "vitest";
import {
  createImageWorkerPool,
  createTikTokProcessor,
  createTikTokWorkerPool,
  TikTokWorkerFallbackError,
  type CleanWorkerRequest,
  type ImageWorker,
  type ImageWorkerRequest,
  type WorkerResponse,
} from "@/lib/batch/worker-pool";
import {
  handleCleanWorkerRequest,
  handleTikTokWorkerRequest,
} from "@/workers/image-worker";
import { jpegWithComment } from "@/tests/fixtures/images";
import type { CleanResult } from "@/lib/types";
import type { TikTokExportResult } from "@/lib/tiktok/export";

type WorkerEventType = "message" | "error" | "messageerror";

class FakeWorker implements ImageWorker {
  readonly posted: Array<{ message: ImageWorkerRequest; transfer: Transferable[] }> = [];
  readonly terminate = vi.fn();
  private readonly listeners = new Map<WorkerEventType, Set<EventListenerOrEventListenerObject>>();

  postMessage(message: ImageWorkerRequest, transfer: Transferable[]): void {
    this.posted.push({ message, transfer });
  }

  addEventListener(
    type: WorkerEventType,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: WorkerEventType,
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  emitMessage(data: WorkerResponse): void {
    this.emit("message", new MessageEvent("message", { data }));
  }

  emitError(message = "worker roto"): void {
    this.emit("error", new ErrorEvent("error", { message }));
  }

  emitMessageError(): void {
    this.emit("messageerror", new MessageEvent("messageerror"));
  }

  listenerCount(type: WorkerEventType): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  private emit(type: WorkerEventType, event: Event): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
}

function workerFactory() {
  const workers: FakeWorker[] = [];
  return {
    workers,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  };
}

function request(
  id: string,
  generation = 1,
  bytes = Uint8Array.of(1, 2, 3).buffer,
): CleanWorkerRequest {
  return { id, generation, kind: "clean", bytes };
}

function result(cleaned: Uint8Array = Uint8Array.of(9, 8)): CleanResult {
  return {
    format: "jpeg",
    mime: "image/jpeg",
    cleaned,
    originalSize: 3,
    cleanedSize: cleaned.byteLength,
    findings: [],
    preserved: [],
    isAi: false,
    notices: [],
    pixelPayloadHash: "hash",
    qualityVerified: true,
    outputExtension: ".jpg",
  };
}

function success(message: ImageWorkerRequest, cleaned?: Uint8Array): WorkerResponse {
  if (message.kind !== "clean") throw new Error("Se esperaba una solicitud clean.");
  return {
    id: message.id,
    generation: message.generation,
    kind: "clean",
    ok: true,
    result: result(cleaned),
  };
}

describe("createImageWorkerPool", () => {
  it("creates two eager slots by default and transfers each input buffer", async () => {
    const factory = workerFactory();
    const pool = createImageWorkerPool({ createWorker: factory.createWorker });
    const firstBuffer = Uint8Array.of(1, 2, 3).buffer;
    const secondBuffer = Uint8Array.of(4, 5).buffer;

    expect(factory.workers).toHaveLength(2);
    const first = pool.clean(request("a", 1, firstBuffer));
    const second = pool.clean(request("b", 1, secondBuffer));
    const third = pool.clean(request("c"));
    let thirdSettled = false;
    void third.then(
      () => {
        thirdSettled = true;
      },
      () => {
        thirdSettled = true;
      },
    );
    await Promise.resolve();
    expect(thirdSettled).toBe(false);

    expect(factory.workers[0].posted[0]).toEqual({
      message: request("a", 1, firstBuffer),
      transfer: [firstBuffer],
    });
    expect(factory.workers[1].posted[0].transfer).toEqual([secondBuffer]);
    factory.workers[0].emitMessage(success(factory.workers[0].posted[0].message));
    expect(factory.workers[0].posted[1].message.id).toBe("c");
    factory.workers[0].emitMessage(success(factory.workers[0].posted[1].message));
    factory.workers[1].emitMessage(success(factory.workers[1].posted[0].message));

    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
    expect(pool.running).toBe(0);
  });

  it("uses a healthy busy slot after another slot cannot be replaced", async () => {
    const workers: FakeWorker[] = [];
    let factoryCalls = 0;
    const createWorker = () => {
      factoryCalls += 1;
      if (factoryCalls > 2) throw new Error("reemplazo bloqueado");
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
    const pool = createImageWorkerPool({ size: 2, createWorker });
    const failed = pool.clean(request("failed"));
    const healthy = pool.clean(request("healthy"));

    workers[0].emitError("boom");
    await expect(failed).rejects.toThrow("boom");
    const waiting = pool.clean(request("waiting"));
    let waitingSettled = false;
    void waiting.then(
      () => {
        waitingSettled = true;
      },
      () => {
        waitingSettled = true;
      },
    );
    await Promise.resolve();
    expect(waitingSettled).toBe(false);
    expect(workers[1].posted).toHaveLength(1);

    workers[1].emitMessage(success(workers[1].posted[0].message));
    await expect(healthy).resolves.toMatchObject({ cleanedSize: 2 });
    expect(workers[1].posted[1].message.id).toBe("waiting");
    workers[1].emitMessage(success(workers[1].posted[1].message));
    await expect(waiting).resolves.toMatchObject({ cleanedSize: 2 });
  });

  it("allows an abort while waiting for a live busy worker", async () => {
    const factory = workerFactory();
    const pool = createImageWorkerPool({ size: 1, createWorker: factory.createWorker });
    const active = pool.clean(request("active"));
    const controller = new AbortController();
    const waiting = pool.clean(request("waiting"), controller.signal);

    controller.abort("ya no se necesita");

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(factory.workers[0].posted).toHaveLength(1);
    factory.workers[0].emitMessage(success(factory.workers[0].posted[0].message));
    await expect(active).resolves.toMatchObject({ cleanedSize: 2 });
  });

  it("skips an aborted waiter without overtaking the next FIFO request", async () => {
    const factory = workerFactory();
    const pool = createImageWorkerPool({ size: 1, createWorker: factory.createWorker });
    const active = pool.clean(request("active"));
    const controller = new AbortController();
    const retired = pool.clean(request("retired"), controller.signal);
    const next = pool.clean(request("next"));

    controller.abort();
    await expect(retired).rejects.toMatchObject({ name: "AbortError" });
    factory.workers[0].emitMessage(success(factory.workers[0].posted[0].message));
    await expect(active).resolves.toMatchObject({ cleanedSize: 2 });
    expect(factory.workers[0].posted).toHaveLength(2);
    expect(factory.workers[0].posted[1].message.id).toBe("next");

    factory.workers[0].emitMessage(success(factory.workers[0].posted[1].message));
    await expect(next).resolves.toMatchObject({ cleanedSize: 2 });
  });

  it.each(["error", "messageerror"] as const)(
    "retires an idle worker after a runtime %s and uses exactly one replacement",
    async (eventType) => {
      const factory = workerFactory();
      const pool = createImageWorkerPool({ size: 1, createWorker: factory.createWorker });
      const retired = factory.workers[0];

      if (eventType === "error") retired.emitError("idle roto");
      else retired.emitMessageError();
      retired.emitError("evento tardío duplicado");

      expect(retired.terminate).toHaveBeenCalledOnce();
      expect(retired.listenerCount("error")).toBe(0);
      expect(retired.listenerCount("messageerror")).toBe(0);
      expect(factory.workers).toHaveLength(2);
      const replacement = factory.workers[1];
      const next = pool.clean(request("next"));
      expect(retired.posted).toHaveLength(0);
      expect(replacement.posted[0].message.id).toBe("next");

      replacement.emitMessage(success(replacement.posted[0].message));
      await expect(next).resolves.toMatchObject({ cleanedSize: 2 });
    },
  );

  it("waits for a healthy busy slot after an idle slot dies and replacement fails", async () => {
    const workers: FakeWorker[] = [];
    let factoryCalls = 0;
    const createWorker = () => {
      factoryCalls += 1;
      if (factoryCalls > 2) throw new Error("reemplazo bloqueado");
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
    const pool = createImageWorkerPool({ size: 2, createWorker });
    const active = pool.clean(request("active"));
    const retiredIdle = workers[1];

    retiredIdle.emitError("idle muerto");
    const waiting = pool.clean(request("waiting"));
    let waitingSettled = false;
    void waiting.then(
      () => {
        waitingSettled = true;
      },
      () => {
        waitingSettled = true;
      },
    );
    await Promise.resolve();

    expect(retiredIdle.terminate).toHaveBeenCalledOnce();
    expect(retiredIdle.posted).toHaveLength(0);
    expect(waitingSettled).toBe(false);
    workers[0].emitMessage(success(workers[0].posted[0].message));
    await expect(active).resolves.toMatchObject({ cleanedSize: 2 });
    expect(workers[0].posted[1].message.id).toBe("waiting");

    workers[0].emitMessage(success(workers[0].posted[1].message));
    await expect(waiting).resolves.toMatchObject({ cleanedSize: 2 });
  });

  it("rejects later work clearly when the only idle worker dies without replacement", async () => {
    const workers: FakeWorker[] = [];
    let factoryCalls = 0;
    const createWorker = () => {
      factoryCalls += 1;
      if (factoryCalls > 1) throw new Error("sin reemplazo");
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
    const pool = createImageWorkerPool({ size: 1, createWorker });

    workers[0].emitMessageError();

    expect(workers[0].terminate).toHaveBeenCalledOnce();
    await expect(pool.clean(request("later"))).rejects.toThrow(/ning[uú]n worker activo/i);
  });

  it("does not recreate an idle worker after the pool is destroyed", () => {
    const factory = workerFactory();
    const pool = createImageWorkerPool({ size: 1, createWorker: factory.createWorker });
    const retired = factory.workers[0];

    pool.destroy();
    retired.emitError("después de destroy");
    retired.emitMessageError();

    expect(factory.workers).toHaveLength(1);
    expect(retired.terminate).toHaveBeenCalledOnce();
  });

  it("rejects waiters clearly when no live worker can be recreated", async () => {
    const workers: FakeWorker[] = [];
    let factoryCalls = 0;
    const createWorker = () => {
      factoryCalls += 1;
      if (factoryCalls > 1) throw new Error("sin reemplazo");
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
    const pool = createImageWorkerPool({ size: 1, createWorker });
    const active = pool.clean(request("active"));
    const waiting = pool.clean(request("waiting"));

    workers[0].emitError("worker muerto");

    await expect(active).rejects.toThrow("worker muerto");
    await expect(waiting).rejects.toThrow(/ning[uú]n worker activo/i);
    await expect(pool.clean(request("later"))).rejects.toThrow(/ning[uú]n worker activo/i);
  });

  it("destroy aborts active and waiting requests without replacement", async () => {
    const factory = workerFactory();
    const pool = createImageWorkerPool({ size: 1, createWorker: factory.createWorker });
    const active = pool.clean(request("active"));
    const waiting = pool.clean(request("waiting"));

    pool.destroy();

    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(factory.workers).toHaveLength(1);
    expect(factory.workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("ignores mismatched messages", async () => {
    const factory = workerFactory();
    const pool = createImageWorkerPool({ size: 1, createWorker: factory.createWorker });
    const active = pool.clean(request("a", 7));
    let settled = false;
    void active.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    factory.workers[0].emitMessage({ ...success(request("wrong", 7)), id: "wrong" });
    factory.workers[0].emitMessage({ ...success(request("a", 6)), generation: 6 });
    await Promise.resolve();
    expect(settled).toBe(false);

    factory.workers[0].emitMessage(success(factory.workers[0].posted[0].message));
    await expect(active).resolves.toMatchObject({ cleanedSize: 2 });
  });

  it("terminates and replaces only the worker whose active request is aborted", async () => {
    const factory = workerFactory();
    const pool = createImageWorkerPool({ size: 2, createWorker: factory.createWorker });
    const controller = new AbortController();
    const cancelled = pool.clean(request("a"), controller.signal);
    const healthy = pool.clean(request("b"));
    const retired = factory.workers[0];
    const untouched = factory.workers[1];

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(retired.terminate).toHaveBeenCalledOnce();
    expect(untouched.terminate).not.toHaveBeenCalled();
    expect(factory.workers).toHaveLength(3);

    retired.emitMessage(success(retired.posted[0].message));
    const replacement = factory.workers[2];
    const next = pool.clean(request("c"));
    expect(replacement.posted[0].message.id).toBe("c");
    replacement.emitMessage(success(replacement.posted[0].message));
    untouched.emitMessage(success(untouched.posted[0].message));
    await expect(Promise.all([next, healthy])).resolves.toHaveLength(2);
  });

  it("reuses a healthy worker after an application error", async () => {
    const factory = workerFactory();
    const pool = createImageWorkerPool({ size: 1, createWorker: factory.createWorker });
    const failed = pool.clean(request("a"));
    factory.workers[0].emitMessage({
      id: "a",
      generation: 1,
      kind: "clean",
      ok: false,
      error: "JPEG truncado",
    });

    await expect(failed).rejects.toThrow("JPEG truncado");
    expect(factory.workers).toHaveLength(1);
    expect(factory.workers[0].terminate).not.toHaveBeenCalled();
    expect(factory.workers[0].listenerCount("message")).toBe(0);

    const retried = pool.clean(request("a", 2));
    factory.workers[0].emitMessage(success(factory.workers[0].posted[1].message));
    await expect(retried).resolves.toMatchObject({ cleanedSize: 2 });
  });

  it.each(["error", "messageerror"] as const)(
    "replaces one worker after a runtime %s and cleans listeners exactly once",
    async (eventType) => {
      const factory = workerFactory();
      const pool = createImageWorkerPool({ size: 2, createWorker: factory.createWorker });
      const failed = pool.clean(request("a"));
      const healthy = factory.workers[1];

      if (eventType === "error") factory.workers[0].emitError("boom");
      else factory.workers[0].emitMessageError();

      await expect(failed).rejects.toThrow(eventType === "error" ? "boom" : /respuesta/i);
      expect(factory.workers).toHaveLength(3);
      expect(factory.workers[0].terminate).toHaveBeenCalledOnce();
      expect(healthy.terminate).not.toHaveBeenCalled();
      expect(factory.workers[0].listenerCount("message")).toBe(0);
      expect(factory.workers[0].listenerCount("error")).toBe(0);
      expect(factory.workers[0].listenerCount("messageerror")).toBe(0);
    },
  );

  it("destroy rejects active work and terminates without replacement", async () => {
    const factory = workerFactory();
    const pool = createImageWorkerPool({ size: 2, createWorker: factory.createWorker });
    const first = pool.clean(request("a"));
    const second = pool.clean(request("b"));

    pool.destroy();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(factory.workers).toHaveLength(2);
    expect(factory.workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
    await expect(pool.clean(request("late"))).rejects.toThrow(/destruido/i);
  });
});

describe("clean worker protocol", () => {
  it("returns kind clean and an exact-sized transferable output buffer", () => {
    const bytes = jpegWithComment("Created by AI").bytes;
    const response = handleCleanWorkerRequest({
      id: "a",
      generation: 9,
      kind: "clean",
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    });

    expect(response.message).toMatchObject({ id: "a", generation: 9, kind: "clean", ok: true });
    if (!response.message.ok) throw new Error(response.message.error);
    expect(response.transfer).toEqual([response.message.result.cleaned.buffer]);
    expect(response.message.result.cleaned.byteOffset).toBe(0);
    expect(response.message.result.cleaned.byteLength).toBe(
      response.message.result.cleaned.buffer.byteLength,
    );
  });

  it("returns kind clean on parser failure without a transfer", () => {
    const response = handleCleanWorkerRequest(request("bad", 3, Uint8Array.of(1, 2).buffer));

    expect(response).toEqual({
      message: {
        id: "bad",
        generation: 3,
        kind: "clean",
        ok: false,
        error: "Formato no soportado. Usa JPEG o PNG.",
      },
      transfer: [],
    });
  });
});

function tiktokResult(): TikTokExportResult {
  return {
    png: Uint8Array.of(1, 2, 3),
    preview: Uint8Array.of(4, 5),
    width: 10,
    height: 20,
    seed: 42,
    outputExtension: ".png",
    approximate: true,
    eligiblePixels: 10,
    eligibleFraction: 0.05,
    changedSamples: 20,
    sumDelta: 0,
    meanDelta: 0,
  };
}

describe("TikTok worker protocol", () => {
  it("uses a dedicated concurrency-one pool and transfers the input buffer", async () => {
    const factory = workerFactory();
    const pool = createTikTokWorkerPool({ createWorker: factory.createWorker });
    const bytes = Uint8Array.of(1, 2, 3).buffer;
    const work = pool.tiktok({
      id: "tt",
      generation: 4,
      kind: "tiktok",
      bytes,
      mimeType: "image/jpeg",
    });

    expect(pool.size).toBe(1);
    expect(factory.workers).toHaveLength(1);
    expect(factory.workers[0].posted[0].transfer).toEqual([bytes]);
    factory.workers[0].emitMessage({
      id: "tt",
      generation: 4,
      kind: "tiktok",
      ok: true,
      result: tiktokResult(),
    });
    await expect(work).resolves.toMatchObject({ width: 10, approximate: true });
  });

  it("correlates kind and generation before accepting a TikTok response", async () => {
    const factory = workerFactory();
    const pool = createTikTokWorkerPool({ createWorker: factory.createWorker });
    const work = pool.tiktok({
      id: "tt",
      generation: 7,
      kind: "tiktok",
      bytes: Uint8Array.of(1).buffer,
      mimeType: "image/png",
    });
    let settled = false;
    void work.finally(() => {
      settled = true;
    });
    factory.workers[0].emitMessage({
      id: "tt",
      generation: 6,
      kind: "tiktok",
      ok: true,
      result: tiktokResult(),
    });
    factory.workers[0].emitMessage({
      id: "tt",
      generation: 7,
      kind: "clean",
      ok: true,
      result: result(),
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    factory.workers[0].emitMessage({
      id: "tt",
      generation: 7,
      kind: "tiktok",
      ok: true,
      result: tiktokResult(),
    });
    await expect(work).resolves.toMatchObject({ seed: 42 });
  });

  it("keeps the worker reusable after a TikTok application error", async () => {
    const factory = workerFactory();
    const pool = createTikTokWorkerPool({ createWorker: factory.createWorker });
    const firstRequest = {
      id: "a",
      generation: 1,
      kind: "tiktok",
      bytes: Uint8Array.of(1).buffer,
      mimeType: "image/png",
    } as const;
    const first = pool.tiktok(firstRequest);
    factory.workers[0].emitMessage({
      id: "a",
      generation: 1,
      kind: "tiktok",
      ok: false,
      error: "APNG no compatible",
    });
    await expect(first).rejects.toThrow("APNG no compatible");

    const second = pool.tiktok({
      ...firstRequest,
      generation: 2,
      bytes: Uint8Array.of(2).buffer,
    });
    expect(factory.workers).toHaveLength(1);
    expect(factory.workers[0].terminate).not.toHaveBeenCalled();
    factory.workers[0].emitMessage({
      id: "a",
      generation: 2,
      kind: "tiktok",
      ok: true,
      result: tiktokResult(),
    });
    await expect(second).resolves.toMatchObject({ outputExtension: ".png" });
  });

  it("replaces the TikTok worker after active cancellation", async () => {
    const factory = workerFactory();
    const pool = createTikTokWorkerPool({ createWorker: factory.createWorker });
    const controller = new AbortController();
    const work = pool.tiktok(
      {
        id: "cancel",
        generation: 1,
        kind: "tiktok",
        bytes: Uint8Array.of(1).buffer,
        mimeType: "image/jpeg",
      },
      controller.signal,
    );
    controller.abort();

    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    expect(factory.workers[0].terminate).toHaveBeenCalledOnce();
    expect(factory.workers).toHaveLength(2);
  });

  it("returns exact PNG and preview transfers from the worker handler", async () => {
    const produced = tiktokResult();
    produced.png = new Uint8Array(Uint8Array.of(9, 1, 2, 8).buffer, 1, 2);
    produced.preview = new Uint8Array(Uint8Array.of(7, 3, 4, 6).buffer, 1, 2);
    const reply = await handleTikTokWorkerRequest(
      {
        id: "tt",
        generation: 9,
        kind: "tiktok",
        bytes: Uint8Array.of(0xff, 0xd8, 0xff).buffer,
        mimeType: "image/jpeg",
      },
      async () => produced,
    );

    expect(reply.message).toMatchObject({
      id: "tt",
      generation: 9,
      kind: "tiktok",
      ok: true,
    });
    if (!reply.message.ok || reply.message.kind !== "tiktok") {
      throw new Error("respuesta inesperada");
    }
    expect(reply.message.result.png.byteOffset).toBe(0);
    expect(reply.message.result.preview.byteOffset).toBe(0);
    expect(reply.transfer).toEqual([
      reply.message.result.png.buffer,
      reply.message.result.preview.buffer,
    ]);
  });

  it("serializes the main-thread fallback at concurrency one", async () => {
    const releases: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    const workerPool = {
      tiktok: vi.fn().mockRejectedValue(new TikTokWorkerFallbackError("sin OffscreenCanvas")),
      destroy: vi.fn(),
    };
    const processor = createTikTokProcessor({
      workerPool,
      async exportOnMainThread() {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
        return tiktokResult();
      },
    });
    const first = processor.export(
      new Blob([Uint8Array.of(1)]),
      { id: "a", generation: 1 },
    );
    const second = processor.export(
      new Blob([Uint8Array.of(2)]),
      { id: "b", generation: 1 },
    );
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(peak).toBe(1);
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(peak).toBe(1);
    releases.shift()?.();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(workerPool.tiktok).toHaveBeenCalledTimes(2);
    processor.destroy();
    expect(workerPool.destroy).toHaveBeenCalledOnce();
  });
});
