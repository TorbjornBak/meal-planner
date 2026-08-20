/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the file-tracing root to this project so the nested worktree lockfile
  // under .claude/ doesn't get inferred as the workspace root.
  outputFileTracingRoot: import.meta.dirname,
  // Receipt OCR (§7). Both ship native/wasm assets and spawn their own workers,
  // which only resolve if they're required at runtime rather than bundled.
  serverExternalPackages: ["tesseract.js", "sharp"],
  experimental: {
    // Receipt-photo uploads can be a few MB; lift the Server Action body cap.
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
