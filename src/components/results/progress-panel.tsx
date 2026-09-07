"use client";

import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { Job, ModelSpec } from "@/lib/types";
import { formatDuration, formatUsd, typicalLatencyFor } from "@/lib/cost";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import type { JobLogEntry } from "@/hooks/use-job-events";
import { useNow } from "@/hooks/use-now";
import { formatClock } from "@/components/shared/format";
import { cn } from "@/lib/utils";

export interface ProgressPanelProps {
  job: Job;
  log: JobLogEntry[];
  connected: boolean;
  model: ModelSpec | undefined;
}

const LEVEL_CLASS: Record<JobLogEntry["level"], string> = {
  info: "text-muted-foreground",
  warn: "text-warning",
  error: "text-destructive",
};

/** Mean duration of finished items in ms, or the model's typical latency when nothing has finished. */
function averageItemMs(job: Job, model: ModelSpec | undefined): number {
  const durations = job.items.filter((item) => item.status === "done" && item.durationMs).map((item) => item.durationMs ?? 0);
  if (durations.length > 0) return durations.reduce((sum, value) => sum + value, 0) / durations.length;
  return (model ? typicalLatencyFor(model) : 10) * 1000;
}

/** Elapsed milliseconds: live while running, otherwise the server's total. */
function elapsedMs(job: Job, now: number): number {
  const started = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
  if (job.status === "running" && !Number.isNaN(started)) return Math.max(0, now - started);
  if (job.finishedAt && !Number.isNaN(started)) return Math.max(0, Date.parse(job.finishedAt) - started);
  return job.stats.elapsedMs;
}

function progressLabel(job: Job): string {
  const { stats } = job;
  const parts = [`${stats.done} of ${stats.total} generated`];
  if (stats.failed > 0) parts.push(`${stats.failed} failed`);
  if (stats.cancelled > 0) parts.push(`${stats.cancelled} cancelled`);
  if (stats.running > 0 && job.status === "running") parts.push(`${stats.running} in progress`);
  return parts.join(" · ");
}

function logTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "" : new Date(time).toLocaleTimeString(undefined, { hour12: false });
}

/** Progress bar, elapsed / ETA / cost readouts and the collapsible activity log. */
export function ProgressPanel({ job, log, connected, model }: ProgressPanelProps) {
  const running = job.status === "running";
  const now = useNow(1000, running);
  const [logOpen, setLogOpen] = useState(false);

  const { stats } = job;
  const finished = stats.done + stats.failed + stats.cancelled;
  const percent = stats.total > 0 ? Math.round((finished / stats.total) * 100) : 0;
  const remaining = stats.pending + stats.running;
  const etaSeconds = running && remaining > 0 ? (remaining * averageItemMs(job, model)) / Math.max(1, job.settings.concurrency) / 1000 : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <Progress value={percent} aria-label="Batch progress">
          <ProgressLabel className="tabular-nums">{progressLabel(job)}</ProgressLabel>
          <ProgressValue>{() => `${percent}%`}</ProgressValue>
        </Progress>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Elapsed</dt>
            <dd className="font-medium tabular-nums">{formatClock(elapsedMs(job, now) / 1000)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Remaining</dt>
            <dd className="font-medium tabular-nums">
              {etaSeconds !== null ? `~${formatDuration(etaSeconds)}` : running ? "…" : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Cost so far</dt>
            <dd className="font-medium tabular-nums">
              {formatUsd(stats.actualCostUsd)}
              {stats.estimatedCostUsd > 0 ? (
                <span className="font-normal text-muted-foreground"> of ~{formatUsd(stats.estimatedCostUsd)}</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Connection</dt>
            <dd className="flex items-center gap-1.5 font-medium">
              <span aria-hidden className={cn("size-2 rounded-full", connected ? "bg-success" : "bg-muted-foreground/40")} />
              {connected ? "Live" : running ? "Reconnecting…" : "Idle"}
            </dd>
          </div>
        </dl>

        <Collapsible open={logOpen} onOpenChange={setLogOpen} className="rounded-lg border">
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
            <span>
              Activity log
              <span className="font-normal text-muted-foreground tabular-nums"> · {log.length}</span>
            </span>
            <ChevronDownIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", logOpen && "rotate-180")} aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t">
            {log.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">Nothing logged yet.</p>
            ) : (
              <ol className="max-h-64 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed" aria-live="polite">
                {log.map((entry, index) => (
                  <li key={`${entry.at}-${index}`} className={cn("flex gap-2", LEVEL_CLASS[entry.level])}>
                    <span className="shrink-0 tabular-nums opacity-70">{logTime(entry.at)}</span>
                    <span className="min-w-0 break-words">{entry.message}</span>
                  </li>
                ))}
              </ol>
            )}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
