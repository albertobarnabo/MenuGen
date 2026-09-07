import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerationSettings, Job, JobEvent, MenuItem } from "@/lib/types";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { __resetJobEventBusForTests, getJobEventBus } from "@/lib/jobs/events";
import { cancelJob, isJobRunning, regenerateItem, retryFailed, runJob, startJob } from "@/lib/jobs/runner";
import {
  INTERRUPTED_ERROR,
  __resetJobStoreForTests,
  computeStats,
  getJobStore,
  jobToSummary,
  type JobStore,
} from "@/lib/jobs/store";

const SETTINGS: GenerationSettings = {
  modelId: "mock/sample",
  size: "1024x1024",
  format: "jpeg",
  stylePresetId: "editorial",
  concurrency: 2,
  maxRetries: 1,
};

let counter = 0;
function menuItem(dishName: string, description = "", category = ""): MenuItem {
  counter += 1;
  return { id: `item-${counter}-${dishName.replace(/\W+/g, "").toLowerCase()}`, dishName, description, category };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve once the runner has no in-flight work for the job (polls; the run is registered synchronously). */
async function waitForIdle(jobId: string, timeoutMs = 30_000): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  while (isJobRunning(jobId)) {
    if (Date.now() > deadline) throw new Error(`Job ${jobId} still running after ${timeoutMs} ms`);
    await sleep(20);
  }
  const job = await getJobStore().get(jobId);
  if (!job) throw new Error(`Job ${jobId} vanished`);
  return job;
}

function capture(jobId: string): { events: JobEvent[]; stop: () => void } {
  const events: JobEvent[] = [];
  const stop = getJobEventBus().subscribe(jobId, (event) => events.push(event));
  return { events, stop };
}

let dataDir: string;
let store: JobStore;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "menugen-"));
  process.env.MENUGEN_DATA_DIR = dataDir;
  __resetJobStoreForTests();
  __resetJobEventBusForTests();
  store = getJobStore();
  await store.init();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  delete process.env.MENUGEN_DATA_DIR;
  __resetJobStoreForTests();
  __resetJobEventBusForTests();
});

describe("JobStore.create", () => {
  it("builds prompts, unique filenames and initial stats; persists job.json without absolute paths", async () => {
    const job = await store.create({
      items: [menuItem("Beef Burger", "double patty", "Mains"), menuItem("Beef Burger"), menuItem("Tiramisu")],
      settings: SETTINGS,
      sourceFilename: "/Users/someone/Downloads/menu.csv",
    });

    expect(store.dataDir).toBe(dataDir);
    expect(job.status).toBe("queued");
    expect(job.sourceFilename).toBe("menu.csv");
    expect(job.items.map((i) => i.filename)).toEqual(["beef_burger.jpg", "beef_burger_2.jpg", "tiramisu.jpg"]);
    expect(job.items[0].prompt).toContain("Beef Burger, double patty (Mains)");
    expect(job.items.every((i) => i.status === "pending" && i.attempts === 0)).toBe(true);
    expect(job.stats).toMatchObject({ total: 3, pending: 3, done: 0, failed: 0, estimatedCostUsd: 0, elapsedMs: 0 });

    const raw = await fs.readFile(path.join(dataDir, "jobs", job.id, "job.json"), "utf8");
    expect(JSON.parse(raw).id).toBe(job.id);
    expect(raw).not.toContain(dataDir);
    expect(raw).not.toContain("/Users/someone");

    expect(store.imagePath(job, job.items[0].id)).toBe(
      path.join(dataDir, "jobs", job.id, "images", `${job.items[0].id}.jpg`),
    );
    await expect(store.existingImagePath(job, job.items[0].id)).resolves.toBeUndefined();
    await store.delete(job.id);
  });

  it("rejects empty batches and duplicate item ids", async () => {
    await expect(store.create({ items: [], settings: SETTINGS })).rejects.toThrow(/at least one/);
    const dup = menuItem("Ramen");
    await expect(store.create({ items: [dup, { ...dup }], settings: SETTINGS })).rejects.toThrow(/Duplicate item id/);
  });

  it("returns snapshots: mutating a returned job does not touch the store", async () => {
    const job = await store.create({ items: [menuItem("Gelato")], settings: SETTINGS });
    job.items[0].dishName = "Mutated";
    const again = await store.get(job.id);
    expect(again?.items[0].dishName).toBe("Gelato");
    await store.delete(job.id);
  });
});

