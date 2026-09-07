import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, ProviderNotConfiguredError } from "@/lib/errors";
import { requireModel } from "@/lib/models";
import { bflProvider, buildBflRequestBody, createBflProvider } from "@/lib/providers/bfl";
import { aspectRatioForSize, buildGeminiRequestBody, googleProvider } from "@/lib/providers/google";
import { base64ToBytes, downloadBytes, fetchJson, mimeTypeForFormat, vendorMessage } from "@/lib/providers/http";
import { buildOpenAIRequestBody, openaiCostUsd, openaiProvider } from "@/lib/providers/openai";
import type { GenerateImageRequest } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures & helpers
// ─────────────────────────────────────────────────────────────────────────────

const IMAGE_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const IMAGE_B64 = Buffer.from(IMAGE_BYTES).toString("base64");

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function bytesResponse(bytes: Uint8Array, contentType = "image/jpeg"): Response {
  return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": contentType } });
}

function call(index: number): { url: string; init: RequestInit; headers: Headers; body: Record<string, unknown> } {
  const entry = fetchMock.mock.calls[index];
  if (!entry) throw new Error(`fetch was called ${fetchMock.mock.calls.length} times, no call #${index}`);
  const [input, init = {}] = entry;
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  return { url, init, headers: new Headers(init.headers), body };
}

function abortErrorFor(signal: AbortSignal | null | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

/** A fetch that never resolves on its own but rejects with an AbortError when its signal fires. */
function hangingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(abortErrorFor(signal));
        return;
      }
      signal?.addEventListener("abort", () => reject(abortErrorFor(signal)), { once: true });
    });
}

async function expectProviderError(promise: Promise<unknown>, expected: Partial<Omit<ProviderError, "message">> & { message?: RegExp }): Promise<ProviderError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProviderError);
  const error = caught as ProviderError;
  const { message, ...rest } = expected;
  if (message) expect(error.message).toMatch(message);
  expect(error).toMatchObject(rest);
  return error;
}

