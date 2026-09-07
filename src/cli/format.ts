/**
 * Terminal formatting helpers for the MenuGen CLI.
 *
 * Hand-rolled ANSI colours (no chalk/ora): colours are enabled only when the
 * target stream is a TTY, `NO_COLOR` is unset and `--no-color` was not passed.
 * Everything here is pure and side-effect free so it can be unit tested.
 */

/** Minimal shape of a writable stream that may or may not be a terminal. */
export interface TtyLike {
  isTTY?: boolean;
}

/** A set of colour functions; each returns its input unchanged when colours are disabled. */
export interface Palette {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

/** One table row: the cell values plus optional indented note lines printed underneath. */
export interface TableRow {
  cells: string[];
  notes?: string[];
}

/** Per-column alignment for {@link renderTable}; defaults to left. */
export type ColumnAlign = "left" | "right";

const ESC = "\u001b";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/**
 * Decide whether to emit ANSI colours.
 *
 * `NO_COLOR` (https://no-color.org) and an explicit `--no-color` always win;
 * `FORCE_COLOR` enables colours even when piped; otherwise colours follow `isTTY`.
 */
export function shouldUseColor(options: {
  stream: TtyLike;
  colorFlag?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = options.env ?? process.env;
  if (options.colorFlag === false) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") return true;
  return options.stream.isTTY === true;
}

/** Build a {@link Palette}; when `enabled` is false every function is the identity. */
export function createPalette(enabled: boolean): Palette {
  const wrap = (open: number, close: number) => (text: string) =>
    enabled ? `${ESC}[${open}m${text}${ESC}[${close}m` : text;
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    green: wrap(32, 39),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

/** Remove ANSI colour codes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Visible width of a string (code points, ignoring ANSI codes). Good enough for menus. */
export function displayWidth(text: string): number {
  return Array.from(stripAnsi(text)).length;
}

/** Pad with spaces to `width` visible columns, honouring ANSI codes in `text`. */
export function padTo(text: string, width: number, align: ColumnAlign = "left"): string {
  const missing = Math.max(0, width - displayWidth(text));
  const fill = " ".repeat(missing);
  return align === "right" ? fill + text : text + fill;
}

/** Truncate to `max` visible characters, appending an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= 1) return "…";
  return `${chars.slice(0, max - 1).join("")}…`;
}

/** Collapse whitespace/newlines to single spaces so a cell stays on one line. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Render a plain-text table (two-space column gutters, dimmed header rule).
 * Rows may carry `notes`, printed indented under the row. Returns the lines.
 */
export function renderTable(
  headers: string[],
  rows: TableRow[],
  options: { palette?: Palette; align?: ColumnAlign[] } = {},
): string[] {
  const palette = options.palette ?? createPalette(false);
  const columnCount = Math.max(headers.length, ...rows.map((r) => r.cells.length));
  const widths = Array.from({ length: columnCount }, (_, col) =>
    Math.max(displayWidth(headers[col] ?? ""), ...rows.map((r) => displayWidth(r.cells[col] ?? ""))),
  );
  const alignFor = (col: number): ColumnAlign => options.align?.[col] ?? "left";
  const formatLine = (cells: string[]): string =>
    widths
      .map((w, col) => padTo(cells[col] ?? "", w, alignFor(col)))
      .join("  ")
      .replace(/\s+$/, "");

  const lines: string[] = [
    palette.bold(formatLine(headers)),
    palette.dim(widths.map((w) => "─".repeat(w)).join("  ")),
  ];
  for (const row of rows) {
    lines.push(formatLine(row.cells));
    for (const note of row.notes ?? []) lines.push(palette.dim(`  ${note}`));
  }
  return lines;
}

/** Draw a box around lines using Unicode box-drawing characters. Returns the lines. */
export function renderBox(lines: string[], palette: Palette = createPalette(false)): string[] {
  const width = Math.max(0, ...lines.map(displayWidth));
  const edge = (left: string, right: string) => palette.dim(`${left}${"─".repeat(width + 2)}${right}`);
  return [
    edge("┌", "┐"),
    ...lines.map((line) => `${palette.dim("│")} ${padTo(line, width)} ${palette.dim("│")}`),
    edge("└", "┘"),
  ];
}

/** `4.2 s` under a minute, then `1m 05s`, then `1h 02m`. Non-finite input counts as zero. */
export function formatMs(ms: number): string {
  const seconds = (Number.isFinite(ms) ? Math.max(0, ms) : 0) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `812 B`, `1.2 KB`, `3.4 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** `1 image`, `8 images`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * `[ 3/10]`-style progress prefix; the numerator is padded to the width of the total
 * so successive lines line up.
 */
export function progressPrefix(done: number, total: number): string {
  const width = String(total).length;
  return `[${String(done).padStart(width)}/${total}]`;
}

/** Render values as an indented bullet list, one per line. */
export function bulletList(values: readonly string[], indent = "  "): string {
  return values.map((v) => `${indent}- ${v}`).join("\n");
}
