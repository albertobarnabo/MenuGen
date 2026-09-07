import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, JobItem } from "@/lib/types";
import {
  MANIFEST_COLUMNS,
  buildManifestCsv,
  buildPromptsText,
  createJobZipStream,
  csvEscape,
  writeJobZip,
  zipFilenameForJob,
} from "@/lib/zip";

const JOB_ID = "abcdef12-3456-7890-abcd-ef1234567890";
const BOM = "\uFEFF";

function item(overrides: Partial<JobItem> & Pick<JobItem, "id" | "dishName" | "filename" | "status">): JobItem {
  return {
    description: "",
    category: "",
    prompt: `Photo of ${overrides.dishName}`,
    attempts: 1,
    ...overrides,
  };
}

function makeJob(items: JobItem[], sourceFilename?: string): Job {
  const job: Job = {
    id: JOB_ID,
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: "2026-09-06T10:05:00.000Z",
    status: "failed",
    settings: {
      modelId: "mock/sample",
      size: "1024x1024",
      format: "jpeg",
      stylePresetId: "editorial",
      concurrency: 2,
      maxRetries: 1,
    },
    items,
    stats: {
      total: items.length,
      pending: 0,
      running: 0,
      done: items.filter((i) => i.status === "done").length,
      failed: items.filter((i) => i.status === "failed").length,
      cancelled: 0,
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      elapsedMs: 1000,
    },
  };
  if (sourceFilename !== undefined) job.sourceFilename = sourceFilename;
  return job;
}

async function tinyJpeg(file: string): Promise<void> {
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ff0000" } })
    .jpeg()
    .toBuffer();
  await fs.writeFile(file, bytes);
}

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

let tmpDir: string;
let burger: JobItem;
let padThai: JobItem;
let soup: JobItem;
let imagePaths: Map<string, string>;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "menugen-"));
  burger = item({
    id: "item-1",
    dishName: "Beef Burger",
    description: 'Cheddar, "aged" & bacon',
    category: "Mains",
    filename: "beef_burger.jpg",
    status: "done",
    generatedAt: "2026-09-06T10:01:00.000Z",
    durationMs: 4200,
    costUsd: 0,
    imageUrl: `/api/jobs/${JOB_ID}/images/item-1?v=1`,
  });
  padThai = item({ id: "item-2", dishName: "Pad Thai", filename: "pad_thai.jpg", status: "done", costUsd: 0.011 });
  soup = item({
    id: "item-3",
    dishName: "[fail] Soup",
    filename: "fail_soup.jpg",
    status: "failed",
    attempts: 2,
    error: "Mock provider: simulated transient failure\nsecond line",
  });

  imagePaths = new Map([
    [burger.id, path.join(tmpDir, "item-1.jpg")],
    [padThai.id, path.join(tmpDir, "item-2.jpg")],
  ]);
  await Promise.all([...imagePaths.values()].map(tinyJpeg));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("csvEscape", () => {
  it("quotes only when needed and doubles inner quotes", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"');
    expect(csvEscape("cr\rhere")).toBe('"cr\rhere"');
    expect(csvEscape("")).toBe("");
  });
});

describe("buildManifestCsv", () => {
  it("writes a BOM, the exact header, CRLF rows in job order and RFC 4180 quoting", () => {
    const csv = buildManifestCsv(makeJob([burger, padThai, soup], "menu.csv"));

    expect(csv.startsWith(BOM)).toBe(true);
    const lines = csv.slice(BOM.length).split("\r\n");
    expect(lines.at(-1)).toBe("");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(
      "filename,dish_name,description,category,status,error,attempts,model,quality,size,style,prompt,generated_at,duration_ms,cost_usd",
    );
    expect(lines[0]).toBe(MANIFEST_COLUMNS.join(","));
    expect(lines[1]).toBe(
      'beef_burger.jpg,Beef Burger,"Cheddar, ""aged"" & bacon",Mains,done,,1,mock/sample,,1024x1024,editorial,Photo of Beef Burger,2026-09-06T10:01:00.000Z,4200,0',
    );
    expect(lines[2]).toBe("pad_thai.jpg,Pad Thai,,,done,,1,mock/sample,,1024x1024,editorial,Photo of Pad Thai,,,0.011");
    expect(csv).not.toContain("\n\n");
    expect(csv).toContain('"Mock provider: simulated transient failure\nsecond line"');
    expect(lines[0].split(",")).toHaveLength(15);
  });

  it("includes the quality column when the settings carry one", () => {
    const job = makeJob([burger]);
    job.settings.quality = "medium";
    const rows = buildManifestCsv(job).split("\r\n");
    expect(rows[1]).toContain(",mock/sample,medium,1024x1024,");
  });
});

