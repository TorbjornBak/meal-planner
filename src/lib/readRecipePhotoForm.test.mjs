import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecipePhotoForm } from './readRecipePhotoForm.ts';

test('multipart photo bytes and page order survive the bounded reader', async () => {
  const form = new FormData();
  form.append('photos', new File([new Uint8Array([1, 2, 3])], 'first.jpg', { type: 'image/jpeg' }));
  form.append('photos', new File(['second page'], 'second.png', { type: 'image/png' }));
  const result = await readRecipePhotoForm(new Request('https://meals.test/api/recipes/scan', { method: 'POST', body: form }));
  assert.equal(result.ok, true);
  const files = result.form.getAll('photos');
  assert.deepEqual(files.map(f => f.name), ['first.jpg', 'second.png']);
  assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()), new Uint8Array([1, 2, 3]));
});
test('chunked multipart over the limit is cancelled without a content-length', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(10)); },
    cancel() { cancelled = true; },
  });
  const req = new Request('https://meals.test/api/recipes/scan', { method: 'POST', body, duplex: 'half', headers: { 'content-type': 'multipart/form-data; boundary=test' } });
  const result = await readRecipePhotoForm(req, 15);
  assert.equal(result.status, 413);
  assert.equal(cancelled, true);
});
test('declared oversized uploads are rejected before reading', async () => {
  const req = new Request('https://meals.test/api/recipes/scan', { method: 'POST', body: 'unused', headers: { 'content-length': '20' } });
  assert.equal((await readRecipePhotoForm(req, 10)).status, 413);
  assert.equal(req.bodyUsed, false);
});
test('malformed multipart returns a retryable upload error', async () => {
  const req = new Request('https://meals.test/api/recipes/scan', { method: 'POST', body: 'broken', headers: { 'content-type': 'multipart/form-data; boundary=test' } });
  assert.equal((await readRecipePhotoForm(req)).status, 400);
});
