import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ✓ Cloudflare Pages: do NOT use output: "standalone"
  // @cloudflare/next-on-pages handles the build output
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  allowedDevOrigins: [
    ".space-z.ai",
  ],
};

export default nextConfig;
