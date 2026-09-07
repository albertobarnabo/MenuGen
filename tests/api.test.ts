import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MODELS, PROVIDER_META } from "@/lib/models";
import type { ApiError, GenerationSettings, Job, JobItem, JobStatus, JobSummary, ModelsResponse } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Environment — must be in place before any route module is evaluated, which
// is why every route is imported dynamically below.
// ─────────────────────────────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "menugen-"));
process.env.MENUGEN_DATA_DIR = dataDir;
process.env.MENUGEN_ENABLE_MOCK = "true";
process.env.MENUGEN_MAX_ITEMS_PER_JOB = "10";
delete process.env.MENUGEN_DEFAULT_MODEL;
for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "BFL_API_KEY"]) {
  delete process.env[key];
}

const api = {
  models: await import("@/app/api/models/route"),
  jobs: await import("@/app/api/jobs/route"),
  job: await import("@/app/api/jobs/[jobId]/route"),
  cancel: await import("@/app/api/jobs/[jobId]/cancel/route"),
  retryFailed: await import("@/app/api/jobs/[jobId]/retry-failed/route"),
  events: await import("@/app/api/jobs/[jobId]/events/route"),
  download: await import("@/app/api/jobs/[jobId]/download/route"),
  image: await import("@/app/api/jobs/[jobId]/images/[itemId]/route"),
  regenerate: await import("@/app/api/jobs/[jobId]/items/[itemId]/regenerate/route"),
};
const store = await import("@/lib/jobs/store");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = "http://localhost";
const MOCK_MODEL_ID = "mock/sample";

/** Any real (key-requiring) model; every real key is removed above, so it is never configured here. */
const realModel = MODELS.find((model) => model.provider !== "mock");
if (!realModel) throw new Error("Test fixture: registry has no real provider model");
const REAL_MODEL_ID = realModel.id;
const REAL_MODEL_ENV_VAR = PROVIDER_META[realModel.provider].envVar;
const TERMINAL: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled"]);
const JOB_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;

const mockSettings: GenerationSettings = {
  modelId: MOCK_MODEL_ID,
  size: "1024x1024",
  format: "jpeg",
  stylePresetId: "editorial",
  concurrency: 3,
  maxRetries: 1,
};

function request(pathname: string, init?: RequestInit): Request {
  return new Request(`${BASE_URL}${pathname}`, init);
}

