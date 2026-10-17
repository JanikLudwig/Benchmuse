import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Do not generate AGENTS.md; this project documents itself in docs/ and README.md.
  agentRules: false,
  // PGlite ships WASM + data files that must be loaded from node_modules at runtime, not bundled.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
