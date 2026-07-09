/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the file-tracing root to this project so the nested worktree lockfile
  // under .claude/ doesn't get inferred as the workspace root.
  outputFileTracingRoot: import.meta.dirname,
  experimental: {
    // Receipt-photo uploads can be a few MB; lift the Server Action body cap.
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
