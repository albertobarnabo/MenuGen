import path from "node:path";

// NOTE: never import this module from client components; it reads secrets.

/**
 * Server-only environment access. Never import this from client components.
 *
 * Next.js loads `.env` automatically. The CLI calls `loadDotEnv()` explicitly.
 */

function str(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined ? fallback : value.trim();
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export const env = {
  get openaiApiKey(): string {
    return str("OPENAI_API_KEY");
  },
  get geminiApiKey(): string {
    return str("GEMINI_API_KEY") || str("GOOGLE_API_KEY");
  },
  get bflApiKey(): string {
    return str("BFL_API_KEY");
  },
  /** Absolute path where jobs and images are stored. */
  get dataDir(): string {
    // turbopackIgnore: the data dir is runtime configuration, not a build-time asset to trace.
    return path.resolve(/* turbopackIgnore: true */ process.cwd(), str("MENUGEN_DATA_DIR", "data"));
  },
  get maxItemsPerJob(): number {
    return int("MENUGEN_MAX_ITEMS_PER_JOB", 500, 1, 5000);
  },
  /** Optional override of the registry default model id. */
  get defaultModelId(): string {
    return str("MENUGEN_DEFAULT_MODEL");
  },
  /** Force the mock model to be listed in the UI even when real providers are configured. */
  get enableMock(): boolean {
    return bool("MENUGEN_ENABLE_MOCK", false);
  },
  /** Optional base URL overrides (proxies, regional endpoints). */
  get openaiBaseUrl(): string {
    return str("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, "");
  },
  get geminiBaseUrl(): string {
    return str("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  },
  get bflBaseUrl(): string {
    return str("BFL_BASE_URL", "https://api.bfl.ai").replace(/\/+$/, "");
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },
};

/**
 * Load `.env` from the current working directory (CLI only; Next.js does this itself).
 * Uses Node's built-in loader, so there is no dotenv dependency. Silently ignores a missing file.
 */
export function loadDotEnv(file = ".env"): void {
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader.call(process, path.resolve(/* turbopackIgnore: true */ process.cwd(), file));
  } catch {
    /* no .env — fine */
  }
}
