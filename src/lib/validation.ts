import { z } from "zod";
import type { CreateJobRequest, ImageFormat, ImageSize, ModelSpec, RegenerateItemRequest } from "./types";
import { ValidationError } from "./errors";
import { MODELS, isValidSize, modelSupportsSize } from "./models";
import { STYLE_PRESETS } from "./prompt";

/**
 * Request validation schemas (zod v4).
 *
 * This module is browser-safe: it never reads the environment. Server-only
 * limits (such as the maximum number of items per job) are passed in by the
 * caller so the same schemas can power client-side pre-validation.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Limits
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum length of a client-generated item id. */
export const MAX_ITEM_ID_LENGTH = 64;
/** Maximum length of a dish name after trimming. */
export const MAX_DISH_NAME_LENGTH = 200;
/** Maximum length of a description or category. */
export const MAX_TEXT_FIELD_LENGTH = 1000;
/** Maximum length of a custom prompt / template. */
export const MAX_CUSTOM_PROMPT_LENGTH = 2000;
/** Maximum length of a verbatim prompt override (preset + subject + extra). */
export const MAX_PROMPT_OVERRIDE_LENGTH = 4000;
/** Maximum length of the uploaded file name. */
export const MAX_SOURCE_FILENAME_LENGTH = 255;

export const IMAGE_FORMATS: readonly ImageFormat[] = ["jpeg", "png", "webp"];

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Every Unicode control character (C0, DEL and C1). */
const ALL_CONTROL_CHARS = /\p{Cc}/gu;
/** As above but keeps tab, line feed and carriage return (multi-line text). */
const CONTROL_CHARS_EXCEPT_NEWLINES = /(?![\t\n\r])\p{Cc}/gu;

/** Remove every control character (single-line values such as names and file names). */
export function stripControlChars(value: string): string {
  return value.replace(ALL_CONTROL_CHARS, "");
}

/** Remove control characters but keep line breaks and tabs (multi-line text). */
export function stripControlCharsKeepNewlines(value: string): string {
  return value.replace(CONTROL_CHARS_EXCEPT_NEWLINES, "");
}

/** Single-line, trimmed, control characters removed. */
function singleLine(maxLength: number, label: string) {
  return z
    .string({ error: `${label} must be a string` })
    .overwrite(stripControlChars)
    .trim()
    .max(maxLength, { error: `${label} must be at most ${maxLength} characters` });
}

/** Multi-line text, trimmed, control characters removed, defaults to "". */
function multiLine(maxLength: number, label: string) {
  return z
    .string({ error: `${label} must be a string` })
    .overwrite(stripControlCharsKeepNewlines)
    .trim()
    .max(maxLength, { error: `${label} must be at most ${maxLength} characters` });
}

const imageSizeSchema = z.custom<ImageSize>((value) => typeof value === "string" && isValidSize(value), {
  error: 'Size must look like "<width>x<height>", e.g. "1024x1024"',
});

const imageFormatSchema = z.enum(IMAGE_FORMATS as [ImageFormat, ...ImageFormat[]], {
  error: `Format must be one of ${IMAGE_FORMATS.join(", ")}`,
});

const stylePresetIds = STYLE_PRESETS.map((preset) => preset.id);

const stylePresetIdSchema = z.enum(stylePresetIds, {
  error: `Style preset must be one of ${stylePresetIds.join(", ")}`,
});

// ─────────────────────────────────────────────────────────────────────────────
// Menu items
// ─────────────────────────────────────────────────────────────────────────────

/** One menu row as sent by the client. Dish name is required; other text defaults to "". */
export const menuItemSchema = z.object({
  id: z
    .string({ error: "Item id must be a string" })
    .min(1, { error: "Item id is required" })
    .max(MAX_ITEM_ID_LENGTH, { error: `Item id must be at most ${MAX_ITEM_ID_LENGTH} characters` }),
  dishName: singleLine(MAX_DISH_NAME_LENGTH, "Dish name").min(1, { error: "Dish name is required" }),
  description: multiLine(MAX_TEXT_FIELD_LENGTH, "Description").default(""),
  category: multiLine(MAX_TEXT_FIELD_LENGTH, "Category").default(""),
});

export type MenuItemInput = z.input<typeof menuItemSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Generation settings
// ─────────────────────────────────────────────────────────────────────────────

const generationSettingsShape = z.object({
  modelId: z.string({ error: "Model id must be a string" }).min(1, { error: "Model id is required" }),
  quality: z.string({ error: "Quality must be a string" }).max(64).optional(),
  size: imageSizeSchema,
  format: imageFormatSchema,
  stylePresetId: stylePresetIdSchema,
  customPrompt: multiLine(MAX_CUSTOM_PROMPT_LENGTH, "Custom prompt").optional(),
  concurrency: z
    .number({ error: "Concurrency must be a number" })
    .int({ error: "Concurrency must be an integer" })
    .min(1, { error: "Concurrency must be between 1 and 8" })
    .max(8, { error: "Concurrency must be between 1 and 8" }),
  maxRetries: z
    .number({ error: "Max retries must be a number" })
    .int({ error: "Max retries must be an integer" })
    .min(0, { error: "Max retries must be between 0 and 5" })
    .max(5, { error: "Max retries must be between 0 and 5" }),
});

