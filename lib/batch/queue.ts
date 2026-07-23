export type TaskKey = string | number | symbol;

export interface TaskQueueOptions<T, R> {
  concurrency: number;
  run: (value: T, signal: AbortSignal) => Promise<R> | R;
}

export interface TaskOptions {
  key?: TaskKey;
}

export interface TaskPromise<R> extends Promise<R> {
  readonly signal: AbortSignal;
}

export interface TaskQueue<T, R> {
  readonly pending: number;
  readonly running: number;
  readonly disposed: boolean;
  add(value: T, options?: TaskOptions | TaskKey): TaskPromise<R>;
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
  outwardSettled: boolean;
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

function withSignal<R>(promise: Promise<R>, signal: AbortSignal): TaskPromise<R> {
  Object.defineProperty(promise, "signal", { value: signal });
  return promise as TaskPromise<R>;
}

function rejectedTask<R>(error: unknown): TaskPromise<R> {
  const controller = new AbortController();
  return withSignal(Promise.reject(error), controller.signal);
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

  const resolveOutward = (entry: QueueEntry<T, R>, value: R): void => {
    if (entry.outwardSettled) return;
    entry.outwardSettled = true;
    releaseKey(entry);
    entry.resolve(value);
  };

  const rejectOutward = (entry: QueueEntry<T, R>, error: unknown): void => {
    if (entry.outwardSettled) return;
    entry.outwardSettled = true;
    releaseKey(entry);
    entry.reject(error);
  };

  const cancelEntry = (entry: QueueEntry<T, R>, reason?: unknown): void => {
    if (entry.status === "settled") return;
    entry.controller.abort(reason);
    rejectOutward(entry, cancellationError(reason));
    if (entry.status === "queued") entry.status = "settled";
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
            rejectOutward(entry, cancellationError(entry.controller.signal.reason));
          } else {
            resolveOutward(entry, value);
          }
        },
        (error) => {
          if (entry.controller.signal.aborted) {
            rejectOutward(entry, cancellationError(entry.controller.signal.reason));
          } else {
            rejectOutward(entry, error);
          }
        },
      ).finally(() => {
        entry.status = "settled";
        active.delete(entry);
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
      if (terminal) return rejectedTask(new Error("La cola fue eliminada."));
      const { explicit, key } = optionKey(options);
      if (explicit && keyed.has(key)) {
        return rejectedTask(new Error("La cola ya contiene una tarea con esa clave duplicada."));
      }

      const controller = new AbortController();
      let resolve!: (result: R | PromiseLike<R>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = withSignal(new Promise<R>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      }), controller.signal);
      const entry: QueueEntry<T, R> = {
        value,
        key,
        explicitKey: explicit,
        controller,
        status: "queued",
        outwardSettled: false,
        resolve,
        reject,
      };
      queued.push(entry);
      if (explicit) keyed.set(key, entry);
      drain();
      return promise;
    },
    cancel(key, reason) {
      const entry = keyed.get(key);
      if (!entry || entry.status === "settled") return false;
      cancelEntry(entry, reason);
      return true;
    },
    cancelAll(reason) {
      for (const entry of [...queued]) cancelEntry(entry, reason);
      queued.length = 0;
      for (const entry of active) cancelEntry(entry, reason);
    },
    dispose(reason) {
      if (terminal) return;
      terminal = true;
      for (const entry of [...queued]) cancelEntry(entry, reason);
      queued.length = 0;
      for (const entry of active) cancelEntry(entry, reason);
    },
  };
}
