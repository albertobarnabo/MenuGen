"use client";

import { GITHUB_URL } from "@/components/app-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useModels } from "@/hooks/use-models";
import { cn } from "@/lib/utils";

const ARCHITECTURE_URL = `${GITHUB_URL}/blob/main/docs/ARCHITECTURE.md`;

/** Provider status dots (success when the key is present on the server) plus licence note and docs link. */
export function AppFooter() {
  const { data, loading } = useModels();
  const providers = data?.providers.filter((provider) => provider.id !== "mock") ?? [];

  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-6 text-sm text-muted-foreground sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
        <ul aria-label="Provider status" className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {loading && providers.length === 0
            ? Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-4 w-24" />)
            : providers.map((provider) => (
                <li key={provider.id} className="flex items-center gap-1.5">
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50" tabIndex={0} />}
                    >
                      <span
                        aria-hidden
                        className={cn("size-2 rounded-full", provider.configured ? "bg-success" : "bg-muted-foreground/40")}
                      />
                      <span>{provider.name}</span>
                      <span className="sr-only">{provider.configured ? "configured" : "not configured"}</span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {provider.configured ? `${provider.envVar} is set` : `Add ${provider.envVar} to .env to enable`}
                    </TooltipContent>
                  </Tooltip>
                </li>
              ))}
        </ul>
        <p className="text-balance">
          MIT licensed · Generated images come from third-party APIs — review before publishing.{" "}
          <a
            href={ARCHITECTURE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Architecture docs
          </a>
        </p>
      </div>
    </footer>
  );
}
