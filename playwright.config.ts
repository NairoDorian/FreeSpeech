import { defineConfig, devices } from "@playwright/test";

import { appEnvVar } from "./scripts/lib/env-flag";

// The dev server port the browser tests use. 1430 keeps them off Tauri's fixed
// development port; `<PREFIX>TEST_PORT` (the app's env prefix) moves them when another
// project's dev server already holds it. `tests/harness/global-setup.ts` checks
// that whatever answers there is this app before any test runs.
const PORT = Number(appEnvVar("TEST_PORT") ?? 1430);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/harness/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Launch Vite directly so teardown does not leave a bunx child holding
    // the listener.
    command: `bun node_modules/vite/bin/vite.js --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
