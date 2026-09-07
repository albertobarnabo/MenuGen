"use client";

import { Loader2Icon, Maximize2Icon, RefreshCwIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import type { JobItem } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IconButton } from "@/components/shared/icon-button";
import { formatMs } from "@/components/shared/format";

export interface GalleryCardProps {
  item: JobItem;
  /** True while a regenerate request for this item is in flight. */
  busy: boolean;
  onOpen: (item: JobItem) => void;
  onRegenerate: (item: JobItem) => void;
}

function Meta({ item }: { item: JobItem }) {
  const parts: string[] = [];
  if (item.status === "done" && item.durationMs !== undefined) parts.push(formatMs(item.durationMs));
  if (item.attempts > 1) parts.push(`${item.attempts} attempts`);
  if (parts.length === 0) return null;
  return <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{parts.join(" · ")}</span>;
}

function ImageArea({ item, busy, onOpen, onRegenerate }: GalleryCardProps) {
  switch (item.status) {
    case "pending":
      return (
        <div className="absolute inset-0">
          <Skeleton className="size-full rounded-none" />
          <span className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">Queued</span>
        </div>
      );
    case "running":
      return (
        <div className="absolute inset-0 animate-shimmer">
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-5 animate-spin text-primary" aria-hidden />
            Generating…
          </span>
        </div>
      );
    case "failed":
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-destructive/5 p-4 text-center text-destructive">
          <TriangleAlertIcon className="size-5" aria-hidden />
          <Tooltip>
            <TooltipTrigger render={<p className="line-clamp-3 cursor-default text-xs" tabIndex={0} />}>
              {item.error ?? "Generation failed"}
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-pre-wrap">{item.error ?? "Generation failed"}</TooltipContent>
          </Tooltip>
          <Button variant="outline" size="sm" onClick={() => onRegenerate(item)} disabled={busy}>
            <RotateCcwIcon />
            Retry
          </Button>
        </div>
      );
    case "cancelled":
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted p-4 text-center text-muted-foreground">
          <span className="text-sm">Cancelled</span>
          <Button variant="outline" size="sm" onClick={() => onRegenerate(item)} disabled={busy}>
            <RotateCcwIcon />
            Retry
          </Button>
        </div>
      );
    case "done":
      return (
        <>
          <button
            type="button"
            className="absolute inset-0 block size-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            aria-label={`Open ${item.dishName}`}
            onClick={() => onOpen(item)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- private, per-job API URLs; the optimizer adds nothing here */}
            <img src={item.imageUrl} alt={item.dishName} loading="lazy" decoding="async" className="size-full object-cover" />
          </button>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-end gap-1 bg-gradient-to-t from-black/50 to-transparent p-2 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
            <div className="pointer-events-auto flex gap-1">
              <IconButton label={`Regenerate ${item.dishName}`} variant="secondary" size="icon-sm" disabled={busy} onClick={() => onRegenerate(item)}>
                <RefreshCwIcon className={busy ? "animate-spin" : undefined} />
              </IconButton>
              <IconButton label={`Open ${item.dishName}`} variant="secondary" size="icon-sm" onClick={() => onOpen(item)}>
                <Maximize2Icon />
              </IconButton>
            </div>
          </div>
        </>
      );
    default:
      return null;
  }
}

/** One dish in the results grid: image / skeleton / error panel plus name, category and timing. */
export function GalleryCard(props: GalleryCardProps) {
  const { item } = props;
  return (
    <article className="group flex flex-col gap-2 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10" aria-busy={item.status === "running"}>
      <div className="relative aspect-square w-full overflow-hidden bg-muted">
        <ImageArea {...props} />
      </div>
      <div className="flex flex-col gap-1 px-3 pb-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="min-w-0 truncate text-sm font-medium" title={item.dishName}>
            {item.dishName}
          </h3>
          <Meta item={item} />
        </div>
        {item.category ? (
          <Badge variant="secondary" className="max-w-full">
            <span className="truncate">{item.category}</span>
          </Badge>
        ) : null}
      </div>
    </article>
  );
}
