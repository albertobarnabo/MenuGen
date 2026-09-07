import type { ModelSpec } from "./types";
import { PROVIDER_META, priceForQuality } from "./models";

/** Lowest concurrency accepted by the job runner (mirrors the API validation limits). */
export const MIN_CONCURRENCY = 1;
/** Highest concurrency accepted by the job runner (mirrors the API validation limits). */
export const MAX_CONCURRENCY = 8;

/** Round to 4 decimals to keep sub-cent prices exact (e.g. 3 × 0.011 → 0.033, not 0.033000000000000005). */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Non-negative integer count; anything unusable (NaN, negative) counts as 0. */
function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

/** Clamp a requested concurrency into the supported range; unusable values fall back to 1. */
export function clampConcurrency(concurrency: number): number {
  if (!Number.isFinite(concurrency)) return MIN_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(concurrency)));
}

/**
 * Cost estimate for generating `count` images with `model` at `quality`
 * (falls back to the model's default quality / base price).
 */
export function estimateJobCost(
  model: ModelSpec,
  count: number,
  quality?: string,
): { perImageUsd: number; totalUsd: number } {
  const perImageUsd = round4(priceForQuality(model, quality));
  return { perImageUsd, totalUsd: round4(perImageUsd * safeCount(count)) };
}

/**
 * Seconds one image typically takes on `model`: the model-level
 * `typicalLatencySeconds` when it is a positive finite number, otherwise the
 * provider default from `PROVIDER_META`.
 */
export function typicalLatencyFor(model: ModelSpec): number {
  const override = model.typicalLatencySeconds;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  return PROVIDER_META[model.provider].typicalLatencySeconds;
}

/**
 * Rough wall-clock estimate: `ceil(count / concurrency)` sequential waves, each
 * taking {@link typicalLatencyFor} seconds. Concurrency is clamped to the
 * supported range; zero items → 0.
 */
export function estimateDurationSeconds(model: ModelSpec, count: number, concurrency: number): number {
  const n = safeCount(count);
  if (n === 0) return 0;
  const waves = Math.ceil(n / clampConcurrency(concurrency));
  return waves * typicalLatencyFor(model);
}

/** `1234567.89` → `1,234,567.89` (locale-independent). */
function withThousandsSeparators(fixed: string): string {
  const [whole, fraction] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** `$0.011` under $1 (3 decimals), otherwise `$1.20`. Zero → `Free`. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "Free";
  if (usd < 1) {
    const three = usd.toFixed(3);
    // 0.9995 rounds up to "1.000" — fall through to the two-decimal form instead.
    if (Number(three) < 1) return `$${three}`;
  }
  return `$${withThousandsSeparators(usd.toFixed(2))}`;
}

/** `45 s`, `~2 min`, `~1 h 05 min`. */
export function formatDuration(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  if (s < 60) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `~${hours} h ${String(rest).padStart(2, "0")} min`;
}
