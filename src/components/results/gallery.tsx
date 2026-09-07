"use client";

import { ImageOffIcon } from "lucide-react";
import type { JobItem } from "@/lib/types";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { GalleryCard } from "@/components/results/gallery-card";

export interface GalleryProps {
  items: JobItem[];
  busyIds: ReadonlySet<string>;
  onOpen: (item: JobItem) => void;
  onRegenerate: (item: JobItem) => void;
}

const GRID_CLASS = "grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4";

/** Placeholder grid shown before the first snapshot arrives. */
export function GallerySkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className={GRID_CLASS} aria-busy aria-label="Loading images">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          <Skeleton className="aspect-square w-full rounded-none" />
          <div className="flex flex-col gap-2 px-3 pb-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-16 rounded-4xl" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Responsive 2–4 column grid of {@link GalleryCard}s. */
export function Gallery({ items, busyIds, onOpen, onRegenerate }: GalleryProps) {
  if (items.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ImageOffIcon />
          </EmptyMedia>
          <EmptyTitle>This batch has no dishes</EmptyTitle>
          <EmptyDescription>Start a new batch to generate images.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className={GRID_CLASS}>
      {items.map((item) => (
        <GalleryCard key={item.id} item={item} busy={busyIds.has(item.id)} onOpen={onOpen} onRegenerate={onRegenerate} />
      ))}
    </div>
  );
}
