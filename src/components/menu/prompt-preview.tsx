"use client";

import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { MenuItem } from "@/lib/types";
import { buildPrompt } from "@/lib/prompt";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface PromptPreviewProps {
  item: MenuItem | undefined;
  stylePresetId: string;
  customPrompt: string | undefined;
}

/** Collapsible showing the exact prompt the first row would send with the current style settings. */
export function PromptPreview({ item, stylePresetId, customPrompt }: PromptPreviewProps) {
  const [open, setOpen] = useState(false);
  const prompt = item ? buildPrompt(item, stylePresetId, customPrompt) : null;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
        <span>
          Prompt preview
          {item ? <span className="font-normal text-muted-foreground"> · {item.dishName.trim() || "first dish"}</span> : null}
        </span>
        <ChevronDownIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-3">
        {prompt ? (
          <pre className="max-h-48 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{prompt}</pre>
        ) : (
          <p className="text-sm text-muted-foreground">Add a dish to preview its prompt.</p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
