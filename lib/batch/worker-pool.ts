import type { CleanResult } from "../types";

export type WorkerRequest = {
  id: string;
  generation: number;
  kind: "clean";
  bytes: ArrayBuffer;
};

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
    };

export type ImageWorkerEventType = "message" | "error" | "messageerror";

export interface ImageWorker {
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
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
  clean(request: WorkerRequest, signal?: AbortSignal): Promise<CleanResult>;
  process(request: WorkerRequest, signal?: AbortSignal): Promise<CleanResult>;
  destroy(): void;
}

interface ActiveRequest {
  finished: boolean;
  destroy: () => void;
  fail: (error: unknown) => void;
}

interface WaitingRequest {
  request: WorkerRequest;
  signal?: AbortSignal;
  settled: boolean;
  resolve: (result: CleanResult) => void;
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
  const candidate = value as Partial<WorkerResponse>;
  const envelopeIsValid =
    typeof candidate.id === "string" &&
    typeof candidate.generation === "number" &&
    candidate.kind === "clean" &&
    typeof candidate.ok === "boolean";
  if (!envelopeIsValid) return false;
  if (candidate.ok) return typeof candidate.result === "object" && candidate.result !== null;
  return "error" in candidate && typeof candidate.error === "string";
}

export function createDefaultImageWorker(): ImageWorker {
  return new Worker(new URL("../workers/image-worker.ts", import.meta.url), { type: "module" });
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
    outcome: { result: CleanResult } | { error: unknown },
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
      outcome: { result: CleanResult } | { error: unknown },
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
      if (message.ok) finish({ result: message.result }, false);
      else finish({ error: new Error(message.error) }, false);
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

  const execute = (request: WorkerRequest, signal?: AbortSignal): Promise<CleanResult> => {
    if (terminal) return Promise.reject(new Error("El pool de workers fue destruido."));
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));

    return new Promise<CleanResult>((resolve, reject) => {
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
    });
  };

  return {
    size,
    get running() {
      return slots.reduce((count, slot) => count + (slot.active ? 1 : 0), 0);
    },
    get destroyed() {
      return terminal;
    },
    clean: execute,
    process: execute,
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
  request: WorkerRequest,
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
