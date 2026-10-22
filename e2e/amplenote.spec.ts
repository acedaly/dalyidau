import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import plugin from "../amplenote/plugin.js";
import { NOTE_IDS, createAmplenoteMock } from "../fixtures/amplenote/mock-api.mjs";
import { setCapacitiesSync } from "./helpers";

// Amplenote publishing end to end: the real plugin (as Amplenote would run it) against the invented
// stand-in (scripts/mock-amplenote.mjs on :8792), the real Worker, and a browser. The plugin's `app`
// is played in this process over the same invented notes the stand-in serves.

const AMPLENOTE = "http://localhost:8792";
const TITLE = "Notes from a small vegetable garden";
const ARTICLE = "/blog/notes-from-a-small-vegetable-garden";

const local = createAmplenoteMock({ apiBase: `${AMPLENOTE}/api`, loginBase: `${AMPLENOTE}/login`, publicBase: `${AMPLENOTE}/public`, imageBase: AMPLENOTE });

/** Applies a change to the notes both here (the plugin's view) and in the stand-in (the API's and the public pages' view). */
const control = async (action: string, ...args: unknown[]) => {
    (local.control as unknown as Record<string, (...a: unknown[]) => unknown>)[action](...args);
    const response = await fetch(`${AMPLENOTE}/__control`, { method: "POST", body: JSON.stringify({ action, args }) });
    if (!response.ok) throw new Error(`mock control failed: ${action}`);
};

const runPlugin = async () => {
    const app = local.app({ "Publishing token": "e2e-amplenote-publish-token-0123456789abcdef", Website: "http://localhost:8787" });
    const instance = { ...plugin, _nextRun: 0 };
    await instance.appOption["Publish to website now"].call(instance, app);
    expect(app.alerts[0], app.alerts.join("\n")).toMatch(/^Sent \d+ tagged note/);
    return app;
};

test.beforeEach(async () => {
    await control("reset");
    await runPlugin();
});

// Leave the site as the other suites expect it: the article unpublished again.
test.afterAll(async () => {
    await control("unpublish", NOTE_IDS.garden);
    await runPlugin();
    // And no API connection left behind if a test stopped half-way (the e2e Worker acts as an owner).
    await fetch("http://localhost:8787/api/portal/website/amplenote/disconnect", {
        method: "POST",
        headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" },
        body: "{}",
    });
});

test("a published, tagged note appears across the site with its Amplenote title", async ({ page, isMobile }) => {
    await page.goto("/");
    await page.getByRole("link", { name: TITLE }).first().click();
    await expect(page).toHaveURL(ARTICLE);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLE);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByText("A first season, honestly reported")).toBeVisible();
    await expect(page.getByRole("heading", { name: "What worked" })).toBeVisible();
    await expect(page.locator("[data-article-body] img").first()).toHaveAttribute("src", /^\/media\/[a-f0-9]{24}\.png$/);
    await expect(page.locator("iframe")).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "no horizontal scrolling").toBeLessThanOrEqual(0);
    if (isMobile) await expect(page.getByText("On this page")).toBeHidden();

    await page.goto("/blog?q=zucchini");
    await expect(page.getByRole("link", { name: TITLE }).first()).toBeVisible();
    await page.goto(`/blog?category=${encodeURIComponent("Making things")}`);
    await expect(page.getByRole("link", { name: TITLE }).first()).toBeVisible();

    const rss = await (await page.request.get("/feed.xml")).text();
    expect(rss).toContain(`<title>${TITLE}</title>`);
    expect(await (await page.request.get("/sitemap.xml")).text()).toContain(ARTICLE);
    // The Capacities articles are all still there.
    expect(rss).toContain("Publishing straight from my notebook");
});

test("keeps Amplenote out of the CSP on articles and in the portal", async ({ page }) => {
    const article = await page.goto(ARTICLE);
    expect(article?.headers()["content-security-policy"]).not.toContain("amplenote");
    expect(article?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    const portal = await page.goto("/portal/settings/website");
    expect(portal?.headers()["content-security-policy"]).not.toContain("amplenote");
    expect((await page.request.get("/blog/amplenote-test")).status()).toBe(404);
});

test("an article unpublished in Amplenote leaves the site", async ({ page }) => {
    await control("unpublish", NOTE_IDS.garden);
    await runPlugin();
    expect((await page.goto(ARTICLE))?.status()).toBe(404);
    await page.goto("/blog");
    await expect(page.getByRole("link", { name: TITLE })).toHaveCount(0);
});

test("Portal settings → Website shows the articles and connects the Amplenote API", async ({ page }) => {
    await page.goto("/portal/settings/website");
    await expect(page.getByRole("heading", { name: "Amplenote articles" })).toBeVisible();
    const list = page.getByRole("list", { name: "Amplenote articles" });
    await expect(list.getByRole("link", { name: TITLE })).toBeVisible();
    await expect(list.getByText("Not published in Amplenote")).toBeVisible();
    await expect(page.getByText("A draft that isn't finished")).toHaveCount(0);

    const results = await new AxeBuilder({ page }).include("main").exclude("main p.bg-warning-primary").analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

    const connect = page.getByRole("button", { name: /^(Connect Amplenote|Reconnect)$/ });
    await connect.click();
    // The stand-in consents straight away and sends the browser back through the callback.
    await expect(page).toHaveURL(/\/portal\/settings\/website$/);
    await expect(page.getByText("Amplenote API connected")).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();

    await page.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByText(/Last full check with Amplenote/)).toBeVisible();

    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByRole("button", { name: "Connect Amplenote" })).toBeVisible();
});

test("Portal settings → Website & Blog shows Amplenote as the source and archives Capacities", async ({ page }) => {
    try {
        await page.goto("/portal/settings/website");
        const source = page.getByRole("region", { name: "Publishing source" });
        await expect(source.getByText("Active", { exact: true })).toBeVisible();
        // The Capacities fixtures run with sync on (e2e/helpers.ts).
        await expect(source.getByText("Syncing", { exact: true })).toBeVisible();

        const checks = page.getByLabel("Retirement checks");
        await page.getByRole("button", { name: "Check and archive" }).click();
        await expect(checks.locator("div").filter({ hasText: "Every image is stored in R2" }).locator("dd")).toHaveText("Done");
        await expect(checks.locator("div").filter({ hasText: "Capacities sync is switched off" }).locator("dd")).toHaveText("Not yet");
        await expect(page.getByText("Safe to retire Capacities")).toHaveCount(0);

        await setCapacitiesSync(false);
        await page.reload();
        await expect(source.getByText("Archived", { exact: true })).toBeVisible();
        // Loading the page never checks R2, so it can't call Capacities safe to retire until checked again.
        await expect(page.getByText("Safe to retire Capacities")).toHaveCount(0);
        await page.getByRole("button", { name: "Check and archive" }).click();
        await expect(page.getByText("Safe to retire Capacities")).toBeVisible();
        // The switch is shown here read-only; it's changed in Features.
        await expect(page.locator('[data-flag="website.capacities.sync"]').getByText("Off")).toBeVisible();

        const results = await new AxeBuilder({ page }).include("main").exclude("main p.bg-warning-primary").analyze();
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

        // Capacities articles are untouched by all of this.
        expect((await page.request.get("/blog/publishing-from-my-notebook")).status()).toBe(200);
    } finally {
        await setCapacitiesSync(true);
    }
});
