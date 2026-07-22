export type TaskKey = string | number | symbol;

export interface TaskQueueOptions<T, R> {
  concurrency: number;
  run: (value: T, signal: AbortSignal) => Promise<R> | R;
}

export interface TaskOptions {
  key?: TaskKey;
}

export interface TaskQueue<T, R> {
  readonly pending: number;
  readonly running: number;
  readonly disposed: boolean;
  add(value: T, options?: TaskOptions | TaskKey): Promise<R>;
  cancel(key: TaskKey, reason?: unknown): boolean;
  cancelAll(reason?: unknown): void;
  dispose(reason?: unknown): void;
}

type EntryStatus = "queued" | "running" | "settled";

interface QueueEntry<T, R> {
  value: T;
  key: TaskKey;
  explicitKey: boolean;
  controller: AbortController;
  status: EntryStatus;
  resolve: (value: R | PromiseLike<R>) => void;
  reject: (reason?: unknown) => void;
}

function cancellationError(reason?: unknown): DOMException {
  if (reason instanceof DOMException && reason.name === "AbortError") return reason;
  return new DOMException(
    typeof reason === "string" && reason ? reason : "La tarea fue cancelada.",
    "AbortError",
  );
}

function optionKey(options?: TaskOptions | TaskKey): {
  explicit: boolean;
  key: TaskKey;
} {
  if (typeof options === "object" && options !== null) {
    if (options.key !== undefined) return { explicit: true, key: options.key };
    return { explicit: false, key: Symbol("anonymous-task") };
  }
  if (options !== undefined) return { explicit: true, key: options };
  return { explicit: false, key: Symbol("anonymous-task") };
}

export function createTaskQueue<T, R>({
  concurrency,
  run,
}: TaskQueueOptions<T, R>): TaskQueue<T, R> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("La concurrencia debe ser un entero positivo.");
  }

  const queued: Array<QueueEntry<T, R>> = [];
  const keyed = new Map<TaskKey, QueueEntry<T, R>>();
  const active = new Set<QueueEntry<T, R>>();
  let terminal = false;

  const releaseKey = (entry: QueueEntry<T, R>): void => {
    if (entry.explicitKey && keyed.get(entry.key) === entry) keyed.delete(entry.key);
  };

  const settleQueuedCancellation = (entry: QueueEntry<T, R>, reason?: unknown): void => {
    if (entry.status !== "queued") return;
    entry.status = "settled";
    entry.controller.abort(reason);
    releaseKey(entry);
    entry.reject(cancellationError(reason));
  };

  const drain = (): void => {
    while (!terminal && active.size < concurrency && queued.length > 0) {
      const entry = queued.shift();
      if (!entry || entry.status !== "queued") continue;
      entry.status = "running";
      active.add(entry);

      let outcome: Promise<R>;
      try {
        outcome = Promise.resolve(run(entry.value, entry.controller.signal));
      } catch (error) {
        outcome = Promise.reject(error);
      }

      void outcome.then(
        (value) => {
          if (entry.controller.signal.aborted) {
            entry.reject(cancellationError(entry.controller.signal.reason));
          } else {
            entry.resolve(value);
          }
        },
        (error) => {
          if (entry.controller.signal.aborted) {
            entry.reject(cancellationError(entry.controller.signal.reason));
          } else {
            entry.reject(error);
          }
        },
      ).finally(() => {
        entry.status = "settled";
        active.delete(entry);
        releaseKey(entry);
        drain();
      });
    }
  };

  return {
    get pending() {
      return queued.reduce((count, entry) => count + (entry.status === "queued" ? 1 : 0), 0);
    },
    get running() {
      return active.size;
    },
    get disposed() {
      return terminal;
    },
    add(value, options) {
      if (terminal) return Promise.reject(new Error("La cola fue eliminada."));
      const { explicit, key } = optionKey(options);
      if (explicit && keyed.has(key)) {
        return Promise.reject(new Error("La cola ya contiene una tarea con esa clave duplicada."));
      }

      const promise = new Promise<R>((resolve, reject) => {
        const entry: QueueEntry<T, R> = {
          value,
          key,
          explicitKey: explicit,
          controller: new AbortController(),
          status: "queued",
          resolve,
          reject,
        };
        queued.push(entry);
        if (explicit) keyed.set(key, entry);
      });
      drain();
      return promise;
    },
    cancel(key, reason) {
      const entry = keyed.get(key);
      if (!entry || entry.status === "settled") return false;
      if (entry.status === "queued") settleQueuedCancellation(entry, reason);
      else entry.controller.abort(reason);
      return true;
    },
    cancelAll(reason) {
      for (const entry of [...queued]) settleQueuedCancellation(entry, reason);
      queued.length = 0;
      for (const entry of active) entry.controller.abort(reason);
    },
    dispose(reason) {
      if (terminal) return;
      terminal = true;
      for (const entry of [...queued]) settleQueuedCancellation(entry, reason);
      queued.length = 0;
      for (const entry of active) entry.controller.abort(reason);
    },
  };
}
