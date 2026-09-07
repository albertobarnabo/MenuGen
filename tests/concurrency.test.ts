import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/lib/errors";
import {
  DEFAULT_BACKOFF_FACTOR,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  JITTER_RATIO,
  computeBackoffDelay,
  createAbortError,
  defaultRetryAfterMs,
  defaultShouldRetry,
  isAbortError,
  retry,
  runPool,
  sleep,
  throwIfAborted,
} from "../src/lib/concurrency";

/** Records requested delays and returns immediately (still honouring an aborted signal). */
function fakeSleep(): { calls: number[]; fn: (ms: number, signal?: AbortSignal) => Promise<void> } {
  const calls: number[] = [];
  return {
    calls,
    fn: async (ms, signal) => {
      calls.push(ms);
      throwIfAborted(signal);
    },
  };
}

function transient(message = "temporary", retryAfterMs?: number): ProviderError {
  return new ProviderError(message, { provider: "mock", status: 503, retryable: true, retryAfterMs });
}

function fatal(): ProviderError {
  return new ProviderError("permanent", { provider: "mock", status: 400, retryable: false });
}

/** Yield to the macrotask queue so pending pool workers can advance. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Worker factory that parks every call until the test releases it. */
function gatedWorker<T>() {
  const gates: Array<{ item: T; index: number; release: () => void; fail: (reason: unknown) => void }> = [];
  let inFlight = 0;
  const stats = { maxInFlight: 0, calls: 0 };
  const worker = (item: T, index: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      stats.calls += 1;
      inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      gates.push({
        item,
        index,
        release: () => {
          inFlight -= 1;
          resolve(item);
        },
        fail: (reason) => {
          inFlight -= 1;
          reject(reason);
        },
      });
    });
  return { gates, stats, worker };
}

