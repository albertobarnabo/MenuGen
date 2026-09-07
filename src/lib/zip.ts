import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";
import type { Job, JobItem } from "./types";
import { toFilenameStem } from "./filename";

/**
 * ZIP export (server-only): every generated image plus `manifest.csv` and
 * `prompts.txt`, streamed with archiver so large jobs never sit in memory.
 */

/** Column order of `manifest.csv`. */
export const MANIFEST_COLUMNS = [
  "filename",
  "dish_name",
  "description",
  "category",
  "status",
  "error",
  "attempts",
  "model",
  "quality",
  "size",
  "style",
  "prompt",
  "generated_at",
  "duration_ms",
  "cost_usd",
] as const;

/** Name of the manifest entry inside the ZIP. */
export const MANIFEST_ENTRY_NAME = "manifest.csv";

/** Name of the prompts entry inside the ZIP. */
export const PROMPTS_ENTRY_NAME = "prompts.txt";

/** Stem used in the ZIP name when the job has no source filename. */
export const DEFAULT_ZIP_STEM = "menu";

const UTF8_BOM = "﻿";
const CRLF = "\r\n";
const ZIP_DEFLATE_LEVEL = 6;

/** Quote a CSV field per RFC 4180: wrap in quotes when it contains `,` `"` CR or LF, doubling inner quotes. */
export function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function optionalNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/** One manifest row (unescaped), in {@link MANIFEST_COLUMNS} order. */
function manifestRow(job: Job, item: JobItem): string[] {
  const { settings } = job;
  return [
    item.filename,
    item.dishName,
    item.description,
    item.category,
    item.status,
    item.error ?? "",
    String(item.attempts),
    settings.modelId,
    settings.quality ?? "",
    settings.size,
    settings.stylePresetId,
    item.prompt,
    item.generatedAt ?? "",
    optionalNumber(item.durationMs),
    optionalNumber(item.costUsd),
  ];
}

/**
 * `manifest.csv` for a job: one row per item in job order, RFC 4180 quoting,
 * CRLF line endings and a UTF-8 BOM so Excel opens accented dish names correctly.
 */
export function buildManifestCsv(job: Job): string {
  const lines = [
    MANIFEST_COLUMNS.join(","),
    ...job.items.map((item) => manifestRow(job, item).map(csvEscape).join(",")),
  ];
  return UTF8_BOM + lines.join(CRLF) + CRLF;
}

/** `prompts.txt`: `<filename>: <prompt>` per generated image, one per line. */
export function buildPromptsText(items: readonly JobItem[]): string {
  return items.map((item) => `${item.filename}: ${item.prompt}\n`).join("");
}

/** Slug of the source file's base name without extension; `"menu"` when unknown or empty. */
function sourceStem(sourceFilename: string | undefined): string {
  if (!sourceFilename) return DEFAULT_ZIP_STEM;
  const base = sourceFilename.split(/[\\/]/).pop() ?? "";
  const withoutExtension = base.replace(/\.[^.]*$/, "");
  return withoutExtension.trim() ? toFilenameStem(withoutExtension) : DEFAULT_ZIP_STEM;
}

/** `menugen_<sourceStem>_<jobId8>.zip` (sourceStem falls back to "menu"). */
export function zipFilenameForJob(job: Job): string {
  return `menugen_${sourceStem(job.sourceFilename)}_${job.id.slice(0, 8)}.zip`;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Streaming ZIP (archiver, deflate) containing every done item's image (read from
 * `imagePathFor(item)`) plus manifest.csv. Errors on the stream propagate to the consumer.
 *
 * Items whose `imagePathFor` returns `undefined` (image missing on disk) are
 * skipped; the manifest still lists them. `finalize()` is started immediately
 * so the caller only needs to consume the returned stream.
 */
export function createJobZipStream(job: Job, imagePathFor: (item: JobItem) => string | undefined): Readable {
  const archive = new ZipArchive({ zlib: { level: ZIP_DEFLATE_LEVEL } });
  // archiver downgrades some problems (e.g. a vanished source file) to "warning"; treat them as fatal.
  archive.on("warning", (error) => archive.destroy(toError(error)));

  const doneItems = job.items.filter((item) => item.status === "done");
  for (const item of doneItems) {
    const imagePath = imagePathFor(item);
    if (imagePath) archive.file(imagePath, { name: item.filename });
  }
  archive.append(buildManifestCsv(job), { name: MANIFEST_ENTRY_NAME });
  archive.append(buildPromptsText(doneItems), { name: PROMPTS_ENTRY_NAME });

  // finalize() also rejects when the archive errors; the same error is emitted on the stream,
  // so swallow the rejection here to avoid an unhandled-rejection warning.
  void archive.finalize().catch(() => undefined);
  return archive;
}

/**
 * Write the ZIP to disk (CLI). Returns the final path and size.
 *
 * Creates missing parent directories. On failure the partial file is removed
 * and the error rethrown.
 */
export async function writeJobZip(
  job: Job,
  imagePathFor: (item: JobItem) => string | undefined,
  outPath: string,
): Promise<{ path: string; bytes: number }> {
  const target = path.resolve(outPath);
  await fs.mkdir(path.dirname(target), { recursive: true });

  const output = createWriteStream(target);
  try {
    await pipeline(createJobZipStream(job, imagePathFor), output);
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    throw new Error(`Could not write ZIP to ${target}: ${toError(error).message}`, { cause: error });
  }
  return { path: target, bytes: output.bytesWritten };
}
