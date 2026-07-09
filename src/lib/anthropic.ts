import Anthropic from "@anthropic-ai/sdk";

/**
 * Server-side recipe parsing (§1, §12).
 *
 * Turns pasted recipe/plan text into structured ingredient lines plus the
 * recipe's stated serving count. There is NO web scraping — the caller pastes
 * text they fetched as a normal reader. The output of this always goes through
 * the mandatory review-and-edit step before it counts toward anything.
 */

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

export interface ParsedIngredient {
  name: string;
  /** null for "to taste" / uncountable. */
  quantity: number | null;
  /** e.g. "g", "ml", "clove", or null for a bare count. */
  unit: string | null;
}

export interface ParsedRecipe {
  name: string;
  statedServings: number;
  ingredients: ParsedIngredient[];
}

// We get reliable structured output via forced tool use: the model must call
// `record_recipe`, and its typed `input` IS the parsed recipe. (This works
// across SDK versions; when the pinned SDK gains `output_config.format` /
// `messages.parse`, that's a drop-in alternative.)
const RECIPE_TOOL: Anthropic.Tool = {
  name: "record_recipe",
  description: "Record the structured recipe extracted from the pasted text.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The recipe's title." },
      statedServings: {
        type: "integer",
        description:
          "How many servings the recipe as written yields. Default to 4 if not stated.",
      },
      ingredients: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Ingredient name, singular." },
            quantity: {
              type: ["number", "null"],
              description: "Numeric amount, or null for 'to taste'.",
            },
            unit: {
              type: ["string", "null"],
              description:
                "Unit of measure (g, ml, tbsp, clove, …) or null for a bare count.",
            },
          },
          required: ["name", "quantity", "unit"],
        },
      },
    },
    required: ["name", "statedServings", "ingredients"],
  },
};

const SYSTEM_PROMPT = `You extract structured recipe data from pasted text.
Return the recipe title, the number of servings it is written for, and each
ingredient as name / quantity / unit. Split combined amounts sensibly, keep
ingredient names singular and shopping-friendly, and use null for amounts that
are "to taste" or unmeasured. Do not invent ingredients that are not present.`;

export async function parseRecipeText(text: string): Promise<ParsedRecipe> {
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    tools: [RECIPE_TOOL],
    tool_choice: { type: "tool", name: RECIPE_TOOL.name },
    messages: [
      {
        role: "user",
        content: `Extract the recipe from the text below.\n\n---\n${text}\n---`,
      },
    ],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("Anthropic parse returned no tool_use block");
  }
  return block.input as ParsedRecipe;
}
