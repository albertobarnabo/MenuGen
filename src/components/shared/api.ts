import type {
  ApiError,
  CreateJobRequest,
  Job,
  JobItem,
  JobSummary,
  ModelsResponse,
  RegenerateItemRequest,
} from "@/lib/types";

/** Error thrown for non-2xx API responses; carries the server's `ApiError` fields. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, body: Partial<ApiError> | undefined, fallback: string) {
    super(body?.error?.trim() || fallback);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = body?.code ?? "unknown_error";
    this.details = body?.details;
  }
}

/** Human-readable fallback for a failed request without a JSON body. */
function fallbackMessage(status: number): string {
  if (status === 404) return "Not found";
  if (status === 409) return "The batch is busy; try again in a moment";
  if (status >= 500) return "The server hit an unexpected error. Check the terminal running MenuGen.";
  return `Request failed (${status})`;
}

async function readErrorBody(response: Response): Promise<Partial<ApiError> | undefined> {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === "object" ? (parsed as Partial<ApiError>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `fetch` wrapper for the MenuGen API: JSON in / JSON out, throws
 * {@link ApiRequestError} with the server message on non-2xx, and resolves
 * `undefined` for `204`.
 */
export async function apiFetch<T>(input: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiRequestError(0, undefined, "Could not reach the MenuGen server. Is it still running?");
  }
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorBody(response), fallbackMessage(response.status));
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** `GET /api/models`. */
export function getModels(signal?: AbortSignal): Promise<ModelsResponse> {
  return apiFetch<ModelsResponse>("/api/models", { signal });
}

/** `GET /api/jobs?limit=n` — newest first. */
export function listJobs(limit = 20, signal?: AbortSignal): Promise<{ jobs: JobSummary[] }> {
  return apiFetch<{ jobs: JobSummary[] }>(`/api/jobs?limit=${encodeURIComponent(String(limit))}`, { signal });
}

/** `POST /api/jobs` — starts generation immediately (202). */
export function createJob(request: CreateJobRequest): Promise<{ job: Job }> {
  return apiFetch<{ job: Job }>("/api/jobs", { method: "POST", body: JSON.stringify(request) });
}

/** `GET /api/jobs/:id`. */
export function getJob(jobId: string, signal?: AbortSignal): Promise<{ job: Job }> {
  return apiFetch<{ job: Job }>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
}

/** `DELETE /api/jobs/:id` — cancels if running, deletes files. */
export function deleteJob(jobId: string): Promise<void> {
  return apiFetch<void>(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
}

/** `POST /api/jobs/:id/cancel`. */
export function cancelJob(jobId: string): Promise<{ job: Job }> {
  return apiFetch<{ job: Job }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
}

/** `POST /api/jobs/:id/retry-failed` — re-queues failed and cancelled items (202). */
export function retryFailed(jobId: string): Promise<{ job: Job }> {
  return apiFetch<{ job: Job }>(`/api/jobs/${encodeURIComponent(jobId)}/retry-failed`, { method: "POST" });
}

/** `POST /api/jobs/:id/items/:itemId/regenerate` — body optional (202). */
export function regenerateItem(jobId: string, itemId: string, body?: RegenerateItemRequest): Promise<{ item: JobItem }> {
  return apiFetch<{ item: JobItem }>(
    `/api/jobs/${encodeURIComponent(jobId)}/items/${encodeURIComponent(itemId)}/regenerate`,
    { method: "POST", body: body ? JSON.stringify(body) : undefined },
  );
}

/** URL of the streamed ZIP for a job. */
export function jobDownloadUrl(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/download`;
}

/** URL of the SSE stream for a job. */
export function jobEventsUrl(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/events`;
}
