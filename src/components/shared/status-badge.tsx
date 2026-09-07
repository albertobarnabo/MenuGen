import type { ComponentProps } from "react";
import type { JobStatus } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_CLASS: Record<JobStatus, string> = {
  queued: "",
  running: "",
  done: "bg-success/15 text-success dark:bg-success/20",
  failed: "",
  cancelled: "",
};

const STATUS_VARIANT: Record<JobStatus, ComponentProps<typeof Badge>["variant"]> = {
  queued: "secondary",
  running: "default",
  done: "outline",
  failed: "destructive",
  cancelled: "secondary",
};

export interface StatusBadgeProps extends Omit<ComponentProps<typeof Badge>, "variant" | "children"> {
  status: JobStatus;
}

/** Job status pill: running uses the primary colour, done the success token, failed destructive, cancelled muted. */
export function StatusBadge({ status, className, ...props }: StatusBadgeProps) {
  return (
    <Badge
      variant={STATUS_VARIANT[status]}
      className={cn(STATUS_CLASS[status], status === "done" && "border-transparent", className)}
      {...props}
    >
      {status === "running" ? <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" /> : null}
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** Human label for a job status. */
export function jobStatusLabel(status: JobStatus): string {
  return STATUS_LABEL[status];
}
