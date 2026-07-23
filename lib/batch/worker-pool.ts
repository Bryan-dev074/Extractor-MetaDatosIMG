import type { CleanResult } from "../types";
import {
  createHtmlTikTokAdapter,
  exportForTikTok,
  type TikTokExportResult,
} from "../tiktok/export";

export type CleanWorkerRequest = {
  id: string;
  generation: number;
  kind: "clean";
  bytes: ArrayBuffer;
};

export type TikTokWorkerRequest = {
  id: string;
  generation: number;
  kind: "tiktok";
  bytes: ArrayBuffer;
  mimeType: string;
};

export type ImageWorkerRequest = CleanWorkerRequest | TikTokWorkerRequest;
export type WorkerRequest = ImageWorkerRequest;

export type WorkerResponse =
  | {
      id: string;
      generation: number;
      ok: true;
      kind: "clean";
      result: CleanResult;
    }
  | {
      id: string;
      generation: number;
      ok: false;
      kind: "clean";
      error: string;
    }
  | {
      id: string;
      generation: number;
      ok: true;
      kind: "tiktok";
      result: TikTokExportResult;
    }
  | {
      id: string;
      generation: number;
      ok: false;
      kind: "tiktok";
      error: string;
      fallbackRequired?: boolean;
    };

export type ImageWorkerEventType = "message" | "error" | "messageerror";

export interface ImageWorker {
  postMessage(message: ImageWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
  addEventListener(
    type: ImageWorkerEventType,
    listener: EventListenerOrEventListenerObject,
  ): void;
  removeEventListener(
    type: ImageWorkerEventType,
    listener: EventListenerOrEventListenerObject,
  ): void;
}

export type ImageWorkerFactory = () => ImageWorker;

export interface ImageWorkerPoolOptions {
  size?: number;
  createWorker?: ImageWorkerFactory;
}

export interface ImageWorkerPool {
  readonly size: number;
  readonly running: number;
  readonly destroyed: boolean;
  clean(request: CleanWorkerRequest, signal?: AbortSignal): Promise<CleanResult>;
  tiktok(request: TikTokWorkerRequest, signal?: AbortSignal): Promise<TikTokExportResult>;
  process(request: CleanWorkerRequest, signal?: AbortSignal): Promise<CleanResult>;
  process(request: TikTokWorkerRequest, signal?: AbortSignal): Promise<TikTokExportResult>;
  destroy(): void;
}

type ImageWorkerResult = CleanResult | TikTokExportResult;

interface ActiveRequest {
  finished: boolean;
  destroy: () => void;
  fail: (error: unknown) => void;
}

interface WaitingRequest {
  request: ImageWorkerRequest;
  signal?: AbortSignal;
  settled: boolean;
  resolve: (result: ImageWorkerResult) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

interface WorkerSlot {
  worker: ImageWorker | null;
  active: ActiveRequest | null;
  runtimeListeners: {
    worker: ImageWorker;
    onError: EventListener;
    onMessageError: EventListener;
  } | null;
}

function abortError(reason?: unknown): DOMException {
  if (reason instanceof DOMException && reason.name === "AbortError") return reason;
  return new DOMException(
    typeof reason === "string" && reason ? reason : "El trabajo fue cancelado.",
    "AbortError",
  );
}

function eventError(event: Event): Error {
  if ("message" in event && typeof event.message === "string" && event.message) {
    return new Error(event.message);
  }
  return new Error("El worker encontró un error de ejecución.");
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const envelopeIsValid =
    typeof candidate.id === "string" &&
    typeof candidate.generation === "number" &&
    (candidate.kind === "clean" || candidate.kind === "tiktok") &&
    typeof candidate.ok === "boolean";
  if (!envelopeIsValid) return false;
  if (candidate.ok) return typeof candidate.result === "object" && candidate.result !== null;
  return typeof candidate.error === "string";
}

export class TikTokWorkerFallbackError extends Error {
  readonly fallbackRequired = true;

