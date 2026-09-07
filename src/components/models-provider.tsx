"use client";

import type { ReactNode } from "react";
import { ModelsContext, useModelsQuery } from "@/hooks/use-models";

/** Fetches `/api/models` once and shares it with every `useModels()` consumer below. */
export function ModelsProvider({ children }: { children: ReactNode }) {
  const query = useModelsQuery();
  return <ModelsContext.Provider value={query}>{children}</ModelsContext.Provider>;
}
