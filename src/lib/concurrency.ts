import { isAbortError } from "./errors";

export { isAbortError };

/** Tuning knobs for {@link retry}. Only `maxRetries` is required. */
export interface RetryOptions {
  /** Retries after the first attempt; total attempts = maxRetries + 1. */
  maxRetries: number;
  /** First back-off delay in ms (default {@link DEFAULT_BASE_DELAY_MS}). */
  baseDelayMs?: number;
  /** Upper bound for any delay, back-off or vendor hint (default {@link DEFAULT_MAX_DELAY_MS}). */
  maxDelayMs?: number;
  /** Multiplier applied per failed attempt (default {@link DEFAULT_BACKOFF_FACTOR}). */
  factor?: number;
  /** Randomise each delay by ±{@link JITTER_RATIO} (default `true`). */
  jitter?: boolean;
  /** Aborting stops retrying at once, whether waiting or between attempts. */
  signal?: AbortSignal;
  /** Default: retry everything except AbortError and `{ retryable: false }` errors. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Vendor-suggested delay (e.g. ProviderError.retryAfterMs) overrides back-off when larger. */
  retryAfterMs?: (error: unknown) => number | undefined;
  /** Observer called before each wait with the failed attempt number and the delay chosen. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Default first back-off delay (ms). */
export const DEFAULT_BASE_DELAY_MS = 1500;
/** Default cap on any single wait (ms). */
export const DEFAULT_MAX_DELAY_MS = 30_000;
/** Default exponential back-off multiplier. */
export const DEFAULT_BACKOFF_FACTOR = 2;
/** Jitter applied by {@link computeBackoffDelay}: the delay is scaled by a random factor in [1 − J, 1 + J]. */
export const JITTER_RATIO = 0.25;

// ─────────────────────────────────────────────────────────────────────────────
// Abort helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build an error recognised by {@link isAbortError} (name `AbortError`). */
export function createAbortError(message = "The operation was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** The error to throw for an aborted signal: its own `reason` when that is an AbortError, else a fresh one. */
function abortErrorFor(signal: AbortSignal): unknown {
  return isAbortError(signal.reason) ? signal.reason : createAbortError();
}

/** Throw an AbortError if `signal` has already been aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortErrorFor(signal);
}

/** Abortable sleep; rejects with an AbortError when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortErrorFor(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal ? abortErrorFor(signal) : createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// retry()
// ─────────────────────────────────────────────────────────────────────────────

/** Exponential back-off with optional jitter. `attempt` is 1-based (the attempt that just failed). */
export function computeBackoffDelay(
  attempt: number,
  options: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "factor" | "jitter">,
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const factor = options.factor ?? DEFAULT_BACKOFF_FACTOR;
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const raw = Math.min(max, base * factor ** exponent);
  if (options.jitter === false) return Math.round(raw);
  const scale = 1 - JITTER_RATIO + Math.random() * JITTER_RATIO * 2;
  return Math.round(Math.min(max, raw * scale));
}

/** Retry everything except AbortError and errors that explicitly declare `retryable: false`. */
export function defaultShouldRetry(error: unknown): boolean {
  if (isAbortError(error)) return false;
  return (error as { retryable?: boolean } | null)?.retryable !== false;
}

/** Read a `retryAfterMs` hint from an error (duck-typed so any vendor error can carry it). */
export function defaultRetryAfterMs(error: unknown): number | undefined {
  const hint = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof hint === "number" && Number.isFinite(hint) && hint > 0 ? hint : undefined;
}

/**
 * Run `fn(attempt)` (attempt starts at 1) with retries. Rethrows the last error.
 *
 * - The delay before attempt n+1 is `min(maxDelayMs, max(backoff(n), retryAfterMs(error)))`.
 * - `onRetry(error, attempt, delayMs)` fires before each sleep.
 * - When `signal` aborts before an attempt or during a sleep the AbortError is
 *   thrown immediately and nothing is retried.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    signal,
    onRetry,
    shouldRetry = defaultShouldRetry,
    retryAfterMs = defaultRetryAfterMs,
    sleep: doSleep = sleep,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
  } = options;
  const retries = Number.isFinite(options.maxRetries) ? Math.max(0, Math.floor(options.maxRetries)) : 0;

  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await fn(attempt);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (signal?.aborted) throw abortErrorFor(signal);
      if (attempt > retries || !shouldRetry(error, attempt)) throw error;

      const backoff = computeBackoffDelay(attempt, options);
      const hinted = retryAfterMs(error) ?? 0;
      const delayMs = Math.min(maxDelayMs, Math.max(backoff, hinted));
      onRetry?.(error, attempt, delayMs);
      await doSleep(delayMs, signal);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runPool()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run `worker` over `items` with at most `concurrency` in flight. Preserves order.
 * When `signal` aborts, no new items are started; in-flight workers receive the same signal via their own handling.
 *
 * Items that had not started when the signal fired settle as `rejected` with an
 * AbortError. The returned promise itself never rejects.
 */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  options?: { signal?: AbortSignal },
): Promise<PromiseSettledResult<R>[]> {
  const signal = options?.signal;
  const results = new Array<PromiseSettledResult<R>>(items.length);
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  let next = 0;

  const runWorker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      if (signal?.aborted) {
        results[index] = { status: "rejected", reason: abortErrorFor(signal) };
        continue;
      }
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}