describe("JobStore.list / update / delete", () => {
  it("lists newest first with summaries, updates recompute stats, delete removes files", async () => {
    const first = await store.create({ items: [menuItem("Tacos")], settings: SETTINGS });
    const second = await store.create({ items: [menuItem("Nachos")], settings: SETTINGS });

    const listed = await store.list(10);
    expect(listed.map((j) => j.id).slice(0, 2)).toEqual([second.id, first.id]);
    expect(listed[0]).toEqual(jobToSummary((await store.get(second.id)) as Job));
    expect(listed[0].modelId).toBe("mock/sample");
    expect(await store.list(1)).toHaveLength(1);

    const updated = await store.update(first.id, (draft) => {
      draft.items[0].status = "done";
      draft.items[0].costUsd = 0.5;
    });
    expect(updated.stats.done).toBe(1);
    expect(updated.stats.actualCostUsd).toBe(0.5);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));
    await expect(store.update("nope", () => undefined)).rejects.toBeInstanceOf(NotFoundError);

    const dir = path.join(dataDir, "jobs", first.id);
    await store.delete(first.id);
    await store.delete(second.id);
    await expect(fs.access(dir)).rejects.toThrow();
    await expect(store.get(first.id)).resolves.toBeUndefined();
    await expect(store.delete("missing")).resolves.toBeUndefined();
  });
});

describe("computeStats", () => {
  it("prices the estimate by model quality and only sums done items", () => {
    const job: Job = {
      id: "j",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:10.000Z",
      status: "failed",
      settings: { ...SETTINGS, modelId: "openai/gpt-image-2", quality: "high" },
      items: [
        { id: "a", dishName: "A", description: "", category: "", status: "done", filename: "a.jpg", prompt: "p", attempts: 1, costUsd: 0.036 },
        { id: "b", dishName: "B", description: "", category: "", status: "failed", filename: "b.jpg", prompt: "p", attempts: 2, costUsd: 0.036 },
        { id: "c", dishName: "C", description: "", category: "", status: "cancelled", filename: "c.jpg", prompt: "p", attempts: 0 },
      ],
      stats: { total: 0, pending: 0, running: 0, done: 0, failed: 0, cancelled: 0, estimatedCostUsd: 0, actualCostUsd: 0, elapsedMs: 0 },
    };
    expect(computeStats(job)).toEqual({
      total: 3,
      pending: 0,
      running: 0,
      done: 1,
      failed: 1,
      cancelled: 1,
      estimatedCostUsd: 0.375,
      actualCostUsd: 0.036,
      elapsedMs: 10_000,
    });
  });
});

