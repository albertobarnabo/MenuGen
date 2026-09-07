import type { JobEvent, JobStatus } from "@/lib/types";
import { handleRoute, requireJob } from "@/lib/http";
import { getJobEventBus } from "@/lib/jobs/events";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled"]);

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/** `event: <type>\ndata: <json>\n\n` — the JSON also carries `type`. */
function formatSseEvent(event: JobEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Wires one SSE connection: snapshot first, then live events, a heartbeat
 * comment every 15 s, and a single idempotent cleanup path.
 */
class JobEventStream implements UnderlyingDefaultSource<Uint8Array> {
  private readonly encoder = new TextEncoder();
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private unsubscribe: (() => void) | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private readonly jobId: string,
    private readonly snapshot: JobEvent,
    private readonly signal: AbortSignal,
  ) {}

  start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.controller = controller;
    if (this.signal.aborted) {
      this.onAbort();
      return;
    }
    this.send(formatSseEvent(this.snapshot));
    if (this.snapshot.type === "snapshot" && TERMINAL_STATUSES.has(this.snapshot.job.status)) {
      this.send(formatSseEvent({ type: "end", jobId: this.jobId, status: this.snapshot.job.status }));
    }
    this.unsubscribe = getJobEventBus().subscribe(this.jobId, (event) => this.send(formatSseEvent(event)));
    this.heartbeat = setInterval(() => this.send(": ping\n\n"), HEARTBEAT_MS);
    this.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  /** Called by the runtime when the client disconnects or the reader cancels. */
  cancel(): void {
    this.cleanup();
  }

  private readonly onAbort = (): void => {
    this.cleanup();
    try {
      this.controller?.close();
    } catch {
      /* already closed */
    }
  };

  private send(chunk: string): void {
    if (this.closed || !this.controller) return;
    try {
      this.controller.enqueue(this.encoder.encode(chunk));
    } catch {
      // The consumer went away without a cancel() call; stop forwarding.
      this.cleanup();
    }
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.signal.removeEventListener("abort", this.onAbort);
  }
}

/**
 * GET /api/jobs/:jobId/events — Server-Sent Events. Sends `snapshot` first
 * (then `end` if the job is already terminal), forwards bus events, and stays
 * open until the client disconnects.
 */
export const GET = handleRoute(async (request, ctx: RouteContext<"/api/jobs/[jobId]/events">) => {
  const { jobId } = await ctx.params;
  const job = await requireJob(jobId);
  const source = new JobEventStream(jobId, { type: "snapshot", job }, request.signal);
  return new Response(new ReadableStream<Uint8Array>(source), { headers: SSE_HEADERS });
});
