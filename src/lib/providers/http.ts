import { Buffer } from "node:buffer";
import type { ImageFormat, ProviderId } from "../types";
import { throwIfAborted } from "../concurrency";
import { ProviderError, codeForStatus, errorMessage, isRetryableStatus, parseRetryAfter } from "../errors";
import { PROVIDER_META } from "../models";

/**
 * Shared `fetch` helpers for the provider adapters.
 *
 * Every vendor call goes through {@link fetchJson} or {@link downloadBytes} so
 * timeouts, cancellation and error mapping behave identically across
 * providers. Nothing here ever logs request headers (they carry API keys).
 */

/** Per-request timeout applied when the caller passes none. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Maximum characters of a vendor response body kept in `ProviderError.details`. */
export const MAX_DETAILS_CHARS = 500;
/** A non-JSON body longer than this is not used as the error message. */
const MAX_INLINE_MESSAGE_CHARS = 200;
/** Keys, in priority order, under which vendors nest their error text. */
const MESSAGE_KEYS = ["error", "detail", "message", "msg"] as const;
const MAX_MESSAGE_DEPTH = 4;

export interface HttpOptions {
  provider: ProviderId;
  /** Abort the request after this many milliseconds (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Caller's cancellation signal; merged with the timeout via `AbortSignal.any`. */
  signal?: AbortSignal;
}

export interface DownloadOptions extends HttpOptions {
  /** Extra request headers (omit for signed URLs — they must not receive the API key). */
  headers?: Record<string, string>;
}

export interface DownloadedBytes {
  bytes: Uint8Array;
  /** `Content-Type` as sent by the server, if any. */
  contentType?: string;
}

/** Human-readable vendor name used as the prefix of every error message. */
export function providerLabel(provider: ProviderId): string {
  return PROVIDER_META[provider].name;
}

/** Narrow an unknown JSON value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow an unknown value to one of the supported output formats. */
export function isImageFormat(value: unknown): value is ImageFormat {
  return value === "jpeg" || value === "png" || value === "webp";
}

/** `"jpeg"` → `"image/jpeg"`. */
export function mimeTypeForFormat(format: ImageFormat): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

/**
 * Decode a base64 (or `data:` URL) payload into bytes. Throws when the input
 * decodes to nothing, which is what a vendor returning an empty string looks like.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const payload = base64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  const bytes = new Uint8Array(Buffer.from(payload, "base64"));
  if (bytes.byteLength === 0) throw new TypeError("Base64 image payload is empty or invalid");
  return bytes;
}

/** Depth-first search for the human-readable message inside a vendor error payload. */
function extractMessage(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_MESSAGE_DEPTH) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const parts = value.map((entry) => extractMessage(entry, depth + 1)).filter((p): p is string => Boolean(p));
    return parts.length ? parts.join("; ") : undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of MESSAGE_KEYS) {
    if (key in value) {
      const found = extractMessage(value[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Best-effort vendor error text: OpenAI `{error:{message}}`, Google
 * `{error:{message,status}}`, BFL `{detail}` / FastAPI `{detail:[{msg}]}`,
 * then a short plain-text body, then the HTTP status text.
 */
export function vendorMessage(body: string, statusText: string, status: number): string {
  const trimmed = body.trim();
  if (trimmed) {
    try {
      const found = extractMessage(JSON.parse(trimmed));
      if (found) return found;
    } catch {
      /* not JSON */
    }
    if (trimmed.length <= MAX_INLINE_MESSAGE_CHARS && !trimmed.startsWith("<")) return trimmed;
  }
  return statusText.trim() || `HTTP ${status}`;
}

/** Map a non-2xx vendor response to a `ProviderError` (status, code, Retry-After, truncated body). */
export function errorFromResponse(response: Response, body: string, provider: ProviderId): ProviderError {
  const status = response.status;
  return new ProviderError(`${providerLabel(provider)} ${status}: ${vendorMessage(body, response.statusText, status)}`, {
    provider,
    status,
    code: codeForStatus(status),
    retryable: isRetryableStatus(status),
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    details: body.slice(0, MAX_DETAILS_CHARS),
  });
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

function causeSuffix(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error && cause.message ? ` (${cause.message})` : "";
}

/**
 * `fetch` with a timeout merged into the caller's signal. A caller abort
 * rethrows the AbortError untouched; a timeout or network failure becomes a
 * retryable `ProviderError` (`timeout` / `network`).
 */
async function fetchWithTimeout(url: string, init: RequestInit, options: HttpOptions): Promise<Response> {
  const { provider, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  throwIfAborted(signal);
  const timeout = AbortSignal.timeout(timeoutMs);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal: merged });
  } catch (error) {
    throwIfAborted(signal);
    if (timeout.aborted) {
      throw new ProviderError(`${providerLabel(provider)} request timed out after ${formatSeconds(timeoutMs)}`, {
        provider,
        code: "timeout",
        retryable: true,
        cause: error,
      });
    }
    throw new ProviderError(`${providerLabel(provider)} request failed: ${errorMessage(error)}${causeSuffix(error)}`, {
      provider,
      code: "network",
      retryable: true,
      cause: error,
    });
  }
}

async function readText(response: Response, options: HttpOptions): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throwIfAborted(options.signal);
    throw new ProviderError(`${providerLabel(options.provider)} response could not be read: ${errorMessage(error)}`, {
      provider: options.provider,
      status: response.status,
      code: "network",
      retryable: true,
      cause: error,
    });
  }
}

function parseJson<T>(body: string, status: number, provider: ProviderId): T {
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new ProviderError(`${providerLabel(provider)} returned a non-JSON response (HTTP ${status})`, {
      provider,
      status,
      code: "bad_response",
      retryable: false,
      details: body.slice(0, MAX_DETAILS_CHARS),
      cause: error,
    });
  }
}

