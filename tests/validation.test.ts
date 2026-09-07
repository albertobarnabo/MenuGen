import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ValidationError } from "@/lib/errors";
import { MODELS, requireModel } from "@/lib/models";
import { STYLE_PRESETS } from "@/lib/prompt";
import type { GenerationSettings } from "@/lib/types";
import {
  MAX_CUSTOM_PROMPT_LENGTH,
  MAX_DISH_NAME_LENGTH,
  MAX_ITEM_ID_LENGTH,
  MAX_SOURCE_FILENAME_LENGTH,
  MAX_TEXT_FIELD_LENGTH,
  createJobRequestSchema,
  formatIssues,
  generationSettingsSchema,
  menuItemSchema,
  parseCreateJobRequest,
  parseRegenerateItemRequest,
  parseWith,
  regenerateItemRequestSchema,
  stripControlChars,
  stripControlCharsKeepNewlines,
  type ValidationIssue,
} from "@/lib/validation";

const MOCK_MODEL_ID = "mock/sample";

/** Any registry model with a quality knob, plus one of its quality ids and one it lacks. */
const qualityModel = MODELS.find((model) => (model.qualityOptions?.length ?? 0) > 0);
if (!qualityModel?.qualityOptions?.length) throw new Error("Test fixture: registry has no model with qualityOptions");
const QUALITY_MODEL_ID = qualityModel.id;
const KNOWN_QUALITY = qualityModel.qualityOptions[0].id;
const UNKNOWN_QUALITY = "ultra-mega";

/** A settings object that is valid for the mock model. */
function mockSettings(overrides: Partial<GenerationSettings> = {}): GenerationSettings {
  return {
    modelId: MOCK_MODEL_ID,
    size: "1024x1024",
    format: "jpeg",
    stylePresetId: "editorial",
    concurrency: 3,
    maxRetries: 3,
    ...overrides,
  };
}

function validItem(id = "item-1", dishName = "Beef Burger") {
  return { id, dishName, description: "Double patty", category: "burger" };
}

/** Dotted paths of every issue produced for `data`, or `[]` when it is valid. */
function issuePaths(schema: z.ZodType, data: unknown): string[] {
  const result = schema.safeParse(data);
  return result.success ? [] : formatIssues(result.error).map((issue) => issue.path);
}

describe("stripControlChars", () => {
  it("removes C0, DEL and C1 control characters", () => {
    expect(stripControlChars("a\u0000b\u001fc\u007fd\u0085e")).toBe("abcde");
  });

  it("keeps tabs and line breaks in the multi-line variant", () => {
    expect(stripControlCharsKeepNewlines("a\tb\nc\r\nd\u0001e")).toBe("a\tb\nc\r\nde");
  });

  it("leaves ordinary text and accents untouched", () => {
    expect(stripControlChars("Crème Brûlée — 🍮")).toBe("Crème Brûlée — 🍮");
  });
});

describe("menuItemSchema", () => {
  it("accepts a well-formed item", () => {
    expect(menuItemSchema.parse(validItem())).toEqual(validItem());
  });

  it("trims the dish name, strips control characters and defaults text fields to empty strings", () => {
    const parsed = menuItemSchema.parse({ id: "x", dishName: "  Pad Thai\u0007  " });
    expect(parsed).toEqual({ id: "x", dishName: "Pad Thai", description: "", category: "" });
  });

  it("rejects an empty or whitespace-only dish name", () => {
    expect(issuePaths(menuItemSchema, { id: "x", dishName: "" })).toEqual(["dishName"]);
    expect(issuePaths(menuItemSchema, { id: "x", dishName: "   " })).toEqual(["dishName"]);
  });

  it("rejects a missing or empty id", () => {
    expect(issuePaths(menuItemSchema, { dishName: "Soup" })).toEqual(["id"]);
    expect(issuePaths(menuItemSchema, { id: "", dishName: "Soup" })).toEqual(["id"]);
  });

  it("enforces the length limits", () => {
    expect(issuePaths(menuItemSchema, { id: "i".repeat(MAX_ITEM_ID_LENGTH + 1), dishName: "Soup" })).toEqual(["id"]);
    expect(issuePaths(menuItemSchema, { id: "x", dishName: "d".repeat(MAX_DISH_NAME_LENGTH + 1) })).toEqual([
      "dishName",
    ]);
    expect(
      issuePaths(menuItemSchema, { id: "x", dishName: "Soup", description: "d".repeat(MAX_TEXT_FIELD_LENGTH + 1) }),
    ).toEqual(["description"]);
    expect(
      issuePaths(menuItemSchema, { id: "x", dishName: "Soup", category: "c".repeat(MAX_TEXT_FIELD_LENGTH + 1) }),
    ).toEqual(["category"]);
  });

  it("rejects non-string fields", () => {
    expect(issuePaths(menuItemSchema, { id: 1, dishName: 2, description: 3 })).toEqual(["id", "dishName", "description"]);
  });
});