  constructor(message: string) {
    super(message);
    this.name = "TikTokWorkerFallbackError";
  }
}

export function createDefaultImageWorker(): ImageWorker {
  return new Worker(new URL("../../workers/image-worker.ts", import.meta.url), {
    type: "module",
  });
}

export function createImageWorkerPool(
  options: ImageWorkerPoolOptions = {},
): ImageWorkerPool {
  const size = options.size ?? 2;
  const createWorker = options.createWorker ?? createDefaultImageWorker;
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError("El tamaño del pool debe ser un entero positivo.");
  }

  const slots: WorkerSlot[] = [];
  try {
    for (let index = 0; index < size; index += 1) {
      slots.push({ worker: createWorker(), active: null, runtimeListeners: null });
    }
  } catch (error) {
    for (const slot of slots) slot.worker?.terminate();
    throw error;
  }

  let terminal = false;
  const waiting: WaitingRequest[] = [];
  let draining = false;

  const noLiveWorkerError = (): Error =>
    new Error("No queda ningún worker activo y no se pudo recrear el pool.");

  const settleWaiting = (
    entry: WaitingRequest,
    outcome: { result: ImageWorkerResult } | { error: unknown },
  ): void => {
    if (entry.settled) return;
    entry.settled = true;
    entry.signal?.removeEventListener("abort", entry.onAbort);
    if ("result" in outcome) entry.resolve(outcome.result);
    else entry.reject(outcome.error);
  };

  const rejectAllWaiting = (error: unknown): void => {
    for (const entry of waiting.splice(0)) {
      settleWaiting(entry, { error });
    }
  };

  const liveWorkerCount = (): number =>
    slots.reduce((count, slot) => count + (slot.worker ? 1 : 0), 0);

  let drainWaiting: () => void;
  let handleSlotRuntimeFailure: (
    slot: WorkerSlot,
    worker: ImageWorker,
    error: Error,
  ) => void;

  const removeRuntimeListeners = (slot: WorkerSlot, worker: ImageWorker): void => {
    const listeners = slot.runtimeListeners;
    if (!listeners || listeners.worker !== worker) return;
    worker.removeEventListener("error", listeners.onError);
    worker.removeEventListener("messageerror", listeners.onMessageError);
    slot.runtimeListeners = null;
  };

  const attachWorker = (slot: WorkerSlot, worker: ImageWorker): void => {
    const onError: EventListener = (event) => {
      handleSlotRuntimeFailure(slot, worker, eventError(event));
    };
    const onMessageError: EventListener = () => {
      handleSlotRuntimeFailure(
        slot,
        worker,
        new Error("No se pudo decodificar la respuesta del worker."),
      );
    };
    slot.worker = worker;
    slot.runtimeListeners = { worker, onError, onMessageError };
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
  };

  const replaceSlotWorker = (slot: WorkerSlot, worker: ImageWorker): void => {
    if (slot.worker !== worker) return;
    removeRuntimeListeners(slot, worker);
    slot.worker = null;
    worker.terminate();
    if (terminal) return;
    try {
      attachWorker(slot, createWorker());
    } catch {
      slot.worker = null;
      slot.runtimeListeners = null;
    }
  };

  const recreateDeadSlots = (): boolean => {
    for (const slot of slots) {
      if (terminal || slot.worker || slot.active) continue;
      try {
        attachWorker(slot, createWorker());
      } catch {
        slot.worker = null;
        slot.runtimeListeners = null;
      }
    }
    return liveWorkerCount() > 0;
  };