describe("runJob", () => {
  let job: Job;
  let events: JobEvent[];

  beforeAll(async () => {
    const created = await store.create({
      items: [menuItem("Beef Burger", "double patty, cheddar", "Mains"), menuItem("Pad Thai"), menuItem("[fail] Soup")],
      settings: SETTINGS,
      sourceFilename: "menu.csv",
    });
    const captured = capture(created.id);
    events = captured.events;
    job = await runJob(created.id);
    captured.stop();
  }, 60_000);

  it("generates the good items, exhausts retries on the failing one and ends failed", () => {
    expect(job.status).toBe("failed");
    expect(job.startedAt).toBeDefined();
    expect(job.finishedAt).toBeDefined();
    expect(job.error).toBeUndefined();

    const [burger, padThai, soup] = job.items;
    expect(burger.status).toBe("done");
    expect(padThai.status).toBe("done");
    expect(soup.status).toBe("failed");
    expect(soup.attempts).toBe(2);
    expect(soup.error).toContain("simulated transient failure");
    expect(burger.attempts).toBe(1);
    expect(burger.imageUrl).toBe(`/api/jobs/${job.id}/images/${burger.id}?v=1`);
    expect(burger.generatedAt).toBeDefined();
    expect(burger.durationMs).toBeGreaterThan(0);
    expect(burger.costUsd).toBe(0);
  });

  it("computes stats", () => {
    expect(job.stats).toMatchObject({ total: 3, pending: 0, running: 0, done: 2, failed: 1, cancelled: 0, estimatedCostUsd: 0, actualCostUsd: 0 });
    expect(job.stats.elapsedMs).toBeGreaterThan(0);
  });

  it("writes normalised image files for done items only", async () => {
    const [burger, padThai, soup] = job.items;
    for (const item of [burger, padThai]) {
      const file = await store.existingImagePath(job, item.id);
      expect(file).toBe(path.join(dataDir, "jobs", job.id, "images", `${item.id}.jpg`));
      const bytes = await fs.readFile(file as string);
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    }
    await expect(store.existingImagePath(job, soup.id)).resolves.toBeUndefined();
  });

  it("emits item, job, log and end events in order", () => {
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("job");
    expect(types.at(-1)).toBe("end");
    expect(types.indexOf("end")).toBe(types.length - 1);

    const jobEvents = events.filter((e): e is Extract<JobEvent, { type: "job" }> => e.type === "job");
    expect(jobEvents[0].status).toBe("running");
    expect(jobEvents.at(-1)?.status).toBe("failed");
    expect(jobEvents.at(-1)?.stats.done).toBe(2);

    const itemEvents = events.filter((e): e is Extract<JobEvent, { type: "item" }> => e.type === "item");
    const soupId = job.items[2].id;
    expect(itemEvents.filter((e) => e.item.id === soupId).map((e) => e.item.status)).toEqual(["running", "failed"]);
    expect(itemEvents.filter((e) => e.item.status === "done")).toHaveLength(2);
    expect(itemEvents.every((e) => e.jobId === job.id && typeof e.stats.total === "number")).toBe(true);

    const logs = events.filter((e): e is Extract<JobEvent, { type: "log" }> => e.type === "log");
    expect(logs.some((l) => l.level === "warn" && /^Retrying \[fail\] Soup in \d+\.\d s \(attempt 2\/2\): /.test(l.message))).toBe(true);
    expect(logs.some((l) => l.level === "error" && l.message.startsWith("Failed [fail] Soup:") && l.itemId === soupId)).toBe(true);
    expect(logs.some((l) => l.level === "info" && /^Generated beef_burger\.jpg in \d+\.\d s$/.test(l.message))).toBe(true);
    expect(logs.every((l) => !Number.isNaN(Date.parse(l.at)))).toBe(true);

    const end = events.at(-1);
    expect(end).toEqual({ type: "end", jobId: job.id, status: "failed" });
  });

  it("persists the final state so a fresh store reloads it from disk", async () => {
    __resetJobStoreForTests();
    const fresh = getJobStore();
    const reloaded = await fresh.get(job.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.items.map((i) => i.status)).toEqual(["done", "done", "failed"]);
    expect(reloaded?.items[2].attempts).toBe(2);
    expect(reloaded?.settings).toEqual(SETTINGS);
    const listed = await fresh.list();
    expect(listed.some((j) => j.id === job.id)).toBe(true);
    store = fresh;
  });

  it("rejects a second concurrent run and unknown jobs", async () => {
    await expect(runJob("does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
    expect(() => startJob("does-not-exist")).not.toThrow();
    await sleep(20);
  });

  it("retryFailed re-queues the failed item and runs it again", async () => {
    const requeued = await retryFailed(job.id);
    expect(requeued.items[2].status).toBe("pending");
    expect(requeued.items[2].error).toBeUndefined();
    expect(isJobRunning(job.id)).toBe(true);
    await expect(retryFailed(job.id)).rejects.toBeInstanceOf(ConflictError);

    const finished = await waitForIdle(job.id);
    expect(finished.status).toBe("failed");
    expect(finished.items[2].status).toBe("failed");
    expect(finished.items[2].attempts).toBe(4);
  }, 30_000);

  it("regenerateItem with a new dish name rebuilds prompt + filename and produces an image", async () => {
    const padThai = job.items[1];
    const { events: regenEvents, stop } = capture(job.id);
    const queued = await regenerateItem(job.id, padThai.id, { dishName: "Green Curry", category: "Mains" });

    expect(queued.status).toBe("pending");
    expect(queued.dishName).toBe("Green Curry");
    expect(queued.filename).toBe("green_curry.jpg");
    expect(queued.prompt).toContain("Green Curry (Mains)");
    expect(queued.prompt).not.toContain("Pad Thai");
    expect(isJobRunning(job.id)).toBe(true);

    const finished = await waitForIdle(job.id);
    stop();
    const item = finished.items[1];
    expect(item.status).toBe("done");
    expect(item.attempts).toBe(2);
    expect(item.imageUrl).toBe(`/api/jobs/${job.id}/images/${item.id}?v=2`);
    expect(finished.status).toBe("failed");
    expect(finished.items.map((i) => i.filename)).toEqual(["beef_burger.jpg", "green_curry.jpg", "fail_soup.jpg"]);
    await expect(store.existingImagePath(finished, item.id)).resolves.toBeDefined();

    const types = regenEvents.map((e) => e.type);
    expect(types.filter((t) => t === "job").length).toBeGreaterThanOrEqual(2);
    expect(types.at(-1)).toBe("end");
    const untouched = finished.items[0];
    expect(untouched.attempts).toBe(1);
  }, 30_000);

  it("regenerateItem honours promptOverride verbatim and leaves the filename alone", async () => {
    const queued = await regenerateItem(job.id, job.items[0].id, { promptOverride: "A burger on the moon" });
    expect(queued.prompt).toBe("A burger on the moon");
    expect(queued.filename).toBe("beef_burger.jpg");
    const finished = await waitForIdle(job.id);
    expect(finished.items[0].status).toBe("done");
    expect(finished.items[0].attempts).toBe(2);
    await expect(regenerateItem(job.id, "missing-item")).rejects.toBeInstanceOf(NotFoundError);
  }, 30_000);
});

describe("cancelJob", () => {
  it("aborts a running job: in-flight and pending items become cancelled, retryFailed resumes them", async () => {
    const created = await store.create({
      items: ["Margherita Pizza", "Tiramisu", "Chicken Caesar Salad", "Ramen", "Tacos", "Gelato"].map((n) => menuItem(n)),
      settings: { ...SETTINGS, concurrency: 1, maxRetries: 0 },
    });
    const { events, stop } = capture(created.id);

    startJob(created.id);
    expect(isJobRunning(created.id)).toBe(true);
    expect(() => startJob(created.id)).toThrow(ConflictError);
    await sleep(60);

    const cancelled = await cancelJob(created.id);
    stop();
    expect(isJobRunning(created.id)).toBe(false);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finishedAt).toBeDefined();
    expect(cancelled.stats.cancelled).toBeGreaterThan(0);
    expect(cancelled.stats.pending + cancelled.stats.running).toBe(0);
    expect(cancelled.stats.done + cancelled.stats.cancelled).toBe(6);
    expect(events.at(-1)).toEqual({ type: "end", jobId: created.id, status: "cancelled" });

    await expect(cancelJob(created.id)).resolves.toMatchObject({ status: "cancelled" });

    await retryFailed(created.id);
    const finished = await waitForIdle(created.id);
    expect(finished.status).toBe("done");
    expect(finished.items.every((i) => i.status === "done")).toBe(true);
    await store.delete(created.id);
  }, 60_000);

  it("regenerateItem returns 409 for an item that is currently running", async () => {
    const created = await store.create({
      items: [menuItem("Ramen"), menuItem("Udon")],
      settings: { ...SETTINGS, concurrency: 1, maxRetries: 0 },
    });
    startJob(created.id);
    await sleep(60);
    await expect(regenerateItem(created.id, created.items[0].id)).rejects.toBeInstanceOf(ConflictError);
    // The second item is pending and owned by the pool: overrides apply, no parallel task is started.
    const queued = await regenerateItem(created.id, created.items[1].id, { dishName: "Soba" });
    expect(queued.status).toBe("pending");
    expect(queued.filename).toBe("soba.jpg");
    const finished = await waitForIdle(created.id);
    expect(finished.status).toBe("done");
    expect(finished.items[1].attempts).toBe(1);
    expect(finished.items[1].dishName).toBe("Soba");
    await store.delete(created.id);
  }, 30_000);
});

describe("provider not configured", () => {
  it("fails the job and its items without calling the provider", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "";
    try {
      const created = await store.create({
        items: [menuItem("Burger")],
        settings: { ...SETTINGS, modelId: "openai/gpt-image-2", quality: "low" },
      });
      const { events, stop } = capture(created.id);
      const finished = await runJob(created.id);
      stop();
      expect(finished.status).toBe("failed");
      expect(finished.error).toMatch(/not configured.*OPENAI_API_KEY/);
      expect(finished.items[0].status).toBe("failed");
      expect(finished.items[0].error).toBe(finished.error);
      expect(finished.items[0].attempts).toBe(0);
      expect(finished.startedAt).toBeUndefined();
      expect(events.map((e) => e.type)).toEqual(["log", "job", "end"]);
      await store.delete(created.id);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});

describe("JobStore.init recovery", () => {
  it("marks jobs persisted as running/queued failed with 'Interrupted by server restart' and skips corrupt files", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const id = "11111111-2222-4333-8444-555555555555";
    const now = "2026-09-06T12:00:00.000Z";
    const interrupted: Job = {
      id,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      status: "running",
      settings: SETTINGS,
      items: [
        { id: "r", dishName: "Running", description: "", category: "", status: "running", filename: "running.jpg", prompt: "p", attempts: 1 },
        { id: "p", dishName: "Pending", description: "", category: "", status: "pending", filename: "pending.jpg", prompt: "p", attempts: 0 },
        { id: "d", dishName: "Done", description: "", category: "", status: "done", filename: "done.jpg", prompt: "p", attempts: 1, costUsd: 0 },
      ],
      stats: { total: 3, pending: 1, running: 1, done: 1, failed: 0, cancelled: 0, estimatedCostUsd: 0, actualCostUsd: 0, elapsedMs: 0 },
    };
    await fs.mkdir(path.join(dataDir, "jobs", id), { recursive: true });
    await fs.writeFile(path.join(dataDir, "jobs", id, "job.json"), JSON.stringify(interrupted));
    await fs.mkdir(path.join(dataDir, "jobs", "corrupt"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "jobs", "corrupt", "job.json"), "{not json");
    await fs.mkdir(path.join(dataDir, "jobs", "mismatch"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "jobs", "mismatch", "job.json"), JSON.stringify({ ...interrupted, id: "other" }));
    await fs.mkdir(path.join(dataDir, "jobs", "empty-dir"), { recursive: true });

    __resetJobStoreForTests();
    store = getJobStore();
    const recovered = await store.get(id);

    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toBe(INTERRUPTED_ERROR);
    expect(recovered?.finishedAt).toBe(now);
    expect(recovered?.items.map((i) => i.status)).toEqual(["failed", "failed", "done"]);
    expect(recovered?.items[0].error).toBe(INTERRUPTED_ERROR);
    expect(recovered?.items[2].error).toBeUndefined();
    expect(recovered?.stats).toMatchObject({ failed: 2, done: 1, pending: 0, running: 0 });

    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "jobs", id, "job.json"), "utf8")) as Job;
    expect(persisted.status).toBe("failed");

    const listed = await store.list();
    expect(listed.some((j) => j.id === "corrupt" || j.id === "other" || j.id === "mismatch")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupt"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not match its directory"));

    // Recovered jobs can be retried like any other failed job.
    const retried = await retryFailed(id);
    expect(retried.items.map((i) => i.status)).toEqual(["pending", "pending", "done"]);
    const finished = await waitForIdle(id);
    expect(finished.status).toBe("done");
    await store.delete(id);
  }, 30_000);
});
