import type { Job, JobSummary } from "@/lib/types";
import { env } from "@/lib/env";
import { ProviderNotConfiguredError } from "@/lib/errors";
import { getReadyJobStore, handleRoute, json, readIntQuery, readJson } from "@/lib/http";
import { startJob } from "@/lib/jobs/runner";
import { PROVIDER_META, getModel } from "@/lib/models";
import { getProvider } from "@/lib/providers";
import { parseCreateJobRequest } from "@/lib/validation";

export const dynamic = "force-dynamic";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

/** GET /api/jobs?limit=20 — newest jobs first. */
export const GET = handleRoute(async (request) => {
  const limit = readIntQuery(request, "limit", DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const store = await getReadyJobStore();
  const jobs: JobSummary[] = await store.list(limit);
  return json({ jobs });
});

/** Throw 422 when the chosen model's provider has no key. The mock provider never needs one. */
function assertProviderConfigured(modelId: string): void {
  const model = getModel(modelId);
  if (!model) throw new Error(`Model "${modelId}" passed validation but is not in the registry`);
  if (model.provider === "mock") return;
  if (!getProvider(model.provider).isConfigured()) {
    throw new ProviderNotConfiguredError(model.provider, PROVIDER_META[model.provider].envVar);
  }
}

/** POST /api/jobs — validate, persist, start generating; 202 with the queued job. */
export const POST = handleRoute(async (request) => {
  const body = await readJson(request);
  const input = parseCreateJobRequest(body, { maxItems: env.maxItemsPerJob });
  assertProviderConfigured(input.settings.modelId);

  const store = await getReadyJobStore();
  const created = await store.create(input);
  startJob(created.id);

  const job: Job = (await store.get(created.id)) ?? created;
  return json({ job }, 202);
});
