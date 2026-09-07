"use client";

import { useMemo } from "react";
import { Trash2Icon, UtensilsCrossedIcon } from "lucide-react";
import type { MenuItem } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EditableCell } from "@/components/menu/editable-cell";
import { IconButton } from "@/components/shared/icon-button";
import { TABLE_RENDER_LIMIT, rowIssue } from "@/components/shared/limits";

export interface MenuTableProps {
  items: MenuItem[];
  query: string;
  showAll: boolean;
  onShowAll: () => void;
  onUpdate: (id: string, patch: Partial<Omit<MenuItem, "id">>) => void;
  onDelete: (id: string) => void;
  /** Id of a row that should open its dish-name cell for editing on mount. */
  focusRowId: string | null;
}

function matches(item: MenuItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    item.dishName.toLowerCase().includes(q) || item.description.toLowerCase().includes(q) || item.category.toLowerCase().includes(q)
  );
}

/** Editable dish table: click a cell to edit, inline validation, capped at 200 rows until "Show all". */
export function MenuTable({ items, query, showAll, onShowAll, onUpdate, onDelete, focusRowId }: MenuTableProps) {
  const filtered = useMemo(() => {
    const trimmed = query.trim();
    return items.map((item, index) => ({ item, index })).filter(({ item }) => matches(item, trimmed));
  }, [items, query]);
  const visible = showAll ? filtered : filtered.slice(0, TABLE_RENDER_LIMIT);
  const hidden = filtered.length - visible.length;

  if (items.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UtensilsCrossedIcon />
          </EmptyMedia>
          <EmptyTitle>No dishes yet</EmptyTitle>
          <EmptyDescription>Upload a menu above or add a dish by hand.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (filtered.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No dishes match “{query.trim()}”</EmptyTitle>
          <EmptyDescription>Try a different search term.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border">
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10 text-right text-muted-foreground">#</TableHead>
              <TableHead className="w-[28%] min-w-44">Dish name</TableHead>
              <TableHead className="min-w-64">Description</TableHead>
              <TableHead className="w-40">Category</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map(({ item, index }) => {
              const issue = rowIssue(item);
              const rowLabel = item.dishName.trim() || `row ${index + 1}`;
              return (
                <TableRow key={item.id} className="align-top">
                  <TableCell className="pt-2.5 text-right text-muted-foreground tabular-nums">{index + 1}</TableCell>
                  <TableCell className="whitespace-normal">
                    <EditableCell
                      value={item.dishName}
                      label={`Dish name, row ${index + 1}`}
                      placeholder="Dish name"
                      invalidReason={issue}
                      initialEditing={focusRowId === item.id}
                      onCommit={(dishName) => onUpdate(item.id, { dishName })}
                      className="font-medium"
                    />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <EditableCell
                      value={item.description}
                      label={`Description, row ${index + 1}`}
                      placeholder="Add a description"
                      multiline
                      onCommit={(description) => onUpdate(item.id, { description })}
                    />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <EditableCell
                      value={item.category}
                      label={`Category, row ${index + 1}`}
                      placeholder="Add a category"
                      renderIdle={(value) => (
                        <Badge variant="secondary" className="max-w-full">
                          <span className="truncate">{value}</span>
                        </Badge>
                      )}
                      onCommit={(category) => onUpdate(item.id, { category })}
                    />
                  </TableCell>
                  <TableCell className="pt-1.5">
                    <IconButton label={`Delete ${rowLabel}`} size="icon-sm" onClick={() => onDelete(item.id)}>
                      <Trash2Icon />
                    </IconButton>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {hidden > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span className="tabular-nums">
            Showing {visible.length} of {filtered.length} rows
          </span>
          <Button variant="outline" size="sm" onClick={onShowAll}>
            Show all {filtered.length} rows
          </Button>
        </div>
      ) : null}
    </div>
  );
}
