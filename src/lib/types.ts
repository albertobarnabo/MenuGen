/**
 * Shared domain types for MenuGen.
 *
 * This file is the contract between the generation library (`src/lib`), the
 * HTTP API (`src/app/api`), the web UI (`src/components`) and the CLI
 * (`src/cli`). It must stay free of Node-only or browser-only imports so it can
 * be imported from anywhere.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Providers & models
// ─────────────────────────────────────────────────────────────────────────────

/** First-party image APIs we call directly. `mock` is for development/tests. */
export type ProviderId = "openai" | "google" | "bfl" | "mock";

export type ImageFormat = "jpeg" | "png" | "webp";

/** `"<width>x<height>"`, e.g. `"1024x1024"`. */
export type ImageSize = `${number}x${number}`;

export type ModelTag =
  | "recommended"
  | "cheapest"
  | "best-quality"
  | "fast"
  | "preview"
  | "dev-only";

export interface QualityOption {
  /** Value sent to the provider (e.g. OpenAI `quality: "medium"`). */
  id: string;
  label: string;
  pricePerImageUsd: number;
}

export interface ModelSpec {
  /** Stable MenuGen id: `<provider>/<slug>` e.g. `openai/gpt-image-1-mini`. */
  id: string;
  provider: ProviderId;
  /** Exact model id / endpoint slug sent to the vendor. */
  providerModel: string;
  displayName: string;
  /** One line, user-facing. */
  description: string;
  /** Price per generated image (USD) at the default quality/size. */
  pricePerImageUsd: number;
  /** Optional caveat shown next to the price, e.g. "at 1024×1024, medium quality". */
  priceNotes?: string;
  /** Present only for models with a quality knob. */
  qualityOptions?: QualityOption[];
  defaultQuality?: string;
  /** Output sizes the vendor can return directly. */
  sizes: ImageSize[];
  defaultSize: ImageSize;
  /** Formats the vendor can return without conversion. */
  nativeFormats: ImageFormat[];
  tags: ModelTag[];
  docsUrl: string;
  /** ISO date the model was released, for the UI "new" hint. */
  releasedAt?: string;
  /**
   * Important caveats shown in the UI/CLI next to the model, e.g. "Requires
   * OpenAI organisation verification" or "No free tier".
   */
  caveats?: string;
  /** Typical seconds per image, used for duration estimates (falls back to the provider default). */
  typicalLatencySeconds?: number;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** Environment variable that must hold the API key. */
  envVar: string;
  /** Whether the key is present on the server (never the key itself). */
  configured: boolean;
  /** Where to obtain a key. */
  keysUrl: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu input
// ─────────────────────────────────────────────────────────────────────────────

export interface MenuItem {
  /** Client-generated stable id (uuid). */
  id: string;
  dishName: string;
  description: string;
  category: string;
}

export interface ParseWarning {
  /** 1-based row number in the source file (header excluded). */
  row: number;
  message: string;
}

export interface ParseResult {
  items: MenuItem[];
  /** Column names found in the source, lower-cased. */
  columns: string[];
  /** Rows skipped because dish_name was empty, plus other soft issues. */
  warnings: ParseWarning[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompting
// ─────────────────────────────────────────────────────────────────────────────

export interface StylePreset {
  id: string;
  name: string;
  /** Short user-facing description. */
  description: string;
  /**
   * Template with placeholders `{subject}`, `{dish_name}`, `{description}`,
   * `{category}`. `{subject}` is the pre-joined "dish, description, category dish".
   */
  template: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation settings & jobs
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerationSettings {
  modelId: string;
  /** Provider quality id; only meaningful when the model has `qualityOptions`. */
  quality?: string;
  size: ImageSize;
  /** Format written into the ZIP; converted server-side if not native. */
  format: ImageFormat;
  stylePresetId: string;
  /**
   * When `stylePresetId === "custom"`, this is the full template. Otherwise an
   * optional extra sentence appended to the preset prompt.
   */
  customPrompt?: string;
  /** Parallel requests to the provider (1–8). */
  concurrency: number;
  /** Retries per item on retryable errors (0–5). */
  maxRetries: number;
}

export type ItemStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface JobItem extends MenuItem {
  status: ItemStatus;
  /** Final file name inside the ZIP, unique within the job, e.g. `beef_burger.jpg`. */
  filename: string;
  /** Exact prompt sent to the provider. */
  prompt: string;
  attempts: number;
  error?: string;
  /** ISO timestamp of the successful generation. */
  generatedAt?: string;
  durationMs?: number;
  /**
   * URL (relative) to fetch the generated image from the API, set once
   * `status === "done"`. Includes a cache-busting version query.
   */
  imageUrl?: string;
  /** Cost actually charged for this item (successful attempt only). */
  costUsd?: number;
}

export type JobStatus = "queued" | "running" | "done" | "cancelled" | "failed";

export interface JobStats {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  /** Milliseconds spent so far (or total when finished). */
  elapsedMs: number;
}

export interface Job {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** When generation started / finished (ISO). */
  startedAt?: string;
  finishedAt?: string;
  status: JobStatus;
  settings: GenerationSettings;
  /** Original upload name, for display and the ZIP name. */
  sourceFilename?: string;
  items: JobItem[];
  stats: JobStats;
  /** Job-level error, e.g. provider not configured. */
  error?: string;
}

/** Light-weight job listing entry. */
export interface JobSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  modelId: string;
  sourceFilename?: string;
  stats: JobStats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server-sent events (GET /api/jobs/:id/events)
// ─────────────────────────────────────────────────────────────────────────────

export type JobEvent =
  /** Always the first event; full job state. */
  | { type: "snapshot"; job: Job }
  /** One item changed (status/attempts/error/imageUrl). */
  | { type: "item"; jobId: string; item: JobItem; stats: JobStats }
  /** Job-level status change. */
  | { type: "job"; jobId: string; status: JobStatus; stats: JobStats; error?: string }
  /** Human-readable log line for the live log panel. */
  | {
      type: "log";
      jobId: string;
      level: "info" | "warn" | "error";
      message: string;
      itemId?: string;
      at: string;
    }
  /** Job reached a terminal state. The stream stays open for later regenerate/retry events. */
  | { type: "end"; jobId: string; status: JobStatus };

// ─────────────────────────────────────────────────────────────────────────────
// Provider adapter contract (server-only implementations in src/lib/providers)
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateImageRequest {
  prompt: string;
  size: ImageSize;
  quality?: string;
  /** Preferred output format; adapters may return another native format. */
  format: ImageFormat;
  signal?: AbortSignal;
}

export interface GenerateImageResult {
  bytes: Uint8Array;
  /** e.g. `image/png`. */
  mimeType: string;
  width?: number;
  height?: number;
  /** Cost the provider charged for this call, if computable. */
  costUsd?: number;
  /** Anything useful for debugging (request id, revised prompt, seed …). */
  providerMeta?: Record<string, unknown>;
}

export interface ImageProvider {
  id: ProviderId;
  /** True when the API key (or other requirement) is present. */
  isConfigured(): boolean;
  generate(model: ModelSpec, request: GenerateImageRequest): Promise<GenerateImageResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// API payloads
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelsResponse {
  models: ModelSpec[];
  providers: ProviderInfo[];
  stylePresets: StylePreset[];
  defaults: Pick<GenerationSettings, "modelId" | "size" | "format" | "stylePresetId" | "concurrency" | "maxRetries">;
  /** Hard limit on items per job enforced by the server. */
  maxItemsPerJob: number;
}

export interface CreateJobRequest {
  items: MenuItem[];
  settings: GenerationSettings;
  sourceFilename?: string;
}

export interface RegenerateItemRequest {
  /** Optional edits applied before regenerating. */
  dishName?: string;
  description?: string;
  category?: string;
  /** If set, used verbatim instead of the built prompt. */
  promptOverride?: string;
}

export interface ApiError {
  error: string;
  /** Machine-readable code, e.g. `provider_not_configured`, `validation_error`, `not_found`. */
  code: string;
  details?: unknown;
}
