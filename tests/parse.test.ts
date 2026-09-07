import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  COLUMN_ALIASES,
  CSV_EXTENSIONS,
  MAX_PARSE_ROWS,
  ParseError,
  XLSX_EXTENSIONS,
  itemsToCsv,
  normalizeHeader,
  parseCsv,
  parseMenuFile,
  parseXlsx,
} from "../src/lib/parse";
import type { MenuItem } from "../src/lib/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Deterministic id factory so item expectations can be exact. */
function sequentialIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `id-${n}`;
  };
}

/** Build a real .xlsx workbook in memory from an array of rows. */
function xlsxBuffer(rows: unknown[][], sheetName = "Menu"): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  const out: unknown = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  if (out instanceof ArrayBuffer) return out;
  if (out instanceof Uint8Array) return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  throw new Error("XLSX.write returned an unexpected type");
}

function names(items: MenuItem[]): string[] {
  return items.map((item) => item.dishName);
}

describe("normalizeHeader", () => {
  it("trims, lower-cases and collapses separators to a single underscore", () => {
    expect(normalizeHeader("  Dish Name ")).toBe("dish_name");
    expect(normalizeHeader("dish-name")).toBe("dish_name");
    expect(normalizeHeader("DISH__NAME")).toBe("dish_name");
    expect(normalizeHeader("Menu   Item")).toBe("menu_item");
    expect(normalizeHeader("﻿dish_name")).toBe("dish_name");
    expect(normalizeHeader("   ")).toBe("");
  });
});

