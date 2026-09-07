/**
 * MenuGen command-line interface.
 *
 * ```
 * npm run cli -- models [--json]
 * npm run cli -- generate -i menu.csv [-m <model>] [-o ./output] [--yes] [--json] …
 * ```
 *
 * Exit codes: 0 every image generated, 2 some (or all) images failed,
 * 1 input/configuration error, 130 interrupted with Ctrl-C.
 *
 * Imports are relative (never `@/`) so the script runs under plain `tsx`
 * without alias configuration.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Command, InvalidArgumentError, Option } from "commander";

import type {
  GenerationSettings,
  ImageFormat,
  ImageSize,
  Job,
  JobEvent,
  JobItem,
  JobStats,
  MenuItem,
  ModelSpec,
  ParseResult,
  ProviderInfo,
} from "../lib/types";
import {
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  estimateDurationSeconds,
  estimateJobCost,
  formatDuration,
  formatUsd,
} from "../lib/cost";
import { env, loadDotEnv } from "../lib/env";
import { ValidationError, errorMessage, isAbortError } from "../lib/errors";
import { getJobEventBus } from "../lib/jobs/events";
import { cancelJob, runJob } from "../lib/jobs/runner";
import { getJobStore, type JobStore } from "../lib/jobs/store";
import { DEFAULT_MODEL_ID, MODELS, PROVIDER_META, getModel, isValidSize } from "../lib/models";
import { ParseError, parseMenuFile } from "../lib/parse";
import { DEFAULT_STYLE_PRESET_ID, STYLE_PRESETS, getStylePreset } from "../lib/prompt";
import { listProviderInfo } from "../lib/providers";
import { IMAGE_FORMATS, MAX_CUSTOM_PROMPT_LENGTH } from "../lib/validation";
import { writeJobZip, zipFilenameForJob } from "../lib/zip";
import {
  bulletList,
  createPalette,
  formatBytes,
  formatMs,
  pluralize,
  progressPrefix,
  renderBox,
  renderTable,
  shouldUseColor,
  singleLine,
  truncate,
  type Palette,
  type TableRow,
} from "./format";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & errors
// ─────────────────────────────────────────────────────────────────────────────

/** Every image was generated. */
export const EXIT_OK = 0;
/** Bad input or configuration (unreadable file, unknown model, missing API key …). */
export const EXIT_ERROR = 1;
/** The batch ran but at least one image failed or was cancelled. */
export const EXIT_PARTIAL = 2;
/** Interrupted with Ctrl-C (128 + SIGINT). */
export const EXIT_INTERRUPTED = 130;

/** Rows shown in the pre-flight preview table. */
export const PREVIEW_ROWS = 20;
/** Where the ZIP goes unless `--out` is given. */
export const DEFAULT_OUT_DIR = "./output";
export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_MAX_RETRIES = 3;
export const MIN_RETRIES = 0;
export const MAX_RETRIES = 5;

/** A user-facing failure that maps to a process exit code (message only, no stack trace). */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT_ERROR) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where output goes. Human-readable text (tables, progress, prompts) normally
 * goes to stdout; with `--json` it moves to stderr so stdout carries nothing
 * but the machine-readable document.
 */
export interface Terminal {
  readonly palette: Palette;
  /** Stream used for human-readable output and the confirmation prompt. */
  readonly humanStream: NodeJS.WriteStream;
  /** Human-readable lines. */
  info(...lines: string[]): void;
  /** Human-readable warning lines (yellow). */
  warn(...lines: string[]): void;
  /** Error lines; always stderr, red. */
  error(...lines: string[]): void;
  /** Machine-readable output; always stdout. */
  data(text: string): void;
}

