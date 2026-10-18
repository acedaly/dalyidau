import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

// The Daily Planner and time blocking (Milestone 6.2) in a real browser, desktop and Pixel 7:
// scheduling with the keyboard-and-touch Schedule button, dragging a task onto the week view,
// moving, resizing and cancelling a block, accepting a suggestion, completing a task from Calendar,
// the collapsible Tasks panel, accessibility and no horizontal scrolling. Titles carry the
// project's name because both runs share one database.

const BASE = "http://localhost:8787";
const JSON_HEADERS = { Origin: BASE, "Content-Type": "application/json" };
const P = "/api/portal/calendar/planner";

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

/**
 * Plan every day, nearly all day, with no buffer and no daily limit, so the tests don't depend on the
 * weekday, the hour they run at, or tasks other specs leave due on the same day (they share one database).
 */
const plannableEveryDay = async (request: APIRequestContext) => {
    const current = await (await request.get(`${BASE}${P}/preferences`)).json();
    await send(request, "put", `${BASE}${P}/preferences`, {
        preferences: {
            ...current.preferences,
            workingHours: Array.from({ length: 7 }, () => ({ start: "06:00", end: "23:45" })),
            planOnDaysOff: true,
            bufferMinutes: 0,
            dailyFocusMinutes: 960,
        },
        version: current.version,
    });
};
const newTask = async (request: APIRequestContext, title: string, dueDate: string) =>
    (await send(request, "post", `${BASE}/api/portal/tasks/tasks`, { title, dueDate, priority: 1 })).task as { id: string };

test("the Daily Planner fits the screen and passes accessibility checks", async ({ page, request }, info) => {
    await plannableEveryDay(request);
    const today = await sydneyToday(page);
    await newTask(request, `Fit check (${info.project.name})`, today);
    await page.goto(`/portal/calendar/planner?date=${today}`);
    await expect(page.getByRole("heading", { level: 1, name: "Daily planner" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Capacity" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tasks to plan" })).toBeVisible();
    await fits(page, "planner");
    await page.goto(`/portal/calendar?view=week&date=${today}`);
    await expect(page.getByRole("heading", { name: "Tasks to plan" })).toBeVisible();
    await fits(page, "week with tasks panel");
    await page.goto(`/portal/calendar?view=day&date=${today}`);
    await fits(page, "day with tasks panel");
});

test("schedules a task with the Schedule button, then moves, resizes and cancels it", async ({ page, request }, info) => {
    await plannableEveryDay(request);
    const date = tomorrowOf(await sydneyToday(page));
    const title = `Keyboard plan (${info.project.name})`;
    const task = await newTask(request, title, date);
    await page.goto(`/portal/calendar/planner?date=${date}`);

    // The keyboard and touch way: Schedule, choose a time, confirm.
    await page.getByRole("tab", { name: /Upcoming/ }).click();
    await page.getByRole("button", { name: `Schedule ${title}` }).click();
    const dialog = page.getByRole("dialog", { name: "Schedule time" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Start", exact: true }).fill("10:00");
    await dialog.getByRole("button", { name: /^Schedule/ }).click();
    await expect(page.getByText(/^Planned/).first()).toBeVisible();
    const block = page.locator("[data-block]:visible").filter({ hasText: title }).first();
    await expect(block).toBeVisible();

    // The task itself didn't change.
    const after = await (await request.get(`${BASE}/api/portal/tasks/tasks/${task.id}`)).json();
    expect(after.task.dueDate).toBe(date);
    expect(after.task.status).toBe("open");

    // Open it, make it longer, then cancel it.
    await block.click();
    const panel = page.getByRole("dialog", { name: title });
    await panel.getByRole("button", { name: "15 min longer" }).click();
    await expect(panel.getByText(/1 h 15 min/)).toBeVisible();
    await panel.getByRole("button", { name: "Cancel this time" }).click();
    await page.getByRole("dialog", { name: "Cancel this planned time?" }).getByRole("button", { name: "Cancel the time" }).click();
    await expect(page.locator("[data-block]:visible").filter({ hasText: title })).toHaveCount(0);
});

test("drags a task from the Tasks panel onto the week view", async ({ page, request }, info) => {
    test.skip(info.project.name !== "desktop", "Dragging needs the desktop week grid; phones use Schedule");
    await plannableEveryDay(request);
    const today = await sydneyToday(page);
    const title = `Drag plan (${info.project.name})`;
    await newTask(request, title, today);
    await page.goto(`/portal/calendar?view=week&date=${today}`);
    const row = page.locator("[data-task]").filter({ hasText: title });
    await expect(row).toBeVisible();
    const column = page.locator(`[data-date="${today}"]`);
    await column.scrollIntoViewIfNeeded();
    // 14:00 is 14 hours down a column 48 px an hour.
    await row.dragTo(column, { targetPosition: { x: 20, y: 14 * 48 + 4 } });
    const block = page.locator("[data-block]:visible").filter({ hasText: title });
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute("aria-label", /Planned: .*, 2 pm – 3 pm/);

    // The panel can be collapsed and expanded again.
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(page.getByRole("button", { name: "Show", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(row).toHaveCount(0);
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect(row).toBeVisible();
});

test("suggests a plan, accepts a suggestion, and completes a task from Calendar", async ({ page, request }, info) => {
    await plannableEveryDay(request);
    const date = tomorrowOf(await sydneyToday(page));
    const title = `Suggested (${info.project.name})`;
    const task = await newTask(request, title, date);
    await send(request, "put", `${BASE}${P}/estimates/${task.id}`, { minutes: 45 });
    await page.goto(`/portal/calendar/planner?date=${date}`);
    await page.getByRole("button", { name: "Suggest a plan" }).click();
    const suggestion = page.locator(`[data-suggestion="${task.id}"]`).first();
    await expect(suggestion).toBeVisible();
    // Suggestions create nothing until accepted.
    await expect(page.locator("[data-block]").filter({ hasText: title })).toHaveCount(0);
    await suggestion.getByRole("button", { name: /^Accept/ }).click();
    await expect(page.locator("[data-block]:visible").filter({ hasText: title }).first()).toBeVisible();

    // Complete it from the Tasks panel (Tasks' own API).
    await page.getByRole("tab", { name: /Upcoming/ }).click();
    await page.getByRole("button", { name: `Complete ${title}` }).click();
    await expect(page.getByText("Task completed")).toBeVisible();
    const done = await (await request.get(`${BASE}/api/portal/tasks/tasks/${task.id}`)).json();
    expect(done.task.status).toBe("completed");
});