  const start = (slot: WorkerSlot, entry: WaitingRequest): void => {
    const assignedWorker = slot.worker;
    if (!assignedWorker) {
      settleWaiting(entry, { error: noLiveWorkerError() });
      return;
    }

    const cleanup = (): void => {
      assignedWorker.removeEventListener("message", onMessage);
      entry.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (
      outcome: { result: ImageWorkerResult } | { error: unknown },
      replaceWorker: boolean,
    ): void => {
      if (active.finished) return;
      active.finished = true;
      cleanup();

      if (replaceWorker) replaceSlotWorker(slot, assignedWorker);
      if (slot.active === active) slot.active = null;
      settleWaiting(entry, outcome);
      drainWaiting();
    };

    const onMessage: EventListener = (event) => {
      if (slot.worker !== assignedWorker || slot.active !== active) return;
      const message = (event as MessageEvent<unknown>).data;
      if (!isWorkerResponse(message)) return;
      if (
        message.id !== entry.request.id ||
        message.generation !== entry.request.generation ||
        message.kind !== entry.request.kind
      ) {
        return;
      }
      if (message.ok) {
        finish({ result: message.result }, false);
      } else {
        const error =
          message.kind === "tiktok" && message.fallbackRequired
            ? new TikTokWorkerFallbackError(message.error)
            : new Error(message.error);
        finish({ error }, false);
      }
    };

    const onAbort = (): void => {
      if (slot.worker !== assignedWorker || slot.active !== active) return;
      finish({ error: abortError(entry.signal?.reason) }, true);
    };

    const active: ActiveRequest = {
      finished: false,
      destroy: () => finish({ error: abortError("El pool fue destruido.") }, false),
      fail: (error) => finish({ error }, true),
    };
    slot.active = active;
    assignedWorker.addEventListener("message", onMessage);
    entry.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      assignedWorker.postMessage(entry.request, [entry.request.bytes]);
    } catch (error) {
      finish({ error }, true);
    }
  };

  handleSlotRuntimeFailure = (
    slot: WorkerSlot,
    worker: ImageWorker,
    error: Error,
  ): void => {
    if (terminal || slot.worker !== worker) return;
    if (slot.active) {
      slot.active.fail(error);
      return;
    }
    replaceSlotWorker(slot, worker);
    drainWaiting();
  };

  drainWaiting = (): void => {
    if (terminal || draining) return;
    draining = true;
    try {
      while (waiting.length > 0) {
        let slot = slots.find((candidate) => candidate.worker !== null && candidate.active === null);
        if (!slot) {
          if (liveWorkerCount() > 0) return;
          if (!recreateDeadSlots()) {
            rejectAllWaiting(noLiveWorkerError());
            return;
          }
          slot = slots.find(
            (candidate) => candidate.worker !== null && candidate.active === null,
          );
          if (!slot) return;
        }

        const entry = waiting.shift();
        if (!entry || entry.settled) continue;
        entry.signal?.removeEventListener("abort", entry.onAbort);
        if (entry.signal?.aborted) {
          settleWaiting(entry, { error: abortError(entry.signal.reason) });
          continue;
        }
        start(slot, entry);
      }
    } finally {
      draining = false;
    }
  };

  for (const slot of slots) {
    if (slot.worker) attachWorker(slot, slot.worker);
  }

  const execute = <Result extends ImageWorkerResult>(
    request: ImageWorkerRequest,
    signal?: AbortSignal,
  ): Promise<Result> => {
    if (terminal) return Promise.reject(new Error("El pool de workers fue destruido."));
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));

