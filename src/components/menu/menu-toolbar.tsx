"use client";

import { useState } from "react";
import { DownloadIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { pluralize } from "@/components/shared/format";

export interface MenuToolbarProps {
  count: number;
  attentionCount: number;
  query: string;
  onQueryChange: (query: string) => void;
  onAdd: () => void;
  onExport: () => void;
  onClearAll: () => void;
}

/** Search, add, export and clear controls plus the "12 dishes · 2 need attention" summary. */
export function MenuToolbar({ count, attentionCount, query, onQueryChange, onAdd, onExport, onClearAll }: MenuToolbarProps) {
  const [confirmClear, setConfirmClear] = useState(false);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 items-center gap-3">
        <div className="relative w-full max-w-xs">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search dishes"
            aria-label="Search dishes"
            className="pl-8"
          />
        </div>
        <p className="hidden shrink-0 text-sm text-muted-foreground tabular-nums md:block" aria-live="polite">
          {pluralize(count, "dish", "dishes")}
          {attentionCount > 0 ? (
            <>
              {" · "}
              <span className="text-destructive">{attentionCount} need{attentionCount === 1 ? "s" : ""} attention</span>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onAdd}>
          <PlusIcon />
          Add dish
        </Button>
        <Button variant="outline" size="sm" onClick={onExport} disabled={count === 0}>
          <DownloadIcon />
          Export CSV
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)} disabled={count === 0}>
          <Trash2Icon />
          Clear all
        </Button>
      </div>
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear all dishes?"
        description={`This removes ${pluralize(count, "dish", "dishes")} from the table. Your uploaded file is not affected.`}
        confirmLabel="Clear all"
        destructive
        onConfirm={() => {
          setConfirmClear(false);
          onClearAll();
        }}
      />
    </div>
  );
}
