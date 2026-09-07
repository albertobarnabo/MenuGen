import { handleRoute, json, requireJob } from "@/lib/http";
import { cancelJob, isJobRunning } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";

/** POST /api/jobs/:jobId/cancel — idempotent: returns the job unchanged when it is not running. */
export const POST = handleRoute(async (_request, ctx: RouteContext<"/api/jobs/[jobId]/cancel">) => {
  const { jobId } = await ctx.params;
  const current = await requireJob(jobId);
  const job = isJobRunning(jobId) ? await cancelJob(jobId) : current;
  return json({ job });
});
