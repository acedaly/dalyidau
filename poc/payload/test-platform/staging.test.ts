// Phase 1 staging: outbound requests are refused, and the staging entry installs that before anything else.
import { describe, expect, it } from "vitest";
import { lockedFetch } from "../platform/egress";
import entrySource from "../platform/entry-staging.ts?raw";

describe("staging egress lock", () => {
    const calls: string[] = [];
    const original = (async (input: RequestInfo | URL) => {
        calls.push(String(input instanceof Request ? input.url : input));
        return new Response("reached");
    }) as typeof fetch;
    const locked = lockedFetch(original);

    it("refuses every provider and production address, whatever form the request takes", async () => {
        for (const target of [
            "https://api.fastmail.com/jmap/session",
            "https://rest.clicksend.com/v3/sms/send",
            "https://api.capacities.io/",
            "https://daly.id.au/api/portal/wedding/guests",
            "https://wedding.daly.id.au/",
            "https://api.cloudflare.com/client/v4/accounts",
            "https://daly-poc.cloudflareaccess.com/cdn-cgi/access/certs",
            "http://127.0.0.1:8787/",
        ]) {
            await expect(locked(target), target).rejects.toThrow(/egress refused/);
            await expect(locked(new Request(target, { method: "POST", body: "x" })), target).rejects.toThrow(/egress refused/);
            await expect(locked(new URL(target)), target).rejects.toThrow(/egress refused/);
        }
        await expect(locked("not a url")).rejects.toThrow(/egress refused/);
        expect(calls).toEqual([]);
    });

    it("lets through only what an allow-list names", async () => {
        const allowOne = lockedFetch(original, (url) => url.hostname === "allowed.example.test");
        expect(await (await allowOne("https://allowed.example.test/x")).text()).toBe("reached");
        await expect(allowOne("https://allowed.example.test.evil.example/x")).rejects.toThrow(/egress refused/);
        expect(calls).toEqual(["https://allowed.example.test/x"]);
    });

    it("the staging entry installs the lock before importing anything else", () => {
        const imports = entrySource.split("\n").filter((line: string) => /^\s*(import|export)\b.*\bfrom\b|^\s*import\s+["']/.test(line));
        expect(imports[0]).toMatch(/^import "\.\/egress-lock";$/);
    });
});

describe("runtime settings", () => {
    it("the suite runs with the combined Worker's flags (nodejs_compat active)", async () => {
        const { env } = await import("cloudflare:test");
        expect(JSON.parse((env as { COMBINED_FLAGS_UNDER_TEST: string }).COMBINED_FLAGS_UNDER_TEST)).toEqual(["nodejs_compat", "global_fetch_strictly_public"]);
        // nodejs_compat provides Node's process global; without the flag it doesn't exist.
        expect(typeof (globalThis as { process?: { versions?: unknown } }).process?.versions).toBe("object");
    });
});
