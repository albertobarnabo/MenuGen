import type { JobEvent } from "../types";

/**
 * Per-job event bus. The job runner emits `item`/`job`/`log`/`end` events here
 * and the SSE route forwards them to connected browsers.
 */

export type JobEventListener = (event: JobEvent) => void;

export interface JobEventBus {
  emit(event: JobEvent): void;
  /** Returns an unsubscribe function. */
  subscribe(jobId: string, listener: JobEventListener): () => void;
  listenerCount(jobId: string): number;
}

/** The job an event belongs to (`snapshot` events carry the whole job). */
export function jobIdOfEvent(event: JobEvent): string {
  return event.type === "snapshot" ? event.job.id : event.jobId;
}

/** Map-backed bus: synchronous fan-out, listener exceptions are isolated from the emitter. */
class InMemoryJobEventBus implements JobEventBus {
  private readonly listeners = new Map<string, Set<JobEventListener>>();

  emit(event: JobEvent): void {
    const jobId = jobIdOfEvent(event);
    const set = this.listeners.get(jobId);
    if (!set || set.size === 0) return;
    // Copy so listeners may unsubscribe (themselves or others) while we iterate.
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[events] Listener for job "${jobId}" threw while handling "${event.type}":`, error);
      }
    }
  }

  subscribe(jobId: string, listener: JobEventListener): () => void {
    let set = this.listeners.get(jobId);
    if (!set) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(listener);

    return () => {
      const current = this.listeners.get(jobId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(jobId);
    };
  }

  listenerCount(jobId: string): number {
    return this.listeners.get(jobId)?.size ?? 0;
  }
}

const GLOBAL_KEY = "__menugenEventBus";

type GlobalWithBus = typeof globalThis & { [GLOBAL_KEY]?: JobEventBus };

/** Process-wide singleton (cached on globalThis so Next.js dev HMR keeps one instance). */
export function getJobEventBus(): JobEventBus {
  const holder = globalThis as GlobalWithBus;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const bus = new InMemoryJobEventBus();
  holder[GLOBAL_KEY] = bus;
  return bus;
}

/** Drop the cached bus so the next `getJobEventBus()` starts empty (tests only). */
export function __resetJobEventBusForTests(): void {
  delete (globalThis as GlobalWithBus)[GLOBAL_KEY];
}
