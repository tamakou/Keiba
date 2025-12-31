import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */

  // Disable experimental features that might cause build worker crashes
  experimental: {
    // Turbopack is causing build worker crashes
  }
};

export default nextConfig;