describe("generationSettingsSchema", () => {
  const schema = generationSettingsSchema();

  it("accepts valid settings for the mock model", () => {
    expect(schema.parse(mockSettings())).toEqual(mockSettings());
  });

  it("accepts a valid quality for a model that has quality options", () => {
    const settings = mockSettings({ modelId: QUALITY_MODEL_ID, quality: KNOWN_QUALITY, size: qualityModel.defaultSize });
    expect(schema.parse(settings)).toEqual(settings);
  });

  it("rejects an unknown model id", () => {
    expect(issuePaths(schema, mockSettings({ modelId: "acme/unknown" }))).toEqual(["modelId"]);
  });

  it("rejects a size the model does not support", () => {
    const model = requireModel(MOCK_MODEL_ID);
    expect(model.sizes).not.toContain("512x512");
    expect(issuePaths(schema, mockSettings({ size: "512x512" }))).toEqual(["size"]);
  });

  it("rejects a malformed size", () => {
    expect(issuePaths(schema, { ...mockSettings(), size: "big" })).toEqual(["size"]);
  });

  it("rejects a quality on a model without quality options", () => {
    expect(issuePaths(schema, mockSettings({ quality: "high" }))).toEqual(["quality"]);
  });

  it("rejects a quality the model does not offer", () => {
    const settings = mockSettings({ modelId: QUALITY_MODEL_ID, quality: UNKNOWN_QUALITY, size: qualityModel.defaultSize });
    expect(issuePaths(schema, settings)).toEqual(["quality"]);
  });

  it("accepts an omitted quality on a model with quality options", () => {
    expect(issuePaths(schema, mockSettings({ modelId: QUALITY_MODEL_ID, size: qualityModel.defaultSize }))).toEqual([]);
  });

  it("rejects an unknown format", () => {
    expect(issuePaths(schema, { ...mockSettings(), format: "gif" })).toEqual(["format"]);
  });

  it("rejects concurrency outside 1–8 or non-integers", () => {
    expect(issuePaths(schema, mockSettings({ concurrency: 0 }))).toEqual(["concurrency"]);
    expect(issuePaths(schema, mockSettings({ concurrency: 9 }))).toEqual(["concurrency"]);
    expect(issuePaths(schema, mockSettings({ concurrency: 2.5 }))).toEqual(["concurrency"]);
    expect(issuePaths(schema, mockSettings({ concurrency: 8 }))).toEqual([]);
  });

  it("rejects maxRetries outside 0–5", () => {
    expect(issuePaths(schema, mockSettings({ maxRetries: -1 }))).toEqual(["maxRetries"]);
    expect(issuePaths(schema, mockSettings({ maxRetries: 6 }))).toEqual(["maxRetries"]);
    expect(issuePaths(schema, mockSettings({ maxRetries: 0 }))).toEqual([]);
  });

  it("accepts every registered style preset and rejects unknown ones", () => {
    for (const preset of STYLE_PRESETS) {
      expect(issuePaths(schema, mockSettings({ stylePresetId: preset.id }))).toEqual([]);
    }
    expect(issuePaths(schema, mockSettings({ stylePresetId: "noir" }))).toEqual(["stylePresetId"]);
  });

  it("caps the custom prompt length", () => {
    expect(issuePaths(schema, mockSettings({ customPrompt: "x".repeat(MAX_CUSTOM_PROMPT_LENGTH) }))).toEqual([]);
    expect(issuePaths(schema, mockSettings({ customPrompt: "x".repeat(MAX_CUSTOM_PROMPT_LENGTH + 1) }))).toEqual([
      "customPrompt",
    ]);
  });

  it("reports several cross-field problems at once", () => {
    const paths = issuePaths(schema, mockSettings({ size: "512x512", quality: "high" }));
    expect(paths).toEqual(["size", "quality"]);
  });

  it("validates against the registry it is given", () => {
    const withoutMock = generationSettingsSchema(MODELS.filter((model) => model.provider !== "mock"));
    expect(issuePaths(withoutMock, mockSettings())).toEqual(["modelId"]);
  });
});

