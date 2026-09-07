import { promises as fs } from "node:fs";
import type { JobItem } from "@/lib/types";
import { NotFoundError } from "@/lib/errors";
import { mimeTypeForFormat } from "@/lib/filename";
import { contentDispositionFilename, getReadyJobStore, handleRoute, requireJob, requireJobItem } from "@/lib/http";

export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, max-age=31536000, immutable";

/** Strong ETag that changes whenever the item is regenerated. */
function etagFor(item: JobItem): string {
  return `"${item.id}-${item.attempts}"`;
}

/** True when an `If-None-Match` header (list, `*`, or weak tags) matches `etag`. */
function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .includes(etag);
}

/**
 * GET /api/jobs/:jobId/images/:itemId — the generated image, aggressively
 * cacheable (the `?v=` query in `imageUrl` busts the cache after regeneration).
 */
export const GET = handleRoute(async (request, ctx: RouteContext<"/api/jobs/[jobId]/images/[itemId]">) => {
  const { jobId, itemId } = await ctx.params;
  const job = await requireJob(jobId);
  const item = requireJobItem(job, itemId);

  const store = await getReadyJobStore();
  const imagePath = await store.existingImagePath(job, item.id);
  if (!imagePath) throw new NotFoundError(`No image has been generated for item "${itemId}" yet`);

  const etag = etagFor(item);
  const headers = new Headers({
    "Cache-Control": CACHE_CONTROL,
    ETag: etag,
  });
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  const bytes = await fs.readFile(imagePath);
  headers.set("Content-Type", mimeTypeForFormat(job.settings.format));
  headers.set("Content-Length", String(bytes.byteLength));
  headers.set("Content-Disposition", `inline; ${contentDispositionFilename(item.filename)}`);
  return new Response(new Uint8Array(bytes), { status: 200, headers });
});