const baseRequest: GenerateImageRequest = {
  prompt: "Professional editorial food photography of Margherita pizza.",
  size: "1024x1024",
  format: "jpeg",
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPENAI_API_KEY", "sk-test-openai");
  vi.stubEnv("GEMINI_API_KEY", "AIza-test-gemini");
  vi.stubEnv("BFL_API_KEY", "bfl-test-key");
  // Pin the vendor hosts so a developer's .env overrides cannot change the asserted URLs.
  vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
  vi.stubEnv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com");
  vi.stubEnv("BFL_BASE_URL", "https://api.bfl.ai");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// http.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("http helpers", () => {
  it("base64ToBytes decodes plain and data-URL payloads and rejects empty ones", () => {
    expect(base64ToBytes(IMAGE_B64)).toEqual(IMAGE_BYTES);
    expect(base64ToBytes(`data:image/jpeg;base64,${IMAGE_B64}`)).toEqual(IMAGE_BYTES);
    expect(() => base64ToBytes("")).toThrow(/empty or invalid/);
  });

  it("mimeTypeForFormat", () => {
    expect(mimeTypeForFormat("jpeg")).toBe("image/jpeg");
    expect(mimeTypeForFormat("png")).toBe("image/png");
    expect(mimeTypeForFormat("webp")).toBe("image/webp");
  });

  it("vendorMessage understands OpenAI, Google and BFL error shapes", () => {
    expect(vendorMessage(JSON.stringify({ error: { message: "Rate limit reached", type: "requests" } }), "", 429)).toBe(
      "Rate limit reached",
    );
    expect(vendorMessage(JSON.stringify({ error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } }), "", 429)).toBe(
      "Quota exceeded",
    );
    expect(vendorMessage(JSON.stringify({ detail: "Insufficient credits" }), "", 402)).toBe("Insufficient credits");
    expect(vendorMessage(JSON.stringify({ detail: [{ loc: ["body", "width"], msg: "value too small", type: "x" }] }), "", 422)).toBe(
      "value too small",
    );
    expect(vendorMessage("plain text failure", "Bad Gateway", 502)).toBe("plain text failure");
    expect(vendorMessage("<html>big page</html>", "Bad Gateway", 502)).toBe("Bad Gateway");
    expect(vendorMessage("", "", 503)).toBe("HTTP 503");
  });

  it("fetchJson maps non-2xx responses to ProviderError with status, code, Retry-After and details", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Slow down" } }, { status: 429, headers: { "retry-after": "3" } }),
    );
    const error = await expectProviderError(fetchJson("https://example.test/x", { method: "GET" }, { provider: "openai" }), {
      status: 429,
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 3000,
      message: /^OpenAI 429: Slow down$/,
    });
    expect(String(error.details)).toContain("Slow down");
  });

  it("fetchJson truncates details to 500 characters", async () => {
    const long = "x".repeat(2000);
    fetchMock.mockResolvedValueOnce(new Response(long, { status: 500 }));
    const error = await expectProviderError(fetchJson("https://example.test/x", {}, { provider: "bfl" }), {
      status: 500,
      code: "server_error",
      retryable: true,
    });
    expect(String(error.details)).toHaveLength(500);
  });

  it("fetchJson rejects a non-JSON 2xx body as a non-retryable bad_response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>oops</html>", { status: 200 }));
    await expectProviderError(fetchJson("https://example.test/x", {}, { provider: "google" }), {
      code: "bad_response",
      retryable: false,
      status: 200,
    });
  });

  it("fetchJson turns a timeout into a retryable ProviderError", async () => {
    fetchMock.mockImplementation(hangingFetch());
    await expectProviderError(fetchJson("https://example.test/x", {}, { provider: "openai", timeoutMs: 20 }), {
      code: "timeout",
      retryable: true,
      message: /timed out/,
    });
  });

  it("fetchJson turns a network failure into a retryable ProviderError", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("ENOTFOUND api.example") }));
    await expectProviderError(fetchJson("https://example.test/x", {}, { provider: "bfl" }), {
      code: "network",
      retryable: true,
      message: /fetch failed \(ENOTFOUND api\.example\)/,
    });
  });

  it("fetchJson rethrows the caller's abort as an AbortError, and passes a merged signal to fetch", async () => {
    fetchMock.mockImplementation(hangingFetch());
    const controller = new AbortController();
    const pending = fetchJson("https://example.test/x", {}, { provider: "openai", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(call(0).init.signal?.aborted).toBe(true);
  });

  it("downloadBytes returns bytes and content type, and fails on empty files", async () => {
    fetchMock.mockResolvedValueOnce(bytesResponse(IMAGE_BYTES, "image/webp"));
    const downloaded = await downloadBytes("https://delivery.test/file", { provider: "bfl" });
    expect(downloaded.bytes).toEqual(IMAGE_BYTES);
    expect(downloaded.contentType).toBe("image/webp");

    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(0), { status: 200 }));
    await expectProviderError(downloadBytes("https://delivery.test/file", { provider: "bfl" }), {
      code: "bad_response",
      message: /empty file/,
    });

    fetchMock.mockResolvedValueOnce(new Response("expired", { status: 403 }));
    await expectProviderError(downloadBytes("https://delivery.test/file", { provider: "bfl" }), {
      status: 403,
      code: "auth",
      retryable: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI
// ─────────────────────────────────────────────────────────────────────────────

describe("openai provider", () => {
  const model = requireModel("openai/gpt-image-2");

  it("posts the documented body with bearer auth and parses b64_json + usage", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        created: 1_760_000_000,
        data: [{ b64_json: IMAGE_B64 }],
        output_format: "jpeg",
        size: "1024x1024",
        usage: { input_tokens: 20, output_tokens: 1056, total_tokens: 1076 },
      }),
    );

    const result = await openaiProvider.generate(model, baseRequest);

    const { url, init, headers, body } = call(0);
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(init.method).toBe("POST");
    expect(headers.get("authorization")).toBe("Bearer sk-test-openai");
    expect(headers.get("content-type")).toBe("application/json");
    expect(body).toEqual({
      model: "gpt-image-2",
      prompt: baseRequest.prompt,
      size: "1024x1024",
      quality: "medium",
      n: 1,
      output_format: "jpeg",
      output_compression: 90,
      moderation: "auto",
    });
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("input_fidelity");

    expect(result.bytes).toEqual(IMAGE_BYTES);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(result.costUsd).toBeCloseTo(1056 * 30e-6 + 20 * 5e-6, 9);
    expect(result.providerMeta).toMatchObject({ created: 1_760_000_000, usage: { output_tokens: 1056 } });
  });

  it("honours the requested quality, drops output_compression for png and falls back to the list price", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: IMAGE_B64 }] }));
    const result = await openaiProvider.generate(model, { ...baseRequest, format: "png", quality: "high", size: "1536x1024" });
    const { body } = call(0);
    expect(body.quality).toBe("high");
    expect(body.output_format).toBe("png");
    expect(body).not.toHaveProperty("output_compression");
    expect(body.size).toBe("1536x1024");
    expect(result.mimeType).toBe("image/png");
    expect(result.width).toBe(1536);
    expect(result.height).toBe(1024);
    expect(result.costUsd).toBe(0.125);
  });

  it("builds request bodies and costs deterministically", () => {
    expect(buildOpenAIRequestBody(model, { ...baseRequest, format: "webp" })).toMatchObject({ output_compression: 90, quality: "medium" });
    expect(openaiCostUsd(model, "low", undefined)).toBe(0.008);
    expect(openaiCostUsd(model, "medium", { output_tokens: 1000 })).toBe(0.03);
    expect(openaiCostUsd(model, "medium", { output_tokens: 1000, input_tokens: 200 })).toBe(0.031);
  });

  it("fails with bad_response when b64_json is missing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ url: "https://nope" }] }));
    await expectProviderError(openaiProvider.generate(model, baseRequest), {
      provider: "openai",
      code: "bad_response",
      retryable: false,
      message: /b64_json/,
    });
  });

  it("maps 401 to a non-retryable auth error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Incorrect API key provided" } }, { status: 401 }));
    await expectProviderError(openaiProvider.generate(model, baseRequest), {
      provider: "openai",
      status: 401,
      code: "auth",
      retryable: false,
      message: /^OpenAI 401: Incorrect API key provided$/,
    });
  });

  it("maps 429 with Retry-After to a retryable rate_limited error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Rate limit reached for images per min" } }, { status: 429, headers: { "Retry-After": "2" } }),
    );
    await expectProviderError(openaiProvider.generate(model, baseRequest), {
      status: 429,
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 2000,
    });
  });

  it("maps 403 to a non-retryable org_verification error pointing at the settings page", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Your organization must be verified to use the model" } }, { status: 403 }),
    );
    await expectProviderError(openaiProvider.generate(model, baseRequest), {
      status: 403,
      code: "org_verification",
      retryable: false,
      message: /platform\.openai\.com\/settings\/organization\/general.*must be verified/,
    });
  });

  it("throws ProviderNotConfiguredError without calling fetch when the key is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(openaiProvider.isConfigured()).toBe(false);
    await expect(openaiProvider.generate(model, baseRequest)).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates the abort signal into fetch and rejects with an AbortError", async () => {
    fetchMock.mockImplementation(hangingFetch());
    const controller = new AbortController();
    const pending = openaiProvider.generate(model, { ...baseRequest, signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(call(0).init.signal?.aborted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Google Gemini
// ─────────────────────────────────────────────────────────────────────────────

describe("google provider", () => {
  const model = requireModel("google/gemini-3.1-flash-lite-image");

  it("posts generateContent with x-goog-api-key and reads the first inlineData part", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: "Here is your pizza." }, { inlineData: { mimeType: "image/png", data: IMAGE_B64 } }],
            },
            finishReason: "STOP",
          },
        ],
        modelVersion: "gemini-3.1-flash-lite-image",
        responseId: "resp-1",
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 1120 },
      }),
    );

    const result = await googleProvider.generate(model, { ...baseRequest, size: "1344x768" });

    const { url, init, headers, body } = call(0);
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-image:generateContent");
    expect(init.method).toBe("POST");
    expect(headers.get("x-goog-api-key")).toBe("AIza-test-gemini");
    expect(headers.get("authorization")).toBeNull();
    expect(body).toEqual({
      contents: [{ parts: [{ text: baseRequest.prompt }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "16:9", imageSize: "1K" },
      },
    });

    expect(result.bytes).toEqual(IMAGE_BYTES);
    expect(result.mimeType).toBe("image/png");
    expect(result.costUsd).toBe(0.0336);
    expect(result.providerMeta).toMatchObject({ aspectRatio: "16:9", finishReason: "STOP", responseId: "resp-1" });
  });

  it("maps sizes to aspect ratios in the request body", () => {
    expect(buildGeminiRequestBody({ ...baseRequest, size: "864x1152" }).generationConfig.imageConfig.aspectRatio).toBe("3:4");
    expect(aspectRatioForSize("1024x1024")).toBe("1:1");
  });

  it("fails with no_image (non-retryable) and surfaces the block reason when no image part is returned", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "I can't help with that." }] }, finishReason: "IMAGE_SAFETY" }],
        promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
      }),
    );
    await expectProviderError(googleProvider.generate(model, baseRequest), {
      provider: "google",
      code: "no_image",
      retryable: false,
      message: /PROHIBITED_CONTENT.*IMAGE_SAFETY.*I can't help with that/,
    });
  });

  it("maps 429 RESOURCE_EXHAUSTED to a retryable rate_limited error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } },
        { status: 429, headers: { "retry-after": "2" } },
      ),
    );
    await expectProviderError(googleProvider.generate(model, baseRequest), {
      status: 429,
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 2000,
      message: /Google Gemini API 429: Resource has been exhausted/,
    });
  });

  it("maps 401/403 to non-retryable auth errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 401, message: "API key not valid", status: "UNAUTHENTICATED" } }, { status: 401 }));
    await expectProviderError(googleProvider.generate(model, baseRequest), { status: 401, code: "auth", retryable: false });
  });

  it("throws ProviderNotConfiguredError when neither GEMINI_API_KEY nor GOOGLE_API_KEY is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    expect(googleProvider.isConfigured()).toBe(false);
    await expect(googleProvider.generate(model, baseRequest)).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates the abort signal", async () => {
    fetchMock.mockImplementation(hangingFetch());
    const controller = new AbortController();
    const pending = googleProvider.generate(model, { ...baseRequest, signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Black Forest Labs
// ─────────────────────────────────────────────────────────────────────────────

describe("bfl provider", () => {
  const model = requireModel("bfl/flux-2-pro");
  const fast = createBflProvider({ pollIntervalMs: 1, pollTimeoutMs: 2000 });
  const POLLING_URL = "https://api.eu1.bfl.ai/v1/get_result?id=task-123";
  const SAMPLE_URL = "https://delivery-eu1.bfl.ai/results/task-123/sample.jpeg?sig=abc";

  it("submits, polls Pending → Ready and downloads the signed sample", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "task-123", polling_url: POLLING_URL, cost: 3, input_mp: 0, output_mp: 1 }))
      .mockResolvedValueOnce(jsonResponse({ id: "task-123", status: "Pending", result: null, progress: null }))
      .mockResolvedValueOnce(jsonResponse({ id: "task-123", status: "Generating", result: null }))
      .mockResolvedValueOnce(jsonResponse({ id: "task-123", status: "Ready", result: { sample: SAMPLE_URL, seed: 42 } }))
      .mockResolvedValueOnce(bytesResponse(IMAGE_BYTES, "image/jpeg"));

    const result = await fast.generate(model, { ...baseRequest, size: "1344x768" });

    const submit = call(0);
    expect(submit.url).toBe("https://api.bfl.ai/v1/flux-2-pro");
    expect(submit.init.method).toBe("POST");
    expect(submit.headers.get("x-key")).toBe("bfl-test-key");
    expect(submit.headers.get("authorization")).toBeNull();
    expect(submit.body).toEqual({
      prompt: baseRequest.prompt,
      width: 1344,
      height: 768,
      output_format: "jpeg",
      safety_tolerance: 2,
    });

    for (const index of [1, 2, 3]) {
      const poll = call(index);
      expect(poll.url).toBe(POLLING_URL);
      expect(poll.init.method).toBe("GET");
      expect(poll.headers.get("x-key")).toBe("bfl-test-key");
    }

    const download = call(4);
    expect(download.url).toBe(SAMPLE_URL);
    expect(download.headers.get("x-key")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);

    expect(result.bytes).toEqual(IMAGE_BYTES);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.width).toBe(1344);
    expect(result.height).toBe(768);
    expect(result.costUsd).toBe(0.03);
    expect(result.providerMeta).toMatchObject({ id: "task-123", cost: 3, status: "Ready", pollAttempts: 3, seed: 42 });
  });

  it("uses the registry price when the response carries no cost and honours png/webp", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "t", polling_url: POLLING_URL }))
      .mockResolvedValueOnce(jsonResponse({ id: "t", status: "Ready", result: { sample: SAMPLE_URL } }))
      .mockResolvedValueOnce(bytesResponse(IMAGE_BYTES, "image/webp"));
    const result = await fast.generate(requireModel("bfl/flux-2-max"), { ...baseRequest, format: "webp" });
    expect(call(0).body.output_format).toBe("webp");
    expect(result.mimeType).toBe("image/webp");
    expect(result.costUsd).toBe(0.07);
    expect(buildBflRequestBody({ ...baseRequest, format: "png", size: "768x1344" })).toMatchObject({ width: 768, height: 1344, output_format: "png" });
  });

  it("treats moderated results as non-retryable content_policy errors", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "t", polling_url: POLLING_URL, cost: 3 }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "t", status: "Request Moderated", result: null, details: { "Moderation Reasons": ["Violence"] } }),
      );
    await expectProviderError(fast.generate(model, baseRequest), {
      provider: "bfl",
      code: "content_policy",
      retryable: false,
      message: /moderated the request \(Request Moderated\): Violence/,
    });
  });

  it("treats Error / Failed statuses as retryable and Task not found as non-retryable", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "t", polling_url: POLLING_URL }))
      .mockResolvedValueOnce(jsonResponse({ id: "t", status: "Error", result: null, details: "GPU worker crashed" }));
    await expectProviderError(fast.generate(model, baseRequest), {
      code: "generation_failed",
      retryable: true,
      message: /generation failed \(Error\): GPU worker crashed/,
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "t", polling_url: POLLING_URL }))
      .mockResolvedValueOnce(jsonResponse({ id: "t", status: "Task not found" }));
    await expectProviderError(fast.generate(model, baseRequest), { code: "not_found", retryable: false });
  });

  it("gives up with a retryable timeout when the task never becomes Ready", async () => {
    const impatient = createBflProvider({ pollIntervalMs: 1, pollTimeoutMs: 25 });
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url === POLLING_URL
        ? jsonResponse({ id: "t", status: "Pending", result: null })
        : jsonResponse({ id: "t", polling_url: POLLING_URL, cost: 3 });
    });
    await expectProviderError(impatient.generate(model, baseRequest), {
      code: "timeout",
      retryable: true,
      message: /did not finish within 0 s \(last status: Pending\)/,
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
  });

  it("keeps polling through a transient 429 on the polling URL", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "t", polling_url: POLLING_URL, cost: 3 }))
      .mockResolvedValueOnce(jsonResponse({ detail: "Too many requests" }, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ id: "t", status: "Ready", result: { sample: SAMPLE_URL } }))
      .mockResolvedValueOnce(bytesResponse(IMAGE_BYTES));
    const result = await fast.generate(model, baseRequest);
    expect(result.bytes).toEqual(IMAGE_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("maps 402 to a non-retryable billing error and 429 on submit to a retryable one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "Insufficient credits" }, { status: 402 }));
    await expectProviderError(fast.generate(model, baseRequest), {
      status: 402,
      code: "billing",
      retryable: false,
      message: /Black Forest Labs 402: Insufficient credits.*dashboard\.bfl\.ai/,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "Too many active tasks" }, { status: 429, headers: { "retry-after": "2" } }));
    await expectProviderError(fast.generate(model, baseRequest), {
      status: 429,
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 2000,
    });
  });

  it("maps 401 to a non-retryable auth error and rejects a submit response without polling_url", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "Invalid API key" }, { status: 401 }));
    await expectProviderError(fast.generate(model, baseRequest), { status: 401, code: "auth", retryable: false });

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "t", status: "Pending", webhook_url: "https://hook" }));
    await expectProviderError(fast.generate(model, baseRequest), { code: "bad_response", retryable: false, message: /polling_url/ });
  });

  it("throws ProviderNotConfiguredError when BFL_API_KEY is missing", async () => {
    vi.stubEnv("BFL_API_KEY", "");
    expect(bflProvider.isConfigured()).toBe(false);
    await expect(bflProvider.generate(model, baseRequest)).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts while polling and rejects with an AbortError", async () => {
    const slow = createBflProvider({ pollIntervalMs: 50, pollTimeoutMs: 5000 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "t", polling_url: POLLING_URL, cost: 3 }));
    const controller = new AbortController();
    const pending = slow.generate(model, { ...baseRequest, signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
