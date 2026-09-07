import type {
  GenerateImageRequest,
  GenerateImageResult,
  ImageFormat,
  ImageProvider,
  ImageSize,
  ModelSpec,
} from "../types";
import { env } from "../env";
import { ProviderError, ProviderNotConfiguredError } from "../errors";
import { PROVIDER_META, isValidSize, parseSize, priceForQuality } from "../models";
import { base64ToBytes, fetchJson, isImageFormat, isRecord, mimeTypeForFormat } from "./http";

/**
 * OpenAI Images API adapter — `POST /v1/images/generations` with `gpt-image-2`.
 *
 * GPT Image models always return base64 (`data[0].b64_json`); `response_format`
 * and `input_fidelity` must never be sent. Billing is per token, so the real
 * cost is computed from `usage` when the API returns it.
 */

/** High-quality renders can take ~2 minutes; the docs recommend a long client timeout. */
export const OPENAI_REQUEST_TIMEOUT_MS = 240_000;
/** JPEG/WebP quality sent as `output_compression` (ignored for PNG). */
export const OPENAI_OUTPUT_COMPRESSION = 90;
/** Image output tokens, USD per million (gpt-image-2 standard tier). */
export const OPENAI_IMAGE_OUTPUT_USD_PER_MTOK = 30;
/** Text input tokens, USD per million (gpt-image-2 standard tier). */
export const OPENAI_TEXT_INPUT_USD_PER_MTOK = 5;
/** Where an organisation completes API verification (required for GPT Image models). */
export const OPENAI_ORG_VERIFICATION_URL = "https://platform.openai.com/settings/organization/general";

export interface OpenAIImagesRequestBody {
  model: string;
  prompt: string;
  size: ImageSize;
  quality?: string;
  n: 1;
  output_format: ImageFormat;
  output_compression?: number;
  moderation: "auto";
}

export interface OpenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: Record<string, unknown>;
  output_tokens_details?: Record<string, unknown>;
}

interface ParsedImagesResponse {
  b64: string;
  usage?: OpenAIUsage;
  created?: number;
  outputFormat?: ImageFormat;
  size?: ImageSize;
}

/** `${OPENAI_BASE_URL}/v1/images/generations`, tolerating a base with or without the `/v1` suffix. */
export function openaiImagesUrl(baseUrl: string = env.openaiBaseUrl): string {
  return `${baseUrl.replace(/\/v1$/, "")}/v1/images/generations`;
}

/** Request body for one image: quality defaults to the model's, compression only for lossy formats. */
export function buildOpenAIRequestBody(model: ModelSpec, request: GenerateImageRequest): OpenAIImagesRequestBody {
  const quality = request.quality ?? model.defaultQuality;
  return {
    model: model.providerModel,
    prompt: request.prompt,
    size: request.size,
    ...(quality ? { quality } : {}),
    n: 1,
    output_format: request.format,
    ...(request.format === "png" ? {} : { output_compression: OPENAI_OUTPUT_COMPRESSION }),
    moderation: "auto",
  };
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Actual spend from the `usage` block (output tokens × $30/1M + input tokens ×
 * $5/1M); falls back to the registry estimate when the API omits usage.
 */
export function openaiCostUsd(model: ModelSpec, quality: string | undefined, usage: OpenAIUsage | undefined): number {
  const outputTokens = usage?.output_tokens;
  if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens)) return priceForQuality(model, quality);
  const inputTokens = typeof usage?.input_tokens === "number" && Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
  return round6(
    (outputTokens * OPENAI_IMAGE_OUTPUT_USD_PER_MTOK + inputTokens * OPENAI_TEXT_INPUT_USD_PER_MTOK) / 1_000_000,
  );
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsage(value: unknown): OpenAIUsage | undefined {
  if (!isRecord(value)) return undefined;
  return {
    input_tokens: numberField(value, "input_tokens"),
    output_tokens: numberField(value, "output_tokens"),
    total_tokens: numberField(value, "total_tokens"),
    input_tokens_details: isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined,
    output_tokens_details: isRecord(value.output_tokens_details) ? value.output_tokens_details : undefined,
  };
}

function readImagesResponse(payload: unknown): ParsedImagesResponse {
  const record = isRecord(payload) ? payload : {};
  const first: unknown = Array.isArray(record.data) ? record.data[0] : undefined;
  const b64 = isRecord(first) && typeof first.b64_json === "string" ? first.b64_json : "";
  if (!b64) {
    throw new ProviderError("OpenAI returned no image data (data[0].b64_json is missing)", {
      provider: "openai",
      code: "bad_response",
      retryable: false,
      details: JSON.stringify(payload).slice(0, 500),
    });
  }
  return {
    b64,
    usage: readUsage(record.usage),
    created: numberField(record, "created"),
    outputFormat: isImageFormat(record.output_format) ? record.output_format : undefined,
    size: typeof record.size === "string" && isValidSize(record.size) ? record.size : undefined,
  };
}

/** 403 on GPT Image models means the organisation has not completed API verification. */
function mapOpenAIError(error: unknown): unknown {
  if (!(error instanceof ProviderError) || error.status !== 403) return error;
  const vendor = error.message.replace(/^OpenAI 403:\s*/, "");
  return new ProviderError(
    `OpenAI 403: GPT Image models require organisation verification. Verify your organisation at ${OPENAI_ORG_VERIFICATION_URL} (access can take ~15 minutes to propagate). Vendor message: ${vendor}`,
    {
      provider: "openai",
      status: 403,
      code: "org_verification",
      retryable: false,
      details: error.details,
      cause: error,
    },
  );
}

export const openaiProvider: ImageProvider = {
  id: "openai",
  isConfigured(): boolean {
    return Boolean(env.openaiApiKey);
  },
  async generate(model: ModelSpec, request: GenerateImageRequest): Promise<GenerateImageResult> {
    if (!this.isConfigured()) throw new ProviderNotConfiguredError("openai", PROVIDER_META.openai.envVar);

    const body = buildOpenAIRequestBody(model, request);
    let payload: unknown;
    try {
      payload = await fetchJson(
        openaiImagesUrl(),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.openaiApiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        },
        { provider: "openai", timeoutMs: OPENAI_REQUEST_TIMEOUT_MS, signal: request.signal },
      );
    } catch (error) {
      throw mapOpenAIError(error);
    }

    const parsed = readImagesResponse(payload);
    const format = parsed.outputFormat ?? request.format;
    const { width, height } = parseSize(parsed.size ?? request.size);
    return {
      bytes: base64ToBytes(parsed.b64),
      mimeType: mimeTypeForFormat(format),
      width,
      height,
      costUsd: openaiCostUsd(model, body.quality, parsed.usage),
      providerMeta: { usage: parsed.usage, created: parsed.created, quality: body.quality, size: parsed.size ?? request.size },
    };
  },
};