describe("buildPromptsText", () => {
  it("lists `filename: prompt` per item", () => {
    expect(buildPromptsText([burger, padThai])).toBe(
      "beef_burger.jpg: Photo of Beef Burger\npad_thai.jpg: Photo of Pad Thai\n",
    );
    expect(buildPromptsText([])).toBe("");
  });
});

describe("zipFilenameForJob", () => {
  it("uses the slugified source stem and the first 8 chars of the job id", () => {
    expect(zipFilenameForJob(makeJob([], "Summer Menu 2025.xlsx"))).toBe("menugen_summer_menu_2025_abcdef12.zip");
    expect(zipFilenameForJob(makeJob([], "menus/Crème Brûlée.csv"))).toBe("menugen_creme_brulee_abcdef12.zip");
    expect(zipFilenameForJob(makeJob([], "C:\\Users\\me\\dinner.csv"))).toBe("menugen_dinner_abcdef12.zip");
  });

  it('falls back to "menu" without a source filename', () => {
    expect(zipFilenameForJob(makeJob([]))).toBe("menugen_menu_abcdef12.zip");
    expect(zipFilenameForJob(makeJob([], ".csv"))).toBe("menugen_menu_abcdef12.zip");
  });
});

describe("createJobZipStream", () => {
  it("streams a valid ZIP with the images, manifest.csv and prompts.txt", async () => {
    const buffer = await collect(createJobZipStream(makeJob([burger, padThai, soup]), (i) => imagePaths.get(i.id)));

    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(buffer.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    expect(buffer.includes("beef_burger.jpg")).toBe(true);
    expect(buffer.includes("pad_thai.jpg")).toBe(true);
    expect(buffer.includes("manifest.csv")).toBe(true);
    expect(buffer.includes("prompts.txt")).toBe(true);
  });

  it("skips done items whose image is missing on disk", async () => {
    const buffer = await collect(
      createJobZipStream(makeJob([burger, padThai]), (i) => (i.id === burger.id ? imagePaths.get(i.id) : undefined)),
    );
    expect(buffer.includes("beef_burger.jpg")).toBe(true);
    expect(buffer.includes("pad_thai.jpg")).toBe(false);
    expect(buffer.includes("manifest.csv")).toBe(true);
  });
});

describe("writeJobZip", () => {
  it("writes the archive to disk, creating parent directories, and reports its size", async () => {
    const job = makeJob([burger, padThai, soup], "menu.csv");
    const outPath = path.join(tmpDir, "out", "nested", zipFilenameForJob(job));

    const result = await writeJobZip(job, (i) => imagePaths.get(i.id), outPath);

    expect(result.path).toBe(outPath);
    const stat = await fs.stat(outPath);
    expect(stat.size).toBeGreaterThan(0);
    expect(result.bytes).toBe(stat.size);

    const buffer = await fs.readFile(outPath);
    expect(buffer.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(buffer.includes("beef_burger.jpg")).toBe(true);
    expect(buffer.includes("pad_thai.jpg")).toBe(true);
    expect(buffer.includes("manifest.csv")).toBe(true);
    expect(buffer.includes("prompts.txt")).toBe(true);
  });

  it("removes the partial file and rejects when a source image cannot be read", async () => {
    const outPath = path.join(tmpDir, "broken.zip");
    await expect(
      writeJobZip(makeJob([burger]), () => path.join(tmpDir, "does-not-exist.jpg"), outPath),
    ).rejects.toThrow(/Could not write ZIP/);
    await expect(fs.access(outPath)).rejects.toThrow();
  });
});
