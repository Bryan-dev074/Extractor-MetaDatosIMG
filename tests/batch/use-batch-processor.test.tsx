import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBatchProcessor } from "@/hooks/useBatchProcessor";
import type {
  ImageWorker,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/batch/worker-pool";
import type { InputImage } from "@/lib/batch/types";
import type { CleanResult } from "@/lib/types";
import { jpegWithComment } from "@/tests/fixtures/images";

type WorkerEventType = "message" | "error" | "messageerror";

class FakeWorker implements ImageWorker {
  readonly posted: Array<{ message: WorkerRequest; transfer: Transferable[] }> = [];
  readonly terminate = vi.fn();
  private readonly listeners = new Map<WorkerEventType, Set<EventListenerOrEventListenerObject>>();

  postMessage(message: WorkerRequest, transfer: Transferable[]): void {
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
    const event = new MessageEvent("message", { data });
    for (const listener of [...(this.listeners.get("message") ?? [])]) {
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function makeInput(id: string, read?: () => Promise<ArrayBuffer>): InputImage & {
  read: ReturnType<typeof vi.fn<() => Promise<ArrayBuffer>>>;
} {
  const bytes = jpegWithComment(`Created by AI ${id}`).bytes;
  const makeBuffer = () =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const file = new File([makeBuffer()], `${id}.jpg`, { type: "image/jpeg" });
  const arrayBuffer = vi.fn(read ?? (async () => makeBuffer()));
  Object.defineProperty(file, "arrayBuffer", { configurable: true, value: arrayBuffer });
  return {
    id,
    file,
    relativePath: `Raiz/${id}.jpg`,
    format: "jpeg",
    read: arrayBuffer,
  };
}

function cleanResult(originalSize: number): CleanResult {
  const cleaned = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
  return {
    format: "jpeg",
    mime: "image/jpeg",
    cleaned,
    originalSize,
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

function succeed(worker: FakeWorker, postIndex = worker.posted.length - 1): void {
  const request = worker.posted[postIndex].message;
  worker.emitMessage({
    id: request.id,
    generation: request.generation,
    kind: "clean",
    ok: true,
    result: cleanResult(request.bytes.byteLength),
  });
}

describe("useBatchProcessor", () => {
  it("constructs eager workers in an effect, never during render", async () => {
    const factory = workerFactory();
    let rendering = false;
    let constructedDuringRender = false;
    const createWorker = () => {
      if (rendering) constructedDuringRender = true;
      return factory.createWorker();
    };

    const { result } = renderHook(() => {
      rendering = true;
      const api = useBatchProcessor({ createWorker });
      rendering = false;
      return api;
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(constructedDuringRender).toBe(false);
    expect(factory.workers).toHaveLength(2);
  });

  it("reads files only in active queue runners and respects worker concurrency", async () => {
    const factory = workerFactory();
    const first = makeInput("a");
    const second = makeInput("b");
    const { result } = renderHook(() =>
      useBatchProcessor({ createWorker: factory.createWorker, workerPoolSize: 1 }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.start([first, second]));
    await waitFor(() => expect(factory.workers[0].posted).toHaveLength(1));
    expect(first.read).toHaveBeenCalledOnce();
    expect(second.read).not.toHaveBeenCalled();

    act(() => succeed(factory.workers[0]));
    await waitFor(() => expect(factory.workers[0].posted).toHaveLength(2));
    expect(second.read).toHaveBeenCalledOnce();
    act(() => succeed(factory.workers[0]));
    await waitFor(() => expect(result.current.summary.completed).toBe(2));
    expect(result.current.summary.processing).toBe(0);
  });

  it("removes a keyed active item, replaces its worker, and ignores its late response", async () => {
    const factory = workerFactory();
    const first = makeInput("a");
    const second = makeInput("b");
    const { result } = renderHook(() =>
      useBatchProcessor({ createWorker: factory.createWorker, workerPoolSize: 1 }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.start([first, second]));
    await waitFor(() => expect(factory.workers[0].posted).toHaveLength(1));
    const retiredRequest = factory.workers[0].posted[0].message;

    act(() => result.current.remove("a"));
    await waitFor(() => expect(factory.workers).toHaveLength(2));
    await waitFor(() => expect(factory.workers[1].posted).toHaveLength(1));
    expect(result.current.state.order).toEqual(["b"]);
    factory.workers[0].emitMessage({
      id: retiredRequest.id,
      generation: retiredRequest.generation,
      kind: "clean",
      ok: true,
      result: cleanResult(retiredRequest.bytes.byteLength),
    });
    expect(result.current.state.itemsById.a).toBeUndefined();

    act(() => succeed(factory.workers[1]));
    await waitFor(() => expect(result.current.state.itemsById.b.status).toBe("completed"));
  });

  it("invalidates generation before cancel callbacks and ignores late completion", async () => {
    const factory = workerFactory();
    const item = makeInput("a");
    const { result } = renderHook(() =>
      useBatchProcessor({ createWorker: factory.createWorker, workerPoolSize: 1 }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.start([item]));
    await waitFor(() => expect(factory.workers[0].posted).toHaveLength(1));
    const oldGeneration = result.current.state.generation;
    const retiredRequest = factory.workers[0].posted[0].message;

    act(() => result.current.cancel());
    expect(result.current.state.generation).toBeGreaterThan(oldGeneration);
    expect(result.current.state.itemsById.a.status).toBe("cancelled");
    factory.workers[0].emitMessage({
      id: retiredRequest.id,
      generation: retiredRequest.generation,
      kind: "clean",
      ok: true,
      result: cleanResult(retiredRequest.bytes.byteLength),
    });
    await Promise.resolve();
    expect(result.current.state.itemsById.a.status).toBe("cancelled");
  });

  it("resets to an empty newer generation with no late dispatch", async () => {
    const factory = workerFactory();
    const item = makeInput("a");
    const { result } = renderHook(() =>
      useBatchProcessor({ createWorker: factory.createWorker, workerPoolSize: 1 }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.start([item]));
    await waitFor(() => expect(factory.workers[0].posted).toHaveLength(1));
    const generation = result.current.state.generation;

    act(() => result.current.reset());
    expect(result.current.state).toEqual({
      generation: generation + 1,
      order: [],
      itemsById: {},
    });
    await Promise.resolve();
    expect(result.current.state.order).toEqual([]);
  });

  it("destroys workers without replacement and dispatches nothing after unmount", async () => {
    const factory = workerFactory();
    const item = makeInput("a");
    const { result, unmount } = renderHook(() =>
      useBatchProcessor({ createWorker: factory.createWorker, workerPoolSize: 1 }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.start([item]));
    await waitFor(() => expect(factory.workers[0].posted).toHaveLength(1));

    unmount();
    await Promise.resolve();

    expect(factory.workers).toHaveLength(1);
    expect(factory.workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("uses a cancellable concurrency-one main-thread fallback", async () => {
    const firstGate = deferred<ArrayBuffer>();
    const first = makeInput("a", () => firstGate.promise);
    const second = makeInput("b");
    const { result } = renderHook(() => useBatchProcessor({ forceMainThread: true }));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.start([first, second]));
    await waitFor(() => expect(first.read).toHaveBeenCalledOnce());
    expect(second.read).not.toHaveBeenCalled();
    const bytes = jpegWithComment("Created by AI a").bytes;
    firstGate.resolve(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );

    await waitFor(() => expect(result.current.summary.completed).toBe(2));
    expect(second.read).toHaveBeenCalledOnce();
    expect(result.current.mode).toBe("main-thread");
  });

  it("rereads the source on retry and reuses a worker after an application error", async () => {
    const factory = workerFactory();
    const item = makeInput("a");
    const { result } = renderHook(() =>
      useBatchProcessor({ createWorker: factory.createWorker, workerPoolSize: 1 }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.start([item]));
    await waitFor(() => expect(factory.workers[0].posted).toHaveLength(1));
    const firstRequest = factory.workers[0].posted[0].message;
    act(() =>
      factory.workers[0].emitMessage({
        id: firstRequest.id,
        generation: firstRequest.generation,
        kind: "clean",
        ok: false,
        error: "JPEG truncado",
      }),
    );
    await waitFor(() => expect(result.current.state.itemsById.a.status).toBe("error"));

    act(() => result.current.retry("a"));
    await waitFor(() => expect(factory.workers[0].posted).toHaveLength(2));
    expect(item.read).toHaveBeenCalledTimes(2);
    expect(factory.workers).toHaveLength(1);
    expect(factory.workers[0].posted[1].message.bytes).not.toBe(firstRequest.bytes);
    act(() => succeed(factory.workers[0], 1));
    await waitFor(() => expect(result.current.state.itemsById.a.status).toBe("completed"));
  });

  it("adds items without changing the active generation", async () => {
    const factory = workerFactory();
    const first = makeInput("a");
    const second = makeInput("b");
    const { result } = renderHook(() =>
      useBatchProcessor({ createWorker: factory.createWorker, workerPoolSize: 1 }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.start([first]));
    const generation = result.current.state.generation;

    act(() => result.current.add([second]));

    expect(result.current.state.generation).toBe(generation);
    expect(result.current.state.order).toEqual(["a", "b"]);
  });
});
