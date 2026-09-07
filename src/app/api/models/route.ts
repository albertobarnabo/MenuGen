import type { ModelSpec, ModelsResponse, ProviderId, ProviderInfo } from "@/lib/types";
import { env } from "@/lib/env";
import { handleRoute, json } from "@/lib/http";
import { DEFAULT_MODEL_ID, MODELS, getModel } from "@/lib/models";
import { DEFAULT_STYLE_PRESET_ID, STYLE_PRESETS } from "@/lib/prompt";
import { listProviderInfo } from "@/lib/providers";

export const dynamic = "force-dynamic";

const MOCK_MODEL_ID = "mock/sample";
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RETRIES = 3;

/** Models the UI may offer: the mock model only when enabled or when nothing else is configured. */
function visibleModels(providers: ProviderInfo[]): ModelSpec[] {
  const realProviderConfigured = providers.some((provider) => provider.id !== "mock" && provider.configured);
  const showMock = env.enableMock || !realProviderConfigured;
  return MODELS.filter((model) => model.provider !== "mock" || showMock);
}

/**
 * Pick the pre-selected model: the env override if usable, else the registry
 * default if usable, else the first usable visible model, else the mock model.
 */
function resolveDefaultModel(models: ModelSpec[], configured: Set<ProviderId>): ModelSpec {
  const usable = (model: ModelSpec | undefined): model is ModelSpec =>
    model !== undefined && configured.has(model.provider) && models.some((visible) => visible.id === model.id);

  const candidates = [getModel(env.defaultModelId), getModel(DEFAULT_MODEL_ID)];
  const preferred = candidates.find(usable);
  if (preferred) return preferred;

  const firstUsable = models.find((model) => configured.has(model.provider));
  if (firstUsable) return firstUsable;

  const mock = getModel(MOCK_MODEL_ID);
  if (!mock) throw new Error(`Model registry is missing "${MOCK_MODEL_ID}"`);
  return mock;
}

function buildModelsResponse(): ModelsResponse {
  const providers = listProviderInfo();
  const configured = new Set(providers.filter((provider) => provider.configured).map((provider) => provider.id));
  const models = visibleModels(providers);
  const defaultModel = resolveDefaultModel(models, configured);

  return {
    models,
    providers,
    stylePresets: STYLE_PRESETS,
    defaults: {
      modelId: defaultModel.id,
      size: defaultModel.defaultSize,
      format: "jpeg",
      stylePresetId: DEFAULT_STYLE_PRESET_ID,
      concurrency: DEFAULT_CONCURRENCY,
      maxRetries: DEFAULT_MAX_RETRIES,
    },
    maxItemsPerJob: env.maxItemsPerJob,
  };
}

/** GET /api/models — registry, provider status (never keys), presets and defaults. */
export const GET = handleRoute(async () => json(buildModelsResponse()));
