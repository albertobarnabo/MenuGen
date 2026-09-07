import { ConflictError } from "@/lib/errors";
import { handleRoute, json, requireJob } from "@/lib/http";
import { isJobRunning, retryFailed } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";

/** POST /api/jobs/:jobId/retry-failed — re-queue failed/cancelled items; 409 while the job is running. */
export const POST = handleRoute(async (_request, ctx: RouteContext<"/api/jobs/[jobId]/retry-failed">) => {
  const { jobId } = await ctx.params;
  await requireJob(jobId);
  if (isJobRunning(jobId)) throw new ConflictError(`Job "${jobId}" is still running; wait for it to finish or cancel it first`);
  const job = await retryFailed(jobId);
  return json({ job }, 202);
});
