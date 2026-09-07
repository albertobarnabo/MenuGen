"use client";

import { useMemo, useState } from "react";
import type { MenuItem, ParseResult, ParseWarning } from "@/lib/types";
import { itemsToCsv } from "@/lib/parse";
import { PROVIDER_META } from "@/lib/models";
import { Card, CardContent } from "@/components/ui/card";
import { MenuTable } from "@/components/menu/menu-table";
import { MenuToolbar } from "@/components/menu/menu-toolbar";
import { PromptPreview } from "@/components/menu/prompt-preview";
import { EstimateCard } from "@/components/settings/estimate-card";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { effectiveCustomPrompt, isModelUsable, type ResolvedSettings } from "@/components/settings/settings-utils";
import { downloadBlob } from "@/components/shared/format";
import { rowIssue } from "@/components/shared/limits";
import { UploadCard } from "@/components/upload/upload-card";
import type { UseModelsResult } from "@/hooks/use-models";

export interface ComposeViewProps {
  models: UseModelsResult;
  items: MenuItem[];
  sourceFilename: string | undefined;
  warnings: ParseWarning[];
  focusRowId: string | null;
  settings: ResolvedSettings | null;
  pending: boolean;
  onLoaded: (result: ParseResult, filename: string) => void;
  onClearAll: () => void;
  onUpdateItem: (id: string, patch: Partial<Omit<MenuItem, "id">>) => void;
  onDeleteItem: (id: string) => void;
  onAddItem: () => void;
  onSettingsChange: (next: ResolvedSettings) => void;
  onGenerate: () => void;
}

function exportFilename(sourceFilename: string | undefined): string {
  const stem = (sourceFilename ?? "menu").replace(/\.[^.]+$/, "") || "menu";
  return `${stem}-edited.csv`;
}

/** Two-column compose layout: upload + table on the left, settings + estimate on the right. */
export function ComposeView({
  models,
  items,
  sourceFilename,
  warnings,
  focusRowId,
  settings,
  pending,
  onLoaded,
  onClearAll,
  onUpdateItem,
  onDeleteItem,
  onAddItem,
  onSettingsChange,
  onGenerate,
}: ComposeViewProps) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const attentionCount = useMemo(() => items.filter((item) => rowIssue(item) !== null).length, [items]);
  const model = settings ? (models.modelsById.get(settings.modelId) ?? null) : null;
  const missingEnvVar =
    model && !isModelUsable(model, models.providersById)
      ? (models.providersById.get(model.provider)?.envVar ?? PROVIDER_META[model.provider].envVar)
      : null;

  const exportCsv = (): void => downloadBlob(itemsToCsv(items), exportFilename(sourceFilename), "text/csv;charset=utf-8");

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-6">
        <UploadCard itemCount={items.length} sourceFilename={sourceFilename} warnings={warnings} onLoaded={onLoaded} onClear={onClearAll} />
        <Card>
          <CardContent className="flex flex-col gap-4">
            <MenuToolbar
              count={items.length}
              attentionCount={attentionCount}
              query={query}
              onQueryChange={setQuery}
              onAdd={() => {
                setQuery("");
                setShowAll(true);
                onAddItem();
              }}
              onExport={exportCsv}
              onClearAll={onClearAll}
            />
            <MenuTable
              items={items}
              query={query}
              showAll={showAll}
              onShowAll={() => setShowAll(true)}
              onUpdate={onUpdateItem}
              onDelete={onDeleteItem}
              focusRowId={focusRowId}
            />
            {settings ? (
              <PromptPreview item={items[0]} stylePresetId={settings.stylePresetId} customPrompt={effectiveCustomPrompt(settings)} />
            ) : null}
          </CardContent>
        </Card>
      </div>

      <aside className="flex flex-col gap-6 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
        <SettingsPanel data={models.data} providersById={models.providersById} settings={settings} onChange={onSettingsChange} />
        <EstimateCard
          model={model}
          quality={settings?.quality}
          concurrency={settings?.concurrency ?? 1}
          count={items.length}
          attentionCount={attentionCount}
          missingEnvVar={missingEnvVar}
          maxItemsPerJob={models.data?.maxItemsPerJob ?? null}
          pending={pending}
          loading={models.loading && !models.data}
          onGenerate={onGenerate}
        />
        {models.error ? (
          <p className="text-sm text-destructive" role="alert">
            {models.error}{" "}
            <button type="button" className="underline underline-offset-4" onClick={() => void models.refetch()}>
              Retry
            </button>
          </p>
        ) : null}
      </aside>
    </div>
  );
}
