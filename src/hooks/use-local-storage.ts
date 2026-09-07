"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

/** Result tuple of {@link useLocalStorage}. */
export type UseLocalStorageResult<T> = [
  value: T,
  setValue: (next: T | ((previous: T) => T)) => void,
  meta: {
    /** True once the component has hydrated on the client (stored values are visible). */
    hydrated: boolean;
    /** Remove the key and fall back to the initial value. */
    remove: () => void;
  },
];

type Listener = () => void;

/** Same-tab subscribers per key (the `storage` event only fires in *other* tabs). */
const listeners = new Map<string, Set<Listener>>();
/** In-memory fallback when localStorage is unavailable (private mode, quota, SSR). */
const memory = new Map<string, string>();

function notify(key: string): void {
  listeners.get(key)?.forEach((listener) => listener());
}

function subscribe(key: string, listener: Listener): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === key) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
    window.removeEventListener("storage", onStorage);
  };
}

/** Raw stored string for `key` (localStorage first, memory fallback), or null. */
function readRaw(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) return raw;
  } catch {
    /* storage unavailable */
  }
  return memory.get(key) ?? null;
}

function writeRaw(key: string, raw: string | null): void {
  try {
    if (raw === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, raw);
  } catch {
    /* quota / private mode: keep the in-memory copy only */
  }
  if (raw === null) memory.delete(key);
  else memory.set(key, raw);
  notify(key);
}

function parse<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const getServerRaw = (): null => null;
const subscribeNoop = (): (() => void) => () => {};
const getHydratedClient = (): boolean => true;
const getHydratedServer = (): boolean => false;

/**
 * `useState` mirrored into `localStorage`, implemented on `useSyncExternalStore`
 * so server and client markup match (the server snapshot is always the initial
 * value) and updates from other tabs are picked up. Every storage access is
 * wrapped in try/catch with an in-memory fallback.
 */
export function useLocalStorage<T>(key: string, initialValue: T): UseLocalStorageResult<T> {
  const subscribeKey = useCallback((listener: Listener) => subscribe(key, listener), [key]);
  const getRaw = useCallback(() => readRaw(key), [key]);
  const raw = useSyncExternalStore(subscribeKey, getRaw, getServerRaw);
  const hydrated = useSyncExternalStore(subscribeNoop, getHydratedClient, getHydratedServer);

  const value = useMemo(() => parse(raw, initialValue), [raw, initialValue]);

  const setValue = useCallback(
    (next: T | ((previous: T) => T)) => {
      const previous = parse(readRaw(key), initialValue);
      const resolved = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
      writeRaw(key, JSON.stringify(resolved));
    },
    [key, initialValue],
  );

  const remove = useCallback(() => writeRaw(key, null), [key]);

  return [value, setValue, { hydrated, remove }];
}
