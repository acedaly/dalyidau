import { env } from "cloudflare:test";
import { createMockApi } from "../fixtures/capacities/mock-api.mjs";
import type { Env } from "../worker/env";
import { runSync } from "../worker/sync";

// 1×1 PNG and a tiny JPEG-like payload stand in for the fixture images inside workerd.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

export const testEnv = env as unknown as Env;

export const createMock = () =>
    createMockApi({
        baseUrl: "https://capacities.test",
        readFile: async (name: string) => (name ? PNG : null),
    });

export type Mock = ReturnType<typeof createMock>;

export const sync = (mock: Mock, overrides: Partial<Env> = {}, force = false) =>
    runSync(
        { ...testEnv, ...overrides },
        { trigger: "test", force, fetchImpl: ((input: RequestInfo, init?: RequestInit) => mock.handle(new Request(input, init))) as typeof fetch },
    );

export const resetDb = async () => {
    await testEnv.DB.batch(["posts", "sources", "slug_redirects", "media", "entity_cache", "sync_runs"].map((t) => testEnv.DB.prepare(`DELETE FROM ${t}`)));
    const listed = await testEnv.MEDIA.list();
    for (const object of listed.objects) await testEnv.MEDIA.delete(object.key);
};

export const publishedSlugs = async () => (await testEnv.DB.prepare("SELECT slug FROM posts ORDER BY slug").all<{ slug: string }>()).results.map((r) => r.slug);
