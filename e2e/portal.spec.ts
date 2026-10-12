import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

// The e2e Worker runs with ENVIRONMENT=development and ACCESS_DEV_EMAIL, so localhost requests act
// as an owner without Cloudflare Access. Both projects (desktop, mobile) share one database, so
// every name includes the project to keep runs independent.

const JSON_HEADERS = { Origin: "http://localhost:8787", "Content-Type": "application/json" };

const api = async (request: APIRequestContext, method: "post" | "put" | "patch", path: string, data: unknown) => {
    const response = await request[method](path, { headers: JSON_HEADERS, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return response.json();
};

const watchErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
    return errors;
};

test("every portal page loads, hydrates and fits the screen", async ({ page }) => {
    const errors = watchErrors(page);
    for (const path of [
        "/portal/wedding",
        "/portal/wedding/guests",
        "/portal/wedding/households",
        "/portal/wedding/rsvps",
        "/portal/wedding/events",
        "/portal/wedding/communications",
        "/portal/wedding/tasks",
        "/portal/wedding/timeline",
        "/portal/wedding/budget",
        "/portal/wedding/suppliers",
        "/portal/wedding/website",
        "/portal/settings",
        "/portal/settings/privacy",
        "/portal/audit",
    ]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, path).toBeLessThanOrEqual(0);
    }
    expect(errors).toEqual([]);
});

test("adds a guest through the slide-over and finds them in the list", async ({ page }, info) => {
    const name = `Morgan ${info.project.name}`;
    await page.goto("/portal/wedding/guests");
    await page.getByRole("button", { name: "Add guest" }).first().click();
    const panel = page.getByRole("dialog");
    await panel.getByLabel("First name").fill("Morgan");
    await panel.getByLabel("Last name").fill(info.project.name);
    await panel.getByLabel("Email").fill(`morgan-${info.project.name}@example.com`);
    await panel.getByRole("button", { name: "Add guest" }).click();
    await expect(page.getByText("Guest added")).toBeVisible();
    await expect(panel).toBeHidden();

    await page.getByRole("searchbox", { name: "Search guests" }).fill(name);
    await expect(page.getByRole("rowheader", { name: new RegExp(name) })).toBeVisible();

    // It survives a reload (it was saved, not just added to the page).
    await page.reload();
    await page.getByRole("searchbox", { name: "Search guests" }).fill(name);
    await expect(page.getByRole("rowheader", { name: new RegExp(name) })).toBeVisible();
});

test("shows field errors from the server next to the field", async ({ page }) => {
    await page.goto("/portal/wedding/guests");
    await page.getByRole("button", { name: "Add guest" }).first().click();
    const panel = page.getByRole("dialog");
    await panel.getByLabel("First name").fill("Casey");
    await panel.getByLabel("Email").fill("not-an-email");
    await panel.getByRole("button", { name: "Add guest" }).click();
    await expect(
        panel
            .getByText(/email/i)
            .filter({ hasText: /invalid|valid/i })
            .first(),
    ).toBeVisible();
    await expect(panel).toBeVisible();
});

test("customises the dashboard and keeps the layout", async ({ page }) => {
    await page.goto("/portal/wedding");
    await page.getByRole("button", { name: "Customise" }).click();
    const widgets = page.locator("main section[aria-labelledby]");
    const before = await widgets.count();
    await widgets.first().getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Save layout" }).click();
    await expect(page.getByText("Dashboard saved")).toBeVisible();
    await page.reload();
    await expect(widgets).toHaveCount(before - 1);
    // Put it back for the other project.
    await page.getByRole("button", { name: "Customise" }).click();
    await page.getByRole("button", { name: "Reset to default" }).click();
    await expect(page.getByText("Dashboard reset")).toBeVisible();
});

