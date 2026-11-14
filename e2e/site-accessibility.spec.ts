import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

// The public site against WCAG 2.2 AA (docs/AUDIT-2026-11.md): every kind of page, in both designs, light and
// dark, at desktop and phone widths (the two Playwright projects). axe checks what a machine can (contrast,
// names, roles, landmarks, heading order); the rest here is what it can't: nothing wider than the screen, one
// h1, a working skip link, keyboard focus that can be seen, and the phone menu.

const STATE = ".wrangler/e2e-state";
const sql = (command: string) =>
    execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--env=", "--persist-to", STATE, "--command", command], { stdio: "pipe" });
const flag = (on: boolean) =>
    sql(
        `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('website.projects_home', ${on ? 1 : 0}, '2026-01-01T00:00:00.000Z', 'e2e') ON CONFLICT(key) DO UPDATE SET enabled = ${on ? 1 : 0}`,
    );
// Two invented projects, as the publisher would have written them (worker/site/publisher.ts).
const project = (slug: string, title: string, featured: boolean) => ({
    id: slug,
    slug,
    title,
    summary: `${title}: an invented project for the accessibility checks.`,
    status: "active",
    tags: ["Cloudflare Workers", "TypeScript"],
    featured,
    order: featured ? 1 : 2,
    image: null,
    websiteUrl: "https://example.com",
    githubUrl: null,
    bodyHtml:
        '<h2>What it is</h2><p>Some words about it, with a <a href="https://example.com">link</a>.</p><h2>What I did</h2><ul><li>One thing</li><li>Another</li></ul>',
    gallery: [],
    links: [{ label: "Write-up", url: "https://example.com/write-up" }],
    seoTitle: null,
    seoDescription: null,
    publishedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
});
const quote = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'`;

test.beforeAll(() => {
    const projects = [project("check-one", "Check one", true), project("check-two", "Check two", false)];
    sql(
        [
            ...projects.map(
                (p) => `INSERT INTO meta (key, value) VALUES ('project:${p.slug}', ${quote(p)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ),
            `INSERT INTO meta (key, value) VALUES ('site:projects', ${quote(projects.map(({ bodyHtml: _b, gallery: _g, links: _l, ...summary }) => summary))}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ].join("; "),
    );
});
test.afterAll(() => {
    flag(false);
    sql("DELETE FROM meta WHERE key IN ('project:check-one', 'project:check-two', 'site:projects')");
});

const audit = async (page: Page, label: string) => {
    // The site's own markup. What a third party draws inside its own frame (an embedded video's player) isn't
    // the site's to fix; that the frame itself is named is, and is checked here instead.
    const results = await new AxeBuilder({ page }).exclude("iframe").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(await page.locator("iframe:not([title])").count(), `${label}: embedded frames without a title`).toBe(0);
    expect(
        results.violations.map((v) => `${label} ${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
        label,
    ).toEqual([]);
    // Nothing is wider than the screen: no sideways scrolling on a phone.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
    expect(await page.locator("h1").count(), `${label}: one h1`).toBe(1);
    expect(await page.locator("main").count(), `${label}: one main landmark`).toBe(1);
    // Every image says what it is, or says it is decoration.
    expect(await page.locator("img:not([alt])").count(), `${label}: images without alt`).toBe(0);
};

const DESIGNS = [
    { name: "projects-first", on: true, pages: ["/", "/projects", "/projects/check-one", "/blog", "/about", "/contact", "/no-such-page"] },
    { name: "classic", on: false, pages: ["/", "/blog", "/about", "/contact", "/no-such-page"] },
];

for (const design of DESIGNS)
    for (const scheme of ["light", "dark"] as const)
        test(`${design.name} design, ${scheme}: every page passes axe and fits the screen`, async ({ page }) => {
            flag(design.on);
            await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
            const pages = [...design.pages];
            // An article, whichever the mock site has.
            await page.goto("/blog");
            const article = await page.locator('main a[href^="/blog/"]').first().getAttribute("href");
            if (article) pages.push(article);
            for (const path of pages) {
                await page.goto(path);
                await page.evaluate(() => document.fonts.ready);
                await audit(page, `${design.name} ${scheme} ${path}`);
            }
        });

test("keyboard: the skip link comes first and works, and focus can always be seen", async ({ page }) => {
    flag(true);
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.locator(":focus");
    await expect(skip).toHaveText(/skip/i);
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    // Focus is in (or on) the main content, past the menu.
    expect(await page.evaluate(() => !!document.activeElement?.closest("main") || document.activeElement?.tagName === "MAIN")).toBe(true);
    // Walk the page: every stop shows where it is (an outline or a ring), and none is trapped off-screen.
    await page.goto("/");
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        const stop = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            if (!el || el === document.body) return null;
            const style = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            return {
                id: `${el.tagName}:${el.getAttribute("href") ?? el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)}`,
                indicated: (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none",
                sized: box.width > 0 && box.height > 0,
            };
        });
        if (!stop) break;
        expect(stop.indicated, `focus indicator on ${stop.id}`).toBe(true);
        expect(stop.sized, `focus target has a size: ${stop.id}`).toBe(true);
        seen.add(stop.id);
    }
    expect(seen.size).toBeGreaterThan(5);
});

test("phone menu: opens from the keyboard, lists the menu, closes with Escape and returns focus", async ({ page, isMobile }) => {
    test.skip(!isMobile, "the menu button is only shown at phone widths");
    flag(true);
    await page.goto("/");
    const button = page.getByRole("button", { name: "Open navigation menu" });
    await button.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("dialog");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("link", { name: "Projects" })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Writing" })).toBeVisible();
    // Big enough to touch (WCAG 2.2 target size, with room to spare).
    const box = await menu.getByRole("link", { name: "Projects" }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    await new AxeBuilder({ page })
        .include('[role="dialog"]')
        .analyze()
        .then((r) => expect(r.violations.map((v) => v.id)).toEqual([]));
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();
});
