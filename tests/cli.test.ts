import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end tests for `src/cli/index.ts`, run as a child process through tsx
 * exactly like `npm run cli`. The mock provider is used throughout, so nothing
 * touches the network; job data and ZIPs go to a temp directory.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_TIMEOUT = 90_000;
/** Leave the test a few seconds to report before vitest's own timeout fires. */
const PROCESS_TIMEOUT = TEST_TIMEOUT - 5_000;

const SAMPLE_CSV = [
  "dish_name,description,category",
  'Beef Burger,"Double patty, cheddar, lettuce, pickles",burger',
  'Tiramisu,"Mascarpone cream, espresso-soaked ladyfingers",dessert',
  "",
].join("\n");

/** Extra variables for a CLI child process (plain record: Next.js types NODE_ENV as required on ProcessEnv). */
type EnvOverrides = Record<string, string | undefined>;

let tmpDir: string;
let dataDir: string;
let menuCsv: string;

/** Environment for a CLI child: isolated data dir, colours off, no real provider keys required. */
function cliEnv(extra: EnvOverrides = {}): NodeJS.ProcessEnv {
  return { ...process.env, MENUGEN_DATA_DIR: dataDir, NO_COLOR: "1", MENUGEN_DEFAULT_MODEL: "", ...extra };
}

/** Run the CLI and capture status/stdout/stderr without throwing. */
function runCli(args: string[], env: EnvOverrides = {}): SpawnSyncReturns<string> {
  return spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: cliEnv(env),
    timeout: PROCESS_TIMEOUT,
  });
}

