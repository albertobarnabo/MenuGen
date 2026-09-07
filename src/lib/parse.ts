/**
 * CSV / XLSX → MenuItem[]. Isomorphic (browser + Node): no Node built-ins here.
 * Column matching is case-insensitive and accepts the aliases in {@link COLUMN_ALIASES}.
 */
import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { MenuItem, ParseResult, ParseWarning } from "./types";

/**
 * Accepted header names per field, in priority order (the first alias present
 * in the file wins). Compared after {@link normalizeHeader}, so `"Dish Name"`,
 * `"dish-name"` and `"DISH_NAME"` all match `dish_name`.
 */
export const COLUMN_ALIASES: Record<"dishName" | "description" | "category", string[]> = {
  dishName: ["dish_name", "dish", "dishname", "name", "item", "item_name", "title", "product", "menu_item", "menu item"],
  description: ["description", "desc", "details", "ingredients", "summary"],
  category: ["category", "cat", "section", "type", "course", "group"],
};

/** Hard cap on data rows accepted from a single file. */
export const MAX_PARSE_ROWS = 5000;

/** File extensions (lower-case, no dot) parsed as delimited text. */
export const CSV_EXTENSIONS: readonly string[] = ["csv", "tsv", "txt"];

/** File extensions (lower-case, no dot) parsed as spreadsheets. */
export const XLSX_EXTENSIONS: readonly string[] = ["xlsx", "xls", "xlsm"];

/** Header written by {@link itemsToCsv}, in column order. */
export const EXPORT_COLUMNS = ["dish_name", "description", "category"] as const;

/** Thrown for any input the parser cannot turn into menu items. The message is user-facing. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/** Optional knobs shared by every parse entry point. */
export interface ParseOptions {
  /** Id factory; defaults to `crypto.randomUUID()`. */
  makeId?: () => string;
}

type FieldKey = keyof typeof COLUMN_ALIASES;

