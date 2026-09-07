import { z } from "zod";
import type { ApiError, Job, JobItem } from "./types";
import { ConflictError, NotFoundError, ProviderNotConfiguredError, ValidationError } from "./errors";
import { getJobStore, type JobStore } from "./jobs/store";

/**
 * Helpers shared by every Route Handler under `src/app/api`.
 *
 * Server-only: pulls in the job store. Do not import from client components.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Errors & responses
// ─────────────────────────────────────────────────────────────────────────────

/** An error that already knows which HTTP status and code it maps to. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Build an `ApiError` JSON response. */
export function jsonError(status: number, code: string, message: string, details?: unknown): Response {
  const body: ApiError = details === undefined ? { error: message, code } : { error: message, code, details };
  return Response.json(body, { status });
}

/** JSON response with an explicit status (defaults to 200). */
export function json<T>(data: T, status = 200): Response {
  return Response.json(data, { status });
}

/** Map a thrown value to the `ApiError` response the spec prescribes. */
function responseForError(error: unknown, request: Request): Response {
  if (error instanceof Response) return error;
  if (error instanceof HttpError) return jsonError(error.status, error.code, error.message, error.details);
  if (error instanceof ValidationError) return jsonError(400, "validation_error", error.message, error.details);
  if (error instanceof z.ZodError) {
    return jsonError(400, "validation_error", "Invalid request", z.flattenError(error));
  }
  if (error instanceof NotFoundError) return jsonError(404, "not_found", error.message);
  if (error instanceof ConflictError) return jsonError(409, "conflict", error.message);
  if (error instanceof ProviderNotConfiguredError) {
    return jsonError(422, "provider_not_configured", error.message, {
      provider: error.provider,
      envVar: error.envVar,
    });
  }
  console.error(`[api] ${request.method} ${new URL(request.url).pathname} failed:`, error);
  return jsonError(500, "internal_error", "Internal server error");
}

export type RouteHandler<Ctx> = (request: Request, ctx: Ctx) => Promise<Response> | Response;

/**
 * Wrap a Route Handler so that thrown domain errors become `ApiError`
 * responses (400/404/409/422) and anything else becomes a 500 without leaking
 * stack traces to the client.
 */
export function handleRoute<Ctx = unknown>(fn: RouteHandler<Ctx>): (request: Request, ctx: Ctx) => Promise<Response> {
  return async (request, ctx) => {
    try {
      return await fn(request, ctx);
    } catch (error) {
      return responseForError(error, request);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Request parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read and parse a JSON body. Throws an `HttpError` (400 `invalid_json`) when
 * the body is not valid JSON and (400 `empty_body`) when it is missing.
 */
export async function readJson(request: Request): Promise<unknown> {
  const body = await readOptionalJson(request);
  if (body === undefined) throw new HttpError(400, "empty_body", "Request body is required");
  return body;
}

/** Like `readJson` but resolves to `undefined` for an empty body. */
export async function readOptionalJson(request: Request): Promise<unknown> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new HttpError(400, "invalid_body", "Request body could not be read");
  }
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

/**
 * Parse a positive-integer query parameter, clamped to `max`.
 * Throws a 400 `validation_error` when present but not a positive integer.
 */
export function readIntQuery(request: Request, name: string, fallback: number, max: number): number {
  const raw = new URL(request.url).searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpError(400, "validation_error", `Query parameter "${name}" must be a positive integer`);
  }
  return Math.min(value, max);
}

// ─────────────────────────────────────────────────────────────────────────────
// Job lookups
// ─────────────────────────────────────────────────────────────────────────────

/** The process-wide job store, initialised (loads persisted jobs on first use). */
export async function getReadyJobStore(): Promise<JobStore> {
  const store = getJobStore();
  await store.init();
  return store;
}

/** Load a job or throw `NotFoundError` (→ 404). */
export async function requireJob(jobId: string): Promise<Job> {
  const store = await getReadyJobStore();
  const job = await store.get(jobId);
  if (!job) throw new NotFoundError(`Job "${jobId}" not found`);
  return job;
}

/** Find an item inside a job or throw `NotFoundError` (→ 404). */
export function requireJobItem(job: Job, itemId: string): JobItem {
  const item = job.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new NotFoundError(`Item "${itemId}" not found in job "${job.id}"`);
  return item;
}

/** Quote a value for a `Content-Disposition` filename parameter. */
export function contentDispositionFilename(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `filename="${ascii}"`;
}
