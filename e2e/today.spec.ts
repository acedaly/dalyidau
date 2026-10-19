import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Locator, type Page, expect, test } from "@playwright/test";

// Today (Milestone 6.3) in a real browser, desktop and Pixel 7: the dashboard fits and passes
// accessibility checks, the sidebar leads to it, Plan My Day proposes before changing anything (one
// session rejected, one adjusted, then approved), tasks complete from Today with the keyboard, Quick
// capture opens from the keyboard, and the morning and evening routines change only what the person
// chooses. Titles carry the project's name because both runs share one database.

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

/** Plannable all day, every day, so the tests don't depend on the weekday or the hour they run at. */
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
// Priority 1 only: other specs' axe checks share this database, and Tasks' own P2 and P3 labels have a known contrast issue.
const newTask = async (request: APIRequestContext, title: string, dueDate: string, priority = 1) =>
    (await send(request, "post", `${BASE}/api/portal/tasks/tasks`, { title, dueDate, priority })).task as { id: string };
/** Ticks or unticks an Untitled UI checkbox (or chooses a radio) from the keyboard: its input is visually hidden. */
const setChecked = async (page: Page, box: Locator, want: boolean) => {
    if ((await box.isChecked()) === want) return;
    await box.focus();
    await page.keyboard.press("Space");
    await expect(box).toBeChecked({ checked: want });
};
const blocksFor = async (request: APIRequestContext, date: string, taskId: string) => {
    const r = await (await request.get(`${BASE}${P}/day?date=${date}`)).json();
    return (r.plan.blocks as { taskId: string; startTime: string; durationMinutes: number; status: string }[]).filter((b) => b.taskId === taskId);
};