describe("parseCsv", () => {
  it("handles a BOM, CRLF line endings and quoted commas", () => {
    const csv =
      "﻿dish_name,description,category\r\n" +
      'Chicken Caesar Salad,"Romaine, grilled chicken, parmesan",salad\r\n' +
      'Tiramisu,"Mascarpone cream, ""espresso"" soaked",dessert\r\n';

    const result = parseCsv(csv, { makeId: sequentialIds() });

    expect(result.columns).toEqual(["dish_name", "description", "category"]);
    expect(result.warnings).toEqual([]);
    expect(result.items).toEqual([
      {
        id: "id-1",
        dishName: "Chicken Caesar Salad",
        description: "Romaine, grilled chicken, parmesan",
        category: "salad",
      },
      {
        id: "id-2",
        dishName: "Tiramisu",
        description: 'Mascarpone cream, "espresso" soaked',
        category: "dessert",
      },
    ]);
  });

  it("auto-detects a semicolon delimiter", () => {
    const csv = "dish_name;description;category\nBeef Burger;Double patty, cheddar;burger\nTiramisu;;dessert\n";

    const result = parseCsv(csv, { makeId: sequentialIds() });

    expect(result.columns).toEqual(["dish_name", "description", "category"]);
    expect(result.items).toEqual([
      { id: "id-1", dishName: "Beef Burger", description: "Double patty, cheddar", category: "burger" },
      { id: "id-2", dishName: "Tiramisu", description: "", category: "dessert" },
    ]);
  });

  it("auto-detects a tab delimiter", () => {
    const csv = "dish_name\tcategory\nMiso Soup\tsoup\n";

    const result = parseCsv(csv);

    expect(result.columns).toEqual(["dish_name", "category"]);
    expect(result.items).toMatchObject([{ dishName: "Miso Soup", description: "", category: "soup" }]);
  });

  it("resolves header aliases regardless of case and surrounding whitespace", () => {
    const csv = "Dish Name,Description ,Category\nBeef Burger,Double patty,burger\n";

    const result = parseCsv(csv);

    expect(result.columns).toEqual(["dish_name", "description", "category"]);
    expect(result.items).toMatchObject([{ dishName: "Beef Burger", description: "Double patty", category: "burger" }]);
  });

  it("accepts secondary aliases such as name / desc / section", () => {
    const csv = "Section,Name,Desc\nMains,Lamb Tagine,Slow cooked\n";

    const result = parseCsv(csv);

    expect(result.items).toMatchObject([{ dishName: "Lamb Tagine", description: "Slow cooked", category: "Mains" }]);
  });

  it("prefers the highest-priority alias when several are present", () => {
    const csv = "title,dish_name\nWrong,Right\n";

    const result = parseCsv(csv);

    expect(result.items).toMatchObject([{ dishName: "Right" }]);
    expect(COLUMN_ALIASES.dishName.indexOf("dish_name")).toBeLessThan(COLUMN_ALIASES.dishName.indexOf("title"));
  });

  it("skips rows with an empty dish name and reports the 1-based data row", () => {
    const csv = "dish_name,description\nPizza,cheese\n,no name here\n   ,spaces only\nPasta,\n";

    const result = parseCsv(csv);

    expect(names(result.items)).toEqual(["Pizza", "Pasta"]);
    expect(result.warnings).toEqual([
      { row: 2, message: "Row 2 skipped: dish name is empty" },
      { row: 3, message: "Row 3 skipped: dish name is empty" },
    ]);
  });

  it("silently drops fully blank lines", () => {
    const csv = "dish_name,description\nPizza,cheese\n\n   \n,\nPasta,ragu\n";

    const result = parseCsv(csv);

    expect(names(result.items)).toEqual(["Pizza", "Pasta"]);
    expect(result.warnings).toEqual([]);
  });

  it("trims and collapses whitespace inside values", () => {
    const csv = 'dish_name,description,category\n"  Beef   Burger ","  Double\t\tpatty  ", burger \n';

    const result = parseCsv(csv);

    expect(result.items).toMatchObject([{ dishName: "Beef Burger", description: "Double patty", category: "burger" }]);
  });

  it("lists extra columns but does not copy them into items", () => {
    const csv = "dish_name,Price (EUR),allergens\nPizza,12,gluten\n";

    const result = parseCsv(csv);

    expect(result.columns).toEqual(["dish_name", "price_(eur)", "allergens"]);
    expect(result.items).toEqual([{ id: expect.any(String), dishName: "Pizza", description: "", category: "" }]);
  });

  it("names the found and accepted columns when dish_name is missing", () => {
    const csv = "sku,price\nB-1,10\n";

    expect(() => parseCsv(csv)).toThrow(ParseError);
    expect(() => parseCsv(csv)).toThrowError(/Missing required column dish_name/);
    expect(() => parseCsv(csv)).toThrowError(/Found columns: sku, price/);
    for (const alias of COLUMN_ALIASES.dishName) {
      expect(() => parseCsv(csv)).toThrowError(normalizeHeader(alias));
    }
  });

  it("rejects files with more than MAX_PARSE_ROWS data rows but accepts exactly the limit", () => {
    const header = "dish_name";
    const atLimit = [header, ...Array.from({ length: MAX_PARSE_ROWS }, (_, i) => `Dish ${i}`)].join("\n");
    const overLimit = `${atLimit}\nOne too many`;

    expect(parseCsv(atLimit).items).toHaveLength(MAX_PARSE_ROWS);
    expect(() => parseCsv(overLimit)).toThrow(ParseError);
    expect(() => parseCsv(overLimit)).toThrowError(new RegExp(`${MAX_PARSE_ROWS + 1} data rows.*maximum is ${MAX_PARSE_ROWS}`));
  });

  it("generates UUID ids by default and unique ids per item", () => {
    const result = parseCsv("dish_name\nA\nB\nC\n");

    const ids = result.items.map((item) => item.id);
    for (const id of ids) expect(id).toMatch(UUID_RE);
    expect(new Set(ids).size).toBe(3);
  });

  it("rejects malformed quotes with an actionable message", () => {
    const csv = 'dish_name,description\n"Unclosed,foo\nBurger,ok\n';

    expect(() => parseCsv(csv)).toThrow(ParseError);
    expect(() => parseCsv(csv)).toThrowError(/Malformed CSV/);
    expect(() => parseCsv(csv)).toThrowError(/quote/i);
  });

  it("rejects empty input", () => {
    for (const input of ["", "   \n\r\n", "﻿"]) {
      expect(() => parseCsv(input)).toThrow(ParseError);
      expect(() => parseCsv(input)).toThrowError(/empty/i);
    }
  });

  it("returns no items for a header-only file", () => {
    const result = parseCsv("dish_name,description,category\n");

    expect(result.items).toEqual([]);
    expect(result.columns).toEqual(["dish_name", "description", "category"]);
    expect(result.warnings).toEqual([]);
  });
});

