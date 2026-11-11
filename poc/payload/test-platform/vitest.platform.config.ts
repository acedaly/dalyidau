// Runs the whole existing test suite (test/**/*.test.ts) plus the platform tests through the combined
// Worker's router: every `import worker from "../worker/index"` gets platform/compose.ts, with the real
// existing Worker behind it and a recording stand-in for Payload. It runs with the combined Worker's own
// runtime settings (production's compatibility date plus nodejs_compat and global_fetch_strictly_public),
// so it proves today's code behaves the same inside the combined Worker.
// From the repository root:  npx vitest run --config poc/payload/test-platform/vitest.platform.config.ts
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { unstable_readConfig } from "wrangler";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../../vitest.config";

const root = path.resolve(import.meta.dirname, "../../..");
const combined = unstable_readConfig({ config: path.join(root, "poc/payload/wrangler.jsonc"), env: "staging" });

export default defineConfig(async (env) => {
    const resolved = typeof base === "function" ? await base(env) : base;
    const migrations = await readD1Migrations(path.join(root, "migrations"));
    return mergeConfig(
        { ...resolved, plugins: [] },
        {
            root,
            plugins: [
                cloudflareTest({
                    wrangler: { configPath: path.join(root, "wrangler.jsonc"), environment: "" },
                    remoteBindings: false,
                    miniflare: {
                        compatibilityDate: combined.compatibility_date,
                        compatibilityFlags: combined.compatibility_flags,
                        bindings: {
                            TEST_MIGRATIONS: migrations,
                            CAPACITIES_API_BASE: "https://capacities.test",
                            CAPACITIES_API_TOKEN: "cap-api-local-mock",
                            ADMIN_TOKEN: "test-admin-token-0123456789abcdef",
                            SYNC_REQUEST_SPACING_MS: "0",
                            SITE_URL: "https://daly.id.au",
                            ENVIRONMENT: "production",
                            COMBINED_FLAGS_UNDER_TEST: JSON.stringify(combined.compatibility_flags),
                        },
                    },
                }),
            ],
            resolve: { alias: [{ find: /^\.\.\/worker\/index$/, replacement: path.join(import.meta.dirname, "platform-under-test.ts") }] },
            // Added to the base config's test/**/*.test.ts.
            test: { include: ["poc/payload/test-platform/*.test.ts"] },
        },
    );
});
