import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const useInstalledChrome =
  process.env.PLAYWRIGHT_USE_INSTALLED_CHROME === "1" ||
  existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseUrl ?? "http://localhost:3000";
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1" || Boolean(externalBaseUrl);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  // Latency and recovery tests deliberately hold requests open against one
  // local Next.js process. Serial workers keep those gates deterministic and
  // avoid development-server listener pressure obscuring product failures.
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: skipWebServer
    ? undefined
    : {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(useInstalledChrome ? { channel: "chrome" } : {}),
      },
    },
  ],
});
