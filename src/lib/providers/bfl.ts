import type { GenerateImageRequest, GenerateImageResult, ImageFormat, ImageProvider, ModelSpec } from "../types";
import { sleep } from "../concurrency";
import { env } from "../env";
import { ProviderError, ProviderNotConfiguredError } from "../errors";
import { PROVIDER_META, parseSize, priceForQuality } from "../models";
import { downloadBytes, fetchJson, isRecord, mimeTypeForFormat } from "./http";

/**
 * Black Forest Labs adapter — async submit + poll.
 *
 * `POST /v1/<model>` returns `{ id, polling_url, cost }`; the task is polled at
 * `polling_url` (never a hard-coded `get_result` host — tasks live on a specific
 * cluster) until `status === "Ready"`, then the signed `result.sample` URL is
 * downloaded immediately (it expires after ~10 minutes).
 */

export const BFL_SUBMIT_TIMEOUT_MS = 60_000;
export const BFL_POLL_INTERVAL_MS = 750;
/** Give up on a task that is still not `Ready` after this long. */
export const BFL_POLL_TIMEOUT_MS = 180_000;
export const BFL_POLL_REQUEST_TIMEOUT_MS = 30_000;
export const BFL_DOWNLOAD_TIMEOUT_MS = 60_000;
/** 0 (strictest) … 5 (most permissive) on FLUX.2 endpoints. */
export const BFL_SAFETY_TOLERANCE = 2;
/** 1 credit = $0.01. */
export const BFL_CREDITS_PER_USD = 100;
export const BFL_DASHBOARD_URL = "https://dashboard.bfl.ai";

/** Terminal task states other than `Ready`. `Failed` is undocumented but used by BFL's own samples. */
const MODERATED_STATUSES = new Set(["Request Moderated", "Content Moderated"]);
const FAILED_STATUSES = new Set(["Error", "Failed"]);
const NOT_FOUND_STATUS = "Task not found";

export interface BflRequestBody {
  prompt: string;
  width: number;
  height: number;
  output_format: ImageFormat;
  safety_tolerance: number;
}

export interface BflProviderOptions {
  /** Delay between polls (default {@link BFL_POLL_INTERVAL_MS}). */
  pollIntervalMs?: number;
  /** Overall polling budget (default {@link BFL_POLL_TIMEOUT_MS}). */
  pollTimeoutMs?: number;
}

interface SubmittedTask {
  id: string;
  pollingUrl: string;
  cost?: number;
  inputMp?: number;
  outputMp?: number;
}

interface ReadyTask {
  sample: string;
  attempts: number;
  result: Record<string, unknown>;
}

/** `${BFL_BASE_URL}/v1/<providerModel>`. */
export function bflSubmitUrl(providerModel: string, baseUrl: string = env.bflBaseUrl): string {
  return `${baseUrl}/v1/${encodeURIComponent(providerModel)}`;
}

/** Request body for one text-to-image task at the exact requested pixel size. */
export function buildBflRequestBody(request: GenerateImageRequest): BflRequestBody {
  const { width, height } = parseSize(request.size);
  return {
    prompt: request.prompt,
    width,
    height,
    output_format: request.format,
    safety_tolerance: BFL_SAFETY_TOLERANCE,
  };
}

/** Credits reported by the API (1 credit = $0.01) → USD; falls back to the registry price. */
export function bflCostUsd(model: ModelSpec, quality: string | undefined, cost: unknown): number {
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
    return Math.round((cost / BFL_CREDITS_PER_USD) * 1_000_000) / 1_000_000;
  }
  return priceForQuality(model, quality);
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function badResponse(message: string, payload: unknown): ProviderError {
  return new ProviderError(`Black Forest Labs ${message}`, {
    provider: "bfl",
    code: "bad_response",
    retryable: false,
    details: JSON.stringify(payload).slice(0, 500),
  });
}

/** 402 means the prepaid credit balance is exhausted; make the fix obvious and never retry. */
function mapBflError(error: unknown): unknown {
  if (!(error instanceof ProviderError) || error.status !== 402) return error;
  return new ProviderError(`${error.message} — insufficient credits; top up at ${BFL_DASHBOARD_URL}`, {
    provider: "bfl",
    status: 402,
    code: "billing",
    retryable: false,
    details: error.details,
    cause: error,
  });
}

function readSubmitted(payload: unknown): SubmittedTask {
  if (!isRecord(payload) || typeof payload.id !== "string" || !payload.id) {
    throw badResponse("submit response has no task id", payload);
  }
  if (typeof payload.polling_url !== "string" || !payload.polling_url) {
    throw badResponse("submit response has no polling_url", payload);
  }
  return {
    id: payload.id,
    pollingUrl: payload.polling_url,
    cost: numberField(payload, "cost"),
    inputMp: numberField(payload, "input_mp"),
    outputMp: numberField(payload, "output_mp"),
  };
}

function detailsText(payload: Record<string, unknown>): string {
  const details = payload.details;
  if (details === undefined || details === null) return "";
  if (typeof details === "string") return details;
  if (isRecord(details) && Array.isArray(details["Moderation Reasons"])) {
    return details["Moderation Reasons"].map(String).join(", ");
  }
  return JSON.stringify(details).slice(0, 300);
}

