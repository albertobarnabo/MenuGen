import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_QUALITY, normalizeImage, readImageMeta } from "@/lib/image";

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString("ascii");
}

let sourcePng: Uint8Array;

beforeAll(async () => {
  const buffer = await sharp({
    create: { width: 256, height: 128, channels: 3, background: { r: 200, g: 40, b: 20 } },
  })
    .png()
    .toBuffer();
  sourcePng = new Uint8Array(buffer);
});

describe("normalizeImage", () => {
  it("converts a 256×128 PNG to a 100×100 centre-cropped JPEG", async () => {
    const result = await normalizeImage(sourcePng, { format: "jpeg", size: "100x100" });

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
    expect(startsWith(result.bytes, JPEG_MAGIC)).toBe(true);

    const meta = await sharp(Buffer.from(result.bytes)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);
  });

  it("produces WebP output (RIFF/WEBP container) and honours the size", async () => {
    const result = await normalizeImage(sourcePng, { format: "webp", size: "64x64", quality: 80 });

    expect(result.mimeType).toBe("image/webp");
    expect(result.width).toBe(64);
    expect(result.height).toBe(64);
    expect(ascii(result.bytes, 0, 4)).toBe("RIFF");
    expect(ascii(result.bytes, 8, 12)).toBe("WEBP");
  });

  it("keeps the source dimensions when no size is requested and re-encodes as PNG", async () => {
    const result = await normalizeImage(sourcePng, { format: "png" });

    expect(result.mimeType).toBe("image/png");
    expect(result.width).toBe(256);
    expect(result.height).toBe(128);
    expect(startsWith(result.bytes, PNG_MAGIC)).toBe(true);
  });

  it("does not resize when the source already has the requested size", async () => {
    const result = await normalizeImage(sourcePng, { format: "jpeg", size: "256x128" });
    expect(result.width).toBe(256);
    expect(result.height).toBe(128);
  });

  it("strips metadata from the output", async () => {
    const withExif = await sharp(Buffer.from(sourcePng))
      .withMetadata({ exif: { IFD0: { Copyright: "MenuGen test" } } })
      .jpeg()
      .toBuffer();
    const source = await sharp(withExif).metadata();
    expect(source.exif).toBeDefined();

    const result = await normalizeImage(new Uint8Array(withExif), { format: "jpeg" });
    const meta = await sharp(Buffer.from(result.bytes)).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("rejects an invalid quality with a RangeError", async () => {
    await expect(normalizeImage(sourcePng, { format: "jpeg", quality: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(normalizeImage(sourcePng, { format: "webp", quality: 101 })).rejects.toBeInstanceOf(RangeError);
    await expect(normalizeImage(sourcePng, { format: "jpeg", quality: 42.5 })).rejects.toBeInstanceOf(RangeError);
    expect(DEFAULT_IMAGE_QUALITY).toBe(90);
  });

  it("fails with a descriptive error for undecodable input", async () => {
    await expect(normalizeImage(new Uint8Array([1, 2, 3, 4]), { format: "jpeg" })).rejects.toThrow(
      /Could not normalise image to jpeg/,
    );
    await expect(normalizeImage(new Uint8Array(0), { format: "png" })).rejects.toThrow(/0 bytes/);
  });
});

describe("readImageMeta", () => {
  it("reports dimensions and format", async () => {
    await expect(readImageMeta(sourcePng)).resolves.toEqual({ width: 256, height: 128, format: "png" });
  });

  it("fails with a descriptive error for undecodable input", async () => {
    await expect(readImageMeta(new Uint8Array([0, 0, 0]))).rejects.toThrow(/Could not read image metadata/);
  });
});
