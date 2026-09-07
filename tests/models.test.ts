import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  MODELS,
  PROVIDER_META,
  getModel,
  isValidSize,
  modelSupportsSize,
  modelsForProvider,
  parseSize,
  priceForQuality,
  requireModel,
  sortedModels,
} from "@/lib/models";
import { GEMINI_ASPECT_RATIOS, aspectRatioForSize } from "@/lib/providers/google";
import type { ImageSize, ProviderId } from "@/lib/types";

/** Vendor ids that are deprecated or shut down and must never reappear in the registry. */
const DEPRECATED_PROVIDER_MODELS = [
  "gpt-image-1",
  "gpt-image-1-mini",
  "gpt-image-1.5",
  "chatgpt-image-latest",
  "dall-e-2",
  "dall-e-3",
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-preview",
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
  "imagen-4.0-generate-001",
  "imagen-4.0-fast-generate-001",
  "imagen-4.0-ultra-generate-001",
  "flux-pro-1.1",
  "flux-pro-1.1-ultra",
  "flux-dev",
  "flux-kontext-pro",
  "flux-kontext-max",
];

const EXPECTED_IDS = [
  "bfl/flux-2-pro",
  "bfl/flux-2-klein-9b",
  "bfl/flux-2-max",
  "openai/gpt-image-2",
  "google/gemini-3.1-flash-lite-image",
  "google/gemini-3.1-flash-image",
  "mock/sample",
];

