import type { NextConfig } from "next";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

// One .env.local at the repo root (the README quickstart), not per app.
loadEnvConfig(path.join(import.meta.dirname, "../.."), process.env.NODE_ENV !== "production", undefined, true);

const config: NextConfig = {
  transpilePackages: ["@il/core"],
  serverExternalPackages: ["@electric-sql/pglite"],
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // Lets a phone on the same Wi-Fi load the dev server by its LAN address.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*"],
};

export default config;
