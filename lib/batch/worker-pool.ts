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
}

interface WorkerSlot {
  worker: ImageWorker | null;
  active: ActiveRequest | null;
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
      slots.push({ worker: createWorker(), active: null });
    }
  } catch (error) {
    for (const slot of slots) slot.worker?.terminate();
    throw error;
  }

  let terminal = false;

  const execute = (request: WorkerRequest, signal?: AbortSignal): Promise<CleanResult> => {
    if (terminal) return Promise.reject(new Error("El pool de workers fue destruido."));
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    const slot = slots.find((candidate) => candidate.worker !== null && candidate.active === null);
    if (!slot || !slot.worker) {
      return Promise.reject(new Error("No hay un worker disponible para ejecutar la tarea."));
    }

    const assignedWorker = slot.worker;
    return new Promise<CleanResult>((resolve, reject) => {
      const cleanup = (): void => {
        assignedWorker.removeEventListener("message", onMessage);
        assignedWorker.removeEventListener("error", onError);
        assignedWorker.removeEventListener("messageerror", onMessageError);
        signal?.removeEventListener("abort", onAbort);
      };

      const finish = (
        outcome: { result: CleanResult } | { error: unknown },
        replaceWorker: boolean,
      ): void => {
        if (active.finished) return;
        active.finished = true;
        cleanup();

        if (replaceWorker) {
          assignedWorker.terminate();
          if (!terminal) {
            try {
              slot.worker = createWorker();
            } catch {
              slot.worker = null;
            }
          }
        }
        slot.active = null;

        if ("result" in outcome) resolve(outcome.result);
        else reject(outcome.error);
      };

      const onMessage: EventListener = (event) => {
        if (slot.worker !== assignedWorker || slot.active !== active) return;
        const message = (event as MessageEvent<unknown>).data;
        if (!isWorkerResponse(message)) return;
        if (
          message.id !== request.id ||
          message.generation !== request.generation ||
          message.kind !== request.kind
        ) {
          return;
        }
        if (message.ok) finish({ result: message.result }, false);
        else finish({ error: new Error(message.error) }, false);
      };

      const onError: EventListener = (event) => {
        if (slot.worker !== assignedWorker || slot.active !== active) return;
        finish({ error: eventError(event) }, true);
      };

      const onMessageError: EventListener = () => {
        if (slot.worker !== assignedWorker || slot.active !== active) return;
        finish({ error: new Error("No se pudo decodificar la respuesta del worker.") }, true);
      };

      const onAbort = (): void => {
        if (slot.worker !== assignedWorker || slot.active !== active) return;
        finish({ error: abortError(signal?.reason) }, true);
      };

      const active: ActiveRequest = {
        finished: false,
        destroy: () => finish({ error: abortError("El pool fue destruido.") }, false),
      };
      slot.active = active;
      assignedWorker.addEventListener("message", onMessage);
      assignedWorker.addEventListener("error", onError);
      assignedWorker.addEventListener("messageerror", onMessageError);
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        assignedWorker.postMessage(request, [request.bytes]);
      } catch (error) {
        finish({ error }, true);
      }
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
      for (const slot of slots) {
        slot.active?.destroy();
        slot.worker?.terminate();
        slot.worker = null;
        slot.active = null;
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
