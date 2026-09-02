import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { bookmarkletForOrigin, recipeUrlFromBookmarkSearch } from "./bookmarkImport.ts";

test("a bookmarked recipe URL reaches the recipe import flow intact", () => {
  assert.equal(
    recipeUrlFromBookmarkSearch(
      "?url=https%3A%2F%2Frecipes.example%2Fdinner%3Fservings%3D4%26lang%3Dda",
    ),
    "https://recipes.example/dinner?servings=4&lang=da",
  );
});

test("only ordinary web URLs can trigger a bookmark import", () => {
  assert.equal(recipeUrlFromBookmarkSearch("?url=javascript%3Aalert(1)"), null);
  assert.equal(recipeUrlFromBookmarkSearch("?url=file%3A%2F%2F%2Fetc%2Fpasswd"), null);
  assert.equal(recipeUrlFromBookmarkSearch("?url=%2Frecipes%2F1"), null);
  assert.equal(recipeUrlFromBookmarkSearch("?url="), null);
  assert.equal(recipeUrlFromBookmarkSearch(""), null);
});

test("http remains available for recipe sites that have not moved to https", () => {
  assert.equal(
    recipeUrlFromBookmarkSearch("?url=http%3A%2F%2Fold-recipes.example%2Fsoup"),
    "http://old-recipes.example/soup",
  );
});

test("the bookmarklet leaves the source site through MealPlanner's import page", () => {
  const location = { href: "https://recipes.example/pasta?servings=2&lang=da" };
  const bookmarklet = bookmarkletForOrigin("https://meals.example.com/");

  vm.runInNewContext(bookmarklet.replace(/^javascript:/, ""), {
    location,
    encodeURIComponent,
  });

  assert.equal(
    location.href,
    "https://meals.example.com/recipes/new?url=" +
      "https%3A%2F%2Frecipes.example%2Fpasta%3Fservings%3D2%26lang%3Dda",
  );
});
