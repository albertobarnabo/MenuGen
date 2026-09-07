"use client";

import { useCallback, useEffect, useState } from "react";
import type { Job, JobEvent, JobItem, JobStats, JobStatus } from "@/lib/types";
import { ApiRequestError, getJob, jobEventsUrl } from "@/components/shared/api";

/** One line of the live activity log. */
export type JobLogEntry = Extract<JobEvent, { type: "log" }>;

/** Maximum log lines kept in memory (newest first). */
export const MAX_LOG_LINES = 200;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;
const TERMINAL: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled"]);

/** State and helpers exposed by {@link useJobEvents}. */
export interface UseJobEventsResult {
  /** Latest job state, or null until the first snapshot / fetch. */
  job: Job | null;
  /** Log lines, newest first, capped at {@link MAX_LOG_LINES}. */
  log: JobLogEntry[];
  /** True while the EventSource is open. */
  connected: boolean;
  /** User-facing error (e.g. the job no longer exists). */
  error: string | null;
  /** Re-fetch `GET /api/jobs/:id` and replace the local job. */
  refetch: () => Promise<void>;
  /** Merge one item locally (optimistic update before the SSE echo). */
  mergeItem: (item: JobItem) => void;
  /** Replace the whole job locally (e.g. from a cancel / retry response). */
  replaceJob: (job: Job) => void;
  /** Patch job-level fields locally (e.g. optimistic status change). */
  patchJob: (patch: Partial<Pick<Job, "status" | "error">>) => void;
}

/** Recount item statuses and actual cost; keeps the server's estimate and elapsed time. */
export function recomputeStats(job: Job): JobStats {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  let actualCostUsd = 0;
  for (const item of job.items) {
    counts[item.status] += 1;
    if (item.status === "done") actualCostUsd += item.costUsd ?? 0;
  }
  return {
    ...job.stats,
    ...counts,
    total: job.items.length,
    actualCostUsd: Math.round(actualCostUsd * 10_000) / 10_000,
  };
}

/** Replace (or append) `item` in `job.items` and refresh the stats. */
function withItem(job: Job, item: JobItem, stats?: JobStats): Job {
  const exists = job.items.some((candidate) => candidate.id === item.id);
  const items = exists ? job.items.map((candidate) => (candidate.id === item.id ? item : candidate)) : [...job.items, item];
  const next: Job = { ...job, items, updatedAt: new Date().toISOString() };
  return { ...next, stats: stats ?? recomputeStats(next) };
}

/** Apply a job-level status change, keeping `startedAt`/`finishedAt` plausible for the elapsed timer. */
function withStatus(job: Job, status: JobStatus, stats?: JobStats, error?: string): Job {
  const now = new Date().toISOString();
  return {
    ...job,
    status,
    error: error ?? (status === "running" ? undefined : job.error),
    stats: stats ?? job.stats,
    updatedAt: now,
    startedAt: status === "running" ? (job.startedAt ?? now) : job.startedAt,
    finishedAt: TERMINAL.has(status) ? (job.finishedAt ?? now) : status === "running" ? undefined : job.finishedAt,
  };
}

/** Parse one SSE payload; malformed frames are ignored. */
function parseEvent(raw: string): JobEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "type" in parsed) return parsed as JobEvent;
  } catch {
    /* ignore malformed frame */
  }
  return null;
}

const EVENT_TYPES: ReadonlyArray<JobEvent["type"]> = ["snapshot", "item", "job", "log", "end"];

/**
 * Subscribe to `GET /api/jobs/:id/events`.
 *
 * Handles `snapshot` / `item` / `job` / `log` / `end`, ignores events for other
 * jobs, reconnects with exponential back-off (1 s → 10 s) after re-fetching
 * the job over plain HTTP, and closes the stream on unmount or job change.
 */
export function useJobEvents(jobId: string | null): UseJobEventsResult {
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState<JobLogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!jobId) return;
    try {
      const { job: fresh } = await getJob(jobId);
      setJob(fresh);
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 404) {
        setError("This batch no longer exists. It may have been deleted.");
      } else {
        setError(cause instanceof Error ? cause.message : "Could not load the batch");
      }
    }
  }, [jobId]);

  // Reset per-job state during render when the job changes (React's documented
  // pattern for derived resets; avoids setState inside the effect body).
  const [trackedJobId, setTrackedJobId] = useState(jobId);
  if (trackedJobId !== jobId) {
    setTrackedJobId(jobId);
    setJob(null);
    setLog([]);
    setConnected(false);
    setError(null);
  }

  useEffect(() => {
    if (!jobId) return undefined;

    let source: EventSource | null = null;
    let reconnectTimer: number | undefined;
    let backoff = INITIAL_BACKOFF_MS;
    let disposed = false;

    const handle = (event: JobEvent): void => {
      switch (event.type) {
        case "snapshot":
          if (event.job.id !== jobId) return;
          setJob(event.job);
          setError(null);
          return;
        case "item":
          if (event.jobId !== jobId) return;
          setJob((previous) => (previous ? withItem(previous, event.item, event.stats) : previous));
          return;
        case "job":
          if (event.jobId !== jobId) return;
          setJob((previous) => (previous ? withStatus(previous, event.status, event.stats, event.error) : previous));
          return;
        case "log":
          if (event.jobId !== jobId) return;
          setLog((previous) => [event, ...previous].slice(0, MAX_LOG_LINES));
          return;
        case "end":
          if (event.jobId !== jobId) return;
          setJob((previous) => (previous ? withStatus(previous, event.status) : previous));
          // The final snapshot carries finishedAt / final stats; refresh once.
          void refetch();
          return;
        default:
          return;
      }
    };

    const connect = (): void => {
      if (disposed) return;
      source = new EventSource(jobEventsUrl(jobId));
      source.onopen = () => {
        backoff = INITIAL_BACKOFF_MS;
        setConnected(true);
      };
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, (message) => {
          const parsed = parseEvent((message as MessageEvent<string>).data);
          if (parsed) handle(parsed);
        });
      }
      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (disposed) return;
        const delay = backoff;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        reconnectTimer = window.setTimeout(async () => {
          if (disposed) return;
          await refetch();
          connect();
        }, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      source?.close();
      source = null;
    };
  }, [jobId, refetch]);

  const mergeItem = useCallback((item: JobItem) => {
    setJob((previous) => (previous ? withItem(previous, item) : previous));
  }, []);

  const replaceJob = useCallback((next: Job) => {
    setJob(next);
    setError(null);
  }, []);

  const patchJob = useCallback((patch: Partial<Pick<Job, "status" | "error">>) => {
    setJob((previous) => {
      if (!previous) return previous;
      const next = patch.status ? withStatus(previous, patch.status) : previous;
      return "error" in patch ? { ...next, error: patch.error } : next;
    });
  }, []);

  return { job, log, connected, error, refetch, mergeItem, replaceJob, patchJob };
}
