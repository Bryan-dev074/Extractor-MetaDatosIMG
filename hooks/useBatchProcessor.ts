"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  batchReducer,
  initialBatchState,
  summarizeBatch,
  type BatchItem,
  type BatchState,
  type BatchSummary,
} from "../lib/batch/reducer";
import { createTaskQueue, type TaskQueue } from "../lib/batch/queue";
import {
  cleanOnMainThread,
  createImageWorkerPool,
  type ImageWorkerFactory,
  type ImageWorkerPool,
} from "../lib/batch/worker-pool";
import type { InputImage } from "../lib/batch/types";
import type { CleanResult } from "../lib/types";

type ProcessingMode = "worker" | "main-thread";

interface BatchTask {
  input: InputImage;
  generation: number;
}

interface BatchResources {
  queue: TaskQueue<BatchTask, CleanResult>;
  pool: ImageWorkerPool | null;
  mode: ProcessingMode;
}

export interface UseBatchProcessorOptions {
  workerPoolSize?: number;
  createWorker?: ImageWorkerFactory;
  forceMainThread?: boolean;
}

export interface BatchProcessorApi {
  state: BatchState;
  items: BatchItem[];
  summary: BatchSummary;
  ready: boolean;
  mode: ProcessingMode | null;
  start(items: InputImage[]): void;
  add(items: InputImage[]): void;
  remove(id: string): void;
  cancel(): void;
  reset(): void;
  retry(id: string): void;
}

function abortError(reason?: unknown): DOMException {
  if (reason instanceof DOMException && reason.name === "AbortError") return reason;
  return new DOMException(
    typeof reason === "string" && reason ? reason : "El trabajo fue cancelado.",
    "AbortError",
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.message) return error.message;
  return error instanceof Error && error.message ? error.message : "Error al procesar la imagen.";
}

function uniqueInputs(items: InputImage[], existing: ReadonlySet<string> = new Set()): InputImage[] {
  const seen = new Set(existing);
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function useBatchProcessor(
  options: UseBatchProcessorOptions = {},
): BatchProcessorApi {
  const [state, dispatch] = useReducer(batchReducer, initialBatchState);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<ProcessingMode | null>(null);
  const stateRef = useRef(state);
  const generationRef = useRef(state.generation);
  const mountedRef = useRef(false);
  const resourcesRef = useRef<BatchResources | null>(null);
  stateRef.current = state;

  const createWorker = options.createWorker;
  const forceMainThread = options.forceMainThread ?? false;
  const workerPoolSize = options.workerPoolSize ?? 2;

  useEffect(() => {
    mountedRef.current = true;
    let pool: ImageWorkerPool | null = null;
    let selectedMode: ProcessingMode = "main-thread";

    if (!forceMainThread && (createWorker || typeof Worker === "function")) {
      try {
        pool = createImageWorkerPool({ size: workerPoolSize, createWorker });
        selectedMode = "worker";
      } catch {
        pool = null;
      }
    }

    const selectedPool = pool;
    const queue = createTaskQueue<BatchTask, CleanResult>({
      concurrency: selectedPool ? workerPoolSize : 1,
      run: async ({ input, generation }, signal) => {
        if (mountedRef.current && generationRef.current === generation) {
          dispatch({ type: "item/started", generation, id: input.id });
        }
        throwIfAborted(signal);

        // Reading lives inside the active runner so queued items retain only their File.
        // A retry invokes this runner again and therefore obtains a fresh transferable buffer.
        const bytes = await input.file.arrayBuffer();
        throwIfAborted(signal);
        const request = { id: input.id, generation, kind: "clean" as const, bytes };
        return selectedPool
          ? selectedPool.clean(request, signal)
          : cleanOnMainThread(request, signal);
      },
    });

    resourcesRef.current = { queue, pool: selectedPool, mode: selectedMode };
    setMode(selectedMode);
    setReady(true);

    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      // Destroy first so active workers terminate without creating replacements.
      selectedPool?.destroy();
      queue.dispose("El procesador fue desmontado.");
      if (resourcesRef.current?.queue === queue) resourcesRef.current = null;
    };
  }, [createWorker, forceMainThread, workerPoolSize]);

  const schedule = useCallback((input: InputImage, generation: number): void => {
    const resources = resourcesRef.current;
    if (!resources) return;
    const task = resources.queue.add({ input, generation }, { key: input.id });
    void task
      .then((result) => {
        if (!mountedRef.current || generationRef.current !== generation) return;
        dispatch({ type: "item/completed", generation, id: input.id, result });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || generationRef.current !== generation) return;
        if (task.signal.aborted && isAbortError(error)) {
          dispatch({ type: "item/cancelled", generation, id: input.id });
        } else {
          dispatch({
            type: "item/failed",
            generation,
            id: input.id,
            error: errorMessage(error),
          });
        }
      });
  }, []);

  const start = useCallback(
    (items: InputImage[]): void => {
      const resources = resourcesRef.current;
      if (!resources) return;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      resources.queue.cancelAll("Se inició un lote nuevo.");
      const inputs = uniqueInputs(items);
      dispatch({ type: "batch/started", generation, items: inputs });
      for (const input of inputs) schedule(input, generation);
    },
    [schedule],
  );

  const add = useCallback(
    (items: InputImage[]): void => {
      const resources = resourcesRef.current;
      if (!resources) return;
      const generation = generationRef.current;
      const existing = new Set(stateRef.current.order);
      const inputs = uniqueInputs(items, existing);
      if (inputs.length === 0) return;
      dispatch({ type: "batch/added", generation, items: inputs });
      for (const input of inputs) schedule(input, generation);
    },
    [schedule],
  );

  const remove = useCallback((id: string): void => {
    const generation = generationRef.current;
    resourcesRef.current?.queue.cancel(id, "La imagen fue eliminada.");
    dispatch({ type: "item/removed", generation, id });
  }, []);

  const cancel = useCallback((): void => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    dispatch({ type: "batch/cancelled", generation });
    resourcesRef.current?.queue.cancelAll("El lote fue cancelado.");
  }, []);

  const reset = useCallback((): void => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    dispatch({ type: "batch/reset", generation });
    resourcesRef.current?.queue.cancelAll("El lote fue reiniciado.");
  }, []);

  const retry = useCallback(
    (id: string): void => {
      const item = stateRef.current.itemsById[id];
      if (!item || (item.status !== "error" && item.status !== "cancelled")) return;
      const generation = generationRef.current;
      dispatch({ type: "item/retried", generation, id });
      schedule(item, generation);
    },
    [schedule],
  );

  const items = useMemo(
    () => state.order.flatMap((id) => (state.itemsById[id] ? [state.itemsById[id]] : [])),
    [state],
  );
  const summary = useMemo(() => summarizeBatch(state), [state]);

  return {
    state,
    items,
    summary,
    ready,
    mode,
    start,
    add,
    remove,
    cancel,
    reset,
    retry,
  };
}
