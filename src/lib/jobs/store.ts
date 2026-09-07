import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  GenerationSettings,
  ItemStatus,
  Job,
  JobItem,
  JobStats,
  JobStatus,
  JobSummary,
  MenuItem,
} from "../types";
import { env } from "../env";
import { NotFoundError, ValidationError, errorMessage } from "../errors";
import { assignFilenames, extensionForFormat } from "../filename";
import { getModel, priceForQuality } from "../models";
import { buildPrompt } from "../prompt";

/**
 * JobStore: in-memory map of jobs mirrored to `<dataDir>/jobs/<jobId>/job.json`,
 * with generated images next to it in `images/<itemId>.<ext>`.
 *
 * Every write to `job.json` is atomic (temp file + rename) and serialised per
 * job, so concurrent item updates from the runner's worker pool never
 * interleave on disk. The JSON never contains absolute paths: image locations
 * are derived from `dataDir` at read time.
 */

export interface CreateJobInput {
  items: MenuItem[];
  settings: GenerationSettings;
  sourceFilename?: string;
}

export interface JobStore {
  /** Absolute data directory (env.dataDir). */
  readonly dataDir: string;
  /** Load persisted jobs once; marks interrupted jobs failed. Idempotent. */
  init(): Promise<void>;
  /** Builds prompts + unique filenames, status queued, persists. */
  create(input: CreateJobInput): Promise<Job>;
  get(jobId: string): Promise<Job | undefined>;
  list(limit?: number): Promise<JobSummary[]>;
  /** Mutate in place; recomputes stats + updatedAt; persists; returns the job. */
  update(jobId: string, mutate: (job: Job) => void): Promise<Job>;
  /** Removes the job and its files. No-op if missing. */
  delete(jobId: string): Promise<void>;
  /** Absolute path where an item's image is/will be stored: <dataDir>/jobs/<jobId>/images/<itemId>.<ext>. */
  imagePath(job: Job, itemId: string): string;
  /** Returns the path if the file exists on disk. */
  existingImagePath(job: Job, itemId: string): Promise<string | undefined>;
  writeImage(job: Job, itemId: string, bytes: Uint8Array): Promise<string>;
}

/** Error recorded on jobs/items that were mid-flight when the server last stopped. */
export const INTERRUPTED_ERROR = "Interrupted by server restart";

/** Default page size of {@link JobStore.list}. */
export const DEFAULT_LIST_LIMIT = 20;

const JOBS_DIRNAME = "jobs";
const IMAGES_DIRNAME = "images";
const JOB_FILENAME = "job.json";

const JOB_STATUSES: ReadonlySet<string> = new Set<JobStatus>(["queued", "running", "done", "cancelled", "failed"]);
const ITEM_STATUSES: ReadonlySet<string> = new Set<ItemStatus>(["pending", "running", "done", "failed", "cancelled"]);

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

/** Round to 4 decimals so sub-cent sums stay exact (3 × 0.011 → 0.033). */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Milliseconds between `startedAt` and `finishedAt` (or now while running); 0 before the job starts. */
function elapsedMs(job: Job): number {
  if (!job.startedAt) return 0;
  const started = Date.parse(job.startedAt);
  if (Number.isNaN(started)) return 0;
  const finished = job.finishedAt ? Date.parse(job.finishedAt) : Number.NaN;
  const end = Number.isNaN(finished) ? Date.now() : finished;
  return Math.max(0, end - started);
}

/** Derive `JobStats` from the items and settings (never trusts persisted stats). */
export function computeStats(job: Job): JobStats {
  const counts: Record<ItemStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  let actualCostUsd = 0;
  for (const item of job.items) {
    counts[item.status] += 1;
    if (item.status === "done" && typeof item.costUsd === "number" && Number.isFinite(item.costUsd)) {
      actualCostUsd += item.costUsd;
    }
  }
  const model = getModel(job.settings.modelId);
  const perImageUsd = model ? priceForQuality(model, job.settings.quality) : 0;
  return {
    total: job.items.length,
    ...counts,
    estimatedCostUsd: round4(perImageUsd * job.items.length),
    actualCostUsd: round4(actualCostUsd),
    elapsedMs: elapsedMs(job),
  };
}

/** Listing entry for `GET /api/jobs` (stats recomputed so `elapsedMs` is current). */
export function jobToSummary(job: Job): JobSummary {
  const summary: JobSummary = {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    modelId: job.settings.modelId,
    stats: computeStats(job),
  };
  if (job.sourceFilename !== undefined) summary.sourceFilename = job.sourceFilename;
  return summary;
}

/** Find an item inside a job or throw `NotFoundError`. */
export function requireItem(job: Job, itemId: string): JobItem {
  const item = job.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new NotFoundError(`Item "${itemId}" not found in job "${job.id}"`);
  return item;
}

/** Deep copy with fresh stats so callers can never mutate the store's state by accident. */
function snapshot(job: Job): Job {
  const copy = structuredClone(job);
  copy.stats = computeStats(job);
  return copy;
}