    return new Promise<ImageWorkerResult>((resolve, reject) => {
      const entry: WaitingRequest = {
        request,
        signal,
        settled: false,
        resolve,
        reject,
        onAbort: () => {
          const index = waiting.indexOf(entry);
          if (index < 0) return;
          waiting.splice(index, 1);
          settleWaiting(entry, { error: abortError(signal?.reason) });
        },
      };
      waiting.push(entry);
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      drainWaiting();
    }) as Promise<Result>;
  };

  const clean = (request: CleanWorkerRequest, signal?: AbortSignal): Promise<CleanResult> =>
    execute<CleanResult>(request, signal);
  const tiktok = (
    request: TikTokWorkerRequest,
    signal?: AbortSignal,
  ): Promise<TikTokExportResult> => execute<TikTokExportResult>(request, signal);
  function process(
    request: CleanWorkerRequest,
    signal?: AbortSignal,
  ): Promise<CleanResult>;
  function process(
    request: TikTokWorkerRequest,
    signal?: AbortSignal,
  ): Promise<TikTokExportResult>;
  function process(
    request: ImageWorkerRequest,
    signal?: AbortSignal,
  ): Promise<ImageWorkerResult> {
    return execute(request, signal);
  }

  return {
    size,
    get running() {
      return slots.reduce((count, slot) => count + (slot.active ? 1 : 0), 0);
    },
    get destroyed() {
      return terminal;
    },
    clean,
    tiktok,
    process,
    destroy() {
      if (terminal) return;
      terminal = true;
      rejectAllWaiting(abortError("El pool fue destruido."));
      for (const slot of slots) {
        slot.active?.destroy();
        const worker = slot.worker;
        if (worker) {
          removeRuntimeListeners(slot, worker);
          worker.terminate();
        }
        slot.worker = null;
        slot.active = null;
        slot.runtimeListeners = null;
      }
    },
  };
}

export type TikTokWorkerPoolOptions = Omit<ImageWorkerPoolOptions, "size">;

export function createTikTokWorkerPool(
  options: TikTokWorkerPoolOptions = {},
): ImageWorkerPool {
  return createImageWorkerPool({ ...options, size: 1 });
}

interface TikTokPoolLike {
  tiktok(request: TikTokWorkerRequest, signal?: AbortSignal): Promise<TikTokExportResult>;
  destroy(): void;
}

export interface TikTokProcessorOptions {
  workerPool?: TikTokPoolLike;
  createWorker?: ImageWorkerFactory;
  exportOnMainThread?: (
    input: Blob,
    signal: AbortSignal,
  ) => Promise<TikTokExportResult>;
}

export interface TikTokProcessor {
  readonly size: 1;
  readonly destroyed: boolean;
  export(
    input: Blob,
    correlation: { id: string; generation: number },
    signal?: AbortSignal,
  ): Promise<TikTokExportResult>;
  destroy(): void;
}

