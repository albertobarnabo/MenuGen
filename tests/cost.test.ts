import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  clampConcurrency,
  estimateDurationSeconds,
  estimateJobCost,
  formatDuration,
  formatUsd,
  typicalLatencyFor,
} from "../src/lib/cost";
import { MODELS, PROVIDER_META, priceForQuality } from "../src/lib/models";
import type { ModelSpec } from "../src/lib/types";

/**
 * Self-contained fixtures so the numbers below do not drift with the live
 * registry. The registry itself is covered by the invariant tests at the end.
 */
function fixture(overrides: Partial<ModelSpec> & Pick<ModelSpec, "id" | "provider">): ModelSpec {
  return {
    providerModel: overrides.id.split("/")[1] ?? overrides.id,
    displayName: overrides.id,
    description: "test fixture",
    pricePerImageUsd: 0.01,
    sizes: ["1024x1024"],
    defaultSize: "1024x1024",
    nativeFormats: ["png"],
    tags: [],
    docsUrl: "",
    ...overrides,
  };
}

const withQuality = fixture({
  id: "openai/fixture",
  provider: "openai",
  pricePerImageUsd: 0.011,
  qualityOptions: [
    { id: "low", label: "Low", pricePerImageUsd: 0.005 },
    { id: "medium", label: "Medium", pricePerImageUsd: 0.011 },
    { id: "high", label: "High", pricePerImageUsd: 0.036 },
  ],
  defaultQuality: "medium",
});

const flat = fixture({ id: "google/fixture", provider: "google", pricePerImageUsd: 0.039 });
const free = fixture({ id: "mock/fixture", provider: "mock", pricePerImageUsd: 0 });

describe("estimateJobCost", () => {
  it("uses the default quality price and rounds to 4 decimals", () => {
    expect(estimateJobCost(withQuality, 3)).toEqual({ perImageUsd: 0.011, totalUsd: 0.033 });
    expect(estimateJobCost(flat, 7)).toEqual({ perImageUsd: 0.039, totalUsd: 0.273 });
    expect(estimateJobCost(fixture({ id: "x/y", provider: "bfl", pricePerImageUsd: 0.12345 }), 1)).toEqual({
      perImageUsd: 0.1235,
      totalUsd: 0.1235,
    });
  });

  it("honours an explicit quality", () => {
    expect(estimateJobCost(withQuality, 2, "high")).toEqual({ perImageUsd: 0.036, totalUsd: 0.072 });
    expect(estimateJobCost(withQuality, 1, "low")).toEqual({ perImageUsd: 0.005, totalUsd: 0.005 });
  });

  it("falls back to the base price for unknown qualities and models without a quality knob", () => {
    expect(estimateJobCost(withQuality, 1, "ultra").perImageUsd).toBe(0.011);
    expect(estimateJobCost(flat, 1, "high").perImageUsd).toBe(0.039);
  });

  it("treats unusable counts as zero and floors fractional counts", () => {
    expect(estimateJobCost(withQuality, 0).totalUsd).toBe(0);
    expect(estimateJobCost(withQuality, -3).totalUsd).toBe(0);
    expect(estimateJobCost(withQuality, Number.NaN).totalUsd).toBe(0);
    expect(estimateJobCost(withQuality, 2.9).totalUsd).toBe(0.022);
  });

  it("is free for zero-priced models", () => {
    expect(estimateJobCost(free, 100)).toEqual({ perImageUsd: 0, totalUsd: 0 });
  });
});

describe("clampConcurrency", () => {
  it("clamps into the supported range and floors fractions", () => {
    expect(MIN_CONCURRENCY).toBe(1);
    expect(MAX_CONCURRENCY).toBe(8);
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(-4)).toBe(1);
    expect(clampConcurrency(3.7)).toBe(3);
    expect(clampConcurrency(100)).toBe(8);
    expect(clampConcurrency(Number.NaN)).toBe(1);
  });
});

describe("typicalLatencyFor", () => {
  it("uses the provider default when the model has no override", () => {
    expect(typicalLatencyFor(withQuality)).toBe(PROVIDER_META.openai.typicalLatencySeconds);
    expect(typicalLatencyFor(flat)).toBe(PROVIDER_META.google.typicalLatencySeconds);
    expect(typicalLatencyFor(free)).toBe(PROVIDER_META.mock.typicalLatencySeconds);
  });

  it("prefers a positive model-level override and ignores unusable ones", () => {
    expect(typicalLatencyFor({ ...flat, typicalLatencySeconds: 5 })).toBe(5);
    expect(typicalLatencyFor({ ...flat, typicalLatencySeconds: 0.5 })).toBe(0.5);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(typicalLatencyFor({ ...flat, typicalLatencySeconds: bad })).toBe(PROVIDER_META.google.typicalLatencySeconds);
    }
  });
});

