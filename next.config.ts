import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@supabase/supabase-js"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push({ "node:sqlite": "commonjs node:sqlite" });
    }
    return config;
  },
};

export default nextConfig;
