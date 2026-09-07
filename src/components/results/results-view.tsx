"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowLeftIcon, CircleAlertIcon } from "lucide-react";
import type { Job, JobItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Gallery, GallerySkeleton } from "@/components/results/gallery";
import { Lightbox } from "@/components/results/lightbox";
import { ProgressPanel } from "@/components/results/progress-panel";
import { ResultsHeader } from "@/components/results/results-header";
import { cancelJob, deleteJob, regenerateItem, retryFailed } from "@/components/shared/api";
import { pluralize } from "@/components/shared/format";
import type { UseModelsResult } from "@/hooks/use-models";
import { useJobEvents } from "@/hooks/use-job-events";

export interface ResultsViewProps {
  jobId: string;
  models: UseModelsResult;
  onNewBatch: () => void;
  onDeleted: () => void;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** Local copy of the job with failed/cancelled items queued again, used until the server confirms. */
function withRetriedItems(job: Job): Job {
  const items = job.items.map((item) =>
    item.status === "failed" || item.status === "cancelled" ? { ...item, status: "pending" as const, error: undefined } : item,
  );
  return { ...job, items, status: "running", error: undefined };
}

/** Results workspace state: SSE-driven job, gallery, lightbox and the batch/item actions. */
export function ResultsView({ jobId, models, onNewBatch, onDeleted }: ResultsViewProps) {
  const { job, log, connected, error, refetch, mergeItem, replaceJob } = useJobEvents(jobId);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState({ retry: false, cancel: false, delete: false });
  const previousStatus = useRef<Job["status"] | null>(null);

  const model = job ? models.modelsById.get(job.settings.modelId) : undefined;
  const modelName = model?.displayName ?? job?.settings.modelId ?? "";
  const styleName =
    models.data?.stylePresets.find((preset) => preset.id === job?.settings.stylePresetId)?.name ??
    job?.settings.stylePresetId ??
    "";
  const qualityLabel = model?.qualityOptions?.find((option) => option.id === job?.settings.quality)?.label;

  // Toast on completion / failure / cancellation (only for transitions we observed).
  useEffect(() => {
    if (!job) return;
    const previous = previousStatus.current;
    previousStatus.current = job.status;
    if (previous === null || previous === job.status) return;
    if (previous !== "running" && previous !== "queued") return;
    if (job.status === "done") {
      toast.success(`${pluralize(job.stats.done, "image")} generated`);
    } else if (job.status === "failed") {
      toast.error(`${job.stats.failed} of ${job.stats.total} images failed`, {
        description: job.error ?? "Open a card to see the error, then use Retry failed.",
      });
    } else if (job.status === "cancelled") {
      toast("Batch cancelled", { description: `${pluralize(job.stats.done, "image")} finished before stopping.` });
    }
  }, [job]);

  const setBusy = useCallback((itemId: string, busy: boolean) => {
    setBusyIds((previous) => {
      const next = new Set(previous);
      if (busy) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }, []);

  const regenerate = useCallback(
    async (item: JobItem, promptOverride?: string) => {
      if (busyIds.has(item.id)) return;
      setBusy(item.id, true);
      mergeItem({ ...item, status: "running", error: undefined });
      try {
        const { item: fresh } = await regenerateItem(jobId, item.id, promptOverride ? { promptOverride } : undefined);
        mergeItem(fresh);
        setLightboxId((current) => (current === item.id ? null : current));
        toast(`Regenerating ${item.dishName}`);
      } catch (cause) {
        mergeItem(item);
        toast.error(`Could not regenerate ${item.dishName}`, { description: messageOf(cause, "Try again in a moment.") });
      } finally {
        setBusy(item.id, false);
      }
    },
    [busyIds, jobId, mergeItem, setBusy],
  );

  const retry = useCallback(async () => {
    if (!job) return;
    setPending((state) => ({ ...state, retry: true }));
    replaceJob(withRetriedItems(job));
    try {
      const { job: fresh } = await retryFailed(jobId);
      replaceJob(fresh);
      toast(`Retrying ${pluralize(job.stats.failed + job.stats.cancelled, "image")}`);
    } catch (cause) {
      await refetch();
      toast.error("Could not retry", { description: messageOf(cause, "Try again in a moment.") });
    } finally {
      setPending((state) => ({ ...state, retry: false }));
    }
  }, [job, jobId, refetch, replaceJob]);

  const cancel = useCallback(async () => {
    setPending((state) => ({ ...state, cancel: true }));
    try {
      const { job: fresh } = await cancelJob(jobId);
      replaceJob(fresh);
    } catch (cause) {
      toast.error("Could not cancel", { description: messageOf(cause, "The batch may already have finished.") });
    } finally {
      setPending((state) => ({ ...state, cancel: false }));
    }
  }, [jobId, replaceJob]);

  const remove = useCallback(async () => {
    setPending((state) => ({ ...state, delete: true }));
    try {
      await deleteJob(jobId);
      toast.success("Batch deleted");
      onDeleted();
    } catch (cause) {
      toast.error("Could not delete the batch", { description: messageOf(cause, "Try again in a moment.") });
    } finally {
      setPending((state) => ({ ...state, delete: false }));
    }
  }, [jobId, onDeleted]);

  if (error && !job) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleAlertIcon />
          </EmptyMedia>
          <EmptyTitle>Could not open this batch</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={onNewBatch}>
            <ArrowLeftIcon />
            Back to compose
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (!job) {
    return (
      <div className="flex flex-col gap-6" aria-busy>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-5 w-80" />
        </div>
        <Skeleton className="h-28 w-full rounded-xl" />
        <GallerySkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ResultsHeader
        job={job}
        modelName={modelName}
        styleName={styleName}
        pending={pending}
        onNewBatch={onNewBatch}
        onRetryFailed={() => void retry()}
        onCancel={cancel}
        onDelete={remove}
      />
      <ProgressPanel job={job} log={log} connected={connected} model={model} />
      <Gallery items={job.items} busyIds={busyIds} onOpen={(item) => setLightboxId(item.id)} onRegenerate={(item) => void regenerate(item)} />
      <Lightbox
        job={job}
        itemId={lightboxId}
        modelName={modelName}
        qualityLabel={qualityLabel}
        busy={lightboxId !== null && busyIds.has(lightboxId)}
        onClose={() => setLightboxId(null)}
        onNavigate={setLightboxId}
        onRegenerate={(item, promptOverride) => void regenerate(item, promptOverride)}
      />
    </div>
  );
}
