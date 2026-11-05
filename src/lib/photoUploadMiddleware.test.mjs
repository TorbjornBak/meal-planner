import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import path from 'node:path';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server.js';

const src = path.resolve(import.meta.dirname, '..');
register(`data:text/javascript,${encodeURIComponent(`
  import path from 'node:path';
  import { pathToFileURL } from 'node:url';
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) return nextResolve(pathToFileURL(path.join(${JSON.stringify(src)}, specifier.slice(2) + '.ts')).href, context);
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { config } = await import('../middleware.ts');

test('recipe photo uploads skip the Next middleware body clone', () => {
  for (const url of ['/api/recipes/scan', '/api/recipes/scan/', '/api/recipes/import']) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url }), false, url);
  }
});
test('ordinary recipe endpoints and pages retain middleware protection', () => {
  for (const url of ['/api/recipes', '/api/recipes/scan-other', '/api/recipes/123', '/recipes/new']) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url }), true, url);
  }
});