/** Build a {@link Terminal} honouring `--json`, `--no-color`, `NO_COLOR` and TTY detection. */
export function createTerminal(options: { json: boolean; color: boolean }): Terminal {
  const humanStream = options.json ? process.stderr : process.stdout;
  const palette = createPalette(shouldUseColor({ stream: humanStream, colorFlag: options.color }));
  const errorPalette = createPalette(shouldUseColor({ stream: process.stderr, colorFlag: options.color }));
  const writeLines = (stream: NodeJS.WriteStream, lines: string[]): void => {
    if (lines.length > 0) stream.write(`${lines.join("\n")}\n`);
  };
  return {
    palette,
    humanStream,
    info: (...lines) => writeLines(humanStream, lines),
    warn: (...lines) => writeLines(humanStream, lines.map((line) => palette.yellow(line))),
    error: (...lines) => writeLines(process.stderr, lines.map((line) => errorPalette.red(line))),
    data: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
  };
}

/** Flush stdout/stderr, then exit. Guarantees termination even if a library left a handle open. */
function exitAfterFlush(code: number): Promise<never> {
  return new Promise(() => {
    process.stdout.write("", () => {
      process.stderr.write("", () => process.exit(code));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Option parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Commander argument parser for an integer in `[min, max]`. */
export function parseIntInRange(label: string, min: number, max: number): (value: string) => number {
  return (value) => {
    const n = Number(value.trim());
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new InvalidArgumentError(`${label} must be an integer between ${min} and ${max}`);
    }
    return n;
  };
}

/** Commander argument parser for `--size <WxH>`; model support is checked later. */
export function parseSizeArgument(value: string): ImageSize {
  const trimmed = value.trim().toLowerCase().replace("×", "x");
  if (!isValidSize(trimmed)) {
    throw new InvalidArgumentError(`size must look like <width>x<height>, e.g. 1024x1024`);
  }
  return trimmed;
}

/** The version field of the repository's package.json (falls back to 0.0.0 if unreadable). */
export function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.trim() !== "") return version;
    }
  } catch {
    /* fall through to the placeholder */
  }
  return "0.0.0";
}

/** Model id used when `-m` is omitted: `MENUGEN_DEFAULT_MODEL` or the registry default. */
export function defaultModelId(): string {
  return env.defaultModelId || DEFAULT_MODEL_ID;
}

// ─────────────────────────────────────────────────────────────────────────────
// `models` command
// ─────────────────────────────────────────────────────────────────────────────

interface ModelsOptions {
  json: boolean;
  color: boolean;
}

/** One table row for the `models` listing: cells plus dim note lines (description, quality prices, caveats). */
function modelRow(model: ModelSpec, provider: ProviderInfo | undefined, palette: Palette): TableRow {
  const notes: string[] = [singleLine(model.description)];
  if (model.qualityOptions?.length) {
    const options = model.qualityOptions.map((q) => {
      const marker = q.id === model.defaultQuality ? " (default)" : "";
      return `${q.id} ${formatUsd(q.pricePerImageUsd)}${marker}`;
    });
    notes.push(`quality: ${options.join(" · ")}`);
  }
  if (model.priceNotes) notes.push(`price: ${model.priceNotes}`);
  if (model.caveats) notes.push(`caveat: ${singleLine(model.caveats)}`);

  const tags = [...model.tags.map(String)];
  if (model.id === defaultModelId()) tags.push(palette.bold("default"));
  const configured = provider?.configured ?? false;

  return {
    cells: [
      model.id,
      model.displayName,
      PROVIDER_META[model.provider].name,
      formatUsd(model.pricePerImageUsd),
      model.defaultSize,
      tags.join(", "),
      configured ? palette.green("yes") : palette.red("no"),
    ],
    notes,
  };
}

/** One status line per real provider: configured, or which env var to set and where to get a key. */
function providerLines(providers: ProviderInfo[], palette: Palette): string[] {
  return providers
    .filter((provider) => provider.envVar !== "")
    .map((provider) => {
      if (provider.configured) return `  ${palette.green("●")} ${provider.name} — configured (${provider.envVar})`;
      const where = provider.keysUrl ? ` (get a key at ${provider.keysUrl})` : "";
      return `  ${palette.dim("○")} ${provider.name} — not configured: set ${provider.envVar} in .env${where}`;
    });
}

