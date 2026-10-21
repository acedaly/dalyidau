import { expect, test } from "@playwright/test";

const ARTICLE = "/blog/publishing-from-my-notebook";

test("every route loads directly and survives a refresh", async ({ page }) => {
    for (const path of ["/", "/blog", ARTICLE, "/about", "/contact"]) {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(200);
        await expect(page.locator("h1")).toBeVisible();
        await page.reload();
        await expect(page.locator("h1")).toBeVisible();
    }
});

test("navigates from the homepage to an article and back", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Publishing straight from my notebook" }).first().click();
    await expect(page).toHaveURL(ARTICLE);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Publishing straight from my notebook");
    await page.getByRole("link", { name: "All posts" }).click();
    await expect(page).toHaveURL("/blog");
});

test("invalid slugs show a 404 page", async ({ page }) => {
    const response = await page.goto("/blog/not-a-real-post");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("search and category filters work", async ({ page }) => {
    await page.goto("/blog");
    await page.getByRole("searchbox", { name: "Search articles" }).fill("training");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/q=training/);
    await expect(page.getByRole("heading", { name: "Notes on running a good training session" })).toBeVisible();

    await page.goto("/blog");
    await page
        .getByRole("navigation", { name: "Categories" })
        .getByRole("link", { name: /Training/ })
        .click();
    await expect(page).toHaveURL(/category=Training/);
    await expect(page.getByText("1 article")).toBeVisible();
});

test("dark mode toggles and persists across pages", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const html = page.locator("html");
    await expect(html).not.toHaveClass(/dark-mode/);
    await page.getByRole("button", { name: "Toggle dark mode" }).click();
    await expect(html).toHaveClass(/dark-mode/);
    await page.goto("/blog");
    await expect(html).toHaveClass(/dark-mode/);
    await page.getByRole("button", { name: "Toggle dark mode" }).click();
    await expect(html).not.toHaveClass(/dark-mode/);
});

test("follows the system colour scheme by default", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveClass(/dark-mode/);
});

test("has no horizontal overflow and no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
    for (const path of ["/", "/blog", ARTICLE, "/about", "/contact"]) {
        await page.goto(path);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, path).toBeLessThanOrEqual(0);
    }
    expect(errors).toEqual([]);
});

test("mobile menu opens and links work", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile only");
    await page.goto("/");
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await page.getByRole("navigation", { name: "Mobile" }).getByRole("link", { name: "About" }).click();
    await expect(page).toHaveURL("/about");
});

test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("articles are fully readable", async ({ page }) => {
        await page.goto(ARTICLE);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Publishing straight from my notebook");
        await expect(page.getByRole("heading", { name: "Why write in a notebook first" })).toBeVisible();
        await expect(page.getByText("That's the whole loop.")).toBeVisible();
        await expect(page.locator("figure.image img")).toHaveAttribute("src", /\/media\//);
    });

    test("blog search works as a plain form", async ({ page }) => {
        await page.goto("/blog");
        await page.getByRole("searchbox").fill("escaping");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("heading", { name: /Small tools & big wins/ })).toBeVisible();
    });
});


test("Amplenote proof of concept is unindexed and keeps the CSP narrow", async ({ page }) => {
    const response = await page.goto("/blog/amplenote-test");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("A note from Amplenote.");
    await expect(page.locator('iframe[src="https://public.amplenote.com/embed/32pmddtDM8Xfgwca3nbmfTLm"]')).toHaveCount(1);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    expect(response?.headers()["x-robots-tag"]).toContain("noindex");
    expect(response?.headers()["content-security-policy"]).toContain("https://public.amplenote.com");

    const home = await page.goto("/");
    expect(home?.headers()["content-security-policy"]).not.toContain("public.amplenote.com");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Some things are worth");
});
