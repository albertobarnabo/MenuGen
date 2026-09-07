import type {
  GenerateImageResult,
  GenerationSettings,
  ImageProvider,
  Job,
  JobItem,
  ModelSpec,
  RegenerateItemRequest,
} from "../types";
import { retry, runPool } from "../concurrency";
import { ConflictError, NotFoundError, ProviderError, ProviderNotConfiguredError, errorMessage, isAbortError } from "../errors";
import { extensionForFormat, toFilenameStem } from "../filename";
import { normalizeImage } from "../image";
import { PROVIDER_META, priceForQuality, requireModel } from "../models";
import { buildPrompt } from "../prompt";
import { getProvider } from "../providers";
import { getJobEventBus, type JobEventBus } from "./events";
import { getJobStore, requireItem, type JobStore } from "./store";

/**
 * Job runner: drives a job's items through the provider with a bounded worker
 * pool, retries, cancellation and live events. One `AbortController` per job;
 * runtime state lives on `globalThis` so Next.js dev HMR cannot duplicate it.
 */

/** Item error messages are truncated to this length before persisting. */
export const MAX_ERROR_LENGTH = 500;

/** First back-off delay between attempts (doubles each retry, ±25 % jitter). */
export const RETRY_BASE_DELAY_MS = 1500;

interface JobRuntime {
  controller: AbortController;
  /** Resolves once the pool, every extra task and the finalisation are done. */
  promise: Promise<void>;
  /** Single-item tasks started while the pool is running (regenerate). */
  tasks: Set<Promise<void>>;
  /** Items this runtime will process or is processing; guards against double generation. */
  claimed: Set<string>;
  /** Items re-queued by regenerate that have not finished yet; a second regenerate is a conflict. */
  regenerating: Set<string>;
  /** Set once no new work may join: regenerate must wait for `promise` and start a fresh run. */
  finalizing: boolean;
}

/** Everything a worker needs; built once per run from the job settings. */
interface WorkerContext {
  jobId: string;
  store: JobStore;
  bus: JobEventBus;
  runtime: JobRuntime;
  model: ModelSpec;
  provider: ImageProvider;
  settings: GenerationSettings;
}

const GLOBAL_KEY = "__menugenJobRuntimes";

type GlobalWithRuntimes = typeof globalThis & { [GLOBAL_KEY]?: Map<string, JobRuntime> };

