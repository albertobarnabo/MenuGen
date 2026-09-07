import type { GenerationSettings, ImageFormat, ModelSpec, ModelTag, ModelsResponse, ProviderInfo } from "@/lib/types";
import { CUSTOM_STYLE_PRESET_ID } from "@/lib/prompt";

/** localStorage key for the persisted generation settings. */
export const SETTINGS_STORAGE_KEY = "menugen.settings.v1";

/**
 * Settings as persisted in localStorage. The custom template and the extra
 * instructions are kept separately so switching presets never loses text;
 * `customPrompt` is derived from them (see {@link toGenerationSettings}).
 */
export interface StoredSettings extends Partial<Omit<GenerationSettings, "customPrompt">> {
  customTemplate?: string;
  extraInstructions?: string;
}

/** Fully resolved settings used by the compose view. */
export interface ResolvedSettings extends Omit<GenerationSettings, "customPrompt"> {
  customTemplate: string;
  extraInstructions: string;
}

/** Human labels for model tags. */
export const TAG_LABELS: Record<ModelTag, string> = {
  recommended: "Recommended",
  cheapest: "Cheapest",
  "best-quality": "Best quality",
  fast: "Fast",
  preview: "Preview",
  "dev-only": "Mock",
};

const IMAGE_FORMATS: readonly ImageFormat[] = ["jpeg", "png", "webp"];

/** Concurrency and retry ranges (mirror the API validation limits). */
export const CONCURRENCY_RANGE = { min: 1, max: 8 } as const;
export const RETRIES_RANGE = { min: 0, max: 5 } as const;

function isImageFormat(value: unknown): value is ImageFormat {
  return typeof value === "string" && (IMAGE_FORMATS as readonly string[]).includes(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** True when the model can be used right now (its provider has a key, or it is the mock). */
export function isModelUsable(model: ModelSpec, providersById: ReadonlyMap<string, ProviderInfo>): boolean {
  if (model.provider === "mock") return true;
  return providersById.get(model.provider)?.configured === true;
}

/** Default quality id for a model, or undefined when it has no quality knob. */
export function defaultQualityFor(model: ModelSpec): string | undefined {
  const options = model.qualityOptions;
  if (!options?.length) return undefined;
  return options.some((option) => option.id === model.defaultQuality) ? model.defaultQuality : options[0].id;
}

/** Pick a valid quality for `model`, preferring `requested`. */
function resolveQuality(model: ModelSpec | undefined, requested: unknown): string | undefined {
  if (!model?.qualityOptions?.length) return undefined;
  if (typeof requested === "string" && model.qualityOptions.some((option) => option.id === requested)) return requested;
  return defaultQualityFor(model);
}

/**
 * Turn whatever was in localStorage into valid settings for the loaded model
 * list: unknown or unconfigured models fall back to the server default, and
 * size / quality / format / preset / ranges are validated against it.
 */
export function reconcileSettings(saved: StoredSettings | null, data: ModelsResponse): ResolvedSettings {
  const modelsById = new Map(data.models.map((model) => [model.id, model]));
  const providersById = new Map(data.providers.map((provider) => [provider.id, provider]));

  const savedModel = saved?.modelId ? modelsById.get(saved.modelId) : undefined;
  const model =
    savedModel && isModelUsable(savedModel, providersById) ? savedModel : (modelsById.get(data.defaults.modelId) ?? data.models[0]);

  const size = model && saved?.size && model.sizes.includes(saved.size) ? saved.size : (model?.defaultSize ?? data.defaults.size);
  const stylePresetId = data.stylePresets.some((preset) => preset.id === saved?.stylePresetId)
    ? (saved?.stylePresetId ?? data.defaults.stylePresetId)
    : data.defaults.stylePresetId;

  return {
    modelId: model?.id ?? data.defaults.modelId,
    quality: resolveQuality(model, saved?.quality),
    size,
    format: isImageFormat(saved?.format) ? saved.format : data.defaults.format,
    stylePresetId,
    customTemplate: typeof saved?.customTemplate === "string" ? saved.customTemplate : "",
    extraInstructions: typeof saved?.extraInstructions === "string" ? saved.extraInstructions : "",
    concurrency: clampInt(saved?.concurrency, CONCURRENCY_RANGE.min, CONCURRENCY_RANGE.max, data.defaults.concurrency),
    maxRetries: clampInt(saved?.maxRetries, RETRIES_RANGE.min, RETRIES_RANGE.max, data.defaults.maxRetries),
  };
}

/** Adjust size and quality when the model changes (keeps the size when the new model supports it). */
export function applyModelChange(settings: ResolvedSettings, model: ModelSpec): ResolvedSettings {
  return {
    ...settings,
    modelId: model.id,
    size: model.sizes.includes(settings.size) ? settings.size : model.defaultSize,
    quality: resolveQuality(model, settings.quality),
  };
}

/** The `customPrompt` sent to the API for the current preset (undefined when blank). */
export function effectiveCustomPrompt(settings: ResolvedSettings): string | undefined {
  const text = settings.stylePresetId === CUSTOM_STYLE_PRESET_ID ? settings.customTemplate : settings.extraInstructions;
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Build the API payload from the resolved settings. */
export function toGenerationSettings(settings: ResolvedSettings): GenerationSettings {
  return {
    modelId: settings.modelId,
    quality: settings.quality,
    size: settings.size,
    format: settings.format,
    stylePresetId: settings.stylePresetId,
    customPrompt: effectiveCustomPrompt(settings),
    concurrency: settings.concurrency,
    maxRetries: settings.maxRetries,
  };
}
