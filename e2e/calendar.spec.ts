import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

// Daly Calendar (Milestone 6) in a real browser, desktop and Pixel 7: the compact application
// launcher, every Calendar and Leave page, creating an event, setting up leave and booking it,
// and the planner. All data is invented; titles carry the browser project's name because both runs
// share one database.

const BASE = "http://localhost:8787";
const JSON_HEADERS = { Origin: BASE, "Content-Type": "application/json" };

const watchErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
    return errors;
};
const post = async (request: APIRequestContext, path: string, data: unknown) => {
    const response = await request.post(path, { headers: JSON_HEADERS, data });
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
    return response.json();
};
const fits = async (page: Page, label: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
    const results = await new AxeBuilder({ page }).include("main").exclude("main p.bg-warning-primary").analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};
const sydneyToday = (page: Page) => page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date()));

test.describe("application launcher", () => {
    // Columns follow the width beside the sidebar (container queries), not the window.
    for (const [width, columns] of [
        [375, 1],
        [768, 2],
        [1280, 3],
        [1680, 4],
    ] as const) {
        test(`is compact at ${width}px wide`, async ({ page }, info) => {
            test.skip(info.project.name !== "desktop", "Widths are set explicitly on the desktop project");
            await page.setViewportSize({ width, height: 900 });
            const errors = watchErrors(page);
            await page.goto("/portal");
            const cards = page.locator("[data-application]");
            await expect(cards.first()).toBeVisible();
            expect(await cards.count()).toBeGreaterThanOrEqual(5);
            const boxes = await cards.evaluateAll((els) =>
                els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), height: r.height, left: Math.round(r.left) })),
            );
            for (const b of boxes) expect(b.height, "card height").toBeLessThanOrEqual(140);
            const firstRow = boxes.filter((b) => b.top === boxes[0].top);
            expect(firstRow.length, "cards in the first row").toBe(columns);
            // Every card is one large, accessible link.
            for (const b of boxes) expect(b.height).toBeGreaterThanOrEqual(44);
            await expect(page.getByRole("link", { name: "Open Daly Calendar" })).toBeVisible();
            await fits(page, `launcher ${width}`);
            await page.screenshot({ path: `test-results/launcher-${width}.png`, fullPage: true });
            expect(errors).toEqual([]);
        });
    }

    test("opens Calendar from its card", async ({ page }) => {
        await page.goto("/portal");
        await page.getByRole("link", { name: "Open Daly Calendar" }).click();
        await expect(page).toHaveURL(/\/portal\/calendar$/);
        await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
    });
});

test("every Calendar and Leave page loads, hydrates and fits the screen", async ({ page }) => {
    const errors = watchErrors(page);
    for (const path of [
        "/portal/calendar",
        "/portal/calendar?view=day",
        "/portal/calendar?view=month",
        "/portal/calendar?view=agenda",
        "/portal/calendar/year",
        "/portal/calendar/family",
        "/portal/calendar/leave",
        "/portal/calendar/leave/planner",
        "/portal/calendar/leave/settings",
        "/portal/calendar/calendars",
        "/portal/calendar/subscriptions",
        "/portal/calendar/holidays",
        "/portal/calendar/settings",
    ]) {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(200);
        await expect(page.locator("main h1")).toBeVisible();
        await fits(page, path);
    }
    expect(errors).toEqual([]);
});

test("adds an event in the panel and finds it in the week, month and agenda", async ({ page }, info) => {
    const errors = watchErrors(page);
    const title = `Dentist (${info.project.name})`;
    await page.goto("/portal/calendar?view=week");
    await page.getByRole("button", { name: "Add event" }).first().click();
    const panel = page.getByRole("dialog");
    await panel.getByLabel("Title").fill(title);
    // "Add event" starts an all-day event on today.
    await expect(panel.getByRole("switch", { name: "All day" })).toBeChecked();
    await panel.getByRole("button", { name: "Add event" }).click();
    await expect(page.getByText("Event added")).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("button", { name: new RegExp(`^${title.replace(/[()]/g, "\\$&")}`) }).first()).toBeVisible();
    await page.screenshot({ path: `test-results/calendar-week-${info.project.name}.png`, fullPage: true });
    for (const view of ["month", "agenda"]) {
        await page.goto(`/portal/calendar?view=${view}`);
        await expect(page.getByRole("button", { name: new RegExp(title.replace(/[()]/g, "\\$&")) }).first()).toBeVisible();
    }
    // Open it again: an all-day event on the person's own calendar, editable.
    await page
        .getByRole("button", { name: new RegExp(title.replace(/[()]/g, "\\$&")) })
        .first()
        .click();
    await expect(page.getByRole("dialog").getByLabel("Title")).toHaveValue(title);
    expect(errors).toEqual([]);
});

test("shows NSW public and school holidays on the year planner and holidays page", async ({ page }) => {
    await page.goto("/portal/calendar/year?year=2026");
    await expect(page.getByRole("link", { name: /Monday 5 October 2026, public holiday: Labour Day/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Monday 6 July 2026.*Winter school holidays/ })).toBeVisible();
    await page.goto("/portal/calendar/holidays?year=2026");
    await expect(page.getByText("Anzac Day (additional day)")).toBeVisible();
    await expect(page.getByRole("link", { name: /Source, checked/ }).first()).toBeVisible();
});

test("sets up leave, books it with a live calculation and plans the school holidays", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    await page.goto("/portal/calendar/leave");
    if (await page.getByRole("heading", { name: "Set up your leave planner" }).isVisible()) {
        await page.getByLabel("Annual leave (hours)").fill("120");
        await page.getByRole("button", { name: "Set up" }).click();
        await expect(page.getByText("Leave planner set up")).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Annual leave" }).first()).toBeVisible();
    const today = await sydneyToday(page);
    // A booking through the API (date pickers are covered by the Tasks tests), then its live preview.
    const leave = (await (await request.get("/api/portal/calendar/leave")).json()) as { leave: { types: { id: string; kind: string }[] } };
    const annual = leave.leave.types.find((t) => t.kind === "annual")!;
    await post(request, "/api/portal/calendar/leave/bookings", {
        leaveTypeId: annual.id,
        startDate: today,
        endDate: today,
        status: "proposed",
        title: `Long weekend (${info.project.name})`,
    });
    await page.goto("/portal/calendar/leave?tab=bookings");
    await expect(page.getByText(`Long weekend (${info.project.name})`)).toBeVisible();
    await page.getByRole("button", { name: "Change" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: /Takes .* h/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/portal/calendar/leave?tab=forecast");
    await expect(page.getByRole("table", { name: /How the Annual leave balance/ })).toBeVisible();
    await page.goto("/portal/calendar/leave/planner");
    await page.getByRole("button", { name: "Work it out" }).first().click();
    await expect(page.getByText(/days off ·/).first()).toBeVisible();
    await page.screenshot({ path: `test-results/leave-planner-${info.project.name}.png`, fullPage: true });
    expect(errors).toEqual([]);
});

test("refuses an unsafe subscription address with a clear reason", async ({ page }) => {
    await page.goto("/portal/calendar/subscriptions");
    await page.getByLabel("Calendar address").fill("http://calendar.example.com/school.ics");
    await page.getByRole("button", { name: "Subscribe" }).click();
    await expect(page.getByRole("alert")).toContainText("Only secure (https)");
    await page.getByLabel("Calendar address").fill("https://127.0.0.1/cal.ics");
    await page.getByRole("button", { name: "Subscribe" }).click();
    await expect(page.getByRole("alert")).toContainText("private or local network");
});