function failureError(status: string, payload: Record<string, unknown>): ProviderError {
  const details = detailsText(payload);
  const suffix = details ? `: ${details}` : "";
  if (MODERATED_STATUSES.has(status)) {
    return new ProviderError(`Black Forest Labs moderated the request (${status})${suffix}`, {
      provider: "bfl",
      code: "content_policy",
      retryable: false,
      details: payload.details,
    });
  }
  if (status === NOT_FOUND_STATUS) {
    return new ProviderError("Black Forest Labs lost the generation task (Task not found)", {
      provider: "bfl",
      code: "not_found",
      retryable: false,
      details: payload,
    });
  }
  return new ProviderError(`Black Forest Labs generation failed (${status})${suffix}`, {
    provider: "bfl",
    code: "generation_failed",
    retryable: true,
    details: payload.details ?? payload,
  });
}

function timeoutError(lastStatus: string, budgetMs: number): ProviderError {
  return new ProviderError(
    `Black Forest Labs generation did not finish within ${Math.round(budgetMs / 1000)} s (last status: ${lastStatus})`,
    { provider: "bfl", code: "timeout", retryable: true },
  );
}

/**
 * Poll `pollingUrl` until the task is `Ready`. Transient poll failures
 * (429/5xx/timeouts) keep polling within the budget so a paid generation is
 * not abandoned; terminal statuses and non-retryable HTTP errors throw.
 */
async function pollUntilReady(
  pollingUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  options: Required<BflProviderOptions>,
): Promise<ReadyTask> {
  const deadline = Date.now() + options.pollTimeoutMs;
  let lastStatus = "Pending";
  let delay = options.pollIntervalMs;
  for (let attempts = 1; ; attempts += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError(lastStatus, options.pollTimeoutMs);
    await sleep(Math.min(delay, remaining), signal);
    delay = options.pollIntervalMs;

    let payload: unknown;
    try {
      payload = await fetchJson(
        pollingUrl,
        { method: "GET", headers },
        { provider: "bfl", timeoutMs: BFL_POLL_REQUEST_TIMEOUT_MS, signal },
      );
    } catch (error) {
      if (error instanceof ProviderError && error.retryable) {
        delay = Math.max(options.pollIntervalMs, error.retryAfterMs ?? 0);
        continue;
      }
      throw mapBflError(error);
    }

    if (!isRecord(payload) || typeof payload.status !== "string") throw badResponse("poll response has no status", payload);
    const status = payload.status;
    if (status === "Ready") {
      const result = isRecord(payload.result) ? payload.result : {};
      if (typeof result.sample !== "string" || !result.sample) throw badResponse("task is Ready but result.sample is missing", payload);
      return { sample: result.sample, attempts, result };
    }
    if (MODERATED_STATUSES.has(status) || FAILED_STATUSES.has(status) || status === NOT_FOUND_STATUS) {
      throw failureError(status, payload);
    }
    lastStatus = status;
  }
}

/** Build a BFL provider; `options` exist so tests can shrink the polling budget. */
export function createBflProvider(options: BflProviderOptions = {}): ImageProvider {
  const polling: Required<BflProviderOptions> = {
    pollIntervalMs: options.pollIntervalMs ?? BFL_POLL_INTERVAL_MS,
    pollTimeoutMs: options.pollTimeoutMs ?? BFL_POLL_TIMEOUT_MS,
  };

  return {
    id: "bfl",
    isConfigured(): boolean {
      return Boolean(env.bflApiKey);
    },
    async generate(model: ModelSpec, request: GenerateImageRequest): Promise<GenerateImageResult> {
      if (!this.isConfigured()) throw new ProviderNotConfiguredError("bfl", PROVIDER_META.bfl.envVar);

      const headers = { "x-key": env.bflApiKey, "Content-Type": "application/json", Accept: "application/json" };
      const body = buildBflRequestBody(request);
      let submitPayload: unknown;
      try {
        submitPayload = await fetchJson(
          bflSubmitUrl(model.providerModel),
          { method: "POST", headers, body: JSON.stringify(body) },
          { provider: "bfl", timeoutMs: BFL_SUBMIT_TIMEOUT_MS, signal: request.signal },
        );
      } catch (error) {
        throw mapBflError(error);
      }
      const task = readSubmitted(submitPayload);

      const ready = await pollUntilReady(task.pollingUrl, { "x-key": headers["x-key"], Accept: "application/json" }, request.signal, polling);
      // Signed delivery URL: no API key header.
      const download = await downloadBytes(ready.sample, {
        provider: "bfl",
        timeoutMs: BFL_DOWNLOAD_TIMEOUT_MS,
        signal: request.signal,
      });

      return {
        bytes: download.bytes,
        mimeType: mimeTypeForFormat(request.format),
        width: body.width,
        height: body.height,
        costUsd: bflCostUsd(model, request.quality, task.cost),
        providerMeta: {
          id: task.id,
          cost: task.cost,
          status: "Ready",
          inputMp: task.inputMp,
          outputMp: task.outputMp,
          seed: ready.result.seed,
          pollAttempts: ready.attempts,
          contentType: download.contentType,
        },
      };
    },
  };
}

export const bflProvider: ImageProvider = createBflProvider();
