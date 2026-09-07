import type { ImageFormat, ImageSize, ModelSpec, ProviderId, ProviderInfo } from "./types";

/**
 * Model registry.
 *
 * Prices are USD per generated image at the listed default quality and at
 * 1024×1024, taken from each vendor's public pricing page on 2026-09-06 (see
 * `docsUrl` and `priceNotes`). Keep this file free of Node-only imports: the
 * browser uses it to render the model picker.
 *
 * Deliberately absent (deprecated or shut down as of September 2026):
 * `gpt-image-1*`, `chatgpt-image-latest`, `dall-e-*`, `gemini-2.5-flash-image`,
 * every `*-preview` Gemini id, `imagen-4.0-*`, `flux-pro-1.1*`, `flux-dev` and
 * the Kontext models.
 */

/** Static per-provider metadata (everything in `ProviderInfo` except `configured`). */
export const PROVIDER_META: Record<
  ProviderId,
  Omit<ProviderInfo, "configured"> & { typicalLatencySeconds: number }
> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    keysUrl: "https://platform.openai.com/api-keys",
    typicalLatencySeconds: 30,
  },
  google: {
    id: "google",
    name: "Google Gemini API",
    envVar: "GEMINI_API_KEY",
    keysUrl: "https://aistudio.google.com/apikey",
    typicalLatencySeconds: 8,
  },
  bfl: {
    id: "bfl",
    name: "Black Forest Labs",
    envVar: "BFL_API_KEY",
    keysUrl: "https://dashboard.bfl.ai",
    typicalLatencySeconds: 8,
  },
  mock: {
    id: "mock",
    name: "Mock (no API key)",
    envVar: "",
    keysUrl: "",
    typicalLatencySeconds: 1,
  },
};

const SQUARE: ImageSize = "1024x1024";

/** FLUX.2 accepts any width/height ≥ 64; these all stay ≤ 1 MP so the first-megapixel price applies. */
const BFL_SIZES: ImageSize[] = ["1024x1024", "1152x896", "896x1152", "1344x768", "768x1344"];
const BFL_FORMATS: ImageFormat[] = ["jpeg", "png", "webp"];
const BFL_CAVEATS = "Prepaid credits at dashboard.bfl.ai";

/**
 * Gemini image models take an aspect ratio, not pixel dimensions. The adapter
 * maps each size to the closest supported ratio (1:1, 4:3, 3:4, 3:2, 2:3,
 * 16:9, 9:16) at the 1K tier and the job runner crops to the exact size.
 */
const GEMINI_SIZES: ImageSize[] = [
  "1024x1024",
  "1152x864",
  "864x1152",
  "1248x832",
  "832x1248",
  "1344x768",
  "768x1344",
];
const GEMINI_CAVEATS = "Billing must be enabled (no free tier); output carries an invisible SynthID watermark";

/**
 * NOTE FOR MAINTAINERS: entries below are verified against vendor docs at the
 * date in `releasedAt`/`docsUrl`. When a vendor changes prices, update here.
 */
