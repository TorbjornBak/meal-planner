/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the file-tracing root to this project so the nested worktree lockfile
  // under .claude/ doesn't get inferred as the workspace root.
  outputFileTracingRoot: import.meta.dirname,
  // Receipt OCR (§7). Both ship native/wasm assets and spawn their own workers,
  // which only resolve if they're required at runtime rather than bundled.
  serverExternalPackages: ["tesseract.js", "sharp"],
  experimental: {
    // Every authenticated request passes through middleware. Next buffers that
    // request before handing it to a Route Handler and otherwise truncates it
    // at 10 MB. A valid 10 MB receipt plus its multipart framing is larger than
    // that, so /api/trips receives a broken form unless the envelope has room.
    middlewareClientMaxBodySize: "11mb",
  },
};

export default nextConfig;
