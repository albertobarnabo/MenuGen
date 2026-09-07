"use client";

import { HistoryIcon, XIcon } from "lucide-react";
import type { JobSummary } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/shared/icon-button";
import { formatRelativeTime, pluralize } from "@/components/shared/format";
import { StatusBadge } from "@/components/shared/status-badge";
import { useNow } from "@/hooks/use-now";

export interface ResumeBannerProps {
  job: JobSummary;
  modelName: string;
  onOpen: () => void;
  onDismiss: () => void;
}

/** "Resume last batch — 8 dishes · FLUX.2 [pro] · 2 minutes ago" with Open / Dismiss. */
export function ResumeBanner({ job, modelName, onOpen, onDismiss }: ResumeBannerProps) {
  const now = useNow(30_000);
  return (
    <div role="region" aria-label="Resume last batch" className="flex flex-wrap items-center gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
        <HistoryIcon className="size-4" aria-hidden />
      </span>
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium">Resume last batch</span>
        <span className="text-muted-foreground">
          {" — "}
          {pluralize(job.stats.total, "dish", "dishes")} · {modelName} · {formatRelativeTime(job.createdAt, now)}
        </span>
      </p>
      <StatusBadge status={job.status} className="hidden sm:inline-flex" />
      <div className="flex items-center gap-1">
        <Button size="sm" variant="secondary" onClick={onOpen}>
          Open
        </Button>
        <IconButton label="Dismiss" size="icon-sm" onClick={onDismiss}>
          <XIcon />
        </IconButton>
      </div>
    </div>
  );
}
