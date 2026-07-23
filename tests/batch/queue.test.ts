import { describe, expect, it, vi } from "vitest";
import { createTaskQueue } from "@/lib/batch/queue";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("createTaskQueue", () => {
  it("never runs more tasks than the concurrency limit", async () => {
    const gate = deferred();
    let active = 0;
    let peak = 0;
    const queue = createTaskQueue<number, number>({
      concurrency: 2,
      run: async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return value;
      },
    });

    const pending = [queue.add(1), queue.add(2), queue.add(3)];
    expect(peak).toBe(2);
    expect(queue.running).toBe(2);
    expect(queue.pending).toBe(1);
    gate.resolve();

    await expect(Promise.all(pending)).resolves.toEqual([1, 2, 3]);
    expect(queue.running).toBe(0);
    expect(queue.pending).toBe(0);
  });

  it("rejects a queued cancellation before invoking run", async () => {
    const gate = deferred();
    const run = vi.fn(async (value: string) => {
      if (value === "first") await gate.promise;
      return value;
    });
    const queue = createTaskQueue({ concurrency: 1, run });
    const first = queue.add("first", { key: "first" });
    const queued = queue.add("queued", { key: "queued" });

    expect(queue.cancel("queued")).toBe(true);
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.pending).toBe(0);
    gate.resolve();
    await expect(first).resolves.toBe("first");
  });

  it("rejects active cancellation immediately, releases its key, and retains the slot", async () => {
    const activeGate = deferred();
    const signals = new Map<string, AbortSignal>();
    const starts: string[] = [];
    const queue = createTaskQueue<string, string>({
      concurrency: 1,
      run: async (value, signal) => {
        starts.push(value);
        signals.set(value, signal);
        if (value === "active") await activeGate.promise;
        return value;
      },
    });
    const active = queue.add("active", { key: "active" });
    let activeSettled = false;
    void active.then(
      () => {
        activeSettled = true;
      },
      () => {
        activeSettled = true;
      },
    );

    expect(queue.cancel("active")).toBe(true);
    await Promise.resolve();
    expect(activeSettled).toBe(true);
    expect(signals.get("active")?.aborted).toBe(true);
    expect(active.signal.aborted).toBe(true);
    const replacement = queue.add("replacement", { key: "active" });
    expect(queue.running).toBe(1);
    expect(queue.pending).toBe(1);
    expect(starts).toEqual(["active"]);

    activeGate.resolve();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    await expect(replacement).resolves.toBe("replacement");
    expect(starts).toEqual(["active", "replacement"]);
  });

  it("keeps a replacement key owned when the cancelled runner settles late", async () => {
    const oldGate = deferred<string>();
    const replacementGate = deferred<string>();
    const starts: string[] = [];
    const queue = createTaskQueue<string, string>({
      concurrency: 1,
      run: async (value) => {
        starts.push(value);
        return value === "old" ? oldGate.promise : replacementGate.promise;
      },
    });
    const old = queue.add("old", { key: "same" });
    let oldSettlements = 0;
    void old.then(
      () => {
        oldSettlements += 1;
      },
      () => {
        oldSettlements += 1;
      },
    );

    expect(queue.cancel("same")).toBe(true);
    const replacement = queue.add("replacement", { key: "same" });
    oldGate.reject(new Error("fallo tardío retirado"));

    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(starts).toEqual(["old", "replacement"]));
    expect(oldSettlements).toBe(1);
    expect(queue.cancel("same")).toBe(true);
    await expect(replacement).rejects.toMatchObject({ name: "AbortError" });
    expect(queue.cancel("same")).toBe(false);
    expect(queue.running).toBe(1);

    replacementGate.resolve("replacement");
    await vi.waitFor(() => expect(queue.running).toBe(0));
    expect(oldSettlements).toBe(1);
  });

  it("physically releases a cancelled queued value before the active runner settles", async () => {
    const gate = deferred();
    const activeValue = { id: "active" };
    const replacementValue = { id: "replacement" };
    const queue = createTaskQueue<{ id: string }, string>({
      concurrency: 1,
      run: async (value) => {
        if (value === activeValue) await gate.promise;
        return value.id;
      },
    });
    const active = queue.add(activeValue, { key: "active" });
    const cancelledValues = new Set<{ id: string }>();
    for (let index = 0; index < 16; index += 1) {
      const cancelledValue = { id: `cancelled-${index}` };
      cancelledValues.add(cancelledValue);
      const cancelled = queue.add(cancelledValue, { key: "same" });
      expect(queue.cancel("same")).toBe(true);
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    }
    const replacement = queue.add(replacementValue, { key: "same" });
    let observedRetainedValue = false;
    const originalShift = Array.prototype.shift;
    Object.defineProperty(Array.prototype, "shift", {
      configurable: true,
      writable: true,
      value: function (this: unknown[]) {
        if (
          this.some(
            (candidate) =>
              typeof candidate === "object" &&
              candidate !== null &&
              "value" in candidate &&
              cancelledValues.has(candidate.value as { id: string }),
          )
        ) {
          observedRetainedValue = true;
        }
        return Reflect.apply(originalShift, this, []);
      },
    });

    try {
      gate.resolve();
      await expect(active).resolves.toBe("active");
      await expect(replacement).resolves.toBe("replacement");
    } finally {
      Object.defineProperty(Array.prototype, "shift", {
        configurable: true,
        writable: true,
        value: originalShift,
      });
    }

    expect(observedRetainedValue).toBe(false);
    expect(queue.pending).toBe(0);
    expect(queue.running).toBe(0);
  });

  it("settles cancelAll immediately and permits the same key while the old slot drains", async () => {
    const gate = deferred();
    const starts: string[] = [];
    const queue = createTaskQueue<string, string>({
      concurrency: 1,
      run: async (value) => {
        starts.push(value);
        if (value === "old") await gate.promise;
        return value;
      },
    });
    const old = queue.add("old", { key: "same" });

    queue.cancelAll();
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    const next = queue.add("new", { key: "same" });
    expect(queue.running).toBe(1);
    expect(queue.pending).toBe(1);
    expect(starts).toEqual(["old"]);

    gate.resolve();
    await expect(next).resolves.toBe("new");
    expect(starts).toEqual(["old", "new"]);
  });

  it("settles active work immediately on terminal dispose but retains occupancy", async () => {
    const gate = deferred();
    const queue = createTaskQueue({
      concurrency: 1,
      run: async () => {
        await gate.promise;
        return "done";
      },
    });
    const active = queue.add("active", { key: "active" });

    queue.dispose();

    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    expect(queue.running).toBe(1);
    expect(queue.disposed).toBe(true);
    await expect(queue.add("late", { key: "active" })).rejects.toThrow(/eliminada/i);
    gate.resolve();
    await vi.waitFor(() => expect(queue.running).toBe(0));
  });

  it("rejects duplicate explicit keys while allowing tasks without keys", async () => {
    const gate = deferred();
    const queue = createTaskQueue<number, number>({
      concurrency: 1,
      run: async (value) => {
        await gate.promise;
        return value;
      },
    });
    const first = queue.add(1, "same");
    const duplicate = queue.add(2, { key: "same" });
    const anonymous = queue.add(3);

    await expect(duplicate).rejects.toThrow(/clave duplicada/i);
    expect(queue.pending).toBe(1);
    gate.resolve();
    await expect(Promise.all([first, anonymous])).resolves.toEqual([1, 3]);
  });

  it("keeps cancelAll reusable and makes dispose terminal", async () => {
    const firstGate = deferred();
    const queue = createTaskQueue<string, string>({
      concurrency: 1,
      run: async (value) => {
        if (value === "active") await firstGate.promise;
        return value;
      },
    });
    const active = queue.add("active", { key: "active" });
    const queued = queue.add("queued", { key: "queued" });

    queue.cancelAll();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    const reusable = queue.add("reusable", { key: "reusable" });
    expect(queue.pending).toBe(1);
    firstGate.resolve();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    await expect(reusable).resolves.toBe("reusable");

    queue.dispose();
    expect(queue.disposed).toBe(true);
    await expect(queue.add("late")).rejects.toThrow(/eliminada/i);
    expect(queue.cancel("missing")).toBe(false);
  });

  it("validates concurrency", () => {
    expect(() => createTaskQueue({ concurrency: 0, run: async () => 1 })).toThrow(
      /concurrencia/i,
    );
    expect(() => createTaskQueue({ concurrency: 1.5, run: async () => 1 })).toThrow(
      /concurrencia/i,
    );
  });
});