describe("model registry", () => {
  it("contains exactly the expected models with unique ids", () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("uses <provider>/<slug> ids whose provider exists in PROVIDER_META", () => {
    for (const model of MODELS) {
      const [prefix, slug] = model.id.split("/");
      expect(prefix).toBe(model.provider);
      expect(slug.length).toBeGreaterThan(0);
      expect(PROVIDER_META[model.provider]).toBeDefined();
      expect(PROVIDER_META[model.provider].id).toBe(model.provider);
      expect(model.providerModel.length).toBeGreaterThan(0);
    }
  });

  it("lists valid, unique sizes and a defaultSize that belongs to them", () => {
    for (const model of MODELS) {
      expect(model.sizes.length).toBeGreaterThan(0);
      expect(new Set(model.sizes).size).toBe(model.sizes.length);
      for (const size of model.sizes) expect(isValidSize(size)).toBe(true);
      expect(model.sizes).toContain(model.defaultSize);
      expect(model.nativeFormats.length).toBeGreaterThan(0);
    }
  });

  it("keeps quality prices ascending and consistent with the default price", () => {
    for (const model of MODELS) {
      if (!model.qualityOptions) {
        expect(model.defaultQuality).toBeUndefined();
        continue;
      }
      const prices = model.qualityOptions.map((q) => q.pricePerImageUsd);
      for (let i = 1; i < prices.length; i += 1) expect(prices[i]).toBeGreaterThan(prices[i - 1]);
      expect(model.defaultQuality).toBeDefined();
      const defaultOption = model.qualityOptions.find((q) => q.id === model.defaultQuality);
      expect(defaultOption?.pricePerImageUsd).toBe(model.pricePerImageUsd);
    }
  });

  it("has the verified September 2026 prices at 1024x1024", () => {
    expect(requireModel("bfl/flux-2-pro").pricePerImageUsd).toBe(0.03);
    expect(requireModel("bfl/flux-2-klein-9b").pricePerImageUsd).toBe(0.015);
    expect(requireModel("bfl/flux-2-max").pricePerImageUsd).toBe(0.07);
    expect(requireModel("openai/gpt-image-2").qualityOptions?.map((q) => [q.id, q.pricePerImageUsd])).toEqual([
      ["low", 0.008],
      ["medium", 0.032],
      ["high", 0.125],
    ]);
    expect(requireModel("google/gemini-3.1-flash-lite-image").pricePerImageUsd).toBe(0.0336);
    expect(requireModel("google/gemini-3.1-flash-image").pricePerImageUsd).toBe(0.067);
    expect(requireModel("mock/sample").pricePerImageUsd).toBe(0);
  });

  it("points every real model at an https docs page and tags the mock as dev-only", () => {
    for (const model of MODELS) {
      if (model.provider === "mock") {
        expect(model.tags).toEqual(["dev-only"]);
        continue;
      }
      expect(model.docsUrl).toMatch(/^https:\/\//);
      expect(model.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(model.typicalLatencySeconds).toBeGreaterThan(0);
    }
  });

  it("does not list any deprecated or shut-down vendor model", () => {
    for (const model of MODELS) {
      expect(DEPRECATED_PROVIDER_MODELS).not.toContain(model.providerModel);
      expect(model.providerModel).not.toMatch(/preview/);
    }
  });

  it("exposes the recommended default", () => {
    expect(DEFAULT_MODEL_ID).toBe("bfl/flux-2-pro");
    const model = getModel(DEFAULT_MODEL_ID);
    expect(model).toBeDefined();
    expect(model?.tags).toContain("recommended");
  });

  it("has provider metadata with key URLs and latencies", () => {
    expect(PROVIDER_META.openai.keysUrl).toBe("https://platform.openai.com/api-keys");
    expect(PROVIDER_META.google.keysUrl).toBe("https://aistudio.google.com/apikey");
    expect(PROVIDER_META.bfl.keysUrl).toBe("https://dashboard.bfl.ai");
    expect(PROVIDER_META.openai.typicalLatencySeconds).toBe(30);
    expect(PROVIDER_META.google.typicalLatencySeconds).toBe(8);
    expect(PROVIDER_META.bfl.typicalLatencySeconds).toBe(8);
    for (const id of Object.keys(PROVIDER_META) as ProviderId[]) {
      expect(PROVIDER_META[id].id).toBe(id);
    }
  });
});

describe("registry helpers", () => {
  it("getModel / requireModel", () => {
    expect(getModel("nope")).toBeUndefined();
    expect(() => requireModel("nope")).toThrow(/Unknown model "nope"/);
    expect(requireModel("openai/gpt-image-2").providerModel).toBe("gpt-image-2");
  });

  it("modelsForProvider filters by provider in registry order", () => {
    expect(modelsForProvider("bfl").map((m) => m.id)).toEqual(["bfl/flux-2-pro", "bfl/flux-2-klein-9b", "bfl/flux-2-max"]);
    expect(modelsForProvider("google")).toHaveLength(2);
    expect(modelsForProvider("mock").map((m) => m.id)).toEqual(["mock/sample"]);
  });

  it("priceForQuality resolves quality ids and falls back to the default", () => {
    const gpt = requireModel("openai/gpt-image-2");
    expect(priceForQuality(gpt)).toBe(0.032);
    expect(priceForQuality(gpt, "low")).toBe(0.008);
    expect(priceForQuality(gpt, "high")).toBe(0.125);
    expect(priceForQuality(gpt, "unknown")).toBe(0.032);
    const flux = requireModel("bfl/flux-2-pro");
    expect(priceForQuality(flux, "high")).toBe(0.03);
  });

  it("parseSize / isValidSize / modelSupportsSize", () => {
    expect(parseSize("1344x768")).toEqual({ width: 1344, height: 768 });
    expect(isValidSize("1024x1024")).toBe(true);
    expect(isValidSize("1024×1024")).toBe(false);
    expect(isValidSize("abc")).toBe(false);
    const gemini = requireModel("google/gemini-3.1-flash-image");
    expect(modelSupportsSize(gemini, "1152x864")).toBe(true);
    expect(modelSupportsSize(gemini, "1536x1024")).toBe(false);
    expect(modelSupportsSize(requireModel("openai/gpt-image-2"), "1536x1024")).toBe(true);
  });

  it("sortedModels orders by price ascending with the mock last", () => {
    const sorted = sortedModels();
    expect(sorted).toHaveLength(MODELS.length);
    expect(sorted[sorted.length - 1].id).toBe("mock/sample");
    const real = sorted.slice(0, -1);
    for (let i = 1; i < real.length; i += 1) {
      expect(real[i].pricePerImageUsd).toBeGreaterThanOrEqual(real[i - 1].pricePerImageUsd);
    }
    expect(real[0].id).toBe("bfl/flux-2-klein-9b");
    expect(real[real.length - 1].id).toBe("bfl/flux-2-max");
    // Does not mutate the registry.
    expect(MODELS[0].id).toBe("bfl/flux-2-pro");
  });
});

describe("aspectRatioForSize", () => {
  it("maps every Gemini registry size to the intended ratio", () => {
    const expected: Record<string, string> = {
      "1024x1024": "1:1",
      "1152x864": "4:3",
      "864x1152": "3:4",
      "1248x832": "3:2",
      "832x1248": "2:3",
      "1344x768": "16:9",
      "768x1344": "9:16",
    };
    for (const model of modelsForProvider("google")) {
      for (const size of model.sizes) {
        expect(aspectRatioForSize(size)).toBe(expected[size]);
      }
    }
  });

  it("picks the closest of the 14 supported ratios for other sizes", () => {
    expect(aspectRatioForSize("1536x1024")).toBe("3:2");
    expect(aspectRatioForSize("1024x1536")).toBe("2:3");
    expect(aspectRatioForSize("2100x900")).toBe("21:9");
    expect(aspectRatioForSize("4000x1000")).toBe("4:1");
    expect(aspectRatioForSize("100x800")).toBe("1:8");
    expect(aspectRatioForSize("1000x1250")).toBe("4:5");
    expect(aspectRatioForSize("0x0" as ImageSize)).toBe("1:1");
    expect(GEMINI_ASPECT_RATIOS).toHaveLength(14);
  });
});