/** Reject ids that could escape the job directory when used as a path segment. */
function assertSafePathSegment(value: string, what: string): void {
  if (value === "" || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new ValidationError(`${what} "${value}" is not a valid path segment`);
  }
}

/** Only the base name of the upload is kept: the JSON must never carry client paths. */
function baseName(filename: string): string | undefined {
  const base = filename.split(/[\\/]/).pop()?.trim();
  return base ? base : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural check for a persisted `job.json`; deeper field validation is not needed for our own writes. */
function isPersistedJob(value: unknown): value is Job {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    return false;
  }
  if (typeof value.status !== "string" || !JOB_STATUSES.has(value.status)) return false;
  if (!isRecord(value.settings) || typeof value.settings.modelId !== "string") return false;
  if (!Array.isArray(value.items)) return false;
  return value.items.every(
    (item) =>
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.status === "string" &&
      ITEM_STATUSES.has(item.status) &&
      typeof item.filename === "string" &&
      typeof item.prompt === "string",
  );
}

/**
 * A job persisted as `queued`/`running` cannot resume after a restart: mark it
 * (and its unfinished items) failed so the UI can offer "Retry failed".
 * Returns true when the job was changed.
 */
function recoverInterrupted(job: Job): boolean {
  if (job.status !== "queued" && job.status !== "running") return false;
  for (const item of job.items) {
    if (item.status === "pending" || item.status === "running") {
      item.status = "failed";
      item.error = INTERRUPTED_ERROR;
    }
  }
  job.status = "failed";
  job.error = INTERRUPTED_ERROR;
  job.finishedAt = job.finishedAt ?? job.updatedAt;
  job.updatedAt = nowIso();
  job.stats = computeStats(job);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

/** Atomic write: the temp file is renamed over `file` so readers never see a partial JSON. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/** Atomic binary write (same temp + rename scheme as {@link writeJsonAtomic}). */
async function writeBytesAtomic(file: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, file);
}

/**
 * Serialises writes of one job: at most one write in flight and one queued.
 * A queued write starts after the in-flight one and serialises the state at
 * that moment, so every `flush()` caller is guaranteed its mutation reaches
 * disk while bursts of updates collapse into a single extra write.
 */
class PersistQueue {
  private inFlight: Promise<void> | undefined;
  private queued: Promise<void> | undefined;

  constructor(private readonly write: () => Promise<void>) {}

  /** Resolves once a write that started after this call has completed. */
  flush(): Promise<void> {
    if (this.queued) return this.queued;
    if (!this.inFlight) return this.start();
    const follow = this.inFlight
      .catch(() => undefined)
      .then(() => {
        this.queued = undefined;
        return this.start();
      });
    this.queued = follow;
    return follow;
  }

  /** Resolves when no write is running or queued (errors are ignored). */
  async idle(): Promise<void> {
    while (this.queued || this.inFlight) {
      await (this.queued ?? this.inFlight)?.catch(() => undefined);
    }
  }