interface TikTokFallbackEntry {
  input: Blob;
  signal: AbortSignal;
  started: boolean;
  outwardSettled: boolean;
  resolve: (result: TikTokExportResult) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

export function createTikTokProcessor(
  options: TikTokProcessorOptions = {},
): TikTokProcessor {
  let pool: TikTokPoolLike | null = options.workerPool ?? null;
  if (!pool) {
    try {
      pool = createTikTokWorkerPool({ createWorker: options.createWorker });
    } catch {
      // Worker construction can fail eagerly under CSP, module-loading, or
      // browser support restrictions. The HTML path remains fully usable.
      pool = null;
    }
  }
  const exportOnMainThread =
    options.exportOnMainThread ??
    ((input: Blob, signal: AbortSignal) =>
      exportForTikTok(input, signal, { adapter: createHtmlTikTokAdapter() }));
  let terminal = false;
  const activeControllers = new Set<AbortController>();
  const fallbackWaiting: TikTokFallbackEntry[] = [];
  let fallbackActive: TikTokFallbackEntry | null = null;
  let drainFallback: () => void;

  const settleFallback = (
    entry: TikTokFallbackEntry,
    outcome: { result: TikTokExportResult } | { error: unknown },
  ): void => {
    if (entry.outwardSettled) return;
    entry.outwardSettled = true;
    entry.signal.removeEventListener("abort", entry.onAbort);
    if ("result" in outcome) entry.resolve(outcome.result);
    else entry.reject(outcome.error);
  };

  const runFallback = async (entry: TikTokFallbackEntry): Promise<void> => {
    try {
      throwIfAborted(entry.signal);
      if (terminal) throw abortError("El procesador TikTok fue destruido.");
      const result = await exportOnMainThread(entry.input, entry.signal);
      if (!terminal && !entry.signal.aborted) {
        settleFallback(entry, { result });
      }
    } catch (error) {
      if (!entry.outwardSettled) {
        settleFallback(entry, {
          error:
            entry.signal.aborted
              ? abortError(entry.signal.reason)
              : error,
        });
      }
    } finally {
      if (fallbackActive === entry) fallbackActive = null;
      if (!terminal) drainFallback();
    }
  };

  drainFallback = (): void => {
    if (terminal || fallbackActive) return;
    while (fallbackWaiting.length > 0) {
      const entry = fallbackWaiting.shift();
      if (!entry || entry.outwardSettled) continue;
      if (entry.signal.aborted) {
        settleFallback(entry, { error: abortError(entry.signal.reason) });
        continue;
      }
      entry.started = true;
      fallbackActive = entry;
      void runFallback(entry);
      return;
    }
  };

  const enqueueFallback = (
    input: Blob,
    signal: AbortSignal,
  ): Promise<TikTokExportResult> => {
    if (terminal) return Promise.reject(abortError("El procesador TikTok fue destruido."));
    if (signal.aborted) return Promise.reject(abortError(signal.reason));
    return new Promise<TikTokExportResult>((resolve, reject) => {
      const entry: TikTokFallbackEntry = {
        input,
        signal,
        started: false,
        outwardSettled: false,
        resolve,
        reject,
        onAbort: () => {
          if (!entry.started) {
            const index = fallbackWaiting.indexOf(entry);
            if (index >= 0) fallbackWaiting.splice(index, 1);
          }
          settleFallback(entry, { error: abortError(signal.reason) });
          if (!fallbackActive) drainFallback();
        },
      };
      fallbackWaiting.push(entry);
      signal.addEventListener("abort", entry.onAbort, { once: true });
      drainFallback();
    });
  };

  return {
    size: 1,
    get destroyed() {
      return terminal;
    },
    async export(input, correlation, signal) {
      if (terminal) throw new Error("El procesador TikTok fue destruido.");
      if (signal?.aborted) throw abortError(signal.reason);
      const controller = new AbortController();
      const relayAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", relayAbort, { once: true });
      activeControllers.add(controller);
      try {
        if (!pool) {
          return await enqueueFallback(input, controller.signal);
        }
        const bytes = await input.arrayBuffer();
        throwIfAborted(controller.signal);
        try {
          return await pool.tiktok(
            {
              id: correlation.id,
              generation: correlation.generation,
              kind: "tiktok",
              bytes,
              mimeType: input.type,
            },
            controller.signal,
          );
        } catch (error) {
          if (!(error instanceof TikTokWorkerFallbackError)) throw error;
          return await enqueueFallback(input, controller.signal);
        }
      } finally {
        signal?.removeEventListener("abort", relayAbort);
        activeControllers.delete(controller);
      }
    },
    destroy() {
      if (terminal) return;
      terminal = true;
      for (const controller of activeControllers) {
        controller.abort("El procesador TikTok fue destruido.");
      }
      activeControllers.clear();
      pool?.destroy();
    },
  };
}

function exactSizedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  return Uint8Array.from(bytes);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason);
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Fallback for browsers without Worker support. The yields make queued cancellation
 * observable around parsing; the synchronous cleanBytes call itself is not preemptible.
 */
export async function cleanOnMainThread(
  request: CleanWorkerRequest,
  signal: AbortSignal,
): Promise<CleanResult> {
  throwIfAborted(signal);
  await yieldToMainThread();
  throwIfAborted(signal);
  const { cleanBytes } = await import("../cleaner");
  throwIfAborted(signal);
  const result = cleanBytes(new Uint8Array(request.bytes));
  throwIfAborted(signal);
  await yieldToMainThread();
  throwIfAborted(signal);
  const cleaned = exactSizedBytes(result.cleaned);
  return { ...result, cleaned, cleanedSize: cleaned.byteLength };
}
