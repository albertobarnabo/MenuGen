"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ModelSpec, ModelsResponse, ProviderInfo } from "@/lib/types";
import { getModels } from "@/components/shared/api";

/** State exposed by {@link useModels}. */
export interface UseModelsResult {
  /** `GET /api/models` payload, or null until loaded. */
  data: ModelsResponse | null;
  loading: boolean;
  /** User-facing error message when the request failed. */
  error: string | null;
  modelsById: ReadonlyMap<string, ModelSpec>;
  providersById: ReadonlyMap<string, ProviderInfo>;
  refetch: () => Promise<void>;
}

/**
 * Shared models state. `ModelsProvider` (src/components/models-provider.tsx)
 * fills it once per page so the header, footer and workspace share one request.
 */
export const ModelsContext = createContext<UseModelsResult | null>(null);

const EMPTY_MODELS: ReadonlyMap<string, ModelSpec> = new Map();
const EMPTY_PROVIDERS: ReadonlyMap<string, ProviderInfo> = new Map();

/**
 * Fetch `GET /api/models` on mount (when `enabled`) and expose loading/error
 * state plus lookup maps. Aborts the in-flight request on unmount.
 */
export function useModelsQuery(options: { enabled?: boolean } = {}): UseModelsResult {
  const enabled = options.enabled ?? true;
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const refetch = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    // State is only touched inside the promise callbacks (never synchronously),
    // so calling refetch() from an effect does not cascade renders.
    await getModels(controller.signal).then(
      (response) => {
        if (controller.signal.aborted) return;
        setData(response);
        setError(null);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Could not load the model list");
      },
    );
  }, []);

  const loading = enabled && data === null && error === null;

  useEffect(() => {
    if (!enabled) return undefined;
    void refetch();
    return () => controllerRef.current?.abort();
  }, [enabled, refetch]);

  const modelsById = useMemo(
    () => (data ? new Map(data.models.map((model) => [model.id, model])) : EMPTY_MODELS),
    [data],
  );
  const providersById = useMemo(
    () => (data ? new Map(data.providers.map((provider) => [provider.id, provider])) : EMPTY_PROVIDERS),
    [data],
  );

  return { data, loading, error, modelsById, providersById, refetch };
}

/**
 * Models, providers, presets and defaults from `GET /api/models`.
 * Uses the shared {@link ModelsContext} when a provider is mounted above,
 * otherwise performs its own request.
 */
export function useModels(): UseModelsResult {
  const shared = useContext(ModelsContext);
  const own = useModelsQuery({ enabled: shared === null });
  return shared ?? own;
}
