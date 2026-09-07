"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { JobSummary, MenuItem, ParseResult, ParseWarning } from "@/lib/types";
import { ComposeView } from "@/components/compose-view";
import { ResultsView } from "@/components/results/results-view";
import { ResumeBanner } from "@/components/resume-banner";
import {
  SETTINGS_STORAGE_KEY,
  reconcileSettings,
  toGenerationSettings,
  type ResolvedSettings,
  type StoredSettings,
} from "@/components/settings/settings-utils";
import { createJob, listJobs } from "@/components/shared/api";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useModels } from "@/hooks/use-models";

export interface WorkspaceProps {
  /** `?job=<id>` read by the server page, so the results view renders on first paint. */
  initialJobId: string | null;
}

const JOB_PARAM = "job";
const DISMISSED_KEY = "menugen.resume.dismissed";

function readJobFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(JOB_PARAM);
}

function writeJobToLocation(jobId: string | null): void {
  const url = new URL(window.location.href);
  if (jobId) url.searchParams.set(JOB_PARAM, jobId);
  else url.searchParams.delete(JOB_PARAM);
  window.history.replaceState(window.history.state, "", url);
}

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(jobId: string): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, jobId);
  } catch {
    /* ignore */
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function trimItem(item: MenuItem): MenuItem {
  return { id: item.id, dishName: item.dishName.trim(), description: item.description.trim(), category: item.category.trim() };
}

/**
 * Single-page state machine: compose (upload → edit → settings → generate)
 * or results (live job) depending on whether a job id is active. The active
 * job is mirrored into `?job=` and settings persist in localStorage.
 */
export function Workspace({ initialJobId }: WorkspaceProps) {
  const models = useModels();

  const [items, setItems] = useState<MenuItem[]>([]);
  const [sourceFilename, setSourceFilename] = useState<string | undefined>(undefined);
  const [warnings, setWarnings] = useState<ParseWarning[]>([]);
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [activeJobId, setActiveJobId] = useState<string | null>(() => initialJobId ?? readJobFromLocation());
  const [latestJob, setLatestJob] = useState<JobSummary | null>(null);
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readDismissed(),
  );

  const [stored, setStored, { hydrated }] = useLocalStorage<StoredSettings | null>(SETTINGS_STORAGE_KEY, null);
  const settings = useMemo<ResolvedSettings | null>(
    () => (models.data && hydrated ? reconcileSettings(stored, models.data) : null),
    [models.data, hydrated, stored],
  );

  const setActiveJob = useCallback((jobId: string | null) => {
    setActiveJobId(jobId);
    writeJobToLocation(jobId);
  }, []);

  // Keep state in sync with browser navigation.
  useEffect(() => {
    const onPopState = (): void => setActiveJobId(readJobFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Offer to resume the most recent batch when landing on the compose view.
  useEffect(() => {
    if (initialJobId) return undefined;
    const controller = new AbortController();
    listJobs(1, controller.signal)
      .then(({ jobs }) => setLatestJob(jobs[0] ?? null))
      .catch(() => {
        /* the banner is optional; the compose view still works */
      });
    return () => controller.abort();
  }, [initialJobId]);

  const onLoaded = useCallback((result: ParseResult, filename: string) => {
    setItems(result.items);
    setWarnings(result.warnings);
    setSourceFilename(filename);
    setFocusRowId(null);
  }, []);

  const onClearAll = useCallback(() => {
    setItems([]);
    setWarnings([]);
    setSourceFilename(undefined);
    setFocusRowId(null);
  }, []);

  const onUpdateItem = useCallback((id: string, patch: Partial<Omit<MenuItem, "id">>) => {
    setItems((previous) => previous.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const onDeleteItem = useCallback((id: string) => {
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const onAddItem = useCallback(() => {
    const id = newId();
    setItems((previous) => [...previous, { id, dishName: "", description: "", category: "" }]);
    setFocusRowId(id);
  }, []);

  const generate = useCallback(async () => {
    if (!settings || pending) return;
    setPending(true);
    try {
      const { job } = await createJob({
        items: items.map(trimItem),
        settings: toGenerationSettings(settings),
        sourceFilename,
      });
      setLatestJob(null);
      setActiveJob(job.id);
    } catch (cause) {
      toast.error("Could not start the batch", {
        description: cause instanceof Error ? cause.message : "Try again in a moment.",
      });
    } finally {
      setPending(false);
    }
  }, [settings, pending, items, sourceFilename, setActiveJob]);

  const leaveResults = useCallback(() => setActiveJob(null), [setActiveJob]);

  const onDeleted = useCallback(() => {
    setLatestJob((current) => (current?.id === activeJobId ? null : current));
    setActiveJob(null);
  }, [activeJobId, setActiveJob]);

  if (activeJobId) {
    return <ResultsView jobId={activeJobId} models={models} onNewBatch={leaveResults} onDeleted={onDeleted} />;
  }

  const showResume = latestJob !== null && latestJob.id !== dismissedJobId;

  return (
    <div className="flex flex-col gap-6">
      {showResume ? (
        <ResumeBanner
          job={latestJob}
          modelName={models.modelsById.get(latestJob.modelId)?.displayName ?? latestJob.modelId}
          onOpen={() => setActiveJob(latestJob.id)}
          onDismiss={() => {
            writeDismissed(latestJob.id);
            setDismissedJobId(latestJob.id);
          }}
        />
      ) : null}
      <ComposeView
        models={models}
        items={items}
        sourceFilename={sourceFilename}
        warnings={warnings}
        focusRowId={focusRowId}
        settings={settings}
        pending={pending}
        onLoaded={onLoaded}
        onClearAll={onClearAll}
        onUpdateItem={onUpdateItem}
        onDeleteItem={onDeleteItem}
        onAddItem={onAddItem}
        onSettingsChange={setStored}
        onGenerate={() => void generate()}
      />
    </div>
  );
}
