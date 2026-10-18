import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { defineConfig } from "vitest/config";

// The MCP gateway (mcp/) end to end: real MCP JSON-RPC through mcp/src/index.ts into the portal's
// real PortalMcpEntrypoint logic and a local D1. The portal's bindings come from wrangler.jsonc so the
// portal half runs as it does in production; nodejs_compat is added because the gateway needs it
// (mcp/wrangler.jsonc, same compatibility date). The gateway handler itself is only ever given an
// environment with no database: see test/mcp-gateway/helpers.ts.
export default defineConfig(async () => {
    const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
    return {
        resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
        oxc: { jsx: { runtime: "automatic" as const, development: false } },
        plugins: [
            cloudflareTest({
                wrangler: { configPath: "./wrangler.jsonc", environment: "" },
                miniflare: {
                    compatibilityFlags: ["nodejs_compat"],
                    bindings: {
                        TEST_MIGRATIONS: migrations,
                        CAPACITIES_API_BASE: "https://capacities.test",
                        SITE_URL: "https://daly.id.au",
                        ENVIRONMENT: "production",
                    },
                },
            }),
        ],
        test: {
            include: ["test/mcp-gateway/**/*.test.ts"],
            setupFiles: ["./test/setup.ts"],
        },
    };
});
