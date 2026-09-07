import { describe, expect, it } from "vitest";
import {
  FALLBACK_STEM,
  MAX_STEM_LENGTH,
  assignFilenames,
  extensionForFormat,
  formatForMimeType,
  mimeTypeForFormat,
  toFilenameStem,
} from "../src/lib/filename";

describe("toFilenameStem", () => {
  it("strips diacritics and punctuation", () => {
    expect(toFilenameStem("Crème Brûlée!")).toBe("creme_brulee");
    expect(toFilenameStem("Jalapeño Poppers")).toBe("jalapeno_poppers");
    expect(toFilenameStem("Fish & Chips")).toBe("fish_chips");
    expect(toFilenameStem("Spätzle mit Käse")).toBe("spatzle_mit_kase");
  });

  it("lower-cases and collapses runs of separators", () => {
    expect(toFilenameStem("  Beef   Burger -- Deluxe ")).toBe("beef_burger_deluxe");
    expect(toFilenameStem("Mac_&_Cheese")).toBe("mac_cheese");
    expect(toFilenameStem("__leading__and__trailing__")).toBe("leading_and_trailing");
  });

  it("keeps digits", () => {
    expect(toFilenameStem("Combo #2 (large)")).toBe("combo_2_large");
    expect(toFilenameStem("Menu 2024")).toBe("menu_2024");
  });

  it("falls back to the placeholder stem when nothing ASCII remains", () => {
    expect(FALLBACK_STEM).toBe("dish");
    expect(toFilenameStem("🍕🍔🍟")).toBe("dish");
    expect(toFilenameStem("寿司")).toBe("dish");
    expect(toFilenameStem("Ελληνικά")).toBe("dish");
    expect(toFilenameStem("")).toBe("dish");
    expect(toFilenameStem("!!! ??? ---")).toBe("dish");
  });

  it("keeps the latin part of mixed-script names", () => {
    expect(toFilenameStem("寿司 Sushi 🍣")).toBe("sushi");
  });

  it("caps the stem length, cutting on a word boundary when possible", () => {
    expect(MAX_STEM_LENGTH).toBe(80);
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const stem = toFilenameStem(long);
    expect(stem.length).toBeLessThanOrEqual(MAX_STEM_LENGTH);
    expect(stem.endsWith("_")).toBe(false);
    expect(long.replace(/ /g, "_").startsWith(stem)).toBe(true);

    expect(toFilenameStem("a".repeat(100), 10)).toBe("a".repeat(10));
    expect(toFilenameStem("hello world foo bar", 8)).toBe("hello");
    expect(toFilenameStem("hello world foo bar", 11)).toBe("hello_world");
    expect(toFilenameStem("hello world foo bar", 12)).toBe("hello_world");
    expect(toFilenameStem("abc", 1)).toBe("a");
  });

  it("uses the default cap for unusable maxLength values", () => {
    const long = "x".repeat(200);
    expect(toFilenameStem(long, Number.NaN)).toHaveLength(MAX_STEM_LENGTH);
    expect(toFilenameStem(long, Number.POSITIVE_INFINITY)).toHaveLength(MAX_STEM_LENGTH);
    expect(toFilenameStem(long, 0)).toHaveLength(1);
  });

  it("suffixes Windows reserved device names", () => {
    expect(toFilenameStem("CON")).toBe("con_dish");
    expect(toFilenameStem("Aux")).toBe("aux_dish");
    expect(toFilenameStem("LPT1")).toBe("lpt1_dish");
    expect(toFilenameStem("Console")).toBe("console");
  });
});

describe("assignFilenames", () => {
  it("maps output formats to file extensions", () => {
    expect(assignFilenames([{ dishName: "Beef Burger" }], "jpeg")).toEqual(["beef_burger.jpg"]);
    expect(assignFilenames([{ dishName: "Beef Burger" }], "png")).toEqual(["beef_burger.png"]);
    expect(assignFilenames([{ dishName: "Beef Burger" }], "webp")).toEqual(["beef_burger.webp"]);
  });

  it("appends _2, _3 … to duplicates while preserving input order", () => {
    const items = [{ dishName: "Pizza" }, { dishName: "Salad" }, { dishName: "pizza" }, { dishName: "PIZZA!" }];

    expect(assignFilenames(items, "jpeg")).toEqual(["pizza.jpg", "salad.jpg", "pizza_2.jpg", "pizza_3.jpg"]);
  });

  it("treats names that differ only by diacritics as duplicates", () => {
    expect(assignFilenames([{ dishName: "Café" }, { dishName: "cafe" }], "png")).toEqual(["cafe.png", "cafe_2.png"]);
  });

  it("stays unique when a name already slugifies to a suffixed stem", () => {
    expect(assignFilenames([{ dishName: "Pizza" }, { dishName: "Pizza 2" }, { dishName: "Pizza" }], "png")).toEqual([
      "pizza.png",
      "pizza_2.png",
      "pizza_3.png",
    ]);

    const other = assignFilenames([{ dishName: "Pizza" }, { dishName: "Pizza" }, { dishName: "Pizza 2" }], "png");
    expect(other.slice(0, 2)).toEqual(["pizza.png", "pizza_2.png"]);
    expect(new Set(other).size).toBe(3);
  });

  it("de-duplicates fallback stems too", () => {
    expect(assignFilenames([{ dishName: "🍕" }, { dishName: "寿司" }, { dishName: "" }], "jpeg")).toEqual([
      "dish.jpg",
      "dish_2.jpg",
      "dish_3.jpg",
    ]);
  });

  it("returns an array parallel to the input and every name unique", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ dishName: i % 2 ? "Same Dish" : "Other" }));

    const filenames = assignFilenames(items, "webp");

    expect(filenames).toHaveLength(items.length);
    expect(new Set(filenames).size).toBe(items.length);
    expect(assignFilenames([], "jpeg")).toEqual([]);
  });
});

describe("format helpers", () => {
  it("extensionForFormat uses jpg for jpeg", () => {
    expect(extensionForFormat("jpeg")).toBe("jpg");
    expect(extensionForFormat("png")).toBe("png");
    expect(extensionForFormat("webp")).toBe("webp");
  });

  it("mimeTypeForFormat and formatForMimeType are inverses", () => {
    expect(mimeTypeForFormat("jpeg")).toBe("image/jpeg");
    expect(mimeTypeForFormat("png")).toBe("image/png");
    expect(mimeTypeForFormat("webp")).toBe("image/webp");
    for (const format of ["jpeg", "png", "webp"] as const) {
      expect(formatForMimeType(mimeTypeForFormat(format))).toBe(format);
    }
  });

  it("formatForMimeType tolerates parameters, casing and image/jpg", () => {
    expect(formatForMimeType("image/jpg")).toBe("jpeg");
    expect(formatForMimeType("IMAGE/PNG; charset=binary")).toBe("png");
    expect(formatForMimeType(" image/webp ")).toBe("webp");
    expect(formatForMimeType("text/plain")).toBeUndefined();
    expect(formatForMimeType("")).toBeUndefined();
  });
});
