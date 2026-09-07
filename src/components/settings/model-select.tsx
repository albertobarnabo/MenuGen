"use client";

import { useMemo } from "react";
import { ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import type { ModelSpec, ProviderId, ProviderInfo } from "@/lib/types";
import { PROVIDER_META, priceForQuality } from "@/lib/models";
import { formatUsd } from "@/lib/cost";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TAG_LABELS, isModelUsable } from "@/components/settings/settings-utils";

export interface ModelSelectProps {
  id: string;
  models: ModelSpec[];
  providersById: ReadonlyMap<string, ProviderInfo>;
  value: string;
  onChange: (model: ModelSpec) => void;
  disabled?: boolean;
}

interface ProviderGroup {
  id: ProviderId;
  name: string;
  info: ProviderInfo | undefined;
  configured: boolean;
  models: ModelSpec[];
}

/** Group models by provider (first-seen order) and sort each group by price. */
function groupByProvider(models: ModelSpec[], providersById: ReadonlyMap<string, ProviderInfo>): ProviderGroup[] {
  const groups = new Map<ProviderId, ProviderGroup>();
  for (const model of models) {
    const group = groups.get(model.provider);
    if (group) {
      group.models.push(model);
      continue;
    }
    const info = providersById.get(model.provider);
    groups.set(model.provider, {
      id: model.provider,
      name: info?.name ?? PROVIDER_META[model.provider]?.name ?? model.provider,
      info,
      configured: isModelUsable(model, providersById),
      models: [model],
    });
  }
  for (const group of groups.values()) {
    group.models.sort((a, b) => priceForQuality(a) - priceForQuality(b));
  }
  return [...groups.values()];
}

/** Model picker grouped by provider with price and tag badges; unconfigured providers are disabled with a key hint. */
export function ModelSelect({ id, models, providersById, value, onChange, disabled }: ModelSelectProps) {
  const groups = useMemo(() => groupByProvider(models, providersById), [models, providersById]);
  const modelsById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const selected = modelsById.get(value);

  return (
    <div className="flex flex-col gap-2">
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next: unknown) => {
          const model = typeof next === "string" ? modelsById.get(next) : undefined;
          if (model) onChange(model);
        }}
      >
        <SelectTrigger id={id} className="w-full" aria-label="Model">
          <SelectValue>
            {(current: unknown) => (typeof current === "string" ? (modelsById.get(current)?.displayName ?? current) : "Choose a model")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="w-auto min-w-(--anchor-width) max-w-[min(28rem,calc(100vw-2rem))]">
          {groups.map((group) => (
            <SelectGroup key={group.id}>
              <SelectLabel className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                <span>{group.name}</span>
                {!group.configured && group.info ? (
                  <a
                    href={group.info.keysUrl || undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-warning underline-offset-4 hover:underline"
                  >
                    Add {group.info.envVar} to .env
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : null}
              </SelectLabel>
              {group.models.map((model) => (
                <SelectItem key={model.id} value={model.id} label={model.displayName} disabled={!group.configured}>
                  <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Badge variant="outline" className="tabular-nums">
                      {formatUsd(priceForQuality(model))}
                    </Badge>
                    {model.tags.map((tag) => (
                      <Badge key={tag} variant={tag === "recommended" ? "default" : "secondary"}>
                        {TAG_LABELS[tag]}
                      </Badge>
                    ))}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>

      {selected ? (
        <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          <p>
            {selected.description}
            {selected.priceNotes ? <span className="text-muted-foreground/80"> Price: {selected.priceNotes}.</span> : null}
          </p>
          {selected.caveats ? (
            <p className="flex items-start gap-1.5 text-warning">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{selected.caveats}</span>
            </p>
          ) : null}
          {selected.docsUrl ? (
            <a
              href={selected.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-fit items-center gap-1 underline underline-offset-4 hover:text-foreground"
            >
              Model docs
              <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
