import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces .next/standalone for the Docker image (see Dockerfile).
  output: "standalone",
  // sharp and archiver are native/stream-heavy Node packages; keep them external.
  serverExternalPackages: ["sharp", "archiver"],
};

export default nextConfig;
