import type { GenerateImageRequest, GenerateImageResult, ImageProvider, ImageSize, ModelSpec } from "../types";
import { env } from "../env";
import { ProviderError, ProviderNotConfiguredError } from "../errors";
import { PROVIDER_META, parseSize, priceForQuality } from "../models";
import { base64ToBytes, fetchJson, isRecord } from "./http";

/**
 * Google Gemini API adapter — `POST /v1beta/models/{model}:generateContent`
 * with `responseModalities: ["TEXT", "IMAGE"]` (Gemini 3.1 Flash Image family).
 *
 * Gemini takes an aspect ratio rather than pixel dimensions, so the request
 * size is mapped to the closest supported ratio at the 1K tier and the job
 * runner crops the PNG to the exact size afterwards.
 */

export const GEMINI_REQUEST_TIMEOUT_MS = 120_000;
/** Only tier every Gemini image model supports (Lite is 1K-only). Case-sensitive. */
export const GEMINI_IMAGE_SIZE = "1K";
/** All 14 aspect ratios accepted by the Gemini 3.1 image models. */
export const GEMINI_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
  "1:4",
  "4:1",
  "1:8",
  "8:1",
] as const;

export type GeminiAspectRatio = (typeof GEMINI_ASPECT_RATIOS)[number];

export interface GeminiGenerateContentBody {
  contents: Array<{ parts: Array<{ text: string }> }>;
  generationConfig: {
    responseModalities: ["TEXT", "IMAGE"];
    imageConfig: { aspectRatio: GeminiAspectRatio; imageSize: typeof GEMINI_IMAGE_SIZE };
  };
}

interface InlineImage {
  data: string;
  mimeType?: string;
}

interface ParsedGenerateContent {
  image?: InlineImage;
  texts: string[];
  finishReason?: string;
  blockReason?: string;
  blockReasonMessage?: string;
  modelVersion?: string;
  responseId?: string;
  usageMetadata?: Record<string, unknown>;
}

const RATIO_VALUES: ReadonlyArray<{ ratio: GeminiAspectRatio; value: number }> = GEMINI_ASPECT_RATIOS.map((ratio) => {
  const [w, h] = ratio.split(":").map(Number);
  return { ratio, value: w / h };
});

/**
 * Closest supported aspect ratio for a `WxH` size, compared in log space so
 * landscape and portrait are treated symmetrically. Malformed sizes map to 1:1.
 */
export function aspectRatioForSize(size: ImageSize): GeminiAspectRatio {
  const { width, height } = parseSize(size);
  const target = Math.log(width / height);
  if (!Number.isFinite(target)) return "1:1";
  let best = RATIO_VALUES[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of RATIO_VALUES) {
    const distance = Math.abs(Math.log(candidate.value) - target);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best.ratio;
}

/** `${GEMINI_BASE_URL}/v1beta/models/<model>:generateContent` (image fields are only documented on v1beta). */
export function geminiGenerateContentUrl(providerModel: string, baseUrl: string = env.geminiBaseUrl): string {
  return `${baseUrl}/v1beta/models/${encodeURIComponent(providerModel)}:generateContent`;
}

/** Request body for one text-to-image call at the 1K tier. */
export function buildGeminiRequestBody(request: GenerateImageRequest): GeminiGenerateContentBody {
  return {
    contents: [{ parts: [{ text: request.prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: aspectRatioForSize(request.size), imageSize: GEMINI_IMAGE_SIZE },
    },
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function readParts(candidate: Record<string, unknown>): unknown[] {
  const content = candidate.content;
  return isRecord(content) && Array.isArray(content.parts) ? content.parts : [];
}

function parseGenerateContent(payload: unknown): ParsedGenerateContent {
  const record = isRecord(payload) ? payload : {};
  const candidate: unknown = Array.isArray(record.candidates) ? record.candidates[0] : undefined;
  const feedback = isRecord(record.promptFeedback) ? record.promptFeedback : {};
  const parsed: ParsedGenerateContent = {
    texts: [],
    blockReason: stringField(feedback, "blockReason"),
    blockReasonMessage: stringField(feedback, "blockReasonMessage"),
    modelVersion: stringField(record, "modelVersion"),
    responseId: stringField(record, "responseId"),
    usageMetadata: isRecord(record.usageMetadata) ? record.usageMetadata : undefined,
  };
  if (!isRecord(candidate)) return parsed;
  parsed.finishReason = stringField(candidate, "finishReason");
  for (const part of readParts(candidate)) {
    if (!isRecord(part)) continue;
    const inline = part.inlineData;
    if (!parsed.image && isRecord(inline) && typeof inline.data === "string" && inline.data) {
      parsed.image = { data: inline.data, mimeType: stringField(inline, "mimeType") };
    } else if (typeof part.text === "string" && part.text.trim()) {
      parsed.texts.push(part.text.trim());
    }
  }
  return parsed;
}

function noImageError(parsed: ParsedGenerateContent): ProviderError {
  const reasons: string[] = [];
  if (parsed.blockReason) {
    reasons.push(`prompt blocked: ${parsed.blockReason}${parsed.blockReasonMessage ? ` (${parsed.blockReasonMessage})` : ""}`);
  }
  if (parsed.finishReason && parsed.finishReason !== "STOP") reasons.push(`finish reason: ${parsed.finishReason}`);
  const text = parsed.texts.join(" ");
  if (text) reasons.push(`model said: "${text.length > 200 ? `${text.slice(0, 200)}…` : text}"`);
  const suffix = reasons.length ? ` — ${reasons.join("; ")}` : "";
  return new ProviderError(`Google Gemini API returned no image for this prompt${suffix}`, {
    provider: "google",
    code: "no_image",
    retryable: false,
    details: { blockReason: parsed.blockReason, finishReason: parsed.finishReason, text: text.slice(0, 500) },
  });
}

export const googleProvider: ImageProvider = {
  id: "google",
  isConfigured(): boolean {
    return Boolean(env.geminiApiKey);
  },
  async generate(model: ModelSpec, request: GenerateImageRequest): Promise<GenerateImageResult> {
    if (!this.isConfigured()) throw new ProviderNotConfiguredError("google", PROVIDER_META.google.envVar);

    const body = buildGeminiRequestBody(request);
    const payload = await fetchJson(
      geminiGenerateContentUrl(model.providerModel),
      {
        method: "POST",
        headers: {
          "x-goog-api-key": env.geminiApiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      },
      { provider: "google", timeoutMs: GEMINI_REQUEST_TIMEOUT_MS, signal: request.signal },
    );

    const parsed = parseGenerateContent(payload);
    if (!parsed.image) throw noImageError(parsed);

    return {
      bytes: base64ToBytes(parsed.image.data),
      mimeType: parsed.image.mimeType ?? "image/png",
      costUsd: priceForQuality(model, request.quality),
      providerMeta: {
        aspectRatio: body.generationConfig.imageConfig.aspectRatio,
        imageSize: GEMINI_IMAGE_SIZE,
        finishReason: parsed.finishReason,
        modelVersion: parsed.modelVersion,
        responseId: parsed.responseId,
        usageMetadata: parsed.usageMetadata,
      },
    };
  },
};