describe("estimateDurationSeconds", () => {
  const twentyFive = fixture({ id: "openai/25s", provider: "openai", typicalLatencySeconds: 25 });

  it("multiplies sequential waves by the per-image latency", () => {
    expect(estimateDurationSeconds(twentyFive, 10, 4)).toBe(75);
    expect(estimateDurationSeconds(twentyFive, 8, 4)).toBe(50);
    expect(estimateDurationSeconds(twentyFive, 1, 8)).toBe(25);
    expect(estimateDurationSeconds({ ...twentyFive, typicalLatencySeconds: 12 }, 9, 8)).toBe(24);
  });

  it("falls back to the provider latency when the model has none", () => {
    const providerDefault = PROVIDER_META.google.typicalLatencySeconds;
    expect(estimateDurationSeconds(flat, 3, 1)).toBe(3 * providerDefault);
    expect(estimateDurationSeconds(flat, 3, 3)).toBe(providerDefault);
  });

  it("clamps concurrency into the supported range", () => {
    expect(estimateDurationSeconds(twentyFive, 8, 0)).toBe(200);
    expect(estimateDurationSeconds(twentyFive, 8, Number.NaN)).toBe(200);
    expect(estimateDurationSeconds(twentyFive, 8, 100)).toBe(25);
  });

  it("returns 0 for no items", () => {
    expect(estimateDurationSeconds(twentyFive, 0, 4)).toBe(0);
    expect(estimateDurationSeconds(twentyFive, -1, 4)).toBe(0);
    expect(estimateDurationSeconds(twentyFive, Number.NaN, 4)).toBe(0);
  });
});

describe("formatUsd", () => {
  it("shows Free for zero and unusable values", () => {
    expect(formatUsd(0)).toBe("Free");
    expect(formatUsd(-1)).toBe("Free");
    expect(formatUsd(Number.NaN)).toBe("Free");
  });

  it("uses three decimals under one dollar", () => {
    expect(formatUsd(0.011)).toBe("$0.011");
    expect(formatUsd(0.005)).toBe("$0.005");
    expect(formatUsd(0.5)).toBe("$0.500");
    expect(formatUsd(0.9994)).toBe("$0.999");
  });

  it("switches to two decimals when three-decimal rounding reaches one dollar", () => {
    expect(formatUsd(0.9995)).toBe("$1.00");
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(1.2)).toBe("$1.20");
  });

  it("groups thousands", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(1234567.891)).toBe("$1,234,567.89");
  });
});

describe("formatDuration", () => {
  it("shows whole seconds under a minute", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(59.4)).toBe("59 s");
    expect(formatDuration(Number.NaN)).toBe("0 s");
    expect(formatDuration(-5)).toBe("0 s");
  });

  it("shows approximate minutes under an hour", () => {
    expect(formatDuration(60)).toBe("~1 min");
    expect(formatDuration(120)).toBe("~2 min");
    expect(formatDuration(150)).toBe("~3 min");
    expect(formatDuration(3570)).toBe("~1 h 00 min");
  });

  it("shows hours with zero-padded minutes", () => {
    expect(formatDuration(3900)).toBe("~1 h 05 min");
    expect(formatDuration(7200)).toBe("~2 h 00 min");
    expect(formatDuration(3600 * 10 + 60 * 45)).toBe("~10 h 45 min");
  });
});

describe("live registry invariants", () => {
  it("estimates every registry model consistently with priceForQuality", () => {
    expect(MODELS.length).toBeGreaterThan(0);
    for (const model of MODELS) {
      const { perImageUsd, totalUsd } = estimateJobCost(model, 10);
      expect(perImageUsd).toBe(Math.round(priceForQuality(model) * 10_000) / 10_000);
      expect(totalUsd).toBe(Math.round(perImageUsd * 10 * 10_000) / 10_000);
      for (const quality of model.qualityOptions ?? []) {
        expect(estimateJobCost(model, 1, quality.id).perImageUsd).toBe(Math.round(quality.pricePerImageUsd * 10_000) / 10_000);
      }
    }
  });

  it("derives every registry model's latency from its override or provider default", () => {
    for (const model of MODELS) {
      const expected = model.typicalLatencySeconds ?? PROVIDER_META[model.provider].typicalLatencySeconds;
      expect(typicalLatencyFor(model)).toBe(expected);
      expect(estimateDurationSeconds(model, 5, 5)).toBe(expected);
      expect(estimateDurationSeconds(model, 6, 5)).toBe(expected * 2);
    }
  });

  it("keeps the mock model free", () => {
    const mock = MODELS.find((model) => model.provider === "mock");
    expect(mock).toBeDefined();
    if (mock) expect(estimateJobCost(mock, 100)).toEqual({ perImageUsd: 0, totalUsd: 0 });
  });
});
