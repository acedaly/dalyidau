import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

// Today in a real browser, desktop and Pixel 7: the dashboard fits and passes accessibility checks,
// the launcher and sidebar lead to it, an appointment added from Today lands in the calendar and on
// the timeline, and planning hours save. Daly Tasks and the Daily Planner are retired, so there is
// no task list, Plan My Day or morning and evening routine. Titles carry the project's name because
// both runs share one database.

const BASE = "http://localhost:8787";
const JSON_HEADERS = { Origin: BASE, "Content-Type": "application/json" };

const send = async (request: APIRequestContext, method: "post" | "put", path: string, data: unknown) => {
    const response = await request[method](path, { headers: JSON_HEADERS, data });
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
const tomorrowOf = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Available all day, every day, so the tests don't depend on the weekday or the hour they run at. */
const availableEveryDay = async (request: APIRequestContext) => {
    const current = await (await request.get(`${BASE}/api/portal/today/hours`)).json();
    await send(request, "put", `${BASE}/api/portal/today/hours`, {
        preferences: {
            ...current.preferences,
            workingHours: Array.from({ length: 7 }, () => ({ start: "06:00", end: "23:45" })),
            planOnDaysOff: true,
            bufferMinutes: 0,
        },
        version: current.version,
    });
};

test("Today fits the screen, passes accessibility checks and is in the navigation", async ({ page, request }, info) => {
    await availableEveryDay(request);
    const today = await sydneyToday(page);
    await page.goto("/portal");
    // From the launcher's Today card (the sidebar link is in the drawer on phones).
    await page.locator('[data-portal-link="today"]').click();
    await expect(page).toHaveURL(/\/portal\/today$/);
    await expect(page.getByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
    for (const name of ["Chief of Staff briefing", "Capacity", "Timeline"])
        await expect(page.getByRole("heading", { name, exact: true }).first()).toBeVisible();
    // Nothing of Daly Tasks or the Daily Planner is left.
    await expect(page.getByRole("button", { name: /Plan my day|Morning planning|Evening review|Quick capture/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toHaveCount(0);
    await fits(page, "today");
    await page.getByRole("navigation", { name: "Choose a day" }).getByRole("link", { name: "Tomorrow" }).click();
    await expect(page).toHaveURL(new RegExp(`date=${tomorrowOf(today)}`));
    await fits(page, "tomorrow");
    if (info.project.name === "desktop") {
        await expect(page.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Today" })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "All Applications" })).toBeVisible();
    }
});

test("an appointment added from Today goes into the calendar and onto the timeline", async ({ page, request }, info) => {
    await availableEveryDay(request);
    // Makes sure the person has their own calendar.
    await request.get(`${BASE}/api/portal/calendar/calendars`);
    const date = tomorrowOf(await sydneyToday(page));
    const title = `Dentist (${info.project.name})`;
    await page.goto(`/portal/today?date=${date}`);
    await page.getByRole("button", { name: "Add appointment" }).click();
    const dialog = page.getByRole("dialog", { name: "Add an appointment" });
    await dialog.getByLabel("What").fill(title);
    await dialog.getByLabel("Start").fill("21:00");
    await dialog.getByLabel("End").fill("21:30");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-timeline="event"]').filter({ hasText: title }).first()).toBeVisible();
    const events = await (await request.get(`${BASE}/api/portal/calendar/events?from=${date}&to=${date}`)).json();
    expect(JSON.stringify(events)).toContain(title);
});

test("planning hours save from Customise Today, and the retired planner answers 410", async ({ page, request }) => {
    await availableEveryDay(request);
    await page.goto("/portal/today");
    await page.getByRole("button", { name: "Customise Today" }).click();
    await page.getByRole("button", { name: "Planning hours and buffers" }).click();
    const dialog = page.getByRole("dialog", { name: "Planning hours" });
    await dialog.getByLabel("Buffer after events").click();
    await page.getByRole("option", { name: "15 min" }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Planning hours saved")).toBeVisible();
    expect((await (await request.get(`${BASE}/api/portal/today/hours`)).json()).preferences.bufferMinutes).toBe(15);
    for (const path of ["/api/portal/calendar/planner/preferences", "/api/portal/today/plan", "/api/portal/tasks/tasks"])
        expect((await request.get(`${BASE}${path}`)).status(), path).toBe(410);
    expect((await page.goto("/portal/calendar/planner"))?.status()).toBe(410);
});
