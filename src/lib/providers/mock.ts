import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { GenerateImageRequest, GenerateImageResult, ImageProvider, ModelSpec } from "../types";
import { ProviderError } from "../errors";
import { parseSize } from "../models";

/**
 * Mock provider: no network, no key, no cost.
 *
 * - Returns a bundled sample photo from `public/samples/` when the prompt
 *   mentions one of the sample dishes, otherwise renders a labelled placeholder.
 * - Sleeps 300–900 ms so progress UI can be exercised.
 * - `[fail]` in the prompt → retryable ProviderError (simulated 503).
 * - `[fatal]` in the prompt → non-retryable ProviderError (simulated 400).
 * - Honours `AbortSignal`.
 */

const SAMPLES_DIR = path.resolve(process.cwd(), "public", "samples");

const SAMPLE_KEYWORDS: Array<{ file: string; keywords: string[] }> = [
  { file: "margherita_pizza.jpg", keywords: ["margherita", "pizza"] },
  { file: "chicken_caesar_salad.jpg", keywords: ["caesar", "salad"] },
  { file: "beef_burger.jpg", keywords: ["burger"] },
  { file: "tiramisu.jpg", keywords: ["tiramisu"] },
];

const PLACEHOLDER_COLORS = ["#c2410c", "#b45309", "#15803d", "#1d4ed8", "#7e22ce", "#be123c", "#0f766e"];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/** Extract the dish subject from a prompt built by `buildPrompt` (best-effort, for the placeholder label). */
function labelFromPrompt(prompt: string): string {
  const match = prompt.match(/photography of ([^.]+?)(?:,|\.|\s\(| viewed| on a| shot)/i);
  const label = (match?.[1] ?? prompt).trim();
  return label.length > 40 ? `${label.slice(0, 37)}…` : label;
}

async function renderPlaceholder(label: string, width: number, height: number): Promise<Uint8Array> {
  const color = PLACEHOLDER_COLORS[hash(label) % PLACEHOLDER_COLORS.length];
  const fontSize = Math.round(Math.min(width, height) / 14);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="#111827" stop-opacity="0.95"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="${width / 2}" cy="${height / 2 - fontSize}" r="${Math.min(width, height) / 5}" fill="none" stroke="white" stroke-opacity="0.25" stroke-width="${Math.max(2, fontSize / 6)}"/>
  <text x="50%" y="${height / 2 + fontSize * 2.2}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600" fill="white">${escapeXml(label)}</text>
  <text x="50%" y="${height / 2 + fontSize * 3.6}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(fontSize * 0.55)}" fill="white" fill-opacity="0.7">MOCK IMAGE</text>
</svg>`;
  const out = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
  return new Uint8Array(out);
}

export const mockProvider: ImageProvider = {
  id: "mock",
  isConfigured(): boolean {
    return true;
  },
  async generate(_model: ModelSpec, request: GenerateImageRequest): Promise<GenerateImageResult> {
    const { prompt, size, signal } = request;
    const { width, height } = parseSize(size);

    await sleep(300 + (hash(prompt) % 600), signal);

    if (/\[fatal\]/i.test(prompt)) {
      throw new ProviderError("Mock provider: simulated non-retryable failure ([fatal] in prompt)", {
        provider: "mock",
        status: 400,
        retryable: false,
        code: "bad_request",
      });
    }
    if (/\[fail\]/i.test(prompt)) {
      throw new ProviderError("Mock provider: simulated transient failure ([fail] in prompt)", {
        provider: "mock",
        status: 503,
        retryable: true,
        retryAfterMs: 200,
        code: "server_error",
      });
    }

    const lower = prompt.toLowerCase();
    const sample = SAMPLE_KEYWORDS.find((s) => s.keywords.some((k) => lower.includes(k)));

    let bytes: Uint8Array;
    if (sample) {
      const file = await fs.readFile(path.join(SAMPLES_DIR, sample.file));
      const resized = await sharp(file).resize(width, height, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer();
      bytes = new Uint8Array(resized);
    } else {
      bytes = await renderPlaceholder(labelFromPrompt(prompt), width, height);
    }

    if (signal?.aborted) throw abortError();

    return {
      bytes,
      mimeType: "image/jpeg",
      width,
      height,
      costUsd: 0,
      providerMeta: { mock: true, sample: sample?.file ?? null },
    };
  },
};