/** Run the CLI expecting exit 0; returns stdout (throws with stderr attached otherwise). */
function runCliOk(args: string[], env: EnvOverrides = {}): string {
  return execFileSync("npx", ["tsx", "src/cli/index.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: cliEnv(env),
    timeout: PROCESS_TIMEOUT,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function freshOutDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function zipFilesIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((file) => file.endsWith(".zip"));
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "menugen-"));
  dataDir = path.join(tmpDir, "data");
  menuCsv = path.join(tmpDir, "menu.csv");
  fs.writeFileSync(menuCsv, SAMPLE_CSV, "utf8");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("menugen models", () => {
  it(
    "--json prints the registry, providers and style presets",
    () => {
      const stdout = runCliOk(["models", "--json"]);
      const payload = JSON.parse(stdout) as {
        models: Array<{ id: string; provider: string }>;
        providers: Array<{ id: string; configured: boolean; envVar: string }>;
        stylePresets: Array<{ id: string }>;
      };

      expect(payload.models.map((m) => m.id)).toContain("mock/sample");
      expect(payload.providers.map((p) => p.id)).toEqual(expect.arrayContaining(["openai", "google", "bfl", "mock"]));
      expect(payload.providers.find((p) => p.id === "mock")?.configured).toBe(true);
      expect(payload.stylePresets.map((p) => p.id)).toContain("editorial");
      // Keys never leave the server: only the env var *name* is exposed.
      expect(stdout).not.toMatch(/API_KEY=\S/);
    },
    TEST_TIMEOUT,
  );

  it(
    "prints a human-readable table with provider status and presets",
    () => {
      const stdout = runCliOk(["models"]);
      expect(stdout).toContain("mock/sample");
      expect(stdout).toContain("Mock (sample photos)");
      expect(stdout).toContain("Style presets");
      expect(stdout).toContain("editorial");
      expect(stdout).toContain("OPENAI_API_KEY");
      // NO_COLOR=1 → no escape codes.
      expect(stdout).not.toContain("\u001b[");
    },
    TEST_TIMEOUT,
  );
});

describe("menugen generate", () => {
  it(
    "generates every dish with the mock provider and writes a ZIP",
    () => {
      const outDir = freshOutDir("out-plain");
      const stdout = runCliOk(["generate", "-i", menuCsv, "-m", "mock/sample", "-y", "-o", outDir]);

      // Preview + estimate.
      expect(stdout).toContain("Beef Burger");
      expect(stdout).toContain("2 images");
      // Progress lines.
      expect(stdout).toMatch(/\[\d\/2\] ✓ beef_burger\.jpg/);
      expect(stdout).toMatch(/\[\d\/2\] ✓ tiramisu\.jpg/);
      // Summary box.
      expect(stdout).toContain("Generated 2 of 2 images");
      expect(stdout).toContain("Batch saved as");

      const zips = zipFilesIn(outDir);
      expect(zips).toHaveLength(1);
      expect(zips[0]).toMatch(/^menugen_menu_[A-Za-z0-9-]+\.zip$/);
      expect(fs.statSync(path.join(outDir, zips[0])).size).toBeGreaterThan(1_000);

      // The job was persisted to MENUGEN_DATA_DIR so the web UI can show it.
      const jobDirs = fs.readdirSync(path.join(dataDir, "jobs"));
      expect(jobDirs.length).toBeGreaterThanOrEqual(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "--json keeps stdout machine-readable",
    () => {
      const outDir = freshOutDir("out-json");
      const result = runCli(["generate", "-i", menuCsv, "-m", "mock/sample", "-y", "-o", outDir, "--json"]);
      expect(result.status, result.stderr).toBe(0);

      const summary = JSON.parse(result.stdout) as {
        jobId: string;
        status: string;
        exitCode: number;
        stats: { total: number; done: number; failed: number };
        zip: { path: string; bytes: number } | null;
        items: Array<{ filename: string; status: string }>;
      };
      expect(summary.status).toBe("done");
      expect(summary.exitCode).toBe(0);
      expect(summary.stats).toMatchObject({ total: 2, done: 2, failed: 0 });
      expect(summary.items.map((item) => item.filename).sort()).toEqual(["beef_burger.jpg", "tiramisu.jpg"]);
      expect(summary.zip).not.toBeNull();
      expect(fs.existsSync(summary.zip?.path ?? "")).toBe(true);
      expect(path.dirname(summary.zip?.path ?? "")).toBe(outDir);
      // Human output moved to stderr.
      expect(result.stderr).toContain("beef_burger.jpg");
    },
    TEST_TIMEOUT,
  );

  it(
    "exits 2 when some images fail",
    () => {
      const outDir = freshOutDir("out-partial");
      const csv = path.join(tmpDir, "partial.csv");
      fs.writeFileSync(csv, "dish_name\nBeef Burger\nPad Thai [fatal]\n", "utf8");

      const result = runCli(["generate", "-i", csv, "-m", "mock/sample", "-y", "-o", outDir, "--retries", "0"]);
      expect(result.status, result.stderr).toBe(2);
      expect(result.stdout).toMatch(/✗ Pad Thai \[fatal\] — /);
      expect(result.stdout).toContain("Generated 1 of 2 images (1 failed)");
      expect(zipFilesIn(outDir)).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects an unknown model with exit 1 and lists the valid ids",
    () => {
      const result = runCli(["generate", "-i", menuCsv, "-m", "nope/unknown", "-y", "-o", freshOutDir("out-unknown")]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unknown model "nope/unknown"');
      expect(result.stderr).toContain("mock/sample");
      expect(zipFilesIn(path.join(tmpDir, "out-unknown"))).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects a size the model does not offer",
    () => {
      const result = runCli(["generate", "-i", menuCsv, "-m", "mock/sample", "--size", "512x512", "-y"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("512x512");
      expect(result.stderr).toContain("1024x1024");
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses to run without --yes when stdin is not a terminal",
    () => {
      const result = runCli(["generate", "-i", menuCsv, "-m", "mock/sample", "-o", freshOutDir("out-notty")]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--yes");
      expect(zipFilesIn(path.join(tmpDir, "out-notty"))).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "fails fast on a missing input file",
    () => {
      const result = runCli(["generate", "-i", path.join(tmpDir, "missing.csv"), "-m", "mock/sample", "-y"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing.csv");
    },
    TEST_TIMEOUT,
  );
});
