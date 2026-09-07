import type { ImageFormat } from "./types";

/** Default cap on the length of a filename stem produced by {@link toFilenameStem}. */
export const MAX_STEM_LENGTH = 80;

/** Stem used when a dish name contains no ASCII letters or digits (emoji-only, CJK-only, empty …). */
export const FALLBACK_STEM = "dish";

/**
 * Device names Windows refuses as file names regardless of extension. A stem that
 * collides with one gets a suffix so the ZIP extracts cleanly everywhere.
 */
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Cut `stem` down to `maxLength`, preferring a `_` boundary so words are not split. */
function truncateStem(stem: string, maxLength: number): string {
  if (stem.length <= maxLength) return stem;
  let cut = stem.slice(0, maxLength);
  if (stem.charAt(maxLength) !== "_") {
    const boundary = cut.lastIndexOf("_");
    if (boundary > 0) cut = cut.slice(0, boundary);
  }
  return cut.replace(/_+$/g, "");
}

/**
 * Slugify a dish name into a safe, ASCII-only filename stem.
 *
 * Pipeline: NFKD normalise → strip combining marks → lower-case → runs of
 * non-alphanumerics to `_` → trim `_` → cap at `maxLength` (cut on a word
 * boundary) → `"dish"` when nothing is left.
 *
 * `toFilenameStem("Crème Brûlée!")` → `"creme_brulee"`.
 */
export function toFilenameStem(name: string, maxLength = MAX_STEM_LENGTH): string {
  const limit = Number.isFinite(maxLength) ? Math.max(1, Math.floor(maxLength)) : MAX_STEM_LENGTH;
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const stem = truncateStem(slug, limit) || FALLBACK_STEM;
  return WINDOWS_RESERVED.has(stem) ? `${stem}_${FALLBACK_STEM}` : stem;
}

/** File extension (without dot) used in the ZIP for a given output format. */
export function extensionForFormat(format: ImageFormat): "jpg" | "png" | "webp" {
  return format === "jpeg" ? "jpg" : format;
}

/** MIME type for an output format, e.g. `image/jpeg`. */
export function mimeTypeForFormat(format: ImageFormat): string {
  return `image/${format}`;
}

/** Inverse of {@link mimeTypeForFormat}; tolerates parameters (`image/png; charset=…`) and `image/jpg`. */
export function formatForMimeType(mime: string): ImageFormat | undefined {
  const m = mime.toLowerCase().split(";")[0].trim();
  if (m === "image/jpeg" || m === "image/jpg") return "jpeg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  return undefined;
}

/**
 * Unique filenames for a batch, in input order: `beef_burger.jpg`,
 * `beef_burger_2.jpg`, … Returns an array parallel to `items`.
 *
 * The first occurrence of a stem keeps the plain name; later duplicates get
 * `_2`, `_3`, … Uniqueness is guaranteed even when a dish name itself slugifies
 * to something already taken (e.g. a dish literally called "Pizza 2").
 */
export function assignFilenames(items: ReadonlyArray<{ dishName: string }>, format: ImageFormat): string[] {
  const ext = extensionForFormat(format);
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();

  return items.map((item) => {
    const stem = toFilenameStem(item.dishName);
    let candidate = stem;
    let n = nextSuffix.get(stem) ?? 1;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${stem}_${n}`;
    }
    nextSuffix.set(stem, n);
    used.add(candidate);
    return `${candidate}.${ext}`;
  });
}
