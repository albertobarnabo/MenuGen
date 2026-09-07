"use client";

import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface IconButtonProps extends Omit<ComponentProps<typeof Button>, "aria-label" | "children"> {
  /** Accessible name; also used as the tooltip text. */
  label: string;
  /** Tooltip side. */
  side?: ComponentProps<typeof TooltipContent>["side"];
  children: ReactNode;
}

/**
 * Icon-only button with a mandatory accessible name and a matching tooltip.
 * Defaults to `variant="ghost"` and `size="icon"`.
 */
export function IconButton({ label, side = "top", variant = "ghost", size = "icon", children, ...props }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button aria-label={label} variant={variant} size={size} {...props} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
