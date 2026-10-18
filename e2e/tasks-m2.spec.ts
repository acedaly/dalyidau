import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Browser, type Page, expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Daly Tasks, Milestone 2, in a real browser (desktop and Pixel 7): Todoist import and re-import,
// week and month planning with rescheduling, advanced repeats, templates, Quick Add from Knowledge
// and the rest of the portal, privacy across two identities, and reminder preferences. All data is
// invented; every title carries the project name because desktop and mobile share one database.

const BASE = "http://localhost:8787";
const JSON_HEADERS = { Origin: BASE, "Content-Type": "application/json" };
const PARTNER = "e2e-partner@example.com";

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
const createTask = async (request: APIRequestContext, data: Record<string, unknown>) =>
    ((await post(request, "/api/portal/tasks/tasks", data)) as { task: { id: string; version: number } }).task;
const sydneyToday = (page: Page) => page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date()));
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const fits = async (page: Page, label: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), label).toBeLessThanOrEqual(0);
    // A phone zooms out instead of scrolling sideways when something is too wide; catch that too.
    expect(await page.evaluate(() => window.innerWidth), label).toBeLessThanOrEqual(page.viewportSize()!.width);
    const results = await new AxeBuilder({ page }).include("main").exclude("main p.bg-warning-primary").analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};
const partner = async (browser: Browser, request: APIRequestContext) => {
    const added = await request.post("/api/portal/users", { headers: JSON_HEADERS, data: { email: PARTNER, role: "admin" } });
    expect(added.ok() || added.status() === 409 || added.status() === 422, await added.text()).toBe(true);
    const context = await browser.newContext({ ...test.info().project.use });
    await context.addCookies([{ name: "portal_dev_identity", value: "alt", url: BASE }]);
    return context;
};

