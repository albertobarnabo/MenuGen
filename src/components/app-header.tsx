import Link from "next/link";
import { GitHubMark, Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Public repository, also linked from the footer. */
export const GITHUB_URL = "https://github.com/albertobarnabo/MenuGen";

/** Sticky, translucent top bar: mark + wordmark on the left, GitHub and theme toggle on the right. */
export function AppHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Logo className="size-5" />
          </span>
          <span className="truncate font-heading text-base font-semibold tracking-tight">MenuGen</span>
          <span className="hidden truncate text-sm text-muted-foreground md:inline">AI food photos for every dish</span>
        </Link>
        <nav aria-label="Site" className="flex items-center gap-1">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="MenuGen on GitHub"
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
          >
            <GitHubMark className="size-4" />
          </a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