  private start(): Promise<void> {
    const run = this.write().finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

class FileJobStore implements JobStore {
  readonly dataDir: string;
  private readonly jobs = new Map<string, Job>();
  private readonly persisters = new Map<string, PersistQueue>();
  private initPromise: Promise<void> | undefined;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private get jobsDir(): string {
    return path.join(this.dataDir, JOBS_DIRNAME);
  }

  private jobDir(jobId: string): string {
    assertSafePathSegment(jobId, "Job id");
    return path.join(this.jobsDir, jobId);
  }

  private jobFile(jobId: string): string {
    return path.join(this.jobDir(jobId), JOB_FILENAME);
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.load().catch((error: unknown) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    return this.initPromise;
  }

  async create(input: CreateJobInput): Promise<Job> {
    await this.init();
    if (input.items.length === 0) throw new ValidationError("A job needs at least one menu item");
    const seen = new Set<string>();
    for (const item of input.items) {
      assertSafePathSegment(item.id, "Item id");
      if (seen.has(item.id)) throw new ValidationError(`Duplicate item id "${item.id}"`);
      seen.add(item.id);
    }

    const settings = structuredClone(input.settings);
    const filenames = assignFilenames(input.items, settings.format);
    const items: JobItem[] = input.items.map((item, index) => ({
      id: item.id,
      dishName: item.dishName,
      description: item.description,
      category: item.category,
      status: "pending",
      filename: filenames[index],
      prompt: buildPrompt(item, settings.stylePresetId, settings.customPrompt),
      attempts: 0,
    }));

    const now = nowIso();
    const job: Job = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "queued",
      settings,
      items,
      stats: { total: 0, pending: 0, running: 0, done: 0, failed: 0, cancelled: 0, estimatedCostUsd: 0, actualCostUsd: 0, elapsedMs: 0 },
    };
    const sourceFilename = input.sourceFilename === undefined ? undefined : baseName(input.sourceFilename);
    if (sourceFilename !== undefined) job.sourceFilename = sourceFilename;
    job.stats = computeStats(job);

    await fs.mkdir(path.join(this.jobDir(job.id), IMAGES_DIRNAME), { recursive: true });
    this.jobs.set(job.id, job);
    await this.persist(job);
    return snapshot(job);
  }

  async get(jobId: string): Promise<Job | undefined> {
    await this.init();
    const job = this.jobs.get(jobId);
    return job ? snapshot(job) : undefined;
  }

  async list(limit: number = DEFAULT_LIST_LIMIT): Promise<JobSummary[]> {
    await this.init();
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_LIST_LIMIT;
    // Insertion order is the tiebreak: a job created later in the same millisecond still lists first.
    return [...this.jobs.values()]
      .map((job, insertionIndex) => ({ job, insertionIndex }))
      .sort((a, b) => compareNewestFirst(a.job, b.job) || b.insertionIndex - a.insertionIndex)
      .slice(0, max)
      .map((entry) => jobToSummary(entry.job));
  }

  async update(jobId: string, mutate: (job: Job) => void): Promise<Job> {
    await this.init();
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundError(`Job "${jobId}" not found`);
    mutate(job);
    job.stats = computeStats(job);
    job.updatedAt = nowIso();
    await this.persist(job);
    return snapshot(job);
  }

  async delete(jobId: string): Promise<void> {
    await this.init();
    if (!this.jobs.delete(jobId)) return;
    const persister = this.persisters.get(jobId);
    this.persisters.delete(jobId);
    // Let any in-flight write land before removing the directory, otherwise its rename would resurrect job.json.
    await persister?.idle();
    await fs.rm(this.jobDir(jobId), { recursive: true, force: true });
  }

  imagePath(job: Job, itemId: string): string {
    assertSafePathSegment(itemId, "Item id");
    const extension = extensionForFormat(job.settings.format);
    return path.join(this.jobDir(job.id), IMAGES_DIRNAME, `${itemId}.${extension}`);
  }

  async existingImagePath(job: Job, itemId: string): Promise<string | undefined> {
    const file = this.imagePath(job, itemId);
    try {
      await fs.access(file);
      return file;
    } catch {
      return undefined;
    }
  }

  async writeImage(job: Job, itemId: string, bytes: Uint8Array): Promise<string> {
    const file = this.imagePath(job, itemId);
    await writeBytesAtomic(file, bytes);
    return file;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private persist(job: Job): Promise<void> {
    let persister = this.persisters.get(job.id);
    if (!persister) {
      persister = new PersistQueue(() => writeJsonAtomic(this.jobFile(job.id), job));
      this.persisters.set(job.id, persister);
    }
    return persister.flush();
  }

  /** Read every `jobs/<id>/job.json`, recovering interrupted jobs and skipping corrupt files. */
  private async load(): Promise<void> {
    await fs.mkdir(this.jobsDir, { recursive: true });
    const entries = await fs.readdir(this.jobsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const job = await this.readJobFile(entry.name);
      if (!job) continue;
      if (recoverInterrupted(job)) {
        await writeJsonAtomic(this.jobFile(job.id), job).catch((error: unknown) => {
          console.warn(`[jobs] Could not persist recovery of job "${job.id}": ${errorMessage(error)}`);
        });
      }
      this.jobs.set(job.id, job);
    }
  }

  /** Parse one job directory; returns undefined (with a warning) for anything unusable. */
  private async readJobFile(dirName: string): Promise<Job | undefined> {
    const relative = path.join(JOBS_DIRNAME, dirName, JOB_FILENAME);
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.jobsDir, dirName, JOB_FILENAME), "utf8");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT") console.warn(`[jobs] Skipping unreadable ${relative}: ${errorMessage(error)}`);
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn(`[jobs] Skipping corrupt ${relative}: ${errorMessage(error)}`);
      return undefined;
    }
    if (!isPersistedJob(parsed)) {
      console.warn(`[jobs] Skipping ${relative}: not a valid job record`);
      return undefined;
    }
    if (parsed.id !== dirName) {
      console.warn(`[jobs] Skipping ${relative}: job id "${parsed.id}" does not match its directory`);
      return undefined;
    }
    parsed.stats = computeStats(parsed);
    return parsed;
  }
}

/** Newest `createdAt` first; 0 when the timestamps tie or cannot be parsed. */
function compareNewestFirst(a: Job, b: Job): number {
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return Number.isFinite(byTime) ? byTime : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

const GLOBAL_KEY = "__menugenJobStore";

type GlobalWithStore = typeof globalThis & { [GLOBAL_KEY]?: JobStore };

/** Process-wide singleton (cached on globalThis). */
export function getJobStore(): JobStore {
  const holder = globalThis as GlobalWithStore;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const store = new FileJobStore(env.dataDir);
  holder[GLOBAL_KEY] = store;
  return store;
}

/** Drop the singleton so the next `getJobStore()` reads `MENUGEN_DATA_DIR` afresh and reloads from disk (tests only). */
export function __resetJobStoreForTests(): void {
  delete (globalThis as GlobalWithStore)[GLOBAL_KEY];
}
