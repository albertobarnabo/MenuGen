import sharp, { type Sharp } from "sharp";
import type { ImageFormat, ImageSize } from "./types";
import { errorMessage } from "./errors";
import { mimeTypeForFormat } from "./filename";
import { parseSize } from "./models";

/**
 * Image post-processing with sharp (server-only).
 *
 * Provider output arrives in whatever format/size the vendor returned; the job
 * runner normalises it here into the format the user asked for, cropped to the
 * requested size, with all metadata stripped.
 */

export interface NormalizeOptions {
  format: ImageFormat;
  /** When set and different from the source, resize with `fit: "cover"` (center crop). */
  size?: ImageSize;
  /** JPEG/WebP quality 1–100 (default 90). Ignored for PNG. */
  quality?: number;
}

export interface NormalizedImage {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

/** Quality used for JPEG and WebP output when the caller does not specify one. */
export const DEFAULT_IMAGE_QUALITY = 90;

/** zlib compression level for PNG output (0–9; 8 is close to the maximum at a fraction of the CPU cost). */
export const PNG_COMPRESSION_LEVEL = 8;

/** Wrap a Uint8Array as a Buffer without copying. */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Validate the optional quality knob; sharp itself only clamps silently. */
function resolveQuality(quality: number | undefined): number {
  if (quality === undefined) return DEFAULT_IMAGE_QUALITY;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new RangeError(`Image quality must be an integer between 1 and 100, got ${String(quality)}`);
  }
  return quality;
}

/** Select the encoder for the requested output format. */
function withOutputFormat(pipeline: Sharp, format: ImageFormat, quality: number): Sharp {
  switch (format) {
    case "jpeg":
      return pipeline.jpeg({ quality, mozjpeg: true });
    case "png":
      return pipeline.png({ compressionLevel: PNG_COMPRESSION_LEVEL });
    case "webp":
      return pipeline.webp({ quality });
    default: {
      const unreachable: never = format;
      throw new Error(`Unsupported image format "${String(unreachable)}"`);
    }
  }
}

/**
 * Convert/resize provider output with sharp. Strips metadata.
 *
 * - The image is re-encoded as `options.format` (JPEG via mozjpeg, PNG at
 *   compression level 8, or WebP).
 * - When `options.size` is given and differs from the source dimensions the
 *   image is centre-cropped (`fit: "cover"`) to exactly that size.
 * - EXIF/ICC/XMP metadata is dropped (sharp's default) so the ZIP never leaks
 *   vendor metadata.
 *
 * Throws a `RangeError` for an invalid `quality` and an `Error` whose message
 * starts with `Could not normalise image` when sharp cannot decode the input.
 */
export async function normalizeImage(bytes: Uint8Array, options: NormalizeOptions): Promise<NormalizedImage> {
  if (bytes.byteLength === 0) {
    throw new Error("Could not normalise image: the provider returned 0 bytes");
  }
  const quality = resolveQuality(options.quality);

  try {
    const image = sharp(toBuffer(bytes));
    let pipeline = image;

    if (options.size) {
      const target = parseSize(options.size);
      const meta = await image.metadata();
      if (meta.width !== target.width || meta.height !== target.height) {
        pipeline = pipeline.resize(target.width, target.height, { fit: "cover", position: "centre" });
      }
    }

    const { data, info } = await withOutputFormat(pipeline, options.format, quality).toBuffer({
      resolveWithObject: true,
    });

    return {
      bytes: new Uint8Array(data),
      mimeType: mimeTypeForFormat(options.format),
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    throw new Error(`Could not normalise image to ${options.format}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Read the dimensions and container format (`jpeg`, `png`, `webp`, …) of an
 * encoded image without decoding the pixels.
 */
export async function readImageMeta(bytes: Uint8Array): Promise<{ width: number; height: number; format: string }> {
  if (bytes.byteLength === 0) throw new Error("Could not read image metadata: the buffer is empty");
  try {
    const meta = await sharp(toBuffer(bytes)).metadata();
    if (!meta.width || !meta.height) {
      throw new Error("the image has no dimensions");
    }
    return { width: meta.width, height: meta.height, format: meta.format };
  } catch (error) {
    throw new Error(`Could not read image metadata: ${errorMessage(error)}`, { cause: error });
  }
}
