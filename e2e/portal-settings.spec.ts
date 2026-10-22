import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

// Portal settings: reached from the launcher, sections as tabs (a select on phones), feature
// switches changed in one place and shown read-only where they apply. The e2e Worker acts as an
// owner (ACCESS_DEV_EMAIL). Tests run one at a time on one database, so anything switched on here
// is switched back off.

const JSON_HEADERS = { Origin: "http://localhost:8787", "Content-Type": "application/json" };

const setFlag = async (request: APIRequestContext, key: string, enabled: boolean) => {
    const response = await request.put(`/api/portal/flags/${key}`, { headers: JSON_HEADERS, data: { enabled } });
    expect(response.ok()).toBe(true);
};

const openSection = async (page: Page, isMobile: boolean, label: string) => {
    if (isMobile) {
        await page.getByRole("button", { name: /Settings section/ }).click();
        await page.getByRole("option", { name: label, exact: true }).click();
    } else await page.getByRole("tab", { name: label }).click();
};

const expectAccessible = async (page: Page) => {
    // The development-only environment banner is excluded, as in the other suites.
    const results = await new AxeBuilder({ page }).include("main").exclude("main p.bg-warning-primary").analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};

test("opens Portal settings from the launcher and moves between sections", async ({ page, isMobile }) => {
    await page.goto("/portal");
    await page
        .getByRole("link", { name: /Portal settings/ })
        .first()
        .click();
    await expect(page).toHaveURL(/\/portal\/settings$/);
    await expect(page.getByRole("heading", { level: 1, name: "Portal settings" })).toBeVisible();

    for (const [label, path] of [
        ["Household & Access", "/portal/settings/access"],
        ["Features", "/portal/settings/features"],
        ["Calendar & Subscriptions", "/portal/settings/calendar"],
        ["Intelligence", "/portal/settings/intelligence"],
        ["Integrations & Security", "/portal/settings/security"],
    ] as const) {
        await openSection(page, isMobile, label);
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, path).toBeLessThanOrEqual(0);
        await expectAccessible(page);
    }

    // The address is shareable: reloading keeps the section.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
});

test("changes a Calendar switch in one place and shows it in Calendar settings", async ({ page, request }) => {
    try {
        await page.goto("/portal/settings/features");
        const feeds = page.getByRole("switch", { name: /Calendar subscription addresses/ });
        await expect(feeds).not.toBeChecked();
        await feeds.click({ force: true });
        await expect(feeds).toBeChecked();
        await page.reload();
        await expect(page.getByRole("switch", { name: /Calendar subscription addresses/ })).toBeChecked();

        await page.goto("/portal/calendar/settings");
        const summary = page.locator('[data-flag="calendar.feeds"]');
        await expect(summary).toContainText("On");
        await expect(page.locator('[data-flag="calendar.reminders.email"]')).toContainText("Off");
        // Calendar settings has no toggle of its own for the portal switch.
        await expect(page.getByRole("switch", { name: /Calendar subscription addresses/ })).toHaveCount(0);

        await page.getByRole("link", { name: "Manage in Portal settings → Features" }).click();
        await expect(page).toHaveURL(/\/portal\/settings\/features#features-calendar$/);
        await expect(page.locator("#features-calendar")).toBeInViewport();
    } finally {
        await setFlag(request, "calendar.feeds", false);
    }
});

test("keeps Wedding settings for wedding details and sends old feature links to Portal settings", async ({ page }) => {
    await page.goto("/portal/wedding/settings/features");
    await expect(page).toHaveURL(/\/portal\/settings\/features#features-wedding$/);
    await expect(page.getByRole("switch", { name: /Public wedding website/ })).toBeVisible();

    await page.goto("/portal/wedding/settings");
    await expect(page.getByRole("heading", { level: 1, name: "Wedding settings" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Features" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: /First partner/ })).toBeVisible();
    await expect(page.locator('[data-flag="wedding.site.public"]')).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expectAccessible(page);
});