test("a guest RSVPs on the public website with their household code", async ({ page, request }, info) => {
    const suffix = info.project.name;
    await api(request, "put", "/api/portal/settings/wedding", {
        partnerOne: "Robin",
        partnerTwo: "Jules",
        date: "2027-03-20",
        location: "",
        timeZone: "Australia/Sydney",
    });
    const event = (await api(request, "post", "/api/portal/wedding/events", { name: `Ceremony ${suffix}`, startsAt: "2027-03-20T15:00" })).item;
    const household = (await api(request, "post", "/api/portal/wedding/households", { name: `The Testers ${suffix}` })).item;
    await api(request, "post", "/api/portal/wedding/guests", { firstName: "Taylor", lastName: suffix, householdId: household.id, events: [event.id] });
    await api(request, "put", "/api/portal/flags/wedding.site.public", { enabled: true });
    await api(request, "put", "/api/portal/flags/rsvp.native", { enabled: true });

    const errors = watchErrors(page);
    await page.goto("/wedding");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Robin & Jules");
    // The wedding site has its own palette even when the visitor prefers dark mode.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/dark-mode/);

    await page.getByRole("link", { name: "RSVP" }).first().click();
    await expect(page).toHaveURL(/\/wedding\/rsvp$/);
    await page.getByLabel("RSVP code").fill(household.rsvpCode);
    await page.getByRole("button", { name: "Find my invitation" }).click();
    await expect(page.getByRole("heading", { name: `The Testers ${suffix}` })).toBeVisible();
    await page.getByText("Joyfully accepts").click();
    await expect(page.getByRole("radio", { name: "Joyfully accepts" })).toBeChecked();
    await page.getByLabel("Dietary requirements").fill("Vegetarian");
    await page.getByRole("button", { name: "Send our reply" }).click();
    await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
    await expect(page.getByText("celebrate with Taylor")).toBeVisible();
    expect(errors).toEqual([]);

    // The reply shows up in the portal.
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/portal/wedding/guests");
    await page.getByRole("searchbox", { name: "Search guests" }).fill(`Taylor ${suffix}`);
    await expect(page.getByRole("row", { name: new RegExp(`Taylor ${suffix}`) }).getByText("Attending")).toBeVisible();

    await api(request, "put", "/api/portal/flags/rsvp.native", { enabled: false });
    await api(request, "put", "/api/portal/flags/wedding.site.public", { enabled: false });
});

test("the mobile navigation drawer opens and navigates", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile only");
    await page.goto("/portal/wedding");
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: "Tasks" }).click();
    await expect(page).toHaveURL(/\/portal\/wedding\/tasks$/);
    await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
});

test("dark mode works in the portal", async ({ page }) => {
    await page.goto("/portal/wedding");
    const toggle = page.getByRole("button", { name: "Toggle dark mode" }).last();
    if (!(await toggle.isVisible())) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Toggle dark mode" }).last().click();
    await expect(page.locator("html")).toHaveClass(/dark-mode/);
    await page.goto("/portal/wedding/guests");
    await expect(page.locator("html")).toHaveClass(/dark-mode/);
    // Restore.
    await page.evaluate(() => localStorage.removeItem("ui-theme"));
});

test("deletes a guest, restores it, then erases it with typed confirmation", async ({ page, request }, info) => {
    const name = `Rowan Erasable${info.project.name}`;
    await api(request, "post", "/api/portal/wedding/guests", { firstName: "Rowan", lastName: `Erasable${info.project.name}` });

    await page.goto("/portal/wedding/guests");
    await page.getByRole("searchbox", { name: "Search guests" }).fill(name);
    await page.getByRole("rowheader", { name: new RegExp(name) }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete guest" }).click();
    await expect(page.getByText("Guest deleted")).toBeVisible();

    await page.goto("/portal/settings/privacy");
    const row = page.getByRole("row", { name: new RegExp(name) });
    await row.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText(`${name} restored`)).toBeVisible();
    await expect(row).toBeHidden();

    // Delete again via the API, then erase from the UI.
    const guests = (await (await request.get("/api/portal/wedding/guests")).json()).guests as { id: string; firstName: string; lastName: string }[];
    const id = guests.find((g) => `${g.firstName} ${g.lastName}` === name)!.id;
    await request.delete(`/api/portal/wedding/guests/${id}`, { headers: { Origin: "http://localhost:8787" } });
    await page.reload();
    await page
        .getByRole("row", { name: new RegExp(name) })
        .getByRole("button", { name: "Erase" })
        .click();
    const dialog = page.getByRole("dialog");
    const erase = dialog.getByRole("button", { name: "Erase permanently" });
    await dialog.getByLabel(/Type .* to confirm/).fill("wrong name");
    await erase.click();
    await expect(page.getByText("Couldn't erase")).toBeVisible();
    await dialog.getByLabel(/Type .* to confirm/).fill(name);
    await erase.click();
    await expect(page.getByText("Permanently erased")).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(name) })).toBeHidden();
});
