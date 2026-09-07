"use client";

import { useState } from "react";
import { ArrowLeftIcon, BanIcon, DownloadIcon, EllipsisIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import type { Job } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { jobDownloadUrl } from "@/components/shared/api";
import { formatDateTime, formatRelativeTime, formatSizeLabel, pluralize } from "@/components/shared/format";
import { StatusBadge } from "@/components/shared/status-badge";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

export interface ResultsHeaderProps {
  job: Job;
  modelName: string;
  styleName: string;
  pending: { retry: boolean; cancel: boolean; delete: boolean };
  onNewBatch: () => void;
  onRetryFailed: () => void;
  onCancel: () => Promise<void>;
  onDelete: () => Promise<void>;
}

/** Title, chips, status, created time and the batch-level actions. */
export function ResultsHeader({ job, modelName, styleName, pending, onNewBatch, onRetryFailed, onCancel, onDelete }: ResultsHeaderProps) {
  const now = useNow(30_000);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const active = job.status === "running" || job.status === "queued";
  const retryable = job.stats.failed + job.stats.cancelled;
  const canDownload = job.stats.done > 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" onClick={onNewBatch} className="-ml-2">
          <ArrowLeftIcon />
          New batch
        </Button>
      </div>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate font-heading text-xl font-semibold tracking-tight">{job.sourceFilename ?? "Untitled batch"}</h1>
            <StatusBadge status={job.status} />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">{modelName}</Badge>
            <Badge variant="outline">{styleName}</Badge>
            <Badge variant="outline" className="tabular-nums">
              {formatSizeLabel(job.settings.size)}
            </Badge>
            <Tooltip>
              <TooltipTrigger render={<span className="cursor-default rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50" tabIndex={0} />}>
                Created {formatRelativeTime(job.createdAt, now)}
              </TooltipTrigger>
              <TooltipContent>{formatDateTime(job.createdAt)}</TooltipContent>
            </Tooltip>
          </div>
          {job.error ? <p className="text-sm text-destructive">{job.error}</p> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canDownload ? (
            <a href={jobDownloadUrl(job.id)} download className={cn(buttonVariants({ variant: "outline" }))}>
              <DownloadIcon />
              Download ZIP
            </a>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} className="inline-flex rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />}>
                <Button variant="outline" disabled>
                  <DownloadIcon />
                  Download ZIP
                </Button>
              </TooltipTrigger>
              <TooltipContent>Available once the first image is ready</TooltipContent>
            </Tooltip>
          )}
          {retryable > 0 && !active ? (
            <Button variant="secondary" onClick={onRetryFailed} disabled={pending.retry}>
              {pending.retry ? <Spinner /> : <RotateCcwIcon />}
              Retry {pluralize(retryable, "failed", "failed")}
            </Button>
          ) : null}
          {active ? (
            <Button variant="destructive" onClick={() => setConfirmCancel(true)} disabled={pending.cancel}>
              {pending.cancel ? <Spinner /> : <BanIcon />}
              Cancel
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="More actions" />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2Icon />
                Delete batch
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this batch?"
        description="Images still in progress are stopped. Finished images stay available to download."
        confirmLabel="Cancel batch"
        destructive
        pending={pending.cancel}
        onConfirm={async () => {
          await onCancel();
          setConfirmCancel(false);
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this batch?"
        description="All generated images for this batch are removed from the server. Download the ZIP first if you want to keep them."
        confirmLabel="Delete batch"
        destructive
        pending={pending.delete}
        onConfirm={async () => {
          await onDelete();
          setConfirmDelete(false);
        }}
      />
    </div>
  );
}
