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

  it("keeps an actively cancelled task in its slot until the runner settles", async () => {
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
    const next = queue.add("next", { key: "next" });

    expect(queue.cancel("active")).toBe(true);
    expect(signals.get("active")?.aborted).toBe(true);
    expect(queue.running).toBe(1);
    expect(queue.pending).toBe(1);
    expect(starts).toEqual(["active"]);

    activeGate.resolve();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    await expect(next).resolves.toBe("next");
    expect(starts).toEqual(["active", "next"]);
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