/** `menugen models`: registry table, provider status and style presets (or JSON). */
export function runModels(options: ModelsOptions): void {
  const term = createTerminal(options);
  const providers = listProviderInfo();

  if (options.json) {
    term.data(JSON.stringify({ models: MODELS, providers, stylePresets: STYLE_PRESETS }, null, 2));
    return;
  }

  const { palette } = term;
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const modelRows = MODELS.map((model) => modelRow(model, byId.get(model.provider), palette));
  const presetRows: TableRow[] = STYLE_PRESETS.map((preset) => ({
    cells: [preset.id, preset.name, singleLine(preset.description)],
  }));

  term.info(
    palette.bold("Models"),
    "",
    ...renderTable(["ID", "Name", "Provider", "Price", "Size", "Tags", "Configured"], modelRows, {
      palette,
      align: ["left", "left", "left", "right"],
    }),
    "",
    palette.bold("Providers"),
    ...providerLines(providers, palette),
    "",
    palette.bold("Style presets"),
    "",
    ...renderTable(["ID", "Name", "Description"], presetRows, { palette }),
    "",
    palette.dim(`Default model: ${defaultModelId()} · npm run cli -- generate -i menu.csv -m <id> --style <preset>`),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// `generate` command — input & settings
// ─────────────────────────────────────────────────────────────────────────────

/** Parsed `generate` options (commander fills defaults, argParsers validate ranges). */
export interface GenerateOptions {
  input: string;
  model: string;
  quality?: string;
  size?: ImageSize;
  format: ImageFormat;
  style: string;
  prompt?: string;
  concurrency: number;
  retries: number;
  out: string;
  yes: boolean;
  json: boolean;
  color: boolean;
}

/** Read and parse the menu file; every failure becomes a {@link CliError}. */
export function loadMenu(inputPath: string): ParseResult {
  const resolved = path.resolve(inputPath);
  let data: Uint8Array;
  try {
    data = fs.readFileSync(resolved);
  } catch (error) {
    throw new CliError(`Cannot read "${inputPath}": ${errorMessage(error)}`);
  }
  try {
    return parseMenuFile({ name: path.basename(resolved), data });
  } catch (error) {
    if (error instanceof ParseError) throw new CliError(`Cannot parse "${inputPath}": ${error.message}`);
    throw error;
  }
}

/** Look up a model id, listing the valid ids on failure. `fromEnv` names the env var the id came from. */
export function resolveModel(id: string, fromEnv?: string): ModelSpec {
  const model = getModel(id);
  if (model) return model;
  const origin = fromEnv ? ` (from ${fromEnv})` : "";
  throw new CliError(`Unknown model "${id}"${origin}. Valid model ids:\n${bulletList(MODELS.map((m) => m.id))}`);
}

/** Pick the quality id: the requested one, else the model default; rejects ids the model does not offer. */
export function resolveQuality(model: ModelSpec, requested: string | undefined): string | undefined {
  const options = model.qualityOptions ?? [];
  if (options.length === 0) {
    if (requested !== undefined) throw new CliError(`${model.displayName} has no quality setting; drop --quality`);
    return undefined;
  }
  const quality = requested ?? model.defaultQuality ?? options[0].id;
  if (!options.some((option) => option.id === quality)) {
    const ids = options.map((option) => option.id).join(", ");
    throw new CliError(`Quality "${quality}" is not supported by ${model.displayName}; choose one of ${ids}`);
  }
  return quality;
}

/** Pick the output size: the requested one (must be offered by the model), else the model default. */
export function resolveSize(model: ModelSpec, requested: ImageSize | undefined): ImageSize {
  if (requested === undefined) return model.defaultSize;
  if (!model.sizes.includes(requested)) {
    throw new CliError(
      `Size ${requested} is not supported by ${model.displayName}; choose one of ${model.sizes.join(", ")}`,
    );
  }
  return requested;
}

/** Trim `--prompt`; empty becomes undefined; enforces the shared length limit. */
export function resolveCustomPrompt(prompt: string | undefined): string | undefined {
  const trimmed = prompt?.trim() ?? "";
  if (trimmed === "") return undefined;
  if (trimmed.length > MAX_CUSTOM_PROMPT_LENGTH) {
    throw new CliError(`--prompt is ${trimmed.length} characters; the maximum is ${MAX_CUSTOM_PROMPT_LENGTH}`);
  }
  return trimmed;
}

/** Turn validated CLI options into the shared `GenerationSettings` contract. */
export function buildSettings(options: GenerateOptions, model: ModelSpec): GenerationSettings {
  const preset = getStylePreset(options.style);
  if (!preset) {
    throw new CliError(`Unknown style "${options.style}". Valid presets:\n${bulletList(STYLE_PRESETS.map((p) => p.id))}`);
  }
  const customPrompt = resolveCustomPrompt(options.prompt);
  return {
    modelId: model.id,
    quality: resolveQuality(model, options.quality),
    size: resolveSize(model, options.size),
    format: options.format,
    stylePresetId: preset.id,
    ...(customPrompt === undefined ? {} : { customPrompt }),
    concurrency: options.concurrency,
    maxRetries: options.retries,
  };
}

/** Fail early when the model's provider has no API key, saying exactly which variable to set. */
export function ensureProviderConfigured(model: ModelSpec): void {
  const provider = listProviderInfo().find((candidate) => candidate.id === model.provider);
  if (!provider) throw new CliError(`No provider adapter for "${model.provider}"`);
  if (provider.configured) return;
  const where = provider.keysUrl ? ` (get a key at ${provider.keysUrl})` : "";
  throw new CliError(`${provider.name} is not configured. Set ${provider.envVar} in .env${where}`);
}

/** Create the output directory now so a bad path fails before any money is spent. */
function ensureOutputDir(outDir: string): string {
  const resolved = path.resolve(outDir);
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (error) {
    throw new CliError(`Cannot create output directory "${outDir}": ${errorMessage(error)}`);
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// `generate` command — pre-flight display & confirmation
// ─────────────────────────────────────────────────────────────────────────────

function printPreview(term: Terminal, items: MenuItem[]): void {
  const shown = items.slice(0, PREVIEW_ROWS);
  const rows: TableRow[] = shown.map((item, index) => ({
    cells: [
      String(index + 1),
      truncate(singleLine(item.dishName), 40),
      truncate(singleLine(item.description), 60),
      truncate(singleLine(item.category), 20),
    ],
  }));
  term.info(...renderTable(["#", "Dish", "Description", "Category"], rows, { palette: term.palette, align: ["right"] }));
  if (items.length > shown.length) term.info(term.palette.dim(`… and ${items.length - shown.length} more`));
}

/** "8 images × $0.030 ≈ $0.24 · ~30 s at 3 in parallel" */
export function estimateLine(model: ModelSpec, settings: GenerationSettings, count: number): string {
  const { perImageUsd, totalUsd } = estimateJobCost(model, count, settings.quality);
  const eta = formatDuration(estimateDurationSeconds(model, count, settings.concurrency));
  const etaText = eta.startsWith("~") ? eta : `~${eta}`;
  const cost = totalUsd > 0 ? `× ${formatUsd(perImageUsd)} ≈ ${formatUsd(totalUsd)}` : "· free";
  return `${pluralize(count, "image")} ${cost} · ${etaText} at ${settings.concurrency} in parallel`;
}

function printPlan(term: Terminal, model: ModelSpec, settings: GenerationSettings, count: number): void {
  const { palette } = term;
  const preset = getStylePreset(settings.stylePresetId);
  const quality = settings.quality ? ` · quality ${settings.quality}` : "";
  term.info(
    "",
    `${palette.bold("Model")}  ${model.displayName} ${palette.dim(`(${model.id})`)}${quality}`,
    `${palette.bold("Style")}  ${preset?.name ?? settings.stylePresetId} · ${settings.size} · ${settings.format} · retries ${settings.maxRetries}`,
  );
  if (settings.customPrompt) {
    const label = settings.stylePresetId === "custom" ? "Template" : "Extra";
    term.info(`${palette.bold(label)}  ${truncate(singleLine(settings.customPrompt), 100)}`);
  }
  term.info(palette.cyan(estimateLine(model, settings, count)), "");
}

/**
 * Ask "Generate N images? [y/N]". Skipped with `--yes`; refuses to guess when
 * stdin is not a terminal. Ctrl-C at the prompt exits 130.
 */
export async function confirmGeneration(term: Terminal, count: number, skip: boolean): Promise<boolean> {
  if (skip) return true;
  if (!process.stdin.isTTY) {
    throw new CliError("stdin is not a terminal, so the confirmation prompt cannot be shown. Pass --yes to skip it.");
  }
  const rl = readline.createInterface({ input: process.stdin, output: term.humanStream });
  const controller = new AbortController();
  rl.once("SIGINT", () => controller.abort());
  try {
    const answer = await rl.question(`Generate ${pluralize(count, "image")}? [y/N] `, { signal: controller.signal });
    return /^y(es)?$/i.test(answer.trim());
  } catch (error) {
    if (isAbortError(error)) throw new CliError("Interrupted", EXIT_INTERRUPTED);
    throw error;
  } finally {
    rl.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// `generate` command — running the job
// ─────────────────────────────────────────────────────────────────────────────

/** Progress line for one settled item: `[3/8] ✓ beef_burger.jpg  4.2 s` / `[4/8] ✗ Pad Thai — error`. */
export function itemProgressLine(item: JobItem, stats: JobStats, palette: Palette): string | undefined {
  const finished = stats.done + stats.failed + stats.cancelled;
  const prefix = progressPrefix(finished, stats.total);
  switch (item.status) {
    case "done":
      return `${prefix} ${palette.green("✓")} ${item.filename}  ${palette.dim(formatMs(item.durationMs ?? 0))}`;
    case "failed":
      return `${prefix} ${palette.red("✗")} ${item.dishName} — ${item.error ?? "unknown error"}`;
    case "cancelled":
      return `${prefix} ${palette.dim("–")} ${item.dishName} — ${palette.dim("cancelled")}`;
    default:
      return undefined;
  }
}

/** Event-bus listener that prints progress and retry notices. */
function createProgressPrinter(term: Terminal): (event: JobEvent) => void {
  return (event) => {
    if (event.type === "item") {
      const line = itemProgressLine(event.item, event.stats, term.palette);
      if (line) term.info(line);
    } else if (event.type === "log" && event.level === "warn") {
      term.info(term.palette.dim(`  ↻ ${event.message}`));
    }
  };
}

/**
 * Run the job to completion while streaming progress. Ctrl-C cancels the job
 * (in-flight requests are aborted, pending items marked cancelled) and exits 130.
 */
async function executeJob(term: Terminal, jobId: string): Promise<Job> {
  const unsubscribe = getJobEventBus().subscribe(jobId, createProgressPrinter(term));
  let cancelling: Promise<void> | undefined;

  const onSigint = (): void => {
    if (cancelling) {
      void exitAfterFlush(EXIT_INTERRUPTED);
      return;
    }
    term.info("", term.palette.yellow("Cancelling… (press Ctrl-C again to quit immediately)"));
    cancelling = cancelJob(jobId)
      .then(() => undefined)
      .catch((error: unknown) => term.error(`Cancel failed: ${errorMessage(error)}`));
    void cancelling.then(() => exitAfterFlush(EXIT_INTERRUPTED));
  };
  process.on("SIGINT", onSigint);

  try {
    const job = await runJob(jobId);
    if (cancelling) {
      await cancelling;
      await exitAfterFlush(EXIT_INTERRUPTED);
    }
    return job;
  } finally {
    process.off("SIGINT", onSigint);
    unsubscribe();
  }
}

/** Write `<outDir>/menugen_<stem>_<jobId8>.zip` with every generated image; skipped when nothing succeeded. */
async function packageJob(
  store: JobStore,
  job: Job,
  outDir: string,
): Promise<{ path: string; bytes: number } | undefined> {
  if (job.stats.done === 0) return undefined;
  const imagePaths = new Map<string, string>();
  for (const item of job.items) {
    const imagePath = await store.existingImagePath(job, item.id);
    if (imagePath) imagePaths.set(item.id, imagePath);
  }
  return writeJobZip(job, (item) => imagePaths.get(item.id), path.join(outDir, zipFilenameForJob(job)));
}

/** 0 when every item succeeded, 1 for a job-level error with no output, otherwise 2. */
export function exitCodeForJob(job: Job): number {
  const { stats } = job;
  if (job.status === "done" && stats.failed === 0 && stats.cancelled === 0) return EXIT_OK;
  if (job.error && stats.done === 0) return EXIT_ERROR;
  return EXIT_PARTIAL;
}

function summaryLines(job: Job, zip: { path: string; bytes: number } | undefined, palette: Palette): string[] {
  const { stats } = job;
  const problems: string[] = [];
  if (stats.failed > 0) problems.push(`${stats.failed} failed`);
  if (stats.cancelled > 0) problems.push(`${stats.cancelled} cancelled`);
  const headline = `Generated ${stats.done} of ${pluralize(stats.total, "image")}${problems.length ? ` (${problems.join(", ")})` : ""}`;

  const lines = [
    problems.length === 0 ? palette.green(palette.bold(headline)) : palette.yellow(palette.bold(headline)),
    `Cost      ${formatUsd(stats.actualCostUsd)}`,
    `Elapsed   ${formatMs(stats.elapsedMs)}`,
    zip ? `ZIP       ${zip.path} ${palette.dim(`(${formatBytes(zip.bytes)})`)}` : `ZIP       ${palette.dim("not written — no images were generated")}`,
  ];
  if (job.error) lines.push(palette.red(`Error     ${singleLine(job.error)}`));
  lines.push("", `Batch saved as ${palette.bold(job.id)} — open the web UI to review or regenerate`);
  return lines;
}

/** Machine-readable summary printed by `generate --json`. */
function jsonSummary(job: Job, zip: { path: string; bytes: number } | undefined): Record<string, unknown> {
  return {
    jobId: job.id,
    status: job.status,
    exitCode: exitCodeForJob(job),
    modelId: job.settings.modelId,
    settings: job.settings,
    stats: job.stats,
    error: job.error ?? null,
    zip: zip ?? null,
    items: job.items.map((item) => ({
      id: item.id,
      dishName: item.dishName,
      filename: item.filename,
      status: item.status,
      attempts: item.attempts,
      error: item.error ?? null,
      durationMs: item.durationMs ?? null,
      costUsd: item.costUsd ?? null,
    })),
  };
}

/** `menugen generate`: parse → preview → estimate → confirm → run → ZIP → summary. Resolves to the exit code. */
export async function runGenerate(options: GenerateOptions, modelFromEnv: boolean): Promise<number> {
  const term = createTerminal(options);
  const { palette } = term;

  const model = resolveModel(options.model, modelFromEnv ? "MENUGEN_DEFAULT_MODEL" : undefined);
  const settings = buildSettings(options, model);
  const outDir = ensureOutputDir(options.out);

  const parsed = loadMenu(options.input);
  for (const warning of parsed.warnings) term.warn(`⚠ ${warning.message}`);
  const { items } = parsed;
  if (items.length === 0) throw new CliError(`No menu items found in "${options.input}" (every dish name is empty)`);
  if (items.length > env.maxItemsPerJob) {
    throw new CliError(
      `"${options.input}" has ${items.length} items; the maximum per batch is ${env.maxItemsPerJob} (MENUGEN_MAX_ITEMS_PER_JOB)`,
    );
  }

  term.info(palette.bold(`${path.basename(options.input)} — ${pluralize(items.length, "dish", "dishes")}`), "");
  printPreview(term, items);
  printPlan(term, model, settings, items.length);
  ensureProviderConfigured(model);

  if (!(await confirmGeneration(term, items.length, options.yes))) {
    throw new CliError("Cancelled — nothing was generated.");
  }

  const store = getJobStore();
  await store.init();
  let job: Job;
  try {
    job = await store.create({ items, settings, sourceFilename: path.basename(options.input) });
  } catch (error) {
    if (error instanceof ValidationError) throw new CliError(error.message);
    throw error;
  }
  term.info("", palette.dim(`Job ${job.id} · ${store.dataDir}`));

  const finished = await executeJob(term, job.id);
  const zip = await packageJob(store, finished, outDir);

  if (options.json) {
    term.data(JSON.stringify(jsonSummary(finished, zip), null, 2));
  } else {
    term.info("", ...renderBox(summaryLines(finished, zip, palette), palette));
  }
  return exitCodeForJob(finished);
}

// ─────────────────────────────────────────────────────────────────────────────
// Program
// ─────────────────────────────────────────────────────────────────────────────

/** Add the output flags shared by every command. */
function withOutputOptions(command: Command): Command {
  return command
    .option("--json", "print machine-readable JSON on stdout (human output moves to stderr)", false)
    .option("--no-color", "disable ANSI colours (also honours NO_COLOR)");
}

/** Build the commander program. `exitCode` receives the code the process should end with. */
export function buildProgram(): Command {
  const program = new Command("menugen")
    .description("Turn a menu spreadsheet (CSV/XLSX) into a ZIP of AI-generated dish photos.")
    .version(readPackageVersion(), "-v, --version")
    .showHelpAfterError("(run with --help for usage)");

  withOutputOptions(
    program.command("models").description("List models, prices, configured providers and style presets"),
  ).action((options: ModelsOptions) => runModels(options));

  const generate = program
    .command("generate")
    .description("Generate one photo per menu row and pack them into a ZIP")
    .requiredOption("-i, --input <file>", "menu file (.csv, .tsv, .xlsx, .xls)")
    .option("-m, --model <id>", "model id (see `models`)", defaultModelId())
    .option("-q, --quality <id>", "quality knob for models that have one (e.g. low, medium, high)")
    .option("--size <WxH>", "output size; must be one the model offers (default: the model's default size)", parseSizeArgument)
    .addOption(new Option("--format <format>", "image format written to the ZIP").choices(IMAGE_FORMATS).default("jpeg"))
    .addOption(
      new Option("--style <preset>", "style preset").choices(STYLE_PRESETS.map((p) => p.id)).default(DEFAULT_STYLE_PRESET_ID),
    )
    .option("--prompt <text>", "extra instructions appended to the preset, or the full template with --style custom")
    .option(
      "-c, --concurrency <n>",
      `parallel requests (${MIN_CONCURRENCY}-${MAX_CONCURRENCY})`,
      parseIntInRange("concurrency", MIN_CONCURRENCY, MAX_CONCURRENCY),
      DEFAULT_CONCURRENCY,
    )
    .option(
      "--retries <n>",
      `retries per image on transient errors (${MIN_RETRIES}-${MAX_RETRIES})`,
      parseIntInRange("retries", MIN_RETRIES, MAX_RETRIES),
      DEFAULT_MAX_RETRIES,
    )
    .option("-o, --out <dir>", "directory for the ZIP", DEFAULT_OUT_DIR)
    .option("-y, --yes", "skip the confirmation prompt", false);

  withOutputOptions(generate).action(async (options: GenerateOptions, command: Command) => {
    const modelFromEnv = command.getOptionValueSource("model") === "default" && env.defaultModelId !== "";
    const code = await runGenerate(options, modelFromEnv);
    await exitAfterFlush(code);
  });

  return program;
}

/** Entry point: load `.env`, parse argv, map errors to exit codes. */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  loadDotEnv();
  const colorFlag = argv.includes("--no-color") ? false : undefined;
  const red = createPalette(shouldUseColor({ stream: process.stderr, colorFlag })).red;
  try {
    await buildProgram().parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${red(`Error: ${error.message}`)}\n`);
      await exitAfterFlush(error.exitCode);
    }
    const detail = error instanceof Error && error.stack ? error.stack : errorMessage(error);
    process.stderr.write(`${red("Unexpected error:")} ${detail}\n`);
    await exitAfterFlush(EXIT_ERROR);
  }
}

void main();
