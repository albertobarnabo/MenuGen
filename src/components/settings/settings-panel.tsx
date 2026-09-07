"use client";

import { useId, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { ImageFormat, ImageSize, ModelSpec, ModelsResponse, ProviderInfo } from "@/lib/types";
import { formatUsd } from "@/lib/cost";
import { CUSTOM_STYLE_PRESET_ID } from "@/lib/prompt";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { ModelSelect } from "@/components/settings/model-select";
import {
  CONCURRENCY_RANGE,
  RETRIES_RANGE,
  applyModelChange,
  type ResolvedSettings,
} from "@/components/settings/settings-utils";
import { formatImageFormat, formatSizeLabel } from "@/components/shared/format";
import { MAX_CUSTOM_PROMPT_LENGTH } from "@/components/shared/limits";
import { cn } from "@/lib/utils";

export interface SettingsPanelProps {
  data: ModelsResponse | null;
  providersById: ReadonlyMap<string, ProviderInfo>;
  settings: ResolvedSettings | null;
  onChange: (next: ResolvedSettings) => void;
}

const FORMATS: ImageFormat[] = ["jpeg", "png", "webp"];

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function selectedString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy aria-label="Loading settings">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  );
}

/** "Generation settings" card: model, quality, style, size, format and an Advanced section. */
export function SettingsPanel({ data, providersById, settings, onChange }: SettingsPanelProps) {
  const uid = useId();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const ids = {
    model: `${uid}-model`,
    quality: `${uid}-quality`,
    style: `${uid}-style`,
    template: `${uid}-template`,
    extra: `${uid}-extra`,
    size: `${uid}-size`,
    format: `${uid}-format`,
    concurrency: `${uid}-concurrency`,
    retries: `${uid}-retries`,
  };

  const model: ModelSpec | undefined = data && settings ? data.models.find((candidate) => candidate.id === settings.modelId) : undefined;
  const preset = data && settings ? data.stylePresets.find((candidate) => candidate.id === settings.stylePresetId) : undefined;
  const isCustom = settings?.stylePresetId === CUSTOM_STYLE_PRESET_ID;

  const update = (patch: Partial<ResolvedSettings>): void => {
    if (settings) onChange({ ...settings, ...patch });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generation settings</CardTitle>
        <CardDescription>Choose a model and a look. Settings are remembered on this device.</CardDescription>
      </CardHeader>
      <CardContent>
        {!data || !settings ? (
          <SettingsSkeleton />
        ) : (
          <div className="flex flex-col gap-5">
            <Field label="Model" htmlFor={ids.model}>
              <ModelSelect
                id={ids.model}
                models={data.models}
                providersById={providersById}
                value={settings.modelId}
                onChange={(next) => onChange(applyModelChange(settings, next))}
              />
            </Field>

            {model?.qualityOptions?.length ? (
              <Field label="Quality" htmlFor={ids.quality}>
                <Select
                  value={settings.quality ?? null}
                  onValueChange={(next: unknown) => {
                    const quality = selectedString(next);
                    if (quality) update({ quality });
                  }}
                >
                  <SelectTrigger id={ids.quality} className="w-full">
                    <SelectValue>
                      {(current: unknown) => {
                        const option = model.qualityOptions?.find((candidate) => candidate.id === selectedString(current));
                        return option ? `${option.label} · ${formatUsd(option.pricePerImageUsd)}` : "Choose quality";
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {model.qualityOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id} label={option.label}>
                        <span className="flex-1">{option.label}</span>
                        <span className="text-muted-foreground tabular-nums">{formatUsd(option.pricePerImageUsd)}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            <Field label="Style" htmlFor={ids.style} hint={preset?.description}>
              <Select
                value={settings.stylePresetId}
                onValueChange={(next: unknown) => {
                  const stylePresetId = selectedString(next);
                  if (stylePresetId) update({ stylePresetId });
                }}
              >
                <SelectTrigger id={ids.style} className="w-full">
                  <SelectValue>
                    {(current: unknown) =>
                      data.stylePresets.find((candidate) => candidate.id === selectedString(current))?.name ?? "Choose a style"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {data.stylePresets.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id} label={candidate.name}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {isCustom ? (
              <Field
                label="Prompt template"
                htmlFor={ids.template}
                hint="Placeholders: {subject}, {dish_name}, {description}, {category}. The no-text clause is not added automatically."
              >
                <Textarea
                  id={ids.template}
                  value={settings.customTemplate}
                  maxLength={MAX_CUSTOM_PROMPT_LENGTH}
                  placeholder={preset?.template}
                  rows={4}
                  onChange={(event) => update({ customTemplate: event.target.value })}
                />
              </Field>
            ) : (
              <Field label="Extra instructions" htmlFor={ids.extra} hint="Optional. Appended to every prompt.">
                <Input
                  id={ids.extra}
                  value={settings.extraInstructions}
                  maxLength={MAX_CUSTOM_PROMPT_LENGTH}
                  placeholder="e.g. served on a slate board"
                  onChange={(event) => update({ extraInstructions: event.target.value })}
                />
              </Field>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
              <Field label="Size" htmlFor={ids.size}>
                <Select
                  value={settings.size}
                  onValueChange={(next: unknown) => {
                    const size = selectedString(next);
                    if (size && model?.sizes.includes(size as ImageSize)) update({ size: size as ImageSize });
                  }}
                >
                  <SelectTrigger id={ids.size} className="w-full">
                    <SelectValue>
                      {(current: unknown) => {
                        const size = selectedString(current);
                        return size ? formatSizeLabel(size as ImageSize) : "Choose a size";
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(model?.sizes ?? [settings.size]).map((size) => (
                      <SelectItem key={size} value={size} label={formatSizeLabel(size)}>
                        {formatSizeLabel(size)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Output format" htmlFor={ids.format}>
                <Select
                  value={settings.format}
                  onValueChange={(next: unknown) => {
                    const format = selectedString(next);
                    if (format && FORMATS.includes(format as ImageFormat)) update({ format: format as ImageFormat });
                  }}
                >
                  <SelectTrigger id={ids.format} className="w-full">
                    <SelectValue>
                      {(current: unknown) => {
                        const format = selectedString(current);
                        return format ? formatImageFormat(format as ImageFormat) : "Choose a format";
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {FORMATS.map((format) => (
                      <SelectItem key={format} value={format} label={formatImageFormat(format)}>
                        <span className="flex-1">{formatImageFormat(format)}</span>
                        {model && !model.nativeFormats.includes(format) ? (
                          <span className="text-xs text-muted-foreground">converted</span>
                        ) : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="flex flex-col gap-4">
              <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-md py-1 text-sm font-medium outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
                <span>Advanced</span>
                <ChevronDownIcon
                  className={cn("size-4 text-muted-foreground transition-transform", advancedOpen && "rotate-180")}
                  aria-hidden
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-5">
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <Label id={ids.concurrency}>Parallel requests</Label>
                    <span className="text-sm text-muted-foreground tabular-nums">{settings.concurrency}</span>
                  </div>
                  <Slider
                    aria-labelledby={ids.concurrency}
                    min={CONCURRENCY_RANGE.min}
                    max={CONCURRENCY_RANGE.max}
                    step={1}
                    value={[settings.concurrency]}
                    onValueChange={(value) => update({ concurrency: Array.isArray(value) ? value[0] : value })}
                  />
                  <p className="text-xs text-muted-foreground">Higher is faster but more likely to hit provider rate limits.</p>
                </div>
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <Label id={ids.retries}>Retries per image</Label>
                    <span className="text-sm text-muted-foreground tabular-nums">{settings.maxRetries}</span>
                  </div>
                  <Slider
                    aria-labelledby={ids.retries}
                    min={RETRIES_RANGE.min}
                    max={RETRIES_RANGE.max}
                    step={1}
                    value={[settings.maxRetries]}
                    onValueChange={(value) => update({ maxRetries: Array.isArray(value) ? value[0] : value })}
                  />
                  <p className="text-xs text-muted-foreground">Retried with back-off on rate limits and transient errors.</p>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
