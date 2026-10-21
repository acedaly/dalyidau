import { defineConfig, devices } from "@playwright/test";

// Runs the real Worker (wrangler dev) against the mock Capacities API.
// `npm run test:e2e` builds the client first.
const persist = ".wrangler/e2e-state";

export default defineConfig({
    testDir: "e2e",
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? "github" : "list",
    use: { baseURL: "http://localhost:8787", trace: "retain-on-failure" },
    projects: [
        { name: "desktop", use: { ...devices["Desktop Chrome"] } },
        { name: "mobile", use: { ...devices["Pixel 7"] } },
    ],
    globalSetup: "./e2e/global-setup.ts",
    webServer: [
        { command: "node scripts/mock-capacities.mjs", url: "http://localhost:8790/__files/cover-tools.jpg", reuseExistingServer: false },
        // Invented public-feed fixtures for the Intelligence Centre (never a real provider in tests).
        { command: "node scripts/mock-feeds.mjs", url: "http://localhost:8791/health", reuseExistingServer: false },
        // Invented stand-in for Amplenote's API, login, public pages and images.
        { command: "node scripts/mock-amplenote.mjs", url: "http://localhost:8792/health", reuseExistingServer: false },
        {
            command: `rm -rf ${persist} && npx wrangler d1 migrations apply DB --local --env="" --persist-to ${persist} && npx wrangler dev --local --env="" --port 8787 --persist-to ${persist} --env-file e2e/e2e.vars`,
            url: "http://localhost:8787/api/health",
            timeout: 120_000,
            reuseExistingServer: false,
        },
    ],
});
