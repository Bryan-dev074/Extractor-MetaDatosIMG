import { cleanBytes } from "../lib/cleaner";
import type {
  CleanWorkerRequest,
  ImageWorkerRequest,
  TikTokWorkerRequest,
  WorkerResponse,
} from "../lib/batch/worker-pool";
import {
  exportForTikTok,
  TikTokMainThreadFallbackRequiredError,
  type TikTokExportResult,
} from "../lib/tiktok/export";

export interface CleanWorkerReply {
  message: Extract<WorkerResponse, { kind: "clean" }>;
  transfer: Transferable[];
}

export interface TikTokWorkerReply {
  message: Extract<WorkerResponse, { kind: "tiktok" }>;
  transfer: Transferable[];
}

interface ImageWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ImageWorkerRequest>) => void,
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

export function handleCleanWorkerRequest(request: CleanWorkerRequest): CleanWorkerReply {
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

function exactBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  return Uint8Array.from(bytes);
}

function needsMainThreadFallback(error: unknown): boolean {
  return (
    error instanceof TikTokMainThreadFallbackRequiredError ||
    (typeof error === "object" &&
      error !== null &&
      "fallbackRequired" in error &&
      error.fallbackRequired === true)
  );
}

export async function handleTikTokWorkerRequest(
  request: TikTokWorkerRequest,
  exporter: (input: Blob) => Promise<TikTokExportResult> = (input) =>
    exportForTikTok(input),
): Promise<TikTokWorkerReply> {
  try {
    const result = await exporter(new Blob([request.bytes], { type: request.mimeType }));
    const png = exactBytes(result.png);
    const preview = exactBytes(result.preview);
    return {
      message: {
        id: request.id,
        generation: request.generation,
        kind: "tiktok",
        ok: true,
        result: { ...result, png, preview },
      },
      transfer: [png.buffer, preview.buffer],
    };
  } catch (error) {
    return {
      message: {
        id: request.id,
        generation: request.generation,
        kind: "tiktok",
        ok: false,
        error: messageFor(error),
        fallbackRequired: needsMainThreadFallback(error) || undefined,
      },
      transfer: [],
    };
  }
}

if (typeof document === "undefined") {
  const workerScope = globalThis as unknown as ImageWorkerScope;
  workerScope.addEventListener("message", async (event) => {
    const reply =
      event.data.kind === "clean"
        ? handleCleanWorkerRequest(event.data)
        : await handleTikTokWorkerRequest(event.data);
    workerScope.postMessage(reply.message, reply.transfer);
  });
}
