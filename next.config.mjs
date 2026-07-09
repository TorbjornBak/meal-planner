/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a minimal standalone server bundle for the Docker image.
  output: "standalone",
  experimental: {
    // Receipt-photo uploads can be a few MB; lift the Server Action body cap.
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