describe("createJobRequestSchema", () => {
  const schema = createJobRequestSchema({ maxItems: 3 });

  it("accepts a valid request and normalises the source file name", () => {
    const parsed = schema.parse({
      items: [validItem("a"), validItem("b", "Tiramisu")],
      settings: mockSettings(),
      sourceFilename: "  menu\u0000.csv  ",
    });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.sourceFilename).toBe("menu.csv");
  });

  it("turns an empty source file name into undefined", () => {
    const parsed = schema.parse({ items: [validItem()], settings: mockSettings(), sourceFilename: "   " });
    expect(parsed.sourceFilename).toBeUndefined();
  });

  it("requires at least one item", () => {
    expect(issuePaths(schema, { items: [], settings: mockSettings() })).toEqual(["items"]);
  });

  it("enforces the maximum number of items", () => {
    const items = ["a", "b", "c", "d"].map((id) => validItem(id));
    expect(issuePaths(schema, { items, settings: mockSettings() })).toEqual(["items"]);
  });

  it("rejects duplicate item ids, pointing at the duplicate", () => {
    const items = [validItem("same"), validItem("same", "Tiramisu")];
    expect(issuePaths(schema, { items, settings: mockSettings() })).toEqual(["items.1.id"]);
  });

  it("rejects an over-long source file name", () => {
    const body = {
      items: [validItem()],
      settings: mockSettings(),
      sourceFilename: "m".repeat(MAX_SOURCE_FILENAME_LENGTH + 1),
    };
    expect(issuePaths(schema, body)).toEqual(["sourceFilename"]);
  });

  it("surfaces nested item and settings problems with full paths", () => {
    const body = { items: [validItem("a"), { id: "b", dishName: "" }], settings: mockSettings({ concurrency: 0 }) };
    expect(issuePaths(schema, body)).toEqual(["items.1.dishName", "settings.concurrency"]);
  });

  it("rejects a non-object body", () => {
    expect(issuePaths(schema, "nope")).not.toEqual([]);
    expect(issuePaths(schema, null)).not.toEqual([]);
  });
});

describe("regenerateItemRequestSchema", () => {
  it("accepts an empty object", () => {
    expect(regenerateItemRequestSchema.parse({})).toEqual({});
  });

  it("accepts partial edits", () => {
    expect(regenerateItemRequestSchema.parse({ dishName: " Tiramisu ", category: "dessert" })).toEqual({
      dishName: "Tiramisu",
      category: "dessert",
    });
  });

  it("rejects an empty dish name when one is provided", () => {
    expect(issuePaths(regenerateItemRequestSchema, { dishName: " " })).toEqual(["dishName"]);
  });

  it("drops an empty prompt override", () => {
    expect(regenerateItemRequestSchema.parse({ promptOverride: "  " })).toEqual({});
    expect(regenerateItemRequestSchema.parse({ promptOverride: "A bowl of soup" })).toEqual({
      promptOverride: "A bowl of soup",
    });
  });
});

describe("parseWith", () => {
  it("returns the parsed value on success", () => {
    expect(parseWith(menuItemSchema, validItem())).toEqual(validItem());
  });

  it("throws a ValidationError carrying every issue", () => {
    let caught: unknown;
    try {
      parseWith(menuItemSchema, { id: "", dishName: "" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const error = caught as ValidationError;
    expect(error.message).toBe("id: Item id is required (+1 more)");
    expect(error.details).toEqual({
      issues: [
        { path: "id", message: "Item id is required", code: expect.any(String) },
        { path: "dishName", message: "Dish name is required", code: expect.any(String) },
      ],
    });
  });

  it("uses the bare issue message for a root-level issue", () => {
    let caught: unknown;
    try {
      parseWith(menuItemSchema, null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const error = caught as ValidationError;
    const { issues } = error.details as { issues: ValidationIssue[] };
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("");
    expect(error.message).toBe(issues[0]?.message);
  });
});

describe("request helpers", () => {
  it("parseCreateJobRequest applies the item cap it is given", () => {
    const items = [validItem("a"), validItem("b", "Tiramisu")];
    expect(() => parseCreateJobRequest({ items, settings: mockSettings() }, { maxItems: 1 })).toThrow(ValidationError);
    expect(parseCreateJobRequest({ items, settings: mockSettings() }, { maxItems: 2 }).items).toHaveLength(2);
  });

  it("parseRegenerateItemRequest treats a missing body as no overrides", () => {
    expect(parseRegenerateItemRequest(undefined)).toEqual({});
    expect(parseRegenerateItemRequest(null)).toEqual({});
  });

  it("parseRegenerateItemRequest rejects a non-object body", () => {
    expect(() => parseRegenerateItemRequest("edit")).toThrow(ValidationError);
  });
});