function jsonRequest(pathname: string, method: string, body: unknown): Request {
  return request(pathname, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Mimics the `context` Next.js hands to a dynamic Route Handler. */
function ctx<Params extends Record<string, string>>(params: Params): { params: Promise<Params> } {
  return { params: Promise.resolve(params) };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function menuItems(dishNames: string[]) {
  return dishNames.map((dishName, index) => ({ id: `item-${index + 1}`, dishName, description: "", category: "" }));
}

async function createJob(
  dishNames: string[],
  settings: Partial<GenerationSettings> = {},
  sourceFilename?: string,
): Promise<Job> {
  const body = { items: menuItems(dishNames), settings: { ...mockSettings, ...settings }, sourceFilename };
  const response = await api.jobs.POST(jsonRequest("/api/jobs", "POST", body), {});
  expect(response.status).toBe(202);
  return (await readJson<{ job: Job }>(response)).job;
}

async function getJob(jobId: string): Promise<Job> {
  const response = await api.job.GET(request(`/api/jobs/${jobId}`), ctx({ jobId }));
  expect(response.status).toBe(200);
  return (await readJson<{ job: Job }>(response)).job;
}

function isSettled(job: Job): boolean {
  return TERMINAL.has(job.status) && job.items.every((item) => item.status !== "pending" && item.status !== "running");
}

/** Poll `GET /api/jobs/:id` until `until(job)` holds (default: terminal with no in-flight items). */
async function waitForJob(jobId: string, until: (job: Job) => boolean = isSettled): Promise<Job> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  for (;;) {
    const job = await getJob(jobId);
    if (until(job)) return job;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for job ${jobId} (status ${job.status})`);
    }
    await sleep(100);
  }
}

function findItem(job: Job, itemId: string): JobItem {
  const item = job.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Item ${itemId} missing from job ${job.id}`);
  return item;
}

/** Read SSE chunks until `text` satisfies `until`, or fail after `timeoutMs`. */
async function readSseUntil(
  response: Response,
  until: (text: string) => boolean,
  timeoutMs = JOB_TIMEOUT_MS,
): Promise<{ text: string; firstChunk: string }> {
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let firstChunk: string | undefined;
  try {
    const deadline = Date.now() + timeoutMs;
    while (!until(text)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out reading SSE stream; received so far:\n${text}`);
      const timeout = sleep(remaining).then(() => "timeout" as const);
      const result = await Promise.race([reader.read(), timeout]);
      if (result === "timeout") throw new Error(`Timed out reading SSE stream; received so far:\n${text}`);
      if (result.done) throw new Error(`SSE stream closed unexpectedly; received:\n${text}`);
      const chunk = decoder.decode(result.value, { stream: true });
      firstChunk ??= chunk;
      text += chunk;
    }
  } finally {
    await reader.cancel();
  }
  return { text, firstChunk: firstChunk ?? "" };
}

/** Parse every `event:`/`data:` block in an SSE transcript. */
function parseSseEvents(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: "))
    .map((block) => {
      const lines = block.split("\n");
      const event = lines[0].slice("event: ".length);
      const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

afterAll(async () => {
  await store.__resetJobStoreForTests();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/models
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/models", () => {
  it("lists the mock model and sane defaults when no real provider is configured", async () => {
    const response = await api.models.GET(request("/api/models"), {});
    expect(response.status).toBe(200);
    const body = await readJson<ModelsResponse>(response);

    const modelIds = body.models.map((model) => model.id);
    expect(modelIds).toContain(MOCK_MODEL_ID);
    expect(modelIds).toEqual(MODELS.map((model) => model.id));

    const byId = Object.fromEntries(body.providers.map((provider) => [provider.id, provider]));
    expect(byId.mock?.configured).toBe(true);
    expect(byId.openai?.configured).toBe(false);
    expect(byId.google?.configured).toBe(false);
    expect(byId.bfl?.configured).toBe(false);
    expect(byId.openai?.envVar).toBe("OPENAI_API_KEY");

    expect(body.defaults).toEqual({
      modelId: MOCK_MODEL_ID,
      size: "1024x1024",
      format: "jpeg",
      stylePresetId: "editorial",
      concurrency: 3,
      maxRetries: 3,
    });
    expect(body.maxItemsPerJob).toBe(10);
    expect(body.stylePresets.map((preset) => preset.id)).toEqual([
      "editorial",
      "delivery-clean",
      "rustic-dark",
      "bright-minimal",
      "custom",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path: create → poll → image → download → events → regenerate → delete
// ─────────────────────────────────────────────────────────────────────────────

describe("a mock job from creation to deletion", () => {
  let created: Job;
  let job: Job;
  let burger: JobItem;

  beforeAll(async () => {
    created = await createJob(["Beef Burger", "Tiramisu"], {}, "menu.csv");
    job = await waitForJob(created.id);
    burger = findItem(job, "item-1");
  }, TEST_TIMEOUT_MS);

  it("POST /api/jobs answers 202 with prompts, filenames and a queued/running job", () => {
    expect(["queued", "running"]).toContain(created.status);
    expect(created.sourceFilename).toBe("menu.csv");
    expect(created.settings.modelId).toBe(MOCK_MODEL_ID);
    expect(created.items.map((item) => item.filename)).toEqual(["beef_burger.jpg", "tiramisu.jpg"]);
    expect(created.items[0].prompt).toContain("Beef Burger");
    expect(created.items[1].prompt).toContain("Tiramisu");
    expect(created.stats.total).toBe(2);
  });

  it("reaches status done with every item generated", () => {
    expect(job.status).toBe("done");
    expect(job.finishedAt).toBeDefined();
    for (const item of job.items) {
      expect(item.status).toBe("done");
      expect(item.attempts).toBeGreaterThanOrEqual(1);
      expect(item.imageUrl).toBe(`/api/jobs/${job.id}/images/${item.id}?v=${item.attempts}`);
      expect(item.costUsd).toBe(0);
      expect(item.error).toBeUndefined();
    }
    expect(job.stats).toMatchObject({ total: 2, done: 2, failed: 0, pending: 0, running: 0, cancelled: 0 });
  });

  it("GET /api/jobs lists it newest first and honours ?limit", async () => {
    const all = await api.jobs.GET(request("/api/jobs"), {});
    expect(all.status).toBe(200);
    const { jobs } = await readJson<{ jobs: JobSummary[] }>(all);
    const summary = jobs.find((candidate) => candidate.id === job.id);
    expect(summary).toMatchObject({ id: job.id, status: "done", modelId: MOCK_MODEL_ID, sourceFilename: "menu.csv" });
    expect(summary?.stats.done).toBe(2);

    const limited = await api.jobs.GET(request("/api/jobs?limit=1"), {});
    expect((await readJson<{ jobs: JobSummary[] }>(limited)).jobs).toHaveLength(1);
  });

  it("GET image serves JPEG bytes with a strong ETag and long-lived private caching", async () => {
    const response = await api.image.GET(
      request(`/api/jobs/${job.id}/images/${burger.id}`),
      ctx({ jobId: job.id, itemId: burger.id }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBe(`"${burger.id}-${burger.attempts}"`);
    expect(response.headers.get("content-disposition")).toBe('inline; filename="beef_burger.jpg"');

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(1000);
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  });

  it("GET image answers 304 to a matching If-None-Match", async () => {
    const etag = `"${burger.id}-${burger.attempts}"`;
    const response = await api.image.GET(
      request(`/api/jobs/${job.id}/images/${burger.id}`, { headers: { "if-none-match": etag } }),
      ctx({ jobId: job.id, itemId: burger.id }),
    );
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
    expect(await response.text()).toBe("");
  });

  it("GET image answers 404 for an unknown item", async () => {
    const response = await api.image.GET(
      request(`/api/jobs/${job.id}/images/nope`),
      ctx({ jobId: job.id, itemId: "nope" }),
    );
    expect(response.status).toBe(404);
    expect((await readJson<ApiError>(response)).code).toBe("not_found");
  });

  it("GET download streams a ZIP containing every image plus manifest.csv", async () => {
    const response = await api.download.GET(request(`/api/jobs/${job.id}/download`), ctx({ jobId: job.id }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="menugen_menu_${job.id.slice(0, 8)}.zip"`,
    );

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    const listing = bytes.toString("latin1");
    expect(listing).toContain("beef_burger.jpg");
    expect(listing).toContain("tiramisu.jpg");
    expect(listing).toContain("manifest.csv");
  });

  it("GET events sends snapshot first, then end, for an already-finished job", async () => {
    const response = await api.events.GET(request(`/api/jobs/${job.id}/events`), ctx({ jobId: job.id }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const { text, firstChunk } = await readSseUntil(response, (received) => received.includes("event: end"), 5_000);
    expect(firstChunk.startsWith("event: snapshot\n")).toBe(true);

    const events = parseSseEvents(text);
    expect(events.map((event) => event.event)).toEqual(["snapshot", "end"]);
    expect(events[0].data.type).toBe("snapshot");
    expect((events[0].data.job as Job).id).toBe(job.id);
    expect(events[1].data).toEqual({ type: "end", jobId: job.id, status: "done" });
  });

  it(
    "POST regenerate answers 202, refuses a second concurrent request, then regenerates with the edits",
    async () => {
      const tiramisu = findItem(job, "item-2");
      const before = tiramisu.attempts;

      const response = await api.regenerate.POST(
        jsonRequest(`/api/jobs/${job.id}/items/${tiramisu.id}/regenerate`, "POST", { dishName: "Margherita Pizza" }),
        ctx({ jobId: job.id, itemId: tiramisu.id }),
      );
      expect(response.status).toBe(202);
      const { item } = await readJson<{ item: JobItem }>(response);
      expect(item.id).toBe(tiramisu.id);
      expect(["pending", "running"]).toContain(item.status);
      expect(item.dishName).toBe("Margherita Pizza");
      expect(item.prompt).toContain("Margherita Pizza");

      const again = await api.regenerate.POST(
        request(`/api/jobs/${job.id}/items/${tiramisu.id}/regenerate`, { method: "POST" }),
        ctx({ jobId: job.id, itemId: tiramisu.id }),
      );
      expect(again.status).toBe(409);
      expect((await readJson<ApiError>(again)).code).toBe("conflict");

      job = await waitForJob(job.id);
      expect(job.status).toBe("done");
      const regenerated = findItem(job, tiramisu.id);
      expect(regenerated.status).toBe("done");
      expect(regenerated.dishName).toBe("Margherita Pizza");
      expect(regenerated.attempts).toBeGreaterThan(before);
      expect(regenerated.imageUrl).toBe(`/api/jobs/${job.id}/images/${regenerated.id}?v=${regenerated.attempts}`);

      const image = await api.image.GET(
        request(`/api/jobs/${job.id}/images/${regenerated.id}`),
        ctx({ jobId: job.id, itemId: regenerated.id }),
      );
      expect(image.status).toBe(200);
      expect(image.headers.get("etag")).toBe(`"${regenerated.id}-${regenerated.attempts}"`);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "POST regenerate accepts an empty body",
    async () => {
      const response = await api.regenerate.POST(
        request(`/api/jobs/${job.id}/items/${burger.id}/regenerate`, { method: "POST" }),
        ctx({ jobId: job.id, itemId: burger.id }),
      );
      expect(response.status).toBe(202);
      job = await waitForJob(job.id);
      expect(findItem(job, burger.id).status).toBe("done");
    },
    TEST_TIMEOUT_MS,
  );

  it("POST regenerate answers 404 for an unknown item", async () => {
    const response = await api.regenerate.POST(
      request(`/api/jobs/${job.id}/items/nope/regenerate`, { method: "POST" }),
      ctx({ jobId: job.id, itemId: "nope" }),
    );
    expect(response.status).toBe(404);
  });

  it("POST regenerate answers 400 for an invalid body", async () => {
    const response = await api.regenerate.POST(
      jsonRequest(`/api/jobs/${job.id}/items/${burger.id}/regenerate`, "POST", { dishName: "" }),
      ctx({ jobId: job.id, itemId: burger.id }),
    );
    expect(response.status).toBe(400);
    expect((await readJson<ApiError>(response)).code).toBe("validation_error");
  });

  it("POST cancel on a finished job is a no-op", async () => {
    const response = await api.cancel.POST(request(`/api/jobs/${job.id}/cancel`, { method: "POST" }), ctx({ jobId: job.id }));
    expect(response.status).toBe(200);
    expect((await readJson<{ job: Job }>(response)).job.status).toBe("done");
  });

  it("DELETE removes the job and its files", async () => {
    const response = await api.job.DELETE(request(`/api/jobs/${job.id}`, { method: "DELETE" }), ctx({ jobId: job.id }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    const gone = await api.job.GET(request(`/api/jobs/${job.id}`), ctx({ jobId: job.id }));
    expect(gone.status).toBe(404);
    expect(fs.existsSync(path.join(dataDir, "jobs", job.id))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Running jobs: live events, cancel, retry-failed
// ─────────────────────────────────────────────────────────────────────────────

describe("a running mock job", () => {
  it(
    "GET events forwards item events live and ends when the job finishes",
    async () => {
      const created = await createJob(["Chicken Caesar Salad", "Pad Thai"], { concurrency: 1 });
      const response = await api.events.GET(request(`/api/jobs/${created.id}/events`), ctx({ jobId: created.id }));
      expect(response.status).toBe(200);

      const { text, firstChunk } = await readSseUntil(response, (received) => received.includes("event: end"));
      expect(firstChunk.startsWith("event: snapshot\n")).toBe(true);
      const events = parseSseEvents(text);
      expect(events[0].event).toBe("snapshot");
      expect(events.filter((event) => event.event === "item").length).toBeGreaterThanOrEqual(2);
      expect(events.at(-1)).toEqual({ event: "end", data: { type: "end", jobId: created.id, status: "done" } });

      await waitForJob(created.id);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "POST retry-failed answers 409 while running; POST cancel stops it; retry-failed then re-queues everything",
    async () => {
      const created = await createJob(["Salmon Poke Bowl", "Chocolate Lava Cake", "Pad Thai", "Tiramisu"], {
        concurrency: 1,
      });

      const busy = await api.retryFailed.POST(
        request(`/api/jobs/${created.id}/retry-failed`, { method: "POST" }),
        ctx({ jobId: created.id }),
      );
      expect(busy.status).toBe(409);
      expect((await readJson<ApiError>(busy)).code).toBe("conflict");

      const cancelled = await api.cancel.POST(
        request(`/api/jobs/${created.id}/cancel`, { method: "POST" }),
        ctx({ jobId: created.id }),
      );
      expect(cancelled.status).toBe(200);
      const afterCancel = await waitForJob(created.id);
      expect(afterCancel.status).toBe("cancelled");
      expect(afterCancel.items.every((item) => item.status === "cancelled")).toBe(true);
      expect(afterCancel.stats.cancelled).toBe(4);

      const retried = await api.retryFailed.POST(
        request(`/api/jobs/${created.id}/retry-failed`, { method: "POST" }),
        ctx({ jobId: created.id }),
      );
      expect(retried.status).toBe(202);
      const { job: requeued } = await readJson<{ job: Job }>(retried);
      expect(["queued", "running"]).toContain(requeued.status);
      expect(requeued.items.every((item) => item.status === "pending" || item.status === "running")).toBe(true);

      const finished = await waitForJob(created.id);
      expect(finished.status).toBe("done");
      expect(finished.stats).toMatchObject({ done: 4, cancelled: 0, failed: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "marks the job failed when an item fails for good, while the ZIP still contains the successes",
    async () => {
      const created = await createJob(["[fatal] Mystery Soup", "Tiramisu"], { maxRetries: 0 });
      const job = await waitForJob(created.id);
      expect(job.status).toBe("failed");

      const failed = findItem(job, "item-1");
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/fatal/i);
      expect(failed.imageUrl).toBeUndefined();
      expect(findItem(job, "item-2").status).toBe("done");
      expect(job.stats).toMatchObject({ done: 1, failed: 1 });

      const image = await api.image.GET(
        request(`/api/jobs/${job.id}/images/${failed.id}`),
        ctx({ jobId: job.id, itemId: failed.id }),
      );
      expect(image.status).toBe(404);

      const download = await api.download.GET(request(`/api/jobs/${job.id}/download`), ctx({ jobId: job.id }));
      expect(download.status).toBe(200);
      const listing = Buffer.from(await download.arrayBuffer()).toString("latin1");
      expect(listing).toContain("tiramisu.jpg");
      expect(listing).not.toContain("fatal_mystery_soup.jpg");

      const retried = await api.retryFailed.POST(
        request(`/api/jobs/${job.id}/retry-failed`, { method: "POST" }),
        ctx({ jobId: job.id }),
      );
      expect(retried.status).toBe(202);
      const { job: requeued } = await readJson<{ job: Job }>(retried);
      expect(["pending", "running"]).toContain(findItem(requeued, failed.id).status);
      expect(findItem(requeued, "item-2").status).toBe("done");
      expect((await waitForJob(job.id)).status).toBe("failed");
    },
    TEST_TIMEOUT_MS,
  );

  it("GET download answers 404 while nothing has been generated yet", async () => {
    const created = await createJob(["[fatal] Nothing"], { maxRetries: 0 });
    const job = await waitForJob(created.id);
    expect(job.status).toBe("failed");
    const response = await api.download.GET(request(`/api/jobs/${job.id}/download`), ctx({ jobId: job.id }));
    expect(response.status).toBe(404);
  }, TEST_TIMEOUT_MS);
});

// ─────────────────────────────────────────────────────────────────────────────
// Error responses
// ─────────────────────────────────────────────────────────────────────────────

describe("error responses", () => {
  const missing = "does-not-exist";

  it("answer 404 with code not_found for an unknown job on every job route", async () => {
    const responses = await Promise.all([
      api.job.GET(request(`/api/jobs/${missing}`), ctx({ jobId: missing })),
      api.job.DELETE(request(`/api/jobs/${missing}`, { method: "DELETE" }), ctx({ jobId: missing })),
      api.cancel.POST(request(`/api/jobs/${missing}/cancel`, { method: "POST" }), ctx({ jobId: missing })),
      api.retryFailed.POST(request(`/api/jobs/${missing}/retry-failed`, { method: "POST" }), ctx({ jobId: missing })),
      api.events.GET(request(`/api/jobs/${missing}/events`), ctx({ jobId: missing })),
      api.download.GET(request(`/api/jobs/${missing}/download`), ctx({ jobId: missing })),
      api.image.GET(request(`/api/jobs/${missing}/images/x`), ctx({ jobId: missing, itemId: "x" })),
      api.regenerate.POST(
        request(`/api/jobs/${missing}/items/x/regenerate`, { method: "POST" }),
        ctx({ jobId: missing, itemId: "x" }),
      ),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
      const body = await readJson<ApiError>(response);
      expect(body.code).toBe("not_found");
      expect(body.error).toContain(missing);
    }
  });

  it("POST /api/jobs answers 400 for malformed JSON", async () => {
    const response = await api.jobs.POST(
      request("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }),
      {},
    );
    expect(response.status).toBe(400);
    expect((await readJson<ApiError>(response)).code).toBe("invalid_json");
  });

  it("POST /api/jobs answers 400 for an empty body", async () => {
    const response = await api.jobs.POST(request("/api/jobs", { method: "POST" }), {});
    expect(response.status).toBe(400);
    expect((await readJson<ApiError>(response)).code).toBe("empty_body");
  });

  it("POST /api/jobs answers 400 validation_error with per-field issues", async () => {
    const body = { items: [{ id: "a", dishName: "" }], settings: { ...mockSettings, concurrency: 99 } };
    const response = await api.jobs.POST(jsonRequest("/api/jobs", "POST", body), {});
    expect(response.status).toBe(400);
    const error = await readJson<ApiError & { details: { issues: Array<{ path: string }> } }>(response);
    expect(error.code).toBe("validation_error");
    expect(error.details.issues.map((issue) => issue.path)).toEqual(["items.0.dishName", "settings.concurrency"]);
  });

  it("POST /api/jobs enforces MENUGEN_MAX_ITEMS_PER_JOB", async () => {
    const names = Array.from({ length: 11 }, (_, index) => `Dish ${index + 1}`);
    const response = await api.jobs.POST(
      jsonRequest("/api/jobs", "POST", { items: menuItems(names), settings: mockSettings }),
      {},
    );
    expect(response.status).toBe(400);
    expect((await readJson<ApiError>(response)).error).toContain("at most 10 items");
  });

  it("POST /api/jobs answers 422 provider_not_configured for a model whose key is missing", async () => {
    const body = {
      items: menuItems(["Tiramisu"]),
      settings: { ...mockSettings, modelId: REAL_MODEL_ID, size: realModel.defaultSize },
    };
    const response = await api.jobs.POST(jsonRequest("/api/jobs", "POST", body), {});
    expect(response.status).toBe(422);
    const error = await readJson<ApiError>(response);
    expect(error.code).toBe("provider_not_configured");
    expect(error.error).toContain(REAL_MODEL_ENV_VAR);
    expect(error.details).toEqual({ provider: realModel.provider, envVar: REAL_MODEL_ENV_VAR });
  });

  it("GET /api/jobs answers 400 for a non-positive or non-numeric limit", async () => {
    for (const limit of ["0", "abc", "-3", "1.5"]) {
      const response = await api.jobs.GET(request(`/api/jobs?limit=${limit}`), {});
      expect(response.status).toBe(400);
      expect((await readJson<ApiError>(response)).code).toBe("validation_error");
    }
  });
});
