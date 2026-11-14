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

test("the theme toggles, persists across pages, and can go back to following the device", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const html = page.locator("html");
    // One name that never changes; the state, and what the next press does, is its description.
    const toggle = page.getByRole("button", { name: "Theme", exact: true });
    const themeColors = () => page.locator('meta[name="theme-color"]').evaluateAll((metas) => metas.map((m) => (m as HTMLMetaElement).content));
    const [lightChrome, darkChrome] = await themeColors();
    expect(lightChrome).not.toBe(darkChrome);
    await expect(html).not.toHaveClass(/dark-mode/);
    await expect(toggle).toHaveAccessibleDescription("Following your device. Press to switch to dark.");
    // The first press always changes something: on a light device, to dark.
    await toggle.click();
    await expect(html).toHaveClass(/dark-mode/);
    // The browser's own chrome follows the choice, not the device: both tags carry the dark colour.
    expect(await themeColors()).toEqual([darkChrome, darkChrome]);
    // On the next page the choice is applied before React runs (theme-init.js): checked with scripts held back.
    await page.route("**/*.js", (route) => (route.request().url().endsWith("/theme-init.js") ? route.continue() : route.abort()));
    await page.goto("/blog");
    await expect(html).toHaveClass(/dark-mode/);
    expect(await themeColors()).toEqual([darkChrome, darkChrome]);
    await page.unroute("**/*.js");
    await page.goto("/blog");
    await expect(html).toHaveClass(/dark-mode/);
    await expect(toggle).toHaveAccessibleDescription("Dark. Press to switch to light.");
    await toggle.click();
    await expect(html).not.toHaveClass(/dark-mode/);
    expect(await themeColors()).toEqual([lightChrome, lightChrome]);
    // Chosen by hand, so it holds even when the device says otherwise…
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).not.toHaveClass(/dark-mode/);
    await page.emulateMedia({ colorScheme: "light" });
    // …until the third press hands it back to the device, which is then followed.
    await toggle.click();
    await expect(toggle).toHaveAccessibleDescription(/^Following your device\./);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveClass(/dark-mode/);
    expect(await page.evaluate(() => localStorage.getItem("ui-theme"))).toBeNull();
    expect(await themeColors()).toEqual([lightChrome, darkChrome]);
});

test("a stored theme this site didn't write, or storage that refuses, doesn't break the page", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => localStorage.setItem("ui-theme", "purple"));
    await page.goto("/");
    await expect(page.locator("html")).toHaveClass(/dark-mode/);
    await expect(page.getByRole("button", { name: "Theme", exact: true })).toHaveAccessibleDescription(/^Following your device\./);

    const blocked = await page.context().newPage();
    await blocked.emulateMedia({ colorScheme: "dark" });
    await blocked.addInitScript(() => {
        const refuse = () => {
            throw new DOMException("denied", "SecurityError");
        };
        Object.defineProperty(window, "localStorage", { get: refuse });
    });
    await blocked.goto("/");
    const toggle = blocked.getByRole("button", { name: "Theme", exact: true });
    await expect(toggle).toHaveAccessibleDescription(/^Following your device\./);
    // It still works for this visit; it just isn't remembered.
    await toggle.click();
    await expect(blocked.locator("html")).not.toHaveClass(/dark-mode/);
    await blocked.close();
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