describe("parseXlsx", () => {
  it("parses the first sheet using the header row for aliases", () => {
    const buffer = xlsxBuffer([
      ["Dish Name", "Description", "Category"],
      ["Margherita Pizza", "Tomato, mozzarella", "pizza"],
      ["Tiramisu", "", "dessert"],
    ]);

    const result = parseXlsx(buffer, { makeId: sequentialIds() });

    expect(result.columns).toEqual(["dish_name", "description", "category"]);
    expect(result.warnings).toEqual([]);
    expect(result.items).toEqual([
      { id: "id-1", dishName: "Margherita Pizza", description: "Tomato, mozzarella", category: "pizza" },
      { id: "id-2", dishName: "Tiramisu", description: "", category: "dessert" },
    ]);
  });

  it("accepts a Uint8Array as well as an ArrayBuffer", () => {
    const buffer = xlsxBuffer([["dish_name"], ["Soup"]]);

    expect(names(parseXlsx(new Uint8Array(buffer)).items)).toEqual(["Soup"]);
    expect(names(parseXlsx(buffer).items)).toEqual(["Soup"]);
  });

  it("stringifies numeric cells and warns about blank dish rows", () => {
    const buffer = xlsxBuffer([
      ["dish_name", "description", "category"],
      ["Combo 1", 42, "lunch"],
      ["", "orphan description", ""],
      ["Soup", "hot", ""],
    ]);

    const result = parseXlsx(buffer);

    expect(result.items).toMatchObject([
      { dishName: "Combo 1", description: "42", category: "lunch" },
      { dishName: "Soup", description: "hot", category: "" },
    ]);
    expect(result.warnings).toEqual([{ row: 2, message: "Row 2 skipped: dish name is empty" }]);
  });

  it("matches headers that carry stray whitespace", () => {
    const buffer = xlsxBuffer([
      ["Dish  Name ", " description"],
      ["Ramen", "pork broth"],
    ]);

    const result = parseXlsx(buffer);

    expect(result.columns).toEqual(["dish_name", "description"]);
    expect(result.items).toMatchObject([{ dishName: "Ramen", description: "pork broth" }]);
  });

  it("ignores every sheet but the first", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["dish_name"], ["First"]]), "One");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["dish_name"], ["Second"]]), "Two");
    const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

    expect(names(parseXlsx(bytes).items)).toEqual(["First"]);
  });

  it("reports a missing dish_name column", () => {
    const buffer = xlsxBuffer([["sku", "price"], ["B-1", 10]]);

    expect(() => parseXlsx(buffer)).toThrowError(/Missing required column dish_name.*Found columns: sku, price/);
  });

  it("rejects empty input and empty sheets", () => {
    expect(() => parseXlsx(new Uint8Array())).toThrowError(/empty/i);
    expect(() => parseXlsx(new ArrayBuffer(0))).toThrowError(/empty/i);
    expect(() => parseXlsx(xlsxBuffer([]))).toThrowError(/empty/i);
  });

  it("wraps unreadable bytes in a ParseError", () => {
    expect(() => parseXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))).toThrow(ParseError);
  });
});

