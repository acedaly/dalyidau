import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { at } from "./helpers";

// Administration: reached from the sidebar, sections as tabs (a select on phones), feature
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
        await at(page).getByRole("button", { name: /Settings section/ }).click();
        await at(page).getByRole("option", { name: label, exact: true }).click();
    } else await at(page).getByRole("tab", { name: label }).click();
};

const expectAccessible = async (page: Page) => {
    // The development-only environment banner is excluded, as in the other suites.
    const results = await new AxeBuilder({ page }).include('[data-testid="wedding-screen"]').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};

test("opens Administration from Payload's menu and moves between sections", async ({ page, isMobile }) => {
    // An old portal address opens the section in Payload, which lists it in its menu.
    await page.goto("/portal/settings/access");
    await expect(page).toHaveURL(/\/admin\/administration\/access$/);
    await expect(page.getByRole("navigation", { name: "Wedding and administration" }).getByRole("link", { name: "Users and permissions" })).toHaveCount(1);
    await expect(at(page).getByRole("heading", { level: 1, name: "Administration" })).toBeVisible();

    for (const [label, path] of [
        ["Users and permissions", "/admin/administration/access"],
        ["Features", "/admin/administration/features"],
        ["Capacities archive", "/admin/administration/website"],
        ["Integrations and security", "/admin/administration/security"],
    ] as const) {
        await openSection(page, isMobile, label);
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, path).toBeLessThanOrEqual(0);
        await expectAccessible(page);
    }

    // The address is shareable: reloading keeps the section.
    await page.reload();
    await expect(at(page).getByRole("heading", { name: "Integrations" })).toBeVisible();
});

test("changes a Wedding Planner switch in one place and shows it in Wedding settings", async ({ page, request }) => {
    try {
        await page.goto("/admin/administration/features");
        const saveTheDate = at(page).getByRole("switch", { name: /Public Save the Date page/ });
        await expect(saveTheDate).not.toBeChecked();
        await saveTheDate.click({ force: true });
        await expect(saveTheDate).toBeChecked();
        await page.reload();
        await expect(at(page).getByRole("switch", { name: /Public Save the Date page/ })).toBeChecked();

        await page.goto("/admin/wedding/settings");
        await expect(at(page).locator('[data-flag="wedding.save_the_date.public"]')).toContainText("On");
        // Wedding settings has no toggle of its own for the portal switch.
        await expect(at(page).getByRole("switch", { name: /Public Save the Date page/ })).toHaveCount(0);
    } finally {
        await setFlag(request, "wedding.save_the_date.public", false);
    }
});

test("keeps Wedding settings for wedding details and sends old feature links to Administration", async ({ page }) => {
    await page.goto("/portal/wedding/settings/features");
    await expect(page).toHaveURL(/\/admin\/administration\/features#features-wedding$/);
    await expect(at(page).getByRole("switch", { name: /Public wedding website/ })).toBeVisible();

    await page.goto("/admin/wedding/settings");
    await expect(at(page).getByRole("heading", { level: 1, name: "Wedding settings" })).toBeVisible();
    await expect(at(page).getByRole("tab", { name: "Features" })).toHaveCount(0);
    await expect(at(page).getByRole("textbox", { name: /First partner/ })).toBeVisible();
    await expect(at(page).locator('[data-flag="wedding.site.public"]')).toBeVisible();
    await expect(at(page).getByRole("switch")).toHaveCount(0);
    await expectAccessible(page);
});
