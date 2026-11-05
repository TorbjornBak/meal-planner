// Scan uploads skip Next middleware, so bound the complete multipart body here.
const MAX_MULTIPART_BYTES = 11 * 1024 * 1024;
export async function readRecipePhotoForm(req: Request, maxBytes = MAX_MULTIPART_BYTES): Promise<
  | { ok: true; form: FormData }
  | { ok: false; status: 400 | 413; error: string }
> {
  const tooLarge = { ok: false as const, status: 413 as const, error: "Photos must total less than 10 MB." };
  if (Number(req.headers.get('content-length')) > maxBytes) return tooLarge;
  const invalid = { ok: false as const, status: 400 as const, error: "Could not read the upload. Please choose the photos again." };
  if (!req.body || !req.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')) return invalid;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return tooLarge;
      }
      chunks.push(value);
    }
    const response = new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers.get('content-type')! } });
    return { ok: true, form: await response.formData() };
  } catch {
    return invalid;
  } finally {
    reader.releaseLock();
  }
}
