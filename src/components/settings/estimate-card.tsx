"use client";

import { SparklesIcon } from "lucide-react";
import type { ModelSpec } from "@/lib/types";
import { estimateDurationSeconds, estimateJobCost, formatDuration, formatUsd } from "@/lib/cost";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { pluralize } from "@/components/shared/format";

export interface EstimateCardProps {
  model: ModelSpec | null;
  quality?: string;
  concurrency: number;
  /** Number of rows that would be sent. */
  count: number;
  /** Rows that fail client-side validation. */
  attentionCount: number;
  /** Environment variable to set when the model's provider has no key, or null when configured. */
  missingEnvVar: string | null;
  maxItemsPerJob: number | null;
  /** True while the POST is in flight. */
  pending: boolean;
  /** True while /api/models is loading. */
  loading: boolean;
  onGenerate: () => void;
}

/** Why the Generate button is disabled, or null when it can be clicked. */
function disabledReason(props: EstimateCardProps): string | null {
  if (props.loading) return "Loading models…";
  if (!props.model) return "Choose a model to continue";
  if (props.missingEnvVar) return `Add ${props.missingEnvVar} to .env and restart the server, or pick another model`;
  if (props.count === 0) return "Upload a menu or add a dish to get started";
  if (props.attentionCount > 0) return `${pluralize(props.attentionCount, "dish", "dishes")} need${props.attentionCount === 1 ? "s" : ""} a name before generating`;
  if (props.maxItemsPerJob !== null && props.count > props.maxItemsPerJob) {
    return `This batch has ${props.count} dishes; the limit is ${props.maxItemsPerJob} per batch`;
  }
  return null;
}

/** "N images × price = total", duration hint and the primary Generate button. */
export function EstimateCard(props: EstimateCardProps) {
  const { model, quality, concurrency, count, pending, loading, onGenerate } = props;
  const reason = disabledReason(props);
  const disabled = pending || reason !== null;
  const cost = model ? estimateJobCost(model, count, quality) : null;
  const seconds = model ? estimateDurationSeconds(model, count, concurrency) : 0;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {loading || !model || !cost ? (
          <div className="flex flex-col gap-2" aria-busy>
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
        ) : (
          <dl className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-sm text-muted-foreground">Estimated cost</dt>
              <dd className="text-base font-medium tabular-nums">
                {count > 0 ? (
                  <>
                    <span className="text-muted-foreground">
                      {count} × {formatUsd(cost.perImageUsd)} ={" "}
                    </span>
                    {formatUsd(cost.totalUsd)}
                  </>
                ) : (
                  <span className="text-muted-foreground">{formatUsd(cost.perImageUsd)} per image</span>
                )}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-sm text-muted-foreground">Estimated time</dt>
              <dd className="text-sm tabular-nums">
                {count > 0 ? `~${formatDuration(seconds)} at ${concurrency} in parallel` : "—"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-sm text-muted-foreground">Model</dt>
              <dd className="truncate text-sm">{model.displayName}</dd>
            </div>
          </dl>
        )}

        <Button size="lg" className="w-full" disabled={disabled} onClick={onGenerate}>
          {pending ? <Spinner /> : <SparklesIcon />}
          {pending ? "Starting…" : `Generate ${count > 0 ? pluralize(count, "image") : "images"}`}
        </Button>
        {reason && !pending ? (
          <p className="text-center text-xs text-muted-foreground" role="status">
            {reason}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
