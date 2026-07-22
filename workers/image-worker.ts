import { cleanBytes } from "../lib/cleaner";
import type { WorkerRequest, WorkerResponse } from "../lib/batch/worker-pool";

export interface CleanWorkerReply {
  message: WorkerResponse;
  transfer: Transferable[];
}

interface ImageWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void;
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return Uint8Array.from(bytes).buffer;
}

function messageFor(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Error al limpiar la imagen.";
}

export function handleCleanWorkerRequest(request: WorkerRequest): CleanWorkerReply {
  try {
    const result = cleanBytes(new Uint8Array(request.bytes));
    const output = exactArrayBuffer(result.cleaned);
    const cleaned = new Uint8Array(output);
    return {
      message: {
        id: request.id,
        generation: request.generation,
        kind: "clean",
        ok: true,
        result: { ...result, cleaned, cleanedSize: cleaned.byteLength },
      },
      transfer: [output],
    };
  } catch (error) {
    return {
      message: {
        id: request.id,
        generation: request.generation,
        kind: "clean",
        ok: false,
        error: messageFor(error),
      },
      transfer: [],
    };
  }
}

if (typeof document === "undefined") {
  const workerScope = globalThis as unknown as ImageWorkerScope;
  workerScope.addEventListener("message", (event) => {
    const reply = handleCleanWorkerRequest(event.data);
    workerScope.postMessage(reply.message, reply.transfer);
  });
}