describe("retry", () => {
  it("returns the first successful result without sleeping", async () => {
    const { calls, fn } = fakeSleep();
    const attempts: number[] = [];

    const result = await retry(
      async (attempt) => {
        attempts.push(attempt);
        return "ok";
      },
      { maxRetries: 3, sleep: fn },
    );

    expect(result).toBe("ok");
    expect(attempts).toEqual([1]);
    expect(calls).toEqual([]);
  });

  it("retries transient failures with exponential back-off", async () => {
    const { calls, fn } = fakeSleep();
    const attempts: number[] = [];

    const result = await retry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 3) throw transient(`fail ${attempt}`);
        return `done on ${attempt}`;
      },
      { maxRetries: 3, baseDelayMs: 100, factor: 2, jitter: false, sleep: fn },
    );

    expect(result).toBe("done on 3");
    expect(attempts).toEqual([1, 2, 3]);
    expect(calls).toEqual([100, 200]);
  });

  it("gives up after maxRetries + 1 attempts and rethrows the last error", async () => {
    const { calls, fn } = fakeSleep();
    const errors: Error[] = [];

    const rejection = await retry(
      async (attempt) => {
        const error = transient(`fail ${attempt}`);
        errors.push(error);
        throw error;
      },
      { maxRetries: 2, baseDelayMs: 10, jitter: false, sleep: fn },
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(errors).toHaveLength(3);
    expect(rejection).toBe(errors[2]);
    expect(calls).toEqual([10, 20]);
  });

  it("makes a single attempt when maxRetries is 0 or unusable", async () => {
    for (const maxRetries of [0, -2, Number.NaN]) {
      const { calls, fn } = fakeSleep();
      let attempts = 0;

      await expect(
        retry(
          async () => {
            attempts += 1;
            throw transient();
          },
          { maxRetries, sleep: fn },
        ),
      ).rejects.toThrow("temporary");

      expect(attempts).toBe(1);
      expect(calls).toEqual([]);
    }
  });

  it("honours retryAfterMs when it exceeds the back-off, otherwise keeps the back-off", async () => {
    const { calls, fn } = fakeSleep();
    let attempts = 0;

    await retry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw transient("slow down", 5000);
        if (attempts === 2) throw transient("minor", 50);
        return "ok";
      },
      { maxRetries: 3, baseDelayMs: 100, factor: 2, jitter: false, sleep: fn },
    );

    expect(calls).toEqual([5000, 200]);
  });

  it("caps every delay at maxDelayMs", async () => {
    const { calls, fn } = fakeSleep();
    let attempts = 0;

    await retry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw transient("hinted", 60_000);
        if (attempts === 2) throw transient("backoff");
        return "ok";
      },
      { maxRetries: 3, baseDelayMs: 4000, factor: 10, maxDelayMs: 10_000, jitter: false, sleep: fn },
    );

    expect(calls).toEqual([10_000, 10_000]);
  });

  it("stops immediately on non-retryable errors", async () => {
    const { calls, fn } = fakeSleep();
    let attempts = 0;

    await expect(
      retry(
        async () => {
          attempts += 1;
          throw fatal();
        },
        { maxRetries: 5, sleep: fn },
      ),
    ).rejects.toThrow("permanent");

    expect(attempts).toBe(1);
    expect(calls).toEqual([]);
  });

  it("retries plain errors by default and defers to a custom shouldRetry", async () => {
    const { calls, fn } = fakeSleep();
    let attempts = 0;
    await retry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("plain");
        return "ok";
      },
      { maxRetries: 1, baseDelayMs: 1, jitter: false, sleep: fn },
    );
    expect(attempts).toBe(2);
    expect(calls).toEqual([1]);

    const seen: Array<[string, number]> = [];
    attempts = 0;
    await expect(
      retry(
        async () => {
          attempts += 1;
          throw new Error(`nope ${attempts}`);
        },
        {
          maxRetries: 5,
          baseDelayMs: 1,
          jitter: false,
          sleep: fn,
          shouldRetry: (error, attempt) => {
            seen.push([error instanceof Error ? error.message : "?", attempt]);
            return attempt < 2;
          },
        },
      ),
    ).rejects.toThrow("nope 2");
    expect(seen).toEqual([
      ["nope 1", 1],
      ["nope 2", 2],
    ]);
    expect(attempts).toBe(2);
  });

  it("rethrows an AbortError from the callback without retrying", async () => {
    const { calls, fn } = fakeSleep();
    let attempts = 0;

    await expect(
      retry(
        async () => {
          attempts += 1;
          throw createAbortError("cancelled by test");
        },
        { maxRetries: 3, sleep: fn },
      ),
    ).rejects.toSatisfy(isAbortError);

    expect(attempts).toBe(1);
    expect(calls).toEqual([]);
  });

  it("rejects before the first attempt when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;

    await expect(
      retry(
        async () => {
          attempts += 1;
          return "never";
        },
        { maxRetries: 3, signal: controller.signal },
      ),
    ).rejects.toSatisfy(isAbortError);

    expect(attempts).toBe(0);
  });

  it("aborts a pending back-off wait and does not attempt again", async () => {
    const controller = new AbortController();
    let attempts = 0;

    const pending = retry(
      async () => {
        attempts += 1;
        throw transient();
      },
      { maxRetries: 3, baseDelayMs: 60_000, jitter: false, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toSatisfy(isAbortError);
    expect(attempts).toBe(1);
  });

  it("reports the abort when the callback fails for another reason after the signal fired", async () => {
    const controller = new AbortController();
    const { calls, fn } = fakeSleep();

    await expect(
      retry(
        async () => {
          controller.abort();
          throw new Error("network reset");
        },
        { maxRetries: 3, signal: controller.signal, sleep: fn },
      ),
    ).rejects.toSatisfy(isAbortError);

    expect(calls).toEqual([]);
  });

  it("calls onRetry before each wait, never after the final failure", async () => {
    const { fn } = fakeSleep();
    const onRetry = vi.fn();
    const errors: Error[] = [];

    const rejection = await retry(
      async (attempt) => {
        const error = transient(`fail ${attempt}`, attempt === 1 ? 500 : undefined);
        errors.push(error);
        throw error;
      },
      { maxRetries: 2, baseDelayMs: 100, factor: 2, jitter: false, sleep: fn, onRetry },
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(rejection).toBe(errors[2]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, errors[0], 1, 500);
    expect(onRetry).toHaveBeenNthCalledWith(2, errors[1], 2, 200);
  });
});

describe("computeBackoffDelay", () => {
  it("grows exponentially from the base delay and caps at maxDelayMs", () => {
    const options = { baseDelayMs: 100, factor: 3, maxDelayMs: 1000, jitter: false };
    expect(computeBackoffDelay(1, options)).toBe(100);
    expect(computeBackoffDelay(2, options)).toBe(300);
    expect(computeBackoffDelay(3, options)).toBe(900);
    expect(computeBackoffDelay(4, options)).toBe(1000);
    expect(computeBackoffDelay(0, options)).toBe(100);
  });

  it("uses the documented defaults", () => {
    expect(computeBackoffDelay(1, { jitter: false })).toBe(DEFAULT_BASE_DELAY_MS);
    expect(computeBackoffDelay(2, { jitter: false })).toBe(DEFAULT_BASE_DELAY_MS * DEFAULT_BACKOFF_FACTOR);
    expect(computeBackoffDelay(50, { jitter: false })).toBe(DEFAULT_MAX_DELAY_MS);
  });

  it("applies ±25 % jitter by default and never exceeds maxDelayMs", () => {
    expect(JITTER_RATIO).toBe(0.25);
    const raw = 1000;
    const samples = Array.from({ length: 300 }, () => computeBackoffDelay(1, { baseDelayMs: raw, maxDelayMs: 1100 }));
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(raw * (1 - JITTER_RATIO));
      expect(sample).toBeLessThanOrEqual(1100);
    }
    expect(new Set(samples).size).toBeGreaterThan(1);
  });
});

