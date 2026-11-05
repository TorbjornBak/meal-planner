import { parseRecipeText, parseIngredientLine } from "./parse.ts";

/** Cookbook layouts often omit an Ingredients heading. Only infer a contiguous
 * quantity-led block; leave uncertain text in the method and transcript for review. */
export function parseRecipeScan(text: string) {
  const draft = parseRecipeText(text);
  if (draft.ingredients.length) return { ...draft, instructions: draft.instructions ?? text };
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const quantityLine = (line: string) => /^(?:[•*–-]\s*)?(?:\d+(?:[.,]\d+)?|[½¼¾])\s*[^\d\s.]/.test(line)
    && !/^\d+\s*(?:personer|portioner|pers\b|servings?|minutes?|min\b)/i.test(line);
  const start = lines.findIndex(quantityLine);
  if (start < 0) return { ...draft, instructions: draft.instructions ?? text };
  let end = start;
  while (end < lines.length && quantityLine(lines[end])) end++;
  if (end - start < 2) return { ...draft, instructions: draft.instructions ?? text };
  return {
    ...draft,
    name: lines[0] || draft.name,
    ingredients: lines.slice(start, end).map(parseIngredientLine),
    instructions: draft.instructions ?? (lines.slice(end).join("\n") || text),
  };
}