type GenerationSettingsShape = z.output<typeof generationSettingsShape>;

/** Cross-field checks that need the model registry. */
function checkSettingsAgainstModel(
  models: ReadonlyArray<ModelSpec>,
  settings: GenerationSettingsShape,
  ctx: z.RefinementCtx,
): void {
  const model = models.find((candidate) => candidate.id === settings.modelId);
  if (!model) {
    ctx.addIssue({
      code: "custom",
      path: ["modelId"],
      message: `Unknown model "${settings.modelId}"`,
    });
    return;
  }

  if (!modelSupportsSize(model, settings.size)) {
    ctx.addIssue({
      code: "custom",
      path: ["size"],
      message: `Size "${settings.size}" is not supported by ${model.displayName}; choose one of ${model.sizes.join(", ")}`,
    });
  }

  const qualityIds = model.qualityOptions?.map((option) => option.id) ?? [];
  if (qualityIds.length === 0) {
    if (settings.quality !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["quality"],
        message: `${model.displayName} has no quality setting; omit "quality"`,
      });
    }
  } else if (settings.quality !== undefined && !qualityIds.includes(settings.quality)) {
    ctx.addIssue({
      code: "custom",
      path: ["quality"],
      message: `Quality "${settings.quality}" is not supported by ${model.displayName}; choose one of ${qualityIds.join(", ")}`,
    });
  }
}

/**
 * Schema for `GenerationSettings`, bound to a model registry so that
 * `modelId`, `size` and `quality` are validated against the chosen model.
 */
export function generationSettingsSchema(models: ReadonlyArray<ModelSpec> = MODELS) {
  return generationSettingsShape.superRefine((settings, ctx) => checkSettingsAgainstModel(models, settings, ctx));
}

// ─────────────────────────────────────────────────────────────────────────────
// Requests
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateJobSchemaOptions {
  /** Server-side cap on rows per job (`MENUGEN_MAX_ITEMS_PER_JOB`). */
  maxItems: number;
  /** Model registry to validate against; defaults to the built-in one. */
  models?: ReadonlyArray<ModelSpec>;
}

/** Reject duplicate item ids: they would make item lookups ambiguous. */
function checkUniqueItemIds(items: ReadonlyArray<{ id: string }>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index, "id"],
        message: `Duplicate item id "${item.id}"`,
      });
    }
    seen.add(item.id);
  });
}

/** Schema for `POST /api/jobs` bodies. */
export function createJobRequestSchema({ maxItems, models = MODELS }: CreateJobSchemaOptions) {
  return z
    .object({
      items: z
        .array(menuItemSchema, { error: "Items must be an array" })
        .min(1, { error: "Add at least one menu item" })
        .max(maxItems, { error: `A job may contain at most ${maxItems} items` }),
      settings: generationSettingsSchema(models),
      sourceFilename: singleLine(MAX_SOURCE_FILENAME_LENGTH, "Source file name")
        .optional()
        .transform((value) => (value ? value : undefined)),
    })
    .superRefine((request, ctx) => checkUniqueItemIds(request.items, ctx));
}

/** Schema for `POST /api/jobs/:jobId/items/:itemId/regenerate` bodies (every field optional). */
export const regenerateItemRequestSchema = z.object({
  dishName: singleLine(MAX_DISH_NAME_LENGTH, "Dish name").min(1, { error: "Dish name is required" }).optional(),
  description: multiLine(MAX_TEXT_FIELD_LENGTH, "Description").optional(),
  category: multiLine(MAX_TEXT_FIELD_LENGTH, "Category").optional(),
  promptOverride: multiLine(MAX_PROMPT_OVERRIDE_LENGTH, "Prompt override")
    .optional()
    .transform((value) => (value ? value : undefined)),
});

// ─────────────────────────────────────────────────────────────────────────────
// Parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

/** One validation problem, with a dotted path such as `items.2.dishName`. */
export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

/** Flatten zod issues into a serialisable list. */
export function formatIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
    code: issue.code,
  }));
}

/** One-line summary: the first issue, plus a count of the rest. */
function summarizeIssues(issues: ValidationIssue[]): string {
  const [first, ...rest] = issues;
  if (!first) return "Invalid request";
  const head = first.path ? `${first.path}: ${first.message}` : first.message;
  return rest.length ? `${head} (+${rest.length} more)` : head;
}

/**
 * Parse `data` with `schema`, throwing a `ValidationError` whose `details`
 * is `{ issues: ValidationIssue[] }` when it does not match.
 */
export function parseWith<Schema extends z.ZodType>(schema: Schema, data: unknown): z.output<Schema> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = formatIssues(result.error);
    throw new ValidationError(summarizeIssues(issues), { issues });
  }
  return result.data;
}

/** Validate a `POST /api/jobs` body. */
export function parseCreateJobRequest(data: unknown, options: CreateJobSchemaOptions): CreateJobRequest {
  return parseWith(createJobRequestSchema(options), data);
}

/** Validate a regenerate body; `undefined`/`null` means "no overrides". */
export function parseRegenerateItemRequest(data: unknown): RegenerateItemRequest {
  return parseWith(regenerateItemRequestSchema, data ?? {});
}
