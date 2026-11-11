import { defineConfig, devices } from "@playwright/test";

// The wedding and administration screens as they're used now: inside Payload's admin (/admin/wedding/*,
// /admin/administration/*), on the combined Worker (poc/payload, built with `npm run poc:build` there).
// Same test values as playwright.config.ts; the e2e Worker signs in as an owner (ACCESS_DEV_EMAIL),
// through the portal's own authenticate(), which Payload's sign-in also uses.
const persist = ".wrangler/e2e-admin-state";
const vars = "../../.wrangler/e2e-admin.vars";

export default defineConfig({
    testDir: "e2e",
    testMatch: ["portal.spec.ts", "portal-settings.spec.ts", "guest-import.spec.ts", "communications-studio.spec.ts"],
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    timeout: 60_000,
    reporter: process.env.CI ? "github" : "list",
    use: { baseURL: "http://localhost:8787", trace: "retain-on-failure" },
    projects: [
        { name: "desktop", use: { ...devices["Desktop Chrome"] } },
        { name: "mobile", use: { ...devices["Pixel 7"] } },
    ],
    webServer: [
        {
            // Test-only Payload secret; nothing here is real.
            command: `mkdir -p .wrangler && { cat e2e/e2e.vars; echo; echo PAYLOAD_SECRET=e2e-only-not-a-secret; echo PAYLOAD_JOBS_SECRET=e2e-only-jobs; } > .wrangler/e2e-admin.vars && cd poc/payload && rm -rf ../../${persist} && npx wrangler d1 migrations apply DB --local --persist-to ../../${persist} && npx wrangler dev --local --port 8787 --persist-to ../../${persist} --env-file ${vars}`,
            url: "http://localhost:8787/api/health",
            timeout: 180_000,
            reuseExistingServer: false,
        },
    ],
});