function getRuntimes(): Map<string, JobRuntime> {
  const holder = globalThis as GlobalWithRuntimes;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const runtimes = new Map<string, JobRuntime>();
  holder[GLOBAL_KEY] = runtimes;
  return runtimes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(text: string, max = MAX_ERROR_LENGTH): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function emitJob(bus: JobEventBus, job: Job): void {
  bus.emit(
    job.error === undefined
      ? { type: "job", jobId: job.id, status: job.status, stats: job.stats }
      : { type: "job", jobId: job.id, status: job.status, stats: job.stats, error: job.error },
  );
}

function emitEnd(bus: JobEventBus, job: Job): void {
  bus.emit({ type: "end", jobId: job.id, status: job.status });
}

function emitItem(bus: JobEventBus, job: Job, item: JobItem): void {
  bus.emit({ type: "item", jobId: job.id, item, stats: job.stats });
}

function emitLog(
  bus: JobEventBus,
  jobId: string,
  level: "info" | "warn" | "error",
  message: string,
  itemId?: string,
): void {
  bus.emit(
    itemId === undefined
      ? { type: "log", jobId, level, message, at: nowIso() }
      : { type: "log", jobId, level, message, itemId, at: nowIso() },
  );
}

async function requireJob(store: JobStore, jobId: string): Promise<Job> {
  const job = await store.get(jobId);
  if (!job) throw new NotFoundError(`Job "${jobId}" not found`);
  return job;
}

/** Update one item inside a job and return the persisted snapshot of both. */
async function updateItem(
  ctx: Pick<WorkerContext, "store" | "jobId">,
  itemId: string,
  mutate: (item: JobItem, job: Job) => void,
): Promise<{ job: Job; item: JobItem }> {
  const job = await ctx.store.update(ctx.jobId, (draft) => mutate(requireItem(draft, itemId), draft));
  return { job, item: requireItem(job, itemId) };
}

/** `dish.jpg`, `dish_2.jpg`, … — the first name not already used by another item. */
function uniqueFilename(stem: string, extension: string, taken: ReadonlySet<string>): string {
  let candidate = `${stem}.${extension}`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${stem}_${n}.${extension}`;
  return candidate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker
// ─────────────────────────────────────────────────────────────────────────────

function providerRetryAfterMs(error: unknown): number | undefined {
  return error instanceof ProviderError ? error.retryAfterMs : undefined;
}

/** Call the provider with retries; every attempt bumps `item.attempts` in the store first. */
function generateWithRetry(ctx: WorkerContext, item: JobItem): Promise<GenerateImageResult> {
  const { settings, runtime, store, jobId, bus, model, provider } = ctx;
  const signal = runtime.controller.signal;
  const totalAttempts = settings.maxRetries + 1;

  return retry(
    async () => {
      await store.update(jobId, (draft) => {
        requireItem(draft, item.id).attempts += 1;
      });
      return provider.generate(model, {
        prompt: item.prompt,
        size: settings.size,
        quality: settings.quality,
        format: settings.format,
        signal,
      });
    },
    {
      maxRetries: settings.maxRetries,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      signal,
      retryAfterMs: providerRetryAfterMs,
      onRetry: (error, attempt, delayMs) => {
        emitLog(
          bus,
          jobId,
          "warn",
          `Retrying ${item.dishName} in ${formatSeconds(delayMs)} (attempt ${attempt + 1}/${totalAttempts}): ${errorMessage(error)}`,
          item.id,
        );
      },
    },
  );
}

/** Mark an item cancelled (used when the job was aborted before or during its generation). */
async function cancelItem(ctx: WorkerContext, itemId: string): Promise<void> {
  const { job, item } = await updateItem(ctx, itemId, (draft) => {
    draft.status = "cancelled";
  });
  emitItem(ctx.bus, job, item);
}

/** Generate one item end to end: running → provider (with retries) → normalise → write → done/failed/cancelled. */
async function processItem(ctx: WorkerContext, itemId: string): Promise<void> {
  const { bus, jobId, runtime, settings, store, model } = ctx;
  const signal = runtime.controller.signal;
  try {
    if (signal.aborted) {
      await cancelItem(ctx, itemId);
      return;
    }

    const startedAt = Date.now();
    const running = await updateItem(ctx, itemId, (draft) => {
      draft.status = "running";
      draft.error = undefined;
    });
    emitItem(bus, running.job, running.item);
    const item = running.item;

    try {
      const generated = await generateWithRetry(ctx, item);
      const normalized = await normalizeImage(generated.bytes, { format: settings.format, size: settings.size });
      await store.writeImage(running.job, itemId, normalized.bytes);
      const durationMs = Date.now() - startedAt;

      const done = await updateItem(ctx, itemId, (draft) => {
        draft.status = "done";
        draft.imageUrl = `/api/jobs/${jobId}/images/${itemId}?v=${draft.attempts}`;
        draft.generatedAt = nowIso();
        draft.durationMs = durationMs;
        draft.costUsd = generated.costUsd ?? priceForQuality(model, settings.quality);
        draft.error = undefined;
      });
      emitItem(bus, done.job, done.item);
      emitLog(bus, jobId, "info", `Generated ${done.item.filename} in ${formatSeconds(durationMs)}`, itemId);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        await cancelItem(ctx, itemId);
        return;
      }
      const message = truncate(errorMessage(error));
      const failed = await updateItem(ctx, itemId, (draft) => {
        draft.status = "failed";
        draft.error = message;
        draft.durationMs = Date.now() - startedAt;
      });
      emitItem(bus, failed.job, failed.item);
      emitLog(bus, jobId, "error", `Failed ${item.dishName}: ${message}`, itemId);
    }
  } finally {
    runtime.claimed.delete(itemId);
    runtime.regenerating.delete(itemId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job execution
// ─────────────────────────────────────────────────────────────────────────────

/** Provider has no key: fail the job and every pending item without calling anything. */
async function failUnconfigured(store: JobStore, bus: JobEventBus, jobId: string, model: ModelSpec): Promise<void> {
  const error = new ProviderNotConfiguredError(model.provider, PROVIDER_META[model.provider].envVar);
  const failed = await store.update(jobId, (draft) => {
    draft.status = "failed";
    draft.error = error.message;
    draft.finishedAt = nowIso();
    for (const item of draft.items) {
      if (item.status === "pending") {
        item.status = "failed";
        item.error = error.message;
      }
    }
  });
  emitLog(bus, jobId, "error", error.message);
  emitJob(bus, failed);
  emitEnd(bus, failed);
}

/** Wait until every extra single-item task has settled (tasks remove themselves on completion). */
async function drainTasks(runtime: JobRuntime): Promise<void> {
  while (runtime.tasks.size > 0) {
    await Promise.allSettled([...runtime.tasks]);
  }
}

/** Terminal status: `done` when everything succeeded, `cancelled` after an abort, otherwise `failed`. */
async function finalizeJob(store: JobStore, bus: JobEventBus, jobId: string, aborted: boolean): Promise<void> {
  const final = await store.update(jobId, (draft) => {
    if (aborted) {
      for (const item of draft.items) {
        if (item.status === "pending" || item.status === "running") item.status = "cancelled";
      }
    }
    const allDone = draft.items.every((item) => item.status === "done");
    draft.status = allDone ? "done" : aborted ? "cancelled" : "failed";
    draft.finishedAt = nowIso();
  });
  emitJob(bus, final);
  emitEnd(bus, final);
}

/**
 * The body of one run: mark the job running, process `itemIds` (default: every
 * pending item) through the pool, wait for parallel regenerations, finalise.
 */
async function executeJob(jobId: string, runtime: JobRuntime, itemIds?: readonly string[]): Promise<void> {
  const store = getJobStore();
  const bus = getJobEventBus();
  const job = await requireJob(store, jobId);
  const model = requireModel(job.settings.modelId);
  const provider = getProvider(model.provider);

  if (!provider.isConfigured()) {
    await failUnconfigured(store, bus, jobId, model);
    return;
  }

  const started = await store.update(jobId, (draft) => {
    draft.status = "running";
    draft.startedAt = draft.startedAt ?? nowIso();
    draft.finishedAt = undefined;
    draft.error = undefined;
  });
  emitJob(bus, started);

  const candidates = itemIds ?? started.items.filter((item) => item.status === "pending").map((item) => item.id);
  const targets = candidates.filter((id) => !runtime.claimed.has(id));
  for (const id of targets) runtime.claimed.add(id);

  const ctx: WorkerContext = { jobId, store, bus, runtime, model, provider, settings: started.settings };
  await runPool(targets, started.settings.concurrency, (id) => processItem(ctx, id), {
    signal: runtime.controller.signal,
  });
  await drainTasks(runtime);

  runtime.finalizing = true;
  await finalizeJob(store, bus, jobId, runtime.controller.signal.aborted);
}

/** Last resort when the run itself blows up (disk full, …): leave nothing stuck in `running`. */
async function markJobCrashed(jobId: string, error: unknown): Promise<void> {
  const store = getJobStore();
  const bus = getJobEventBus();
  const message = truncate(errorMessage(error));
  const crashed = await store.update(jobId, (draft) => {
    draft.status = "failed";
    draft.error = message;
    draft.finishedAt = nowIso();
    for (const item of draft.items) {
      if (item.status === "pending" || item.status === "running") {
        item.status = "failed";
        item.error = message;
      }
    }
  });
  emitLog(bus, jobId, "error", `Job failed: ${message}`);
  emitJob(bus, crashed);
  emitEnd(bus, crashed);
}

/**
 * Register a runtime and start the run. Throws `ConflictError` synchronously
 * when the job already has one; the returned promise settles with the run.
 */
function launch(jobId: string, itemIds?: readonly string[]): JobRuntime {
  const runtimes = getRuntimes();
  if (runtimes.has(jobId)) throw new ConflictError(`Job "${jobId}" is already running`);

  const runtime: JobRuntime = {
    controller: new AbortController(),
    promise: Promise.resolve(),
    tasks: new Set(),
    claimed: new Set(),
    regenerating: new Set(),
    finalizing: false,
  };
  runtimes.set(jobId, runtime);

  runtime.promise = executeJob(jobId, runtime, itemIds)
    .catch(async (error: unknown) => {
      if (!(error instanceof NotFoundError)) await markJobCrashed(jobId, error).catch(() => undefined);
      throw error;
    })
    .finally(() => {
      if (runtimes.get(jobId) === runtime) runtimes.delete(jobId);
    });
  return runtime;
}

/** Fire-and-forget variant of {@link launch}: failures are reported to the console, never thrown. */
function launchInBackground(jobId: string, itemIds?: readonly string[]): void {
  launch(jobId, itemIds).promise.catch((error: unknown) => {
    console.error(`[runner] Job "${jobId}" run failed: ${errorMessage(error)}`);
  });
}

/** The active runtime, or undefined when the job is idle or already finalising. */
function activeRuntime(jobId: string): JobRuntime | undefined {
  const runtime = getRuntimes().get(jobId);
  return runtime && !runtime.finalizing ? runtime : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** True while a job has in-flight work in this process. */
export function isJobRunning(jobId: string): boolean {
  return getRuntimes().has(jobId);
}

/** Fire-and-forget: begins processing pending items. Throws ConflictError if already running. */
export function startJob(jobId: string): void {
  launchInBackground(jobId);
}

/** Like startJob but resolves with the final job (CLI). */
export async function runJob(jobId: string): Promise<Job> {
  await launch(jobId).promise;
  return requireJob(getJobStore(), jobId);
}

/** Abort in-flight requests; pending → cancelled; job → cancelled. */
export async function cancelJob(jobId: string): Promise<Job> {
  const store = getJobStore();
  const bus = getJobEventBus();
  const runtime = getRuntimes().get(jobId);
  if (!runtime) return requireJob(store, jobId);

  runtime.controller.abort();
  emitLog(bus, jobId, "warn", "Cancellation requested; waiting for in-flight requests to stop");
  const cancelledIds: string[] = [];
  const updated = await store.update(jobId, (draft) => {
    for (const item of draft.items) {
      if (item.status === "pending") {
        item.status = "cancelled";
        cancelledIds.push(item.id);
      }
    }
  });
  for (const id of cancelledIds) emitItem(bus, updated, requireItem(updated, id));

  await runtime.promise.catch(() => undefined);
  return requireJob(store, jobId);
}

/** failed/cancelled items → pending, then startJob. */
export async function retryFailed(jobId: string): Promise<Job> {
  if (isJobRunning(jobId)) {
    throw new ConflictError(`Job "${jobId}" is still running; wait for it to finish or cancel it first`);
  }
  const store = getJobStore();
  const bus = getJobEventBus();
  await requireJob(store, jobId);

  const requeued: string[] = [];
  const updated = await store.update(jobId, (draft) => {
    for (const item of draft.items) {
      if (item.status === "failed" || item.status === "cancelled") {
        item.status = "pending";
        item.error = undefined;
        requeued.push(item.id);
      }
    }
    draft.status = "queued";
    draft.error = undefined;
    draft.finishedAt = undefined;
  });
  for (const id of requeued) emitItem(bus, updated, requireItem(updated, id));
  emitJob(bus, updated);
  emitLog(bus, jobId, "info", `Retrying ${requeued.length} item${requeued.length === 1 ? "" : "s"}`);

  startJob(jobId);
  return updated;
}

/** Apply edits to an item, rebuild its prompt and (when the name changed) give it a filename unique in the job. */
function applyOverrides(job: Job, item: JobItem, overrides: RegenerateItemRequest): void {
  const nameChanged = overrides.dishName !== undefined && overrides.dishName !== item.dishName;
  if (overrides.dishName !== undefined) item.dishName = overrides.dishName;
  if (overrides.description !== undefined) item.description = overrides.description;
  if (overrides.category !== undefined) item.category = overrides.category;

  const promptOverride = overrides.promptOverride;
  item.prompt =
    promptOverride !== undefined && promptOverride.trim() !== ""
      ? promptOverride
      : buildPrompt(item, job.settings.stylePresetId, job.settings.customPrompt);

  if (nameChanged) {
    const taken = new Set(job.items.filter((other) => other.id !== item.id).map((other) => other.filename));
    item.filename = uniqueFilename(toFilenameStem(item.dishName), extensionForFormat(job.settings.format), taken);
  }
}

/** Run one item alongside the pool of a running job; the run's finalisation waits for it. */
function spawnParallelTask(runtime: JobRuntime, jobId: string, job: Job, itemId: string): void {
  const model = requireModel(job.settings.modelId);
  const ctx: WorkerContext = {
    jobId,
    store: getJobStore(),
    bus: getJobEventBus(),
    runtime,
    model,
    provider: getProvider(model.provider),
    settings: job.settings,
  };
  runtime.claimed.add(itemId);
  runtime.regenerating.add(itemId);
  const task: Promise<void> = processItem(ctx, itemId)
    .catch((error: unknown) => {
      emitLog(ctx.bus, jobId, "error", `Regeneration of item "${itemId}" failed: ${errorMessage(error)}`, itemId);
    })
    .finally(() => {
      runtime.tasks.delete(task);
    });
  runtime.tasks.add(task);
}

/** Apply overrides, rebuild prompt, set item running and generate it (async). Returns the item as queued. */
export async function regenerateItem(
  jobId: string,
  itemId: string,
  overrides: RegenerateItemRequest = {},
): Promise<JobItem> {
  const store = getJobStore();
  const bus = getJobEventBus();

  let runtime = activeRuntime(jobId);
  if (!runtime) {
    // A run that is finalising cannot accept new work: wait for it, then start a fresh single-item run.
    await getRuntimes().get(jobId)?.promise.catch(() => undefined);
    runtime = activeRuntime(jobId);
  }

  const before = await requireJob(store, jobId);
  if (requireItem(before, itemId).status === "running" || runtime?.regenerating.has(itemId)) {
    throw new ConflictError(`Item "${itemId}" is already being generated`);
  }

  const updated = await store.update(jobId, (draft) => {
    const item = requireItem(draft, itemId);
    applyOverrides(draft, item, overrides);
    item.status = "pending";
    item.error = undefined;
  });
  const item = requireItem(updated, itemId);
  emitItem(bus, updated, item);

  if (runtime === undefined) {
    const fresh = launch(jobId, [itemId]);
    fresh.regenerating.add(itemId);
    fresh.promise.catch((error: unknown) => {
      console.error(`[runner] Job "${jobId}" run failed: ${errorMessage(error)}`);
    });
  } else if (!runtime.claimed.has(itemId)) {
    // Not queued in the running pool: generate it now, in parallel with the pool.
    spawnParallelTask(runtime, jobId, updated, itemId);
  }
  // Otherwise the running pool still owns this (pending) item and will pick up the new prompt when it starts it.
  return item;
}
