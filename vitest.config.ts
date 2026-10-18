import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests run inside workerd with real (local) D1 and R2 bindings from wrangler.jsonc.
// Run `vite build` first so the app shell exists in dist/client.
export default defineConfig(async () => {
    const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
    return {
        resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
        // The worker bundles React in production mode, so tests must emit production JSX too.
        oxc: { jsx: { runtime: "automatic" as const, development: false } },
        plugins: [
            cloudflareTest({
                wrangler: { configPath: "./wrangler.jsonc", environment: "" },
                miniflare: {
                    bindings: {
                        TEST_MIGRATIONS: migrations,
                        CAPACITIES_API_BASE: "https://capacities.test",
                        CAPACITIES_API_TOKEN: "cap-api-local-mock",
                        ADMIN_TOKEN: "test-admin-token-0123456789abcdef",
                        SYNC_REQUEST_SPACING_MS: "0",
                        // Explicit so a local .dev.vars cannot leak into tests.
                        SITE_URL: "https://daly.id.au",
                        ENVIRONMENT: "production",
                    },
                },
            }),
        ],
        test: {
            include: ["test/**/*.test.ts"],
            // The gateway runs with nodejs_compat in its own project: vitest.mcp.config.ts.
            exclude: ["test/mcp-gateway/**"],
            setupFiles: ["./test/setup.ts"],
        },
    };
});
