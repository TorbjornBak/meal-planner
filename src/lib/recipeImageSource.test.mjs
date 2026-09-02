import assert from "node:assert/strict";
import test from "node:test";

import { fetchRecipeImageFromSource } from "./recipeImageSource.ts";

test("a relative photo URL is resolved against the recipe page after redirects", async () => {
  const resolutions = [];
  const result = await fetchRecipeImageFromSource(null, "https://old.example/recipe", {
    resolvePublicUrl: async (raw, base) => {
      resolutions.push([raw, base]);
      return new URL(raw, base).toString();
    },
    fetchPageHtml: async () => ({
      html: '<meta property="og:image" content="/photos/dinner.jpg">',
      finalUrl: "https://new.example/recipes/dinner",
    }),
    fetchImage: async () => ({ bytes: Buffer.from("photo"), mime: "image/jpeg" }),
  });

  assert.deepEqual(resolutions, [
    ["https://old.example/recipe", undefined],
    ["/photos/dinner.jpg", "https://new.example/recipes/dinner"],
  ]);
  assert.equal(result?.imageUrl, "https://new.example/photos/dinner.jpg");
});
