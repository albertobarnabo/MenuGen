import { getReadyJobStore, handleRoute, json, requireJob } from "@/lib/http";
import { cancelJob, isJobRunning } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";

/** GET /api/jobs/:jobId — full job state. */
export const GET = handleRoute(async (_request, ctx: RouteContext<"/api/jobs/[jobId]">) => {
  const { jobId } = await ctx.params;
  const job = await requireJob(jobId);
  return json({ job });
});

/** DELETE /api/jobs/:jobId — cancel if running, then remove the job and its files. */
export const DELETE = handleRoute(async (_request, ctx: RouteContext<"/api/jobs/[jobId]">) => {
  const { jobId } = await ctx.params;
  await requireJob(jobId);
  if (isJobRunning(jobId)) await cancelJob(jobId);
  const store = await getReadyJobStore();
  await store.delete(jobId);
  return new Response(null, { status: 204 });
});
