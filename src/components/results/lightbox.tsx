"use client";

import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowLeftIcon, ArrowRightIcon, CopyIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import type { Job, JobItem } from "@/lib/types";
import { formatUsd } from "@/lib/cost";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IconButton } from "@/components/shared/icon-button";
import { copyText, formatMs, formatSizeLabel } from "@/components/shared/format";
import { cn } from "@/lib/utils";

export interface LightboxProps {
  job: Job;
  /** Item currently shown, or null when closed. */
  itemId: string | null;
  modelName: string;
  qualityLabel: string | undefined;
  busy: boolean;
  onClose: () => void;
  onNavigate: (itemId: string) => void;
  onRegenerate: (item: JobItem, promptOverride?: string) => void;
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

interface BodyProps {
  item: JobItem;
  job: Job;
  modelName: string;
  qualityLabel: string | undefined;
  busy: boolean;
  onRegenerate: (item: JobItem, promptOverride?: string) => void;
}

/** Side panel; keyed by item id so the prompt draft resets when navigating. */
function LightboxDetails({ item, job, modelName, qualityLabel, busy, onRegenerate }: BodyProps) {
  const [draft, setDraft] = useState(item.prompt);
  const changed = draft.trim() !== item.prompt.trim();

  const copyPrompt = async (): Promise<void> => {
    const ok = await copyText(item.prompt);
    if (ok) toast.success("Prompt copied");
    else toast.error("Could not copy. Select the prompt text and copy it manually.");
  };

  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 md:max-h-[75vh]">
      <div className="flex flex-col gap-1 pr-8">
        <DialogTitle className="text-lg">{item.dishName}</DialogTitle>
        <DialogDescription>{item.description || "No description"}</DialogDescription>
        {item.category ? (
          <Badge variant="secondary" className="mt-1 w-fit">
            {item.category}
          </Badge>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Detail label="File name">
          <span className="font-mono text-xs">{item.filename}</span>
        </Detail>
        <Detail label="Model">
          {modelName}
          {qualityLabel ? ` · ${qualityLabel}` : ""}
        </Detail>
        <Detail label="Size">{formatSizeLabel(job.settings.size)}</Detail>
        <Detail label="Attempts">
          <span className="tabular-nums">{item.attempts}</span>
        </Detail>
        <Detail label="Duration">
          <span className="tabular-nums">{item.durationMs !== undefined ? formatMs(item.durationMs) : "—"}</span>
        </Detail>
        <Detail label="Cost">
          <span className="tabular-nums">{item.costUsd !== undefined ? formatUsd(item.costUsd) : "—"}</span>
        </Detail>
      </dl>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Prompt sent</span>
          <Button variant="ghost" size="xs" onClick={() => void copyPrompt()}>
            <CopyIcon />
            Copy
          </Button>
        </div>
        <pre className="max-h-32 overflow-auto rounded-md bg-muted p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">{item.prompt}</pre>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`tweak-${item.id}`}>Tweak prompt</Label>
        <Textarea
          id={`tweak-${item.id}`}
          value={draft}
          rows={4}
          className="text-xs md:text-xs"
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {changed ? "Regenerate uses this edited prompt verbatim." : "Edit the text to regenerate with a different prompt."}
        </p>
      </div>

      <div className="mt-auto flex flex-wrap gap-2 pt-2">
        <Button onClick={() => onRegenerate(item, changed ? draft.trim() : undefined)} disabled={busy || (changed && draft.trim() === "")}>
          <RefreshCwIcon className={busy ? "animate-spin" : undefined} />
          Regenerate
        </Button>
        {item.imageUrl ? (
          <a href={item.imageUrl} download={item.filename} className={cn(buttonVariants({ variant: "outline" }))}>
            <DownloadIcon />
            Download image
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** Full-size image dialog with keyboard navigation between finished items and a details panel. */
export function Lightbox({ job, itemId, modelName, qualityLabel, busy, onClose, onNavigate, onRegenerate }: LightboxProps) {
  const doneItems = useMemo(() => job.items.filter((item) => item.status === "done" && item.imageUrl), [job.items]);
  const item = itemId ? job.items.find((candidate) => candidate.id === itemId) : undefined;
  const index = item ? doneItems.findIndex((candidate) => candidate.id === item.id) : -1;
  const previous = index > 0 ? doneItems[index - 1] : undefined;
  const next = index >= 0 && index < doneItems.length - 1 ? doneItems[index + 1] : undefined;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isTextField(event.target)) return;
    if (event.key === "ArrowLeft" && previous) {
      event.preventDefault();
      onNavigate(previous.id);
    } else if (event.key === "ArrowRight" && next) {
      event.preventDefault();
      onNavigate(next.id);
    }
  };

  return (
    <Dialog open={item !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] gap-0 overflow-hidden p-0 sm:max-w-5xl"
        onKeyDown={onKeyDown}
        aria-describedby={undefined}
      >
        {item ? (
          <div className="grid max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_22rem] md:grid-rows-1">
            <div className="relative flex items-center justify-center bg-muted p-4 md:min-h-[24rem]">
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- private, per-job API URL at its natural size
                <img src={item.imageUrl} alt={item.dishName} className="max-h-[40vh] max-w-full rounded-md object-contain md:max-h-[75vh]" />
              ) : (
                <p className="text-sm text-muted-foreground">No image yet</p>
              )}
              {doneItems.length > 1 ? (
                <>
                  <div className="absolute top-1/2 left-2 -translate-y-1/2">
                    <IconButton label="Previous image" variant="secondary" disabled={!previous} onClick={() => previous && onNavigate(previous.id)}>
                      <ArrowLeftIcon />
                    </IconButton>
                  </div>
                  <div className="absolute top-1/2 right-2 -translate-y-1/2">
                    <IconButton label="Next image" variant="secondary" disabled={!next} onClick={() => next && onNavigate(next.id)}>
                      <ArrowRightIcon />
                    </IconButton>
                  </div>
                  <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/80 px-2 py-0.5 text-xs text-muted-foreground tabular-nums">
                    {index + 1} / {doneItems.length}
                  </span>
                </>
              ) : null}
            </div>
            <LightboxDetails
              key={item.id}
              item={item}
              job={job}
              modelName={modelName}
              qualityLabel={qualityLabel}
              busy={busy}
              onRegenerate={onRegenerate}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
