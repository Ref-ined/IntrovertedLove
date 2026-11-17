import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/web/test/**/*.test.ts"],
    testTimeout: 30_000,
    env: { PREVIEW_TOKEN_SECRET: "test-secret-test-secret-test-secret!!", COACH: "fake" },
  },
});
