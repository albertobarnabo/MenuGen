"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface EditableCellProps {
  value: string;
  onCommit: (next: string) => void;
  /** Accessible name, e.g. "Dish name for row 3". */
  label: string;
  placeholder?: string;
  /** Use a textarea (Enter commits, Shift+Enter inserts a newline). */
  multiline?: boolean;
  /** Validation message; when set the cell is marked invalid and shows it in a tooltip. */
  invalidReason?: string | null;
  /** Start in edit mode on mount (used for freshly added rows). */
  initialEditing?: boolean;
  /** Custom idle rendering (e.g. a Badge for categories). */
  renderIdle?: (value: string) => ReactNode;
  className?: string;
}

const CELL_SELECTOR = "[data-editable-cell]";

/** Move focus to the next/previous editable cell in DOM order and open it. */
function focusSibling(current: HTMLElement, direction: 1 | -1): void {
  const cells = Array.from(document.querySelectorAll<HTMLElement>(CELL_SELECTOR));
  const index = cells.indexOf(current);
  const target = cells[index + direction];
  if (!target) return;
  const trigger = target.querySelector<HTMLButtonElement>("button[data-editable-trigger]");
  if (trigger) {
    trigger.focus();
    trigger.click();
  }
}

/**
 * Click-to-edit table cell. Enter / blur commit, Escape cancels, Tab commits
 * and moves to the next cell. Marks itself `aria-invalid` when `invalidReason` is set.
 */
export function EditableCell({
  value,
  onCommit,
  label,
  placeholder = "—",
  multiline = false,
  invalidReason = null,
  initialEditing = false,
  renderIdle,
  className,
}: EditableCellProps) {
  const [editing, setEditing] = useState(initialEditing);
  const [draft, setDraft] = useState(value);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const committed = useRef(false);

  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      wrapperRef.current?.querySelector<HTMLButtonElement>("button[data-editable-trigger]")?.focus();
    }
  }, [editing]);

  const start = (): void => {
    setDraft(value);
    committed.current = false;
    setEditing(true);
  };

  const finish = (save: boolean, refocus: boolean): void => {
    if (committed.current) return;
    committed.current = true;
    if (save && draft !== value) onCommit(draft);
    restoreFocus.current = refocus;
    setEditing(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !(multiline && event.shiftKey)) {
      event.preventDefault();
      finish(true, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false, true);
    } else if (event.key === "Tab") {
      event.preventDefault();
      finish(true, false);
      const wrapper = wrapperRef.current;
      if (wrapper) focusSibling(wrapper, event.shiftKey ? -1 : 1);
    }
  };

  const invalid = invalidReason !== null && invalidReason !== "";

  const trigger = (
    <button
      type="button"
      data-editable-trigger
      aria-label={label}
      data-invalid={invalid || undefined}
      onClick={start}
      className={cn(
        "flex min-h-8 w-full items-center rounded-md px-2 py-1 text-left text-sm outline-none transition-colors",
        "hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
        invalid && "ring-1 ring-destructive/60 hover:bg-destructive/5",
        !value && !invalid && "text-muted-foreground",
        className,
      )}
    >
      {value ? (
        renderIdle ? (
          renderIdle(value)
        ) : (
          <span className={cn("block min-w-0 truncate", multiline && "whitespace-normal line-clamp-2")}>{value}</span>
        )
      ) : (
        <span className="truncate">{invalid ? (invalidReason ?? placeholder) : placeholder}</span>
      )}
    </button>
  );

  return (
    <div ref={wrapperRef} data-editable-cell className="min-w-0">
      {editing ? (
        multiline ? (
          <Textarea
            autoFocus
            aria-label={label}
            aria-invalid={invalid || undefined}
            value={draft}
            rows={2}
            className="min-h-8 py-1 text-sm md:text-sm"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => finish(true, false)}
          />
        ) : (
          <Input
            autoFocus
            aria-label={label}
            aria-invalid={invalid || undefined}
            value={draft}
            className="h-8 text-sm md:text-sm"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => finish(true, false)}
          />
        )
      ) : invalid ? (
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent>{invalidReason}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
    </div>
  );
}
