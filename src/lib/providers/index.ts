import type { ImageProvider, ProviderId, ProviderInfo } from "../types";
import { PROVIDER_META } from "../models";
import { openaiProvider } from "./openai";
import { googleProvider } from "./google";
import { bflProvider } from "./bfl";
import { mockProvider } from "./mock";

const PROVIDERS: Record<ProviderId, ImageProvider> = {
  openai: openaiProvider,
  google: googleProvider,
  bfl: bflProvider,
  mock: mockProvider,
};

export function getProvider(id: ProviderId): ImageProvider {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown provider "${id}"`);
  return provider;
}

/** Provider metadata plus whether its key is present (never the key itself). */
export function listProviderInfo(): ProviderInfo[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({
    id,
    name: PROVIDER_META[id].name,
    envVar: PROVIDER_META[id].envVar,
    keysUrl: PROVIDER_META[id].keysUrl,
    configured: PROVIDERS[id].isConfigured(),
  }));
}

export { openaiProvider, googleProvider, bflProvider, mockProvider };
