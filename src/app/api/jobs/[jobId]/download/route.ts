import { Readable } from "node:stream";
import type { Job } from "@/lib/types";
import type { JobStore } from "@/lib/jobs/store";
import { NotFoundError } from "@/lib/errors";
import { contentDispositionFilename, getReadyJobStore, handleRoute, requireJob } from "@/lib/http";
import { createJobZipStream, zipFilenameForJob } from "@/lib/zip";

export const dynamic = "force-dynamic";

/** Resolve on-disk paths for every finished item up front so the ZIP callback stays synchronous. */
async function collectImagePaths(store: JobStore, job: Job): Promise<Map<string, string>> {
  const done = job.items.filter((item) => item.status === "done");
  const resolved = await Promise.all(
    done.map(async (item) => [item.id, await store.existingImagePath(job, item.id)] as const),
  );
  const paths = new Map<string, string>();
  for (const [itemId, imagePath] of resolved) {
    if (imagePath) paths.set(itemId, imagePath);
  }
  return paths;
}

/** GET /api/jobs/:jobId/download — streamed ZIP of every generated image plus manifest.csv. */
export const GET = handleRoute(async (_request, ctx: RouteContext<"/api/jobs/[jobId]/download">) => {
  const { jobId } = await ctx.params;
  const job = await requireJob(jobId);
  const store = await getReadyJobStore();

  const paths = await collectImagePaths(store, job);
  if (paths.size === 0) throw new NotFoundError(`Job "${jobId}" has no generated images to download yet`);

  const zip = createJobZipStream(job, (item) => paths.get(item.id));
  const body = Readable.toWeb(zip) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; ${contentDispositionFilename(zipFilenameForJob(job))}`,
      "Cache-Control": "no-store",
    },
  });
});
