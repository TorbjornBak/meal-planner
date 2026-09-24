/** Bound the JSON upload independently of middleware, which this route skips. */
export const MAX_RECIPE_TRANSFER_BYTES = 11 * 1024 * 1024;

export async function readRecipeTransferBody(
  req: Request,
  maxBytes = MAX_RECIPE_TRANSFER_BYTES,
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; status: 400 | 413; message: string }
> {
  const invalid = {
    ok: false as const,
    status: 400 as const,
    message:
      "That file isn't valid JSON, so nothing in it could be read. If you edited it by hand, a missing comma or bracket is the usual cause.",
  };
  if (!req.body) return invalid;

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return {
          ok: false,
          status: 413,
          message: `That recipe file is too large to import (limit: ${Math.floor(maxBytes / 1024 / 1024)} MB). Nothing was changed.`,
        };
      }
      chunks.push(value);
    }
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return invalid;
  } finally {
    reader.releaseLock();
  }
}
