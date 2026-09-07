/**
 * Client-side mirrors of the server validation limits documented in
 * docs/ARCHITECTURE.md ("Validation limits"). The server remains the source of
 * truth; these only drive inline hints before a request is sent.
 */

/** Maximum dish name length after trimming. */
export const MAX_DISH_NAME_LENGTH = 200;
/** Maximum description / category length. */
export const MAX_TEXT_FIELD_LENGTH = 1000;
/** Maximum custom prompt / template length. */
export const MAX_CUSTOM_PROMPT_LENGTH = 2000;
/** Maximum upload size accepted by the drop zone (bytes). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Rows rendered before the table asks to "Show all". */
export const TABLE_RENDER_LIMIT = 200;

/** Reason a row cannot be sent to the API, or null when it is fine. */
export function rowIssue(item: { dishName: string; description: string; category: string }): string | null {
  if (item.dishName.trim() === "") return "Dish name is required";
  if (item.dishName.trim().length > MAX_DISH_NAME_LENGTH) return `Dish name must be at most ${MAX_DISH_NAME_LENGTH} characters`;
  if (item.description.length > MAX_TEXT_FIELD_LENGTH) return `Description must be at most ${MAX_TEXT_FIELD_LENGTH} characters`;
  if (item.category.length > MAX_TEXT_FIELD_LENGTH) return `Category must be at most ${MAX_TEXT_FIELD_LENGTH} characters`;
  return null;
}
