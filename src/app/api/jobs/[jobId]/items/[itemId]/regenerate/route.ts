import { ConflictError } from "@/lib/errors";
import { handleRoute, json, readOptionalJson, requireJob, requireJobItem } from "@/lib/http";
import { regenerateItem } from "@/lib/jobs/runner";
import { parseRegenerateItemRequest } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * POST /api/jobs/:jobId/items/:itemId/regenerate — optional `RegenerateItemRequest`
 * body; 404 for an unknown item, 409 while that item is already generating.
 */
export const POST = handleRoute(
  async (request, ctx: RouteContext<"/api/jobs/[jobId]/items/[itemId]/regenerate">) => {
    const { jobId, itemId } = await ctx.params;
    const job = await requireJob(jobId);
    const existing = requireJobItem(job, itemId);
    if (existing.status === "running") {
      throw new ConflictError(`Item "${itemId}" is already being generated`);
    }
    const overrides = parseRegenerateItemRequest(await readOptionalJson(request));
    const item = await regenerateItem(jobId, itemId, overrides);
    return json({ item }, 202);
  },
);
