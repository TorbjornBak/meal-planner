import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipeScan } from './parseRecipeScan.ts';

test('Danish pages combine into editable ingredients and method', () => {
  const recipe = parseRecipeScan('Ærtesuppe\n4 personer\nIngredienser\n500 g ærter\n2 dl fløde\n\nSådan gør du\nKog ærterne. Blend med fløde.');
  assert.equal(recipe.name, 'Ærtesuppe');
  assert.equal(recipe.statedServings, 4);
  assert.equal(recipe.ingredients[0].quantity, 500);
  assert.match(recipe.instructions, /Kog ærterne/);
});
test('English cookbook without ingredient heading', () => {
  const recipe = parseRecipeScan('Pea soup\nServes 2\n500 g peas\n2 cups stock\nSimmer for 10 minutes.');
  assert.equal(recipe.name, 'Pea soup');
  assert.equal(recipe.statedServings, 2);
  assert.equal(recipe.ingredients.length, 2);
  assert.equal(recipe.instructions, 'Simmer for 10 minutes.');
});
test('unrecognisable layout keeps all text for manual review', () => {
  const text = 'A family recipe\nA little salt and some peas\nCook until tender.';
  const recipe = parseRecipeScan(text);
  assert.equal(recipe.instructions, text);
  assert.deepEqual(recipe.ingredients, []);
});
