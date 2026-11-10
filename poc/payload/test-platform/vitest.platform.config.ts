// Runs the whole existing test suite (test/**/*.test.ts) plus the Phase 0 platform tests through the
// combined Worker's router: every `import worker from "../worker/index"` gets platform/compose.ts, with the
// real existing Worker behind it and a recording stand-in for Payload.
// From the repository root:  npx vitest run --config poc/payload/test-platform/vitest.platform.config.ts
import path from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../../vitest.config";

const root = path.resolve(import.meta.dirname, "../../..");

export default defineConfig(async (env) => {
    const resolved = typeof base === "function" ? await base(env) : base;
    return mergeConfig(resolved, {
        root,
        resolve: { alias: [{ find: /^\.\.\/worker\/index$/, replacement: path.join(import.meta.dirname, "platform-under-test.ts") }] },
        // Added to the base config's test/**/*.test.ts.
        test: { include: ["poc/payload/test-platform/*.test.ts"] },
    });
});