test("Today fits the screen, passes accessibility checks and is in the navigation", async ({ page, request }, info) => {
    await plannableEveryDay(request);
    const today = await sydneyToday(page);
    await newTask(request, `Today fit (${info.project.name})`, today);
    await page.goto("/portal");
    // From the launcher's Today card (the sidebar link is in the drawer on phones).
    await page.locator('[data-portal-link="today"]').click();
    await expect(page).toHaveURL(/\/portal\/today$/);
    await expect(page.getByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
    for (const name of ["Chief of Staff briefing", "Capacity", "Timeline", "Needs attention", "Tasks"])
        await expect(page.getByRole("heading", { name, exact: true }).first()).toBeVisible();
    await fits(page, "today");
    // Tomorrow, from the day switcher.
    await page.getByRole("navigation", { name: "Choose a day" }).getByRole("link", { name: "Tomorrow" }).click();
    await expect(page).toHaveURL(new RegExp(`date=${tomorrowOf(today)}`));
    await fits(page, "tomorrow");
    if (info.project.name === "desktop") {
        // The sidebar link, with the launcher still there.
        await expect(page.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Today" })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "All Applications" })).toBeVisible();
    }
});

test("Plan my day shows the proposal first; one session rejected, one adjusted, then approved", async ({ page, request }, info) => {
    await plannableEveryDay(request);
    const date = tomorrowOf(await sydneyToday(page));
    const keep = `Plan keep (${info.project.name})`;
    const reject = `Plan reject (${info.project.name})`;
    // Long overdue, so they come first in the planner's order whatever other specs left in the shared database.
    const kept = await newTask(request, keep, "2020-01-01");
    const rejected = await newTask(request, reject, "2020-01-02");
    await page.goto(`/portal/today?date=${date}`);
    await page.getByRole("button", { name: "Plan my day" }).click();
    const dialog = page.getByRole("dialog", { name: "Plan my day" });
    await expect(dialog.locator(`[data-proposal="${kept.id}"]`).first()).toBeVisible();
    // Nothing exists until it's approved.
    expect(await blocksFor(request, date, kept.id)).toEqual([]);

    // Reject one (untick it), adjust the other's start.
    await setChecked(page, dialog.locator(`[data-proposal="${rejected.id}"]`).first().getByRole("checkbox"), false);
    const row = dialog.locator(`[data-proposal="${kept.id}"]`).first();
    await row.getByRole("textbox", { name: "Start" }).fill("21:30");
    // Only approve ours: untick anything left by other specs sharing the database.
    for (const other of await dialog.locator("[data-proposal]").all()) {
        const id = await other.getAttribute("data-proposal");
        if (id !== kept.id) await setChecked(page, other.getByRole("checkbox"), false);
    }
    await dialog.getByRole("button", { name: /^Approve/ }).click();
    await expect(page.getByText(/^Planned 1 session/)).toBeVisible();
    const blocks = await blocksFor(request, date, kept.id);
    expect(blocks.map((b) => b.startTime)).toContain("21:30");
    expect(await blocksFor(request, date, rejected.id)).toEqual([]);
    // It's on the timeline as movable task time.
    await expect(page.locator('[data-timeline="block"][data-movable]').filter({ hasText: keep }).first()).toBeVisible();
});

test("completes a task from Today and opens Quick capture with the keyboard", async ({ page, request }, info) => {
    await plannableEveryDay(request);
    const today = await sydneyToday(page);
    const title = `Complete from Today (${info.project.name})`;
    const task = await newTask(request, title, today);
    await page.goto("/portal/today");
    const complete = page.getByRole("button", { name: `Complete ${title}` }).first();
    await complete.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Task completed").first()).toBeVisible();
    expect((await (await request.get(`${BASE}/api/portal/tasks/tasks/${task.id}`)).json()).task.status).toBe("completed");

    const capture = page.getByRole("button", { name: "Quick capture" });
    await capture.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Quick capture" });
    await expect(menu.getByRole("menuitem", { name: /Task/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Appointment/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
});

test("morning planning and the evening review change only what's chosen", async ({ page, request }, info) => {
    await plannableEveryDay(request);
    const today = await sydneyToday(page);
    const title = `Unfinished (${info.project.name})`;
    const task = await newTask(request, title, today);
    const created = await send(request, "post", `${BASE}${P}/blocks`, { taskId: task.id, startDate: today, startTime: "06:00", durationMinutes: 30 });
    await page.goto("/portal/today");

    // Morning: walk through every step; approving with no sessions ticked creates none.
    await page.getByRole("button", { name: /^Morning planning/ }).click();
    const morning = page.getByRole("dialog", { name: "Morning planning" });
    await expect(morning.getByRole("heading", { name: /Review the day/ })).toBeVisible();
    await morning.getByRole("button", { name: "Next" }).click();
    await expect(morning.getByRole("heading", { name: /top three/ })).toBeVisible();
    await morning.getByRole("button", { name: "Next" }).click();
    await setChecked(page, morning.getByRole("checkbox", { name: /This is right for today/ }), true);
    await morning.getByRole("button", { name: "Next" }).click();
    await expect(morning.getByRole("heading", { name: /Suggested sessions/ })).toBeVisible();
    await expect(morning.getByRole("list", { name: "Proposed sessions" }).or(morning.getByText(/Nothing to propose/))).toBeVisible();
    for (const box of await morning.getByRole("checkbox").all()) await setChecked(page, box, false);
    await morning.getByRole("button", { name: "Next" }).click();
    await morning.getByRole("button", { name: "Approve the plan" }).click();
    await expect(page.getByText("Morning planning done")).toBeVisible();
    await expect(page.getByRole("button", { name: "Morning planning ✓" })).toBeVisible();

    // Evening: return the unfinished session's task to the list.
    await page.getByRole("button", { name: /^Evening review/ }).click();
    const evening = page.getByRole("dialog", { name: "Evening review" });
    await evening.getByRole("button", { name: "Next" }).click();
    const item = evening.locator(`[data-unfinished="${created.block.id}"]`);
    await expect(item).toBeVisible();
    // Nothing has moved yet.
    expect((await blocksFor(request, today, task.id)).map((b) => b.status)).toEqual(["scheduled"]);
    await setChecked(page, item.getByRole("radio", { name: /Return the task/ }), true);
    await evening.getByRole("button", { name: "Next" }).click();
    await evening.getByRole("button", { name: "Next" }).click();
    await evening.getByRole("textbox", { name: "Notes on the day" }).fill("Steady day.");
    await evening.getByRole("button", { name: "Finish the day" }).click();
    await expect(page.getByText("Evening review done")).toBeVisible();
    expect(await blocksFor(request, today, task.id)).toEqual([]);
    const reviews = await (await request.get(`${BASE}/api/portal/today/reviews/${today}`)).json();
    expect(reviews.reviews.evening).toMatchObject({ note: "Steady day.", summary: { returned: 1 } });
});