/** A parsed table: header cells in source order plus one record per data row, keyed by the raw header text. */
interface RawTable {
  headers: string[];
  rows: ReadonlyArray<Record<string, unknown>>;
  /** Extra hint prepended to the "missing column" error (e.g. when delimiter detection failed). */
  headerHint?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise a header cell for alias matching: trim, lower-case, collapse runs
 * of whitespace / dashes / underscores to a single `_`, strip a stray BOM.
 * `"Dish Name"` → `"dish_name"`, `" Description "` → `"description"`.
 */
export function normalizeHeader(header: string): string {
  return header
    .replace(/\uFEFF/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Collapse internal whitespace and trim. Non-string cell values are stringified. */
function cleanValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function defaultMakeId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  // Fallback for insecure contexts (plain-http origins) where randomUUID is unavailable.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Maps every normalised column name to the raw header key it should be read from (first occurrence wins). */
function indexHeaders(headers: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const raw of headers) {
    const normalised = normalizeHeader(raw);
    if (normalised && !index.has(normalised)) index.set(normalised, raw);
  }
  return index;
}

/** Resolve the raw header key for a field by walking its aliases in priority order. */
function resolveField(field: FieldKey, index: Map<string, string>): string | undefined {
  for (const alias of COLUMN_ALIASES[field]) {
    const raw = index.get(normalizeHeader(alias));
    if (raw !== undefined) return raw;
  }
  return undefined;
}

function missingDishNameError(columns: string[], hint?: string): ParseError {
  const found = columns.length ? columns.join(", ") : "(none)";
  const accepted = COLUMN_ALIASES.dishName.map(normalizeHeader).join(", ");
  const prefix = hint ? `${hint} ` : "";
  return new ParseError(`${prefix}Missing required column dish_name. Found columns: ${found}; accepted names: ${accepted}`);
}

/** Header/alias resolution, validation and row cleaning shared by the CSV and XLSX paths. */
function tableToResult(table: RawTable, options?: ParseOptions): ParseResult {
  const index = indexHeaders(table.headers);
  const columns = [...index.keys()];

  const dishNameKey = resolveField("dishName", index);
  if (dishNameKey === undefined) throw missingDishNameError(columns, table.headerHint);
  const descriptionKey = resolveField("description", index);
  const categoryKey = resolveField("category", index);

  if (table.rows.length > MAX_PARSE_ROWS) {
    throw new ParseError(
      `Too many rows: the file has ${table.rows.length} data rows, the maximum is ${MAX_PARSE_ROWS}`,
    );
  }

  const makeId = options?.makeId ?? defaultMakeId;
  const items: MenuItem[] = [];
  const warnings: ParseWarning[] = [];

  table.rows.forEach((row, i) => {
    const rowNumber = i + 1;
    const dishName = cleanValue(row[dishNameKey]);
    if (!dishName) {
      warnings.push({ row: rowNumber, message: `Row ${rowNumber} skipped: dish name is empty` });
      return;
    }
    items.push({
      id: makeId(),
      dishName,
      description: descriptionKey === undefined ? "" : cleanValue(row[descriptionKey]),
      category: categoryKey === undefined ? "" : cleanValue(row[categoryKey]),
    });
  });

  return { items, columns, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Turn a Papa "Quotes" error into a message a non-technical user can act on. */
function quotesError(error: Papa.ParseError): ParseError {
  const where = error.row === undefined ? "" : ` (data row ${error.row + 1})`;
  return new ParseError(
    `Malformed CSV: ${error.message}${where}. Make sure every quote is closed and quotes inside a field are doubled ("").`,
  );
}

/** Parse CSV text (handles BOM, quoted fields, CRLF, `;` delimiter auto-detect). */
export function parseCsv(text: string, options?: ParseOptions): ParseResult {
  const input = stripBom(text);
  if (input.trim() === "") throw new ParseError("The file is empty");

  const result = Papa.parse<Record<string, unknown>>(input, {
    header: true,
    skipEmptyLines: "greedy",
    delimitersToGuess: [",", ";", "\t"],
  });

  const quotes = result.errors.find((e) => e.type === "Quotes");
  if (quotes) throw quotesError(quotes);
  // Papa cannot detect a delimiter for single-column files; it falls back to "," which is fine.
  // Only surface the problem when the header could not be resolved as a result.
  const delimiterUndetected = result.errors.some((e) => e.type === "Delimiter");

  return tableToResult(
    {
      headers: result.meta.fields ?? [],
      rows: result.data,
      headerHint: delimiterUndetected ? "Could not detect the column delimiter (comma, semicolon or tab)." : undefined,
    },
    options,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// XLSX
// ─────────────────────────────────────────────────────────────────────────────

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Read the first (header) row of a sheet as formatted text, in column order.
 *
 * Cells are returned verbatim (no trimming): they must equal the object keys
 * `sheet_to_json` derives from the same row, or data lookups would miss.
 * Normalisation happens later in {@link normalizeHeader}.
 */
function readHeaderRow(sheet: XLSX.WorkSheet, ref: string): string[] {
  const range = XLSX.utils.decode_range(ref);
  range.e.r = range.s.r;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    range: XLSX.utils.encode_range(range),
  });
  return (rows[0] ?? []).map((cell) => (typeof cell === "string" ? cell : String(cell ?? "")));
}

/** Parse the first sheet of an .xlsx/.xls workbook. */
export function parseXlsx(data: ArrayBuffer | Uint8Array, options?: ParseOptions): ParseResult {
  const bytes = toUint8Array(data);
  if (bytes.byteLength === 0) throw new ParseError("The file is empty");

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ParseError(`Could not read the spreadsheet: ${detail}`);
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName === undefined ? undefined : workbook.Sheets[sheetName];
  const ref = sheet?.["!ref"];
  if (!sheet || !ref) throw new ParseError("The file is empty");

  const headers = readHeaderRow(sheet, ref);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  if (rows.length === 0 && headers.every((header) => header.trim() === "")) {
    throw new ParseError("The file is empty");
  }
  return tableToResult({ headers, rows }, options);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch & export
// ─────────────────────────────────────────────────────────────────────────────

/** Lower-cased extension without the dot; `""` when the name has none. */
function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function decodeText(data: ArrayBuffer | Uint8Array | string): string {
  return typeof data === "string" ? data : new TextDecoder("utf-8").decode(data);
}

/** Dispatch on file extension (`.csv`, `.tsv`, `.txt` → CSV; `.xlsx`, `.xls` → XLSX). */
export function parseMenuFile(
  file: { name: string; data: ArrayBuffer | Uint8Array | string },
  options?: ParseOptions,
): ParseResult {
  const ext = extensionOf(file.name);
  if (CSV_EXTENSIONS.includes(ext)) return parseCsv(decodeText(file.data), options);
  if (XLSX_EXTENSIONS.includes(ext)) {
    if (typeof file.data === "string") {
      throw new ParseError(`Spreadsheet "${file.name}" must be provided as binary data (ArrayBuffer or Uint8Array)`);
    }
    return parseXlsx(file.data, options);
  }
  const accepted = [...CSV_EXTENSIONS, ...XLSX_EXTENSIONS].map((e) => `.${e}`).join(", ");
  const shown = ext ? `.${ext}` : "(no extension)";
  throw new ParseError(`Unsupported file type ${shown} for "${file.name}". Accepted types: ${accepted}`);
}

/**
 * Serialise items back to CSV (dish_name, description, category) for export.
 * Rows are CRLF-separated with no trailing line break; fields are quoted only
 * when they contain a comma, quote, line break or surrounding whitespace.
 */
export function itemsToCsv(items: MenuItem[]): string {
  if (items.length === 0) return EXPORT_COLUMNS.join(",");
  return Papa.unparse(
    {
      fields: [...EXPORT_COLUMNS],
      data: items.map((item) => [item.dishName, item.description, item.category]),
    },
    {
      newline: "\r\n",
      quotes: (value: unknown) => /[",\r\n]/.test(String(value ?? "")),
    },
  );
}
