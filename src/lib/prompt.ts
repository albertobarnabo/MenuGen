import type { MenuItem, StylePreset } from "./types";

/**
 * Appended to every prompt. Modern image models ignore "negative prompt"
 * syntax, so the constraints are phrased as plain positive instructions.
 */
export const NO_ARTIFACTS_CLAUSE =
  "The image contains no text, captions, logos, watermarks, hands or people.";

export const DEFAULT_STYLE_PRESET_ID = "editorial";
export const CUSTOM_STYLE_PRESET_ID = "custom";

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: "editorial",
    name: "Editorial",
    description:
      "Warm natural light, 45° angle, shallow depth of field. A safe default for any cuisine.",
    template:
      "Professional editorial food photography of {subject}. " +
      "Shot from a 45-degree angle on an 85mm lens with soft natural window light and shallow depth of field. " +
      "Authentic textures and natural imperfections, appetizing restaurant-quality plating on a neutral ceramic plate, " +
      "a softly blurred wooden table in the background. Photorealistic, high detail. " +
      NO_ARTIFACTS_CLAUSE,
  },
  {
    id: "delivery-clean",
    name: "Delivery app",
    description:
      "Top-down on a clean light background. Consistent tiles for menus and delivery apps.",
    template:
      "Clean product-style food photography of {subject}, viewed from directly above (top-down), " +
      "centered on a plain light neutral background with soft even studio lighting and minimal shadows. " +
      "Photorealistic, sharp focus, vibrant but natural colours, consistent catalogue look. " +
      NO_ARTIFACTS_CLAUSE,
  },
  {
    id: "rustic-dark",
    name: "Rustic & moody",
    description: "Dark wood, dramatic side light. Great for steaks, pasta and desserts.",
    template:
      "Moody rustic food photography of {subject} on a dark wooden table, " +
      "dramatic directional side light with deep soft shadows and rich textures, " +
      "a linen napkin and cutlery slightly out of focus. Photorealistic, cinematic, restaurant quality. " +
      NO_ARTIFACTS_CLAUSE,
  },
  {
    id: "bright-minimal",
    name: "Bright & minimal",
    description: "Airy, high-key, pastel tones. Cafés, brunch and healthy bowls.",
    template:
      "Bright airy minimalist food photography of {subject}, high-key lighting, " +
      "light pastel background, clean white plate, generous negative space, fresh and healthy feel. " +
      "Photorealistic, crisp detail. " +
      NO_ARTIFACTS_CLAUSE,
  },
  {
    id: CUSTOM_STYLE_PRESET_ID,
    name: "Custom template",
    description:
      "Write your own template. Placeholders: {subject}, {dish_name}, {description}, {category}.",
    template: "Photorealistic food photography of {subject}. " + NO_ARTIFACTS_CLAUSE,
  },
];

export function getStylePreset(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find((p) => p.id === id);
}

/** Collapse whitespace and trim. */
function clean(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * "Beef Burger, double patty, cheddar, lettuce, pickles (burger)".
 * Only the dish name is mandatory.
 */
export function buildSubject(item: Pick<MenuItem, "dishName" | "description" | "category">): string {
  const name = clean(item.dishName);
  const description = clean(item.description);
  const category = clean(item.category);
  let subject = name;
  if (description && description.toLowerCase() !== name.toLowerCase()) {
    subject += `, ${description.replace(/[.\s]+$/, "")}`;
  }
  if (category && !name.toLowerCase().includes(category.toLowerCase())) {
    subject += ` (${category})`;
  }
  return subject;
}

/** Replace `{placeholders}` in a template; unknown placeholders are left as-is. */
export function renderTemplate(
  template: string,
  item: Pick<MenuItem, "dishName" | "description" | "category">,
): string {
  const values: Record<string, string> = {
    subject: buildSubject(item),
    dish_name: clean(item.dishName),
    description: clean(item.description),
    category: clean(item.category),
  };
  return template
    .replace(/\{(subject|dish_name|description|category)\}/g, (_m, key: string) => values[key] ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim();
}

/**
 * Build the final prompt for one menu item.
 *
 * - For a named preset, `customPrompt` (if any) is appended as an extra sentence.
 * - For the `custom` preset, `customPrompt` *is* the template (falls back to the
 *   preset's default template when empty).
 */
export function buildPrompt(
  item: Pick<MenuItem, "dishName" | "description" | "category">,
  stylePresetId: string = DEFAULT_STYLE_PRESET_ID,
  customPrompt?: string,
): string {
  const preset = getStylePreset(stylePresetId) ?? getStylePreset(DEFAULT_STYLE_PRESET_ID)!;
  const extra = clean(customPrompt);

  if (preset.id === CUSTOM_STYLE_PRESET_ID) {
    const template = extra || preset.template;
    return renderTemplate(template, item);
  }

  const base = renderTemplate(preset.template, item);
  if (!extra) return base;
  const suffix = /[.!?]$/.test(extra) ? extra : `${extra}.`;
  return `${base} ${suffix}`;
}