describe("default retry predicates", () => {
  it("defaultShouldRetry excludes AbortError and retryable:false", () => {
    expect(defaultShouldRetry(createAbortError())).toBe(false);
    expect(defaultShouldRetry(fatal())).toBe(false);
    expect(defaultShouldRetry(transient())).toBe(true);
    expect(defaultShouldRetry(new Error("plain"))).toBe(true);
    expect(defaultShouldRetry("string error")).toBe(true);
    expect(defaultShouldRetry(null)).toBe(true);
  });

  it("defaultRetryAfterMs reads positive finite hints only", () => {
    expect(defaultRetryAfterMs(transient("x", 1500))).toBe(1500);
    expect(defaultRetryAfterMs(transient("x"))).toBeUndefined();
    expect(defaultRetryAfterMs({ retryAfterMs: 0 })).toBeUndefined();
    expect(defaultRetryAfterMs({ retryAfterMs: "10" })).toBeUndefined();
    expect(defaultRetryAfterMs(null)).toBeUndefined();
  });
});

describe("abort helpers and sleep", () => {
  it("createAbortError is recognised by isAbortError", () => {
    const error = createAbortError();
    expect(error.name).toBe("AbortError");
    expect(isAbortError(error)).toBe(true);
    expect(isAbortError(new Error("x"))).toBe(false);
  });

  it("throwIfAborted is a no-op without a signal or when not aborted", () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (error) {
      thrown = error;
    }
    expect(isAbortError(thrown)).toBe(true);
  });

  it("sleep resolves after the delay and rejects when aborted", async () => {
    await expect(sleep(1)).resolves.toBeUndefined();

    const pre = new AbortController();
    pre.abort();
    await expect(sleep(10_000, pre.signal)).rejects.toSatisfy(isAbortError);

    const mid = new AbortController();
    const pending = sleep(10_000, mid.signal);
    setTimeout(() => mid.abort(), 5);
    await expect(pending).rejects.toSatisfy(isAbortError);
  });
});

describe("runPool", () => {
  it("preserves input order and captures rejections", async () => {
    const results = await runPool([1, 2, 3, 4, 5], 2, async (item, index) => {
      expect(index).toBe(item - 1);
      if (item === 3) throw new Error(`item ${item} failed`);
      return item * 10;
    });

    expect(results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 20 },
      { status: "rejected", reason: expect.objectContaining({ message: "item 3 failed" }) },
      { status: "fulfilled", value: 40 },
      { status: "fulfilled", value: 50 },
    ]);
  });

  it("keeps at most `concurrency` workers in flight and reaches that limit", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const { gates, stats, worker } = gatedWorker<number>();

    const pool = runPool(items, 3, worker);
    await tick();
    expect(gates).toHaveLength(3);

    // Release the most recently started worker each time so completion order
    // differs from input order.
    for (let released = 0; released < items.length; released += 1) {
      const gate = gates.pop();
      if (!gate) throw new Error("expected a parked worker");
      gate.release();
      await tick();
      expect(gates.length).toBeLessThanOrEqual(3);
    }

    const results = await pool;
    expect(stats.maxInFlight).toBe(3);
    expect(stats.calls).toBe(items.length);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : "rejected"))).toEqual(items);
  });

  it("clamps concurrency to at least 1", async () => {
    for (const concurrency of [0, -5, Number.NaN, 0.5]) {
      const { gates, stats, worker } = gatedWorker<number>();
      const pool = runPool([1, 2, 3], concurrency, worker);

      for (let released = 0; released < 3; released += 1) {
        await tick();
        expect(gates).toHaveLength(1);
        const gate = gates.shift();
        if (!gate) throw new Error("expected a parked worker");
        gate.release();
      }

      const results = await pool;
      expect(stats.maxInFlight).toBe(1);
      expect(results.map((r) => (r.status === "fulfilled" ? r.value : "rejected"))).toEqual([1, 2, 3]);
    }
  });

  it("never spawns more workers than there are items", async () => {
    const { stats, worker, gates } = gatedWorker<number>();
    const pool = runPool([1, 2], 8, worker);
    await tick();
    expect(stats.calls).toBe(2);
    for (const gate of gates.splice(0)) gate.release();
    await pool;
    expect(stats.maxInFlight).toBe(2);
  });

  it("returns an empty array without calling the worker for no items", async () => {
    let calls = 0;
    const results = await runPool([], 4, async () => {
      calls += 1;
      return 1;
    });

    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it("on abort, rejects unstarted items with an AbortError and starts nothing new", async () => {
    const items = ["a", "b", "c", "d", "e", "f"];
    const controller = new AbortController();
    const { gates, stats, worker } = gatedWorker<string>();

    const pool = runPool(items, 2, worker, { signal: controller.signal });
    await tick();
    expect(stats.calls).toBe(2);

    controller.abort();
    const [first, second] = gates.splice(0);
    first.release();
    second.fail(createAbortError("fetch aborted"));

    const results = await pool;
    expect(stats.calls).toBe(2);
    expect(results[0]).toEqual({ status: "fulfilled", value: "a" });
    expect(results[1].status).toBe("rejected");
    for (const result of results.slice(1)) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(isAbortError(result.reason)).toBe(true);
    }
    expect(results).toHaveLength(items.length);
  });

  it("rejects every item when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    const results = await runPool([1, 2, 3], 2, async () => {
      calls += 1;
      return 1;
    }, { signal: controller.signal });

    expect(calls).toBe(0);
    expect(results.every((r) => r.status === "rejected" && isAbortError(r.reason))).toBe(true);
  });
});
