import type { ProviderId } from "./types";

export interface ProviderErrorOptions {
  provider: ProviderId;
  /** HTTP status from the vendor, if any. */
  status?: number;
  /** Whether the job runner should retry this call. */
  retryable?: boolean;
  /** Vendor-suggested wait before retrying (from `Retry-After` or the body). */
  retryAfterMs?: number;
  /** Machine-readable code, e.g. `rate_limited`, `content_policy`, `auth`. */
  code?: string;
  /** Raw vendor payload (truncated) for debugging. */
  details?: unknown;
  cause?: unknown;
}

/** Any failure talking to an image provider. */
export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? (options.status ? isRetryableStatus(options.status) : true);
    this.retryAfterMs = options.retryAfterMs;
    this.code = options.code ?? (options.status ? codeForStatus(options.status) : "provider_error");
    this.details = options.details;
  }
}

export class ValidationError extends Error {
  readonly details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message = "Conflict") {
    super(message);
    this.name = "ConflictError";
  }
}

export class ProviderNotConfiguredError extends Error {
  readonly provider: ProviderId;
  readonly envVar: string;
  constructor(provider: ProviderId, envVar: string) {
    super(`Provider "${provider}" is not configured. Set ${envVar} in your environment (.env).`);
    this.name = "ProviderNotConfiguredError";
    this.provider = provider;
    this.envVar = envVar;
  }
}

/** Transient HTTP statuses worth retrying with back-off. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function codeForStatus(status: number): string {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "bad_request";
  if (status >= 500) return "server_error";
  return "provider_error";
}

/** Parse a `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Best-effort human message from any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")
  );
}