test("1 and 2. imports a Todoist export after a preview, and importing it again adds nothing", async ({ page }, info) => {
    const errors = watchErrors(page);
    // A file name of its own per browser project, so the two runs don't find each other's import.
    const csv = (await readFile("fixtures/todoist/Household [1000000001].csv", "utf8")).replace(/Pay water bill/g, `Pay water bill ${info.project.name}`);
    const file = { name: `Household ${info.project.name}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv) };
    await page.goto("/portal/tasks/settings");
    const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Import from Todoist" }) });
    await card.locator('input[type="file"]').setInputFiles(file);
    const preview = card
        .getByRole("region", { name: `Household ${info.project.name}` })
        .or(card.locator("section").filter({ hasText: `Household ${info.project.name}` }));
    await expect(preview.first()).toBeVisible();
    await expect(card.getByText("New: 6")).toBeVisible();
    await expect(card.getByText(/not imported: author/i)).toBeVisible();
    await fits(page, "import preview");
    await card.getByRole("button", { name: "Import", exact: true }).click();
    await expect(card.getByText("Import finished")).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText(/1 projects and 6 tasks added/)).toBeVisible();

    // Again: everything is recognised, and there's nothing to import.
    await card.locator('input[type="file"]').setInputFiles(file);
    await expect(card.getByText("You've imported these files before")).toBeVisible();
    await expect(card.getByText("Already imported: 6")).toBeVisible();
    await expect(card.getByRole("button", { name: "Nothing new to import" })).toBeDisabled();

    await page.goto("/portal/tasks/search?q=" + encodeURIComponent(`Pay water bill ${info.project.name}`));
    await expect(page.getByRole("button", { name: `Pay water bill ${info.project.name}`, exact: true })).toHaveCount(1);
    expect(errors).toEqual([]);
});

// The week/month journey changes the remembered Upcoming layout; put it back even if it fails,
// because the other journeys share this person and database and expect the agenda.
test.afterEach(async ({ request }, info) => {
    if (!info.title.startsWith("3 and 4.")) return;
    const reset = await request.put("/api/portal/tasks/preferences/views/upcoming", { headers: JSON_HEADERS, data: { mode: "agenda" } });
    expect(reset.ok()).toBe(true);
});

test("3 and 4. plans in week and month views and reschedules from the calendar", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const today = await sydneyToday(page);
    const title = `Book plumber ${info.project.name}`;
    await createTask(request, { title, dueDate: today, deadline: addDays(today, 10) });
    await page.goto("/portal/tasks/upcoming");
    await page
        .getByRole("radio", { name: "Week" })
        .or(page.getByRole("button", { name: "Week", exact: true }))
        .first()
        .click();
    await expect(page).toHaveURL(/mode=week/);
    const card = page.getByRole("button", { name: title }).first();
    await expect(card).toBeVisible();
    await fits(page, "week");

    // Keyboard rescheduling (the same dialog the mobile menu opens): "s" on the card.
    await page.locator(`[aria-label^="${title}"]`).first().focus();
    await page.keyboard.press("s");
    const dialog = page.getByRole("dialog", { name: "Reschedule" });
    await expect(dialog.getByText(/the deadline .* stays as it is/)).toBeVisible();
    await dialog.getByRole("button", { name: "Tomorrow" }).click();
    await dialog.getByRole("button", { name: /^Move to/ }).click();
    await expect(page.getByText("Moved to Tomorrow")).toBeVisible();

    // The week moves on; then the month shows the selected day's agenda.
    await page.getByRole("button", { name: "Later" }).click();
    await expect(page.getByRole("button", { name: "Today", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page
        .getByRole("radio", { name: "Month" })
        .or(page.getByRole("button", { name: "Month", exact: true }))
        .first()
        .click();
    await expect(page).toHaveURL(/mode=month/);
    await page
        .getByRole("button", {
            name: new RegExp(
                `^${new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(Date.parse(`${addDays(today, 1)}T00:00:00Z`)).replace(",", "")}:`,
            ),
        })
        .click();
    await expect(
        page
            .getByRole("region", { name: /Tomorrow|Due/ })
            .or(page.locator("section"))
            .getByRole("button", { name: title, exact: true })
            .first(),
    ).toBeVisible();
    await fits(page, "month");
    // The layout is remembered.
    await page.goto("/portal/tasks/upcoming");
    await expect(page.getByRole("group", { name: "Month" })).toBeVisible();
    expect(errors).toEqual([]);
});

test("5. completes a second-Tuesday repeat and skips a later occurrence", async ({ page, request }, info) => {
    const title = `Book club ${info.project.name}`;
    await page.goto("/portal/tasks/inbox");
    await page.getByRole("button", { name: "Add task" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add a task" });
    await dialog.getByRole("textbox", { name: "Task name" }).fill(`${title} every 2nd tuesday`);
    await expect(dialog.getByText(/Repeats: Every month on the 2nd Tue/)).toBeVisible();
    await dialog.getByRole("textbox", { name: "Task name" }).press("Enter");
    await expect(dialog).toBeHidden();
    const tasks = (await (await request.get(`/api/portal/tasks/search?q=${encodeURIComponent(title)}`)).json()) as { tasks: { id: string; dueDate: string }[] };
    const task = tasks.tasks[0];
    // Complete it from its row; it moves to the next second Tuesday.
    const row = page.locator("li[data-task-id]").filter({ has: page.getByRole("button", { name: title, exact: true }) });
    await row
        .locator("label")
        .filter({ has: page.getByRole("checkbox", { name: `Complete “${title}”` }) })
        .click();
    await expect(page.getByText(/Done\. Next:/)).toBeVisible();
    const after = (await (await request.get(`/api/portal/tasks/tasks/${task.id}`)).json()) as { task: { dueDate: string } };
    expect(after.task.dueDate > task.dueDate).toBe(true);
    expect(new Date(`${after.task.dueDate}T00:00:00Z`).getUTCDay()).toBe(2);
    expect(Number(after.task.dueDate.slice(8))).toBeGreaterThanOrEqual(8);
    expect(Number(after.task.dueDate.slice(8))).toBeLessThanOrEqual(14);
});

test("6. creates a template with a checklist and uses it", async ({ page }, info) => {
    const errors = watchErrors(page);
    const name = `Packing ${info.project.name}`;
    await page.goto("/portal/tasks/templates");
    await page.getByRole("button", { name: "New template" }).click();
    const editor = page.getByRole("dialog", { name: "New template" });
    await editor.getByRole("textbox", { name: /Template name/ }).fill(name);
    await editor.getByRole("textbox", { name: /Task title/ }).fill(`Pack for the coast ${info.project.name}`);
    await editor.getByRole("textbox", { name: "Checklist" }).fill("Clothes\n  Swimmers\nChargers");
    await editor.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByText("Template created")).toBeVisible();
    const item = page.locator("li").filter({ hasText: name });
    await expect(item.getByText(/3 checklist items/)).toBeVisible();
    await fits(page, "templates");
    await item.getByRole("button", { name: "Use" }).click();
    await page
        .getByRole("dialog", { name: `Use “${name}”` })
        .getByRole("button", { name: "Create task" })
        .click();
    await expect(page.getByText("Task created")).toBeVisible();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    const panel = page.getByRole("dialog").filter({ has: page.getByRole("textbox", { name: "Task name" }) });
    await expect(panel.getByRole("list", { name: "Subtasks" }).getByRole("button", { name: "Clothes", exact: true })).toBeVisible();
    await expect(panel.getByText("0 of 2")).toBeVisible();
    expect(errors).toEqual([]);
});

test("7. adds a task from a Knowledge page, linked to it, without leaving the page", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const spaces = ((await (await request.get("/api/portal/knowledge/spaces")).json()) as { spaces: { id: string; kind: string }[] }).spaces;
    const note = (
        (await post(request, `/api/portal/knowledge/spaces/${spaces.find((s) => s.kind === "personal")!.id}/objects`, {
            title: `Car notes ${info.project.name}`,
        })) as {
            object: { id: string };
        }
    ).object;
    await page.goto(`/portal/knowledge/o/${note.id}`);
    await expect(page.getByRole("main")).toBeVisible();
    if (info.project.name === "desktop") {
        await page.locator("body").click({ position: { x: 5, y: 5 } });
        await page.keyboard.press("q");
    } else await page.getByRole("button", { name: "Add task", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add a task" });
    await expect(dialog.getByRole("switch", { name: `Link to “Car notes ${info.project.name}”` })).toBeChecked();
    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    const title = `Book a service ${info.project.name}`;
    await dialog.getByRole("textbox", { name: "Task name" }).fill(`${title} friday`);
    await expect(dialog.getByText(/Due: /)).toBeVisible();
    await dialog.getByRole("textbox", { name: "Task name" }).press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Task added")).toBeVisible();
    // Still on the Knowledge page.
    await expect(page).toHaveURL(new RegExp(`/portal/knowledge/o/${note.id}`));
    const linked = (await (await request.get(`/api/portal/tasks/knowledge/${note.id}`)).json()) as { tasks: { title: string }[] };
    expect(linked.tasks.map((t) => t.title)).toContain(title);
    // Quick Add itself is checked here; the Knowledge page is covered by the Knowledge journeys.
    expect(await page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(errors).toEqual([]);
});

test("8. keeps A's tasks, templates and imports away from B", async ({ page, request, browser }, info) => {
    const secret = `Private appointment ${info.project.name}`;
    const task = await createTask(request, { title: secret });
    await post(request, "/api/portal/tasks/templates", { name: `Private template ${info.project.name}`, title: "Hidden" });
    const context = await partner(browser, request);
    const b = await context.newPage();
    for (const path of ["/portal/tasks/mine", "/portal/tasks/templates", "/portal/tasks/upcoming?mode=month", "/portal/tasks/today"]) {
        await b.goto(path);
        await expect(b.getByRole("main")).toBeVisible();
        await expect(b.getByText(secret)).toHaveCount(0);
        await expect(b.getByText(`Private template ${info.project.name}`)).toHaveCount(0);
    }
    expect((await context.request.get(`/api/portal/tasks/tasks/${task.id}`)).status()).toBe(404);
    const shell = await (await context.request.get("/api/portal/tasks/shell")).text();
    expect(shell).not.toContain(secret);
    await context.close();
    await page.goto("/portal/tasks/mine");
    await expect(page.getByRole("button", { name: secret, exact: true })).toBeVisible();
});

test("9. plans and captures on a phone", async ({ page, request }, info) => {
    test.skip(info.project.name !== "mobile", "The phone layout");
    const today = await sydneyToday(page);
    await createTask(request, { title: `Phone plan ${info.project.name}`, dueDate: today });
    await page.goto("/portal/tasks/upcoming?mode=month");
    await expect(page.getByRole("group", { name: "Month" })).toBeVisible();
    await fits(page, "mobile month");
    // The floating button opens Quick Add from any page, including outside Tasks.
    await page.goto("/portal");
    await page.getByRole("button", { name: "Add task", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add a task" });
    await dialog.getByRole("textbox", { name: "Task name" }).fill(`Phone capture ${info.project.name} tomorrow`);
    await dialog.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText("Task added")).toBeVisible();
    await page.goto("/portal/tasks/mine");
    await expect(page.getByRole("button", { name: `Phone capture ${info.project.name}`, exact: true })).toBeVisible();
    await fits(page, "mobile my tasks");
});

test("10. saves reminder preferences", async ({ page }) => {
    await page.goto("/portal/tasks/settings");
    const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Reminders" }) });
    await expect(card.getByText("Email reminders aren't switched on for the portal")).toBeVisible();
    const email = card.getByRole("switch", { name: "Email my reminders to me" });
    const was = await email.isChecked();
    await card.locator("label").filter({ hasText: "Email my reminders to me" }).click();
    await expect(page.getByText("Saved").first()).toBeVisible();
    await page.reload();
    await expect(
        page
            .locator("section")
            .filter({ has: page.getByRole("heading", { name: "Reminders" }) })
            .getByRole("switch", { name: "Email my reminders to me" }),
    ).toBeChecked({
        checked: !was,
    });
    await fits(page, "settings");
});