/**
 * Perform a request and parse the JSON body.
 *
 * - Non-2xx → `ProviderError` with `status`, `code` (via `codeForStatus`),
 *   `retryable` (via `isRetryableStatus`), `retryAfterMs` (from `Retry-After`),
 *   `details` (first 500 chars of the body) and a message like
 *   `"OpenAI 429: Rate limit reached"`.
 * - Timeout / network failure → retryable `ProviderError` (`timeout` / `network`).
 * - Caller abort → the AbortError is rethrown so the job runner can cancel cleanly.
 *
 * The caller narrows `T`; nothing is validated here beyond "is JSON".
 */
export async function fetchJson<T = unknown>(url: string, init: RequestInit, options: HttpOptions): Promise<T> {
  const response = await fetchWithTimeout(url, init, options);
  const body = await readText(response, options);
  if (!response.ok) throw errorFromResponse(response, body, options.provider);
  return parseJson<T>(body, response.status, options.provider);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown host";
  }
}

/**
 * Download a binary file (e.g. a vendor's signed result URL). Applies the same
 * timeout / abort / error mapping as {@link fetchJson}. Pass no `headers` for
 * signed URLs so the API key never leaves the vendor's API host.
 */
export async function downloadBytes(url: string, options: DownloadOptions): Promise<DownloadedBytes> {
  const { provider } = options;
  const response = await fetchWithTimeout(url, { method: "GET", headers: options.headers }, options);
  if (!response.ok) throw errorFromResponse(response, await readText(response, options), provider);

  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (error) {
    throwIfAborted(options.signal);
    throw new ProviderError(`${providerLabel(provider)} download from ${hostOf(url)} failed: ${errorMessage(error)}`, {
      provider,
      status: response.status,
      code: "network",
      retryable: true,
      cause: error,
    });
  }
  if (buffer.byteLength === 0) {
    throw new ProviderError(`${providerLabel(provider)} download from ${hostOf(url)} returned an empty file`, {
      provider,
      status: response.status,
      code: "bad_response",
      retryable: true,
    });
  }
  return { bytes: new Uint8Array(buffer), contentType: response.headers.get("content-type") ?? undefined };
}