export const MODELS: ModelSpec[] = [
  // ── Black Forest Labs ─────────────────────────────────────────────────────
  {
    id: "bfl/flux-2-pro",
    provider: "bfl",
    providerModel: "flux-2-pro",
    displayName: "FLUX.2 [pro]",
    description:
      "Production-grade photorealism, explicitly strong for food and product shots. The best price/quality balance for menus.",
    pricePerImageUsd: 0.03,
    priceNotes: "per image up to 1 MP; +$0.015 per extra MP",
    sizes: BFL_SIZES,
    defaultSize: SQUARE,
    nativeFormats: BFL_FORMATS,
    tags: ["recommended"],
    docsUrl: "https://docs.bfl.ai/api-reference/models/generate-or-edit-an-image-with-flux2-%5Bpro%5D",
    releasedAt: "2025-11-25",
    caveats: BFL_CAVEATS,
    typicalLatencySeconds: 10,
  },
  {
    id: "bfl/flux-2-klein-9b",
    provider: "bfl",
    providerModel: "flux-2-klein-9b",
    displayName: "FLUX.2 [klein] 9B",
    description:
      "Distilled 4-step model: sub-second generation and the cheapest option that still yields usable menu tiles.",
    pricePerImageUsd: 0.015,
    priceNotes: "per image up to 1 MP; +$0.002 per extra MP",
    sizes: BFL_SIZES,
    defaultSize: SQUARE,
    nativeFormats: BFL_FORMATS,
    tags: ["cheapest", "fast"],
    docsUrl: "https://docs.bfl.ai/api-reference/models/generate-or-edit-an-image-with-flux2-%5Bklein%5D-9b",
    releasedAt: "2026-01-15",
    caveats: BFL_CAVEATS,
    typicalLatencySeconds: 3,
  },
  {
    id: "bfl/flux-2-max",
    provider: "bfl",
    providerModel: "flux-2-max",
    displayName: "FLUX.2 [max]",
    description:
      "Black Forest Labs' highest-quality tier for hero shots: strongest prompt following and world knowledge.",
    pricePerImageUsd: 0.07,
    priceNotes: "per image up to 1 MP; +$0.03 per extra MP",
    sizes: BFL_SIZES,
    defaultSize: SQUARE,
    nativeFormats: BFL_FORMATS,
    tags: [],
    docsUrl: "https://docs.bfl.ai/api-reference/models/generate-or-edit-an-image-with-flux2-%5Bmax%5D",
    releasedAt: "2025-12-16",
    caveats: BFL_CAVEATS,
    typicalLatencySeconds: 15,
  },

  // ── OpenAI ────────────────────────────────────────────────────────────────
  {
    id: "openai/gpt-image-2",
    provider: "openai",
    providerModel: "gpt-image-2",
    displayName: "GPT Image 2",
    description:
      "OpenAI's state-of-the-art image model. Reasons before it draws; the best fine detail at high quality.",
    pricePerImageUsd: 0.032,
    priceNotes:
      "token-billed estimate at 1024×1024; landscape/portrait ≈ 1.5×; actual cost is read from the API response",
    qualityOptions: [
      { id: "low", label: "Low", pricePerImageUsd: 0.008 },
      { id: "medium", label: "Medium", pricePerImageUsd: 0.032 },
      { id: "high", label: "High", pricePerImageUsd: 0.125 },
    ],
    defaultQuality: "medium",
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    defaultSize: SQUARE,
    nativeFormats: ["png", "jpeg", "webp"],
    tags: ["best-quality"],
    docsUrl: "https://developers.openai.com/api/docs/models/gpt-image-2",
    releasedAt: "2026-04-21",
    caveats:
      "Requires OpenAI organisation verification (403 until verified); Tier 1 keys are limited to 5 images/min",
    typicalLatencySeconds: 30,
  },

  // ── Google ────────────────────────────────────────────────────────────────
  {
    id: "google/gemini-3.1-flash-lite-image",
    provider: "google",
    providerModel: "gemini-3.1-flash-lite-image",
    displayName: "Gemini 3.1 Flash Lite Image (Nano Banana 2 Lite)",
    description:
      "Google's fastest and cheapest image model (~4 s). Good photorealism at 1K for single-dish shots.",
    pricePerImageUsd: 0.0336,
    priceNotes: "per 1K image (1120 output tokens × $30/1M)",
    sizes: GEMINI_SIZES,
    defaultSize: SQUARE,
    nativeFormats: ["png"],
    tags: ["fast"],
    docsUrl: "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image",
    releasedAt: "2026-06-30",
    caveats: GEMINI_CAVEATS,
    typicalLatencySeconds: 6,
  },
  {
    id: "google/gemini-3.1-flash-image",
    provider: "google",
    providerModel: "gemini-3.1-flash-image",
    displayName: "Gemini 3.1 Flash Image (Nano Banana 2)",
    description:
      "Nano Banana 2, Google's quality tier: strong photorealism and world knowledge, reliable compositions.",
    pricePerImageUsd: 0.067,
    priceNotes: "per 1K image (1120 output tokens × $60/1M)",
    sizes: GEMINI_SIZES,
    defaultSize: SQUARE,
    nativeFormats: ["png"],
    tags: [],
    docsUrl: "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image",
    releasedAt: "2026-05-28",
    caveats: GEMINI_CAVEATS,
    typicalLatencySeconds: 10,
  },

  // ── Mock ──────────────────────────────────────────────────────────────────
  {
    id: "mock/sample",
    provider: "mock",
    providerModel: "sample",
    displayName: "Mock (sample photos)",
    description: "Free. Returns bundled sample photos instantly. For trying the UI and for tests.",
    pricePerImageUsd: 0,
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    defaultSize: SQUARE,
    nativeFormats: ["jpeg"],
    tags: ["dev-only"],
    docsUrl: "",
    typicalLatencySeconds: 1,
  },
];

/** Registry default: the best price/quality option for photorealistic food. */
export const DEFAULT_MODEL_ID = "bfl/flux-2-pro";

/** Look up a model by its MenuGen id (`<provider>/<slug>`). */
export function getModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Like {@link getModel} but throws a descriptive error for unknown ids. */
export function requireModel(id: string): ModelSpec {
  const model = getModel(id);
  if (!model) throw new Error(`Unknown model "${id}"`);
  return model;
}

/** Every registry entry served by `provider`, in registry order. */
export function modelsForProvider(provider: ProviderId): ModelSpec[] {
  return MODELS.filter((m) => m.provider === provider);
}

/** Price per image for the given quality (falls back to the model default). */
export function priceForQuality(model: ModelSpec, quality?: string): number {
  if (model.qualityOptions?.length) {
    const q = model.qualityOptions.find((o) => o.id === (quality ?? model.defaultQuality));
    if (q) return q.pricePerImageUsd;
  }
  return model.pricePerImageUsd;
}

/** Split `"1024x768"` into `{ width: 1024, height: 768 }`. */
export function parseSize(size: ImageSize): { width: number; height: number } {
  const [w, h] = size.split("x").map((n) => Number.parseInt(n, 10));
  return { width: w, height: h };
}

/** True for well-formed `<width>x<height>` strings (does not check model support). */
export function isValidSize(value: string): value is ImageSize {
  return /^\d{2,5}x\d{2,5}$/.test(value);
}

/** True when the vendor can return `size` directly for `model`. */
export function modelSupportsSize(model: ModelSpec, size: string): size is ImageSize {
  return model.sizes.includes(size as ImageSize);
}

/**
 * Registry sorted by default price ascending (stable for ties, so registry
 * order breaks them); the mock model always comes last.
 */
export function sortedModels(models: readonly ModelSpec[] = MODELS): ModelSpec[] {
  return [...models].sort((a, b) => {
    if (a.provider === "mock" || b.provider === "mock") {
      return Number(a.provider === "mock") - Number(b.provider === "mock");
    }
    return a.pricePerImageUsd - b.pricePerImageUsd;
  });
}
