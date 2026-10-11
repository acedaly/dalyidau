import { SELF } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { resetDb, testEnv } from "./helpers";

const TOTAL = 20;

beforeAll(async () => {
    await resetDb();
    const statements = Array.from({ length: TOTAL }, (_, i) => {
        const day = String(i + 1).padStart(2, "0");
        return testEnv.DB.prepare(
            "INSERT INTO posts (id, slug, title, body_html, published_at, content_hash, synced_at, featured) VALUES (?, ?, ?, '<p>x</p>', ?, 'h', ?, ?)",
        ).bind(`id-${i}`, `post-${i}`, `Post number ${i}`, `2026-09-${day}T00:00:00.000Z`, new Date().toISOString(), i === 3 ? 1 : 0);
    });
    await testEnv.DB.batch(statements);
});

const slugsOn = async (page: number) => {
    const html = await (await SELF.fetch(`https://daly.id.au/blog?page=${page}`)).text();
    const featured = /aria-label="Featured article".*?href="\/blog\/(post-\d+)"/s.exec(html)?.[1] ?? null;
    const grid = html.slice(html.indexOf('aria-label="Articles"'));
    const posts = [...new Set([...grid.matchAll(/<h2[^>]*><a href="\/blog\/(post-\d+)"/g)].map((m) => m[1]))];
    return { featured, posts };
};

it("shows every post exactly once across unfiltered pages", async () => {
    const first = await slugsOn(1);
    expect(first.featured).toBe("post-3");
    const seen = [first.featured!, ...first.posts];
    for (let page = 2; page <= 3; page++) {
        const next = await slugsOn(page);
        expect(next.featured).toBeNull();
        seen.push(...next.posts);
    }
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
});