describe("parseMenuFile", () => {
  const csv = "dish_name,category\nPad Thai,noodles\n";

  it("parses delimited text for every CSV extension, case-insensitively", () => {
    for (const ext of CSV_EXTENSIONS) {
      expect(names(parseMenuFile({ name: `menu.${ext}`, data: csv }).items)).toEqual(["Pad Thai"]);
    }
    expect(names(parseMenuFile({ name: "MENU.CSV", data: csv }).items)).toEqual(["Pad Thai"]);
    expect(names(parseMenuFile({ name: "/tmp/exports/menu.v2.csv", data: csv }).items)).toEqual(["Pad Thai"]);
  });

  it("decodes UTF-8 bytes for delimited text", () => {
    const bytes = new TextEncoder().encode("﻿dish_name\nCrème Brûlée\n");

    expect(names(parseMenuFile({ name: "menu.csv", data: bytes }).items)).toEqual(["Crème Brûlée"]);
    expect(names(parseMenuFile({ name: "menu.csv", data: bytes.buffer as ArrayBuffer }).items)).toEqual(["Crème Brûlée"]);
  });

  it("parses spreadsheets for every XLSX extension", () => {
    const buffer = xlsxBuffer([["dish_name"], ["Gyoza"]]);

    for (const ext of XLSX_EXTENSIONS) {
      expect(names(parseMenuFile({ name: `menu.${ext}`, data: buffer }).items)).toEqual(["Gyoza"]);
    }
    expect(names(parseMenuFile({ name: "Menu.XLSM", data: new Uint8Array(buffer) }).items)).toEqual(["Gyoza"]);
  });

  it("rejects unknown or missing extensions and lists the accepted ones", () => {
    expect(() => parseMenuFile({ name: "menu.pdf", data: csv })).toThrow(ParseError);
    expect(() => parseMenuFile({ name: "menu.pdf", data: csv })).toThrowError(/Unsupported file type \.pdf/);
    expect(() => parseMenuFile({ name: "menu.pdf", data: csv })).toThrowError(/\.csv, \.tsv, \.txt, \.xlsx, \.xls, \.xlsm/);
    expect(() => parseMenuFile({ name: "menu", data: csv })).toThrowError(/\(no extension\)/);
    expect(() => parseMenuFile({ name: ".csv", data: csv })).toThrowError(/\(no extension\)/);
  });

  it("rejects string data for spreadsheets", () => {
    expect(() => parseMenuFile({ name: "menu.xlsx", data: "dish_name\nA" })).toThrowError(/binary data/);
  });
});

describe("itemsToCsv", () => {
  it("writes the canonical header with CRLF rows and quotes only when needed", () => {
    const items: MenuItem[] = [
      { id: "1", dishName: "Beef Burger", description: "Double patty, cheddar", category: "burger" },
      { id: "2", dishName: 'The "Big" One', description: "line1\nline2", category: "" },
    ];

    expect(itemsToCsv(items)).toBe(
      "dish_name,description,category\r\n" +
        'Beef Burger,"Double patty, cheddar",burger\r\n' +
        '"The ""Big"" One","line1\nline2",',
    );
  });

  it("emits only the header for an empty list", () => {
    expect(itemsToCsv([])).toBe("dish_name,description,category");
  });

  it("round-trips through parseCsv", () => {
    const items: MenuItem[] = [
      { id: "a", dishName: "Crème Brûlée", description: "Vanilla custard, caramel", category: "dessert" },
      { id: "b", dishName: 'Chef\'s "Special"', description: "", category: "mains; daily" },
      { id: "c", dishName: "Plain", description: "", category: "" },
    ];

    const parsed = parseCsv(itemsToCsv(items));

    expect(parsed.warnings).toEqual([]);
    expect(parsed.columns).toEqual(["dish_name", "description", "category"]);
    expect(parsed.items.map(({ dishName, description, category }) => ({ dishName, description, category }))).toEqual(
      items.map(({ dishName, description, category }) => ({ dishName, description, category })),
    );
  });
});
