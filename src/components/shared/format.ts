import type { ImageFormat, ImageSize } from "@/lib/types";
import { parseSize } from "@/lib/models";

/** "8 dishes", "1 dish". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const relativeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "just now", "2 minutes ago", "yesterday". Falls back to the raw string for invalid dates. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const seconds = Math.round((time - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return relativeFormatter.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relativeFormatter.format(Math.round(seconds / 3600), "hour");
  if (abs < 86_400 * 30) return relativeFormatter.format(Math.round(seconds / 86_400), "day");
  return new Date(time).toLocaleDateString();
}

/** Absolute timestamp for tooltips, e.g. "6 Sep 2026, 16:42". */
export function formatDateTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Milliseconds → "0.8 s", "4.2 s", "1:05". */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** Seconds → "0:42", "12:05", "1:02:09" for the live elapsed timer. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(rest).padStart(2, "0")}`;
}

interface AspectPreset {
  label: string;
  ratio: number;
}

const LANDSCAPE_PRESETS: AspectPreset[] = [
  { label: "5:4", ratio: 5 / 4 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "3:2", ratio: 3 / 2 },
  { label: "16:10", ratio: 16 / 10 },
  { label: "16:9", ratio: 16 / 9 },
  { label: "2:1", ratio: 2 },
  { label: "21:9", ratio: 21 / 9 },
];

/** Closest well-known aspect label for a width/height ratio (≥ 1). */
function nearestAspect(ratio: number): string {
  let best = LANDSCAPE_PRESETS[0];
  for (const preset of LANDSCAPE_PRESETS) {
    if (Math.abs(preset.ratio - ratio) < Math.abs(best.ratio - ratio)) best = preset;
  }
  return best.label;
}

/** "1024 × 1024 · square", "1344 × 768 · landscape 16:9", "768 × 1344 · portrait 9:16". */
export function formatSizeLabel(size: ImageSize): string {
  const { width, height } = parseSize(size);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return size;
  const dims = `${width} × ${height}`;
  if (width === height) return `${dims} · square`;
  if (width > height) return `${dims} · landscape ${nearestAspect(width / height)}`;
  const [a, b] = nearestAspect(height / width).split(":");
  return `${dims} · portrait ${b}:${a}`;
}

const FORMAT_LABELS: Record<ImageFormat, string> = { jpeg: "JPEG", png: "PNG", webp: "WebP" };

/** "jpeg" → "JPEG". */
export function formatImageFormat(format: ImageFormat): string {
  return FORMAT_LABELS[format];
}

/** Trigger a browser download of `content` as `filename`. */
export function downloadBlob(content: BlobPart, filename: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copy text to the clipboard; resolves false when the Clipboard API is unavailable or denied. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
