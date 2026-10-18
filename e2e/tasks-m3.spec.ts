import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Browser, type Page, expect, test } from "@playwright/test";

// Daly Tasks, Milestone 3, in a real browser (desktop and Pixel 7): the personal and household
// dashboards, Tasks ↔ Knowledge in both directions, a project review, goals, routines with turns,
// the project timeline, workload and reports, and privacy between two identities. All data is
// invented; every title carries the browser project's name because both runs share one database.

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
    ((await post(request, "/api/portal/tasks/tasks", data)) as { task: { id: string; version: number; dueDate: string | null } }).task;
const createProject = async (request: APIRequestContext, data: Record<string, unknown>) =>
    ((await post(request, "/api/portal/tasks/projects", data)) as { project: { id: string; version: number } }).project;
const sydneyToday = (page: Page) => page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date()));
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const fits = async (page: Page, label: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), label).toBeLessThanOrEqual(0);
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
const sharedWithPartner = async (request: APIRequestContext, browser: Browser, name: string) => {
    const context = await partner(browser, request);
    const project = await createProject(request, { name, kind: "shared" });
    await post(request, `/api/portal/tasks/projects/${project.id}/members`, { email: PARTNER, role: "editor" });
    return { context, project };
};
const circle = (page: Page, title: string) =>
    page
        .locator("label")
        .filter({ has: page.getByRole("checkbox", { name: `Complete “${title}”`, exact: true }) })
        .first();

test("every new page loads without errors, fits the screen and passes axe", async ({ page }) => {
    const errors = watchErrors(page);
    for (const path of [
        "/portal/tasks/dashboard",
        "/portal/tasks/dashboard?tab=household",
        "/portal/tasks/goals",
        "/portal/tasks/routines",
        "/portal/tasks/workload",
        "/portal/tasks/workload?scope=shared&group=project",
        "/portal/tasks/reports",
        "/portal/tasks/reports?scope=shared&range=12m",
    ]) {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(200);
        await expect(page.getByRole("main")).toBeVisible();
        await fits(page, path);
    }
    expect(errors).toEqual([]);
});

test("1. completes a task from the personal dashboard", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const today = await sydneyToday(page);
    const title = `Dashboard call ${info.project.name}`;
    await createTask(request, { title, dueDate: today, priority: 2 });
    await page.goto("/portal/tasks/dashboard?tab=personal");
    const focus = page.getByRole("region", { name: /Today and overdue/ });
    await expect(focus.getByRole("button", { name: title, exact: true })).toBeVisible();
    await fits(page, "personal dashboard");
    await circle(page, title).click();
    await expect(page.getByText("Task completed")).toBeVisible();
    await expect(focus.getByRole("button", { name: title, exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: /Completed this week/ }).getByRole("button", { name: title, exact: true })).toBeVisible();
    expect(errors).toEqual([]);
});

test("2, 8 and 11. shows the household dashboard to both people, by assignee, and nothing private", async ({ page, request, browser }, info) => {
    const suffix = info.project.name;
    const today = await sydneyToday(page);
    const { context, project } = await sharedWithPartner(request, browser, `Home ${suffix}`);
    await createTask(request, { title: `Shared bins ${suffix}`, projectId: project.id, dueDate: today, assignee: PARTNER });
    await createTask(request, { title: `Shared gutters ${suffix}`, projectId: project.id, dueDate: today });
    await createTask(request, { title: `Private dentist ${suffix}`, dueDate: today });

    await page.goto("/portal/tasks/dashboard?tab=household");
    const attention = page.getByRole("region", { name: /Needs attention/ });
    await expect(attention.getByRole("button", { name: `Shared bins ${suffix}`, exact: true })).toBeVisible();
    await expect(page.getByText(`Private dentist ${suffix}`)).toHaveCount(0);
    await fits(page, "household dashboard");
    await page
        .getByRole("radio", { name: "Unassigned" })
        .or(page.getByRole("button", { name: "Unassigned", exact: true }))
        .first()
        .click();
    await expect(attention.getByRole("button", { name: `Shared gutters ${suffix}`, exact: true })).toBeVisible();
    await expect(attention.getByRole("button", { name: `Shared bins ${suffix}`, exact: true })).toHaveCount(0);
    // Put the filter back for the other journeys.
    await page
        .getByRole("radio", { name: "All shared tasks" })
        .or(page.getByRole("button", { name: "All shared tasks", exact: true }))
        .first()
        .click();

    const b = await context.newPage();
    const errors = watchErrors(b);
    await b.goto("/portal/tasks/dashboard?tab=household");
    await expect(b.getByRole("region", { name: /Needs attention/ }).getByRole("button", { name: `Shared bins ${suffix}`, exact: true })).toBeVisible();
    await expect(b.getByText(`Private dentist ${suffix}`)).toHaveCount(0);
    await b.goto("/portal/tasks/dashboard?tab=personal");
    await expect(b.getByText(`Private dentist ${suffix}`)).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
});

test("3. links a task to Knowledge and navigates both ways", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const spaces = ((await (await request.get("/api/portal/knowledge/spaces")).json()) as { spaces: { id: string; kind: string }[] }).spaces;
    const note = (
        (await post(request, `/api/portal/knowledge/spaces/${spaces.find((s) => s.kind === "personal")!.id}/objects`, {
            title: `Wedding plan ${info.project.name}`,
        })) as {
            object: { id: string };
        }
    ).object;
    const title = `Confirm catering ${info.project.name}`;
    await createTask(request, { title, knowledge: [note.id] });
    await page.goto(`/portal/knowledge/o/${note.id}`);
    const section = page.getByRole("region", { name: "Tasks" });
    await expect(section.getByRole("link", { name: new RegExp(title) })).toBeVisible();

    // Add another from the page: Quick Add offers the link; the list updates without a reload.
    await section.getByRole("button", { name: "Add task" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a task" });
    await expect(dialog.getByRole("switch", { name: `Link to “Wedding plan ${info.project.name}”` })).toBeChecked();
    await dialog.getByRole("textbox", { name: "Task name" }).fill(`Book transport ${info.project.name}`);
    await dialog.getByRole("textbox", { name: "Task name" }).press("Enter");
    await expect(section.getByRole("link", { name: new RegExp(`Book transport ${info.project.name}`) })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/portal/knowledge/o/${note.id}`));
    // The new section; the rest of the Knowledge page is covered by the Knowledge journeys.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const axe = await new AxeBuilder({ page }).include('[aria-labelledby="related-tasks"]').analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

    // To the task, and back to the note from its panel.
    await section.getByRole("link", { name: new RegExp(title) }).click();
    await expect(page).toHaveURL(/\/portal\/tasks\/t\//);
    await page
        .getByRole("dialog")
        .getByRole("link", { name: `Wedding plan ${info.project.name}` })
        .click();
    await expect(page).toHaveURL(new RegExp(`/portal/knowledge/o/${note.id}`));
    expect(errors).toEqual([]);
});

test("4. creates and completes a project review with a next action", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const today = await sydneyToday(page);
    const project = await createProject(request, { name: `Garden ${info.project.name}` });
    await createTask(request, { title: `Late quote ${info.project.name}`, projectId: project.id, dueDate: addDays(today, -2) });
    await page.goto(`/portal/tasks/p/${project.id}?view=overview`);
    await expect(page.getByRole("region", { name: "Health" })).toBeVisible();
    await expect(page.getByText("1 task overdue")).toBeVisible();
    await page.getByRole("button", { name: "Review project" }).click();
    const dialog = page.getByRole("dialog", { name: `Review: Garden ${info.project.name}` });
    await expect(dialog.getByRole("button", { name: `Late quote ${info.project.name}`, exact: true })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Review note" }).fill("Quote is late; chase it this week.");
    await dialog.getByRole("textbox", { name: "Add a next action" }).fill(`Chase the quote ${info.project.name}`);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog.getByRole("button", { name: `Chase the quote ${info.project.name}`, exact: true })).toBeVisible();
    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    await dialog.getByRole("button", { name: "Complete review" }).click();
    // The overview reloads with the review recorded.
    await expect(page.getByText(/last reviewed .* last note: “Quote is late/)).toBeVisible();
    await page.goto(`/portal/tasks/p/${project.id}`);
    await expect(page.getByRole("button", { name: `Chase the quote ${info.project.name}`, exact: true })).toBeVisible();
    expect(errors).toEqual([]);
});

test("5 and 6. creates a goal linked to a project and updates its progress", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const name = `Kitchen ${info.project.name}`;
    const project = await createProject(request, { name });
    await page.goto("/portal/tasks/goals");
    await page.getByRole("button", { name: "New goal" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New goal" });
    await dialog.getByRole("textbox", { name: "Goal" }).fill(`Renovation fund ${info.project.name}`);
    await dialog.getByText("A number I update").click();
    await dialog.getByRole("textbox", { name: "Unit" }).fill("$");
    await dialog
        .getByRole("spinbutton", { name: "Target" })
        .or(dialog.getByRole("textbox", { name: "Target" }))
        .first()
        .fill("8000");
    await dialog.getByRole("checkbox", { name }).check({ force: true });
    await dialog.getByRole("button", { name: "Create goal" }).click();
    await expect(page).toHaveURL(/\/portal\/tasks\/goals\/tgl_/);
    await expect(page.getByRole("heading", { name: `Renovation fund ${info.project.name}` })).toBeVisible();
    await expect(page.getByRole("region", { name: "Linked projects" }).getByRole("link", { name })).toBeVisible();
    await fits(page, "goal");

    const progress = page.getByRole("region", { name: "Progress" });
    await progress
        .getByRole("spinbutton", { name: /Now at/ })
        .or(progress.getByRole("textbox", { name: /Now at/ }))
        .first()
        .fill("2000");
    await progress.getByRole("textbox", { name: "Note" }).fill("First deposit");
    await progress.getByRole("button", { name: "Update" }).click();
    await expect(page.getByText("Progress recorded")).toBeVisible();
    await expect(progress.getByText(/25%/)).toBeVisible();
    await expect(page.getByRole("region", { name: "History" }).getByText(/First deposit/)).toBeVisible();
    // The project shows the goal too.
    await page.goto(`/portal/tasks/p/${project.id}?view=overview`);
    await expect(page.getByRole("link", { name: `Renovation fund ${info.project.name}` })).toBeVisible();
    expect(errors).toEqual([]);
});

test("7 and 8. creates a shared routine where people take turns, and completes it", async ({ page, request, browser }, info) => {
    const suffix = info.project.name;
    const { context, project } = await sharedWithPartner(request, browser, `Chores ${suffix}`);
    const title = `Put the bins out ${suffix}`;
    // Take turns between both members of the project: the signed-in owner, then the partner.
    const members = ((await (await request.get(`/api/portal/tasks/projects/${project.id}/members`)).json()) as { members: { email: string }[] }).members.map(
        (m) => m.email,
    );
    const owner = members.find((m) => m !== PARTNER)!;
    await post(request, "/api/portal/tasks/routines", {
        title,
        projectId: project.id,
        recurrence: { freq: "weekly", interval: 1, weekdays: [3] },
        rotation: "turns",
        participants: [owner, PARTNER],
        checklist: ["Recycling", "General waste"],
    });

    const errors = watchErrors(page);
    await page.goto("/portal/tasks/routines");
    const card = page
        .locator("li")
        .filter({ has: page.getByRole("button", { name: title, exact: true }) })
        .first();
    await expect(card).toBeVisible();
    await expect(card.getByText(/Taking turns/)).toBeVisible();
    await fits(page, "routines");
    await card.getByRole("button", { name: "Done", exact: true }).click();
    // It has a checklist: completing asks first.
    await page.getByRole("dialog", { name: "Complete the subtasks too?" }).getByRole("button", { name: "Complete all" }).click();
    await expect(page.getByText(/Done\. Next:/)).toBeVisible();
    await expect(card.getByText(/Last done/).locator("..")).toContainText(/ago|now|second|minute/);

    // B sees the routine, now their turn.
    const b = await context.newPage();
    await b.goto("/portal/tasks/routines");
    const theirs = b
        .locator("li")
        .filter({ has: b.getByRole("button", { name: title, exact: true }) })
        .first();
    await expect(theirs).toBeVisible();
    await expect(theirs.getByText("Responsible").locator("xpath=following-sibling::dd[1]")).toHaveText(new RegExp(`^${PARTNER.split("@")[0]}`));
    expect(errors).toEqual([]);
    await context.close();
});

test("9. shows a project's timeline", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const today = await sydneyToday(page);
    const project = await createProject(request, { name: `Move house ${info.project.name}`, startDate: today, targetDate: addDays(today, 30) });
    await createTask(request, { title: `Sign lease ${info.project.name}`, projectId: project.id, dueDate: addDays(today, 5), isMilestone: true });
    await page.goto(`/portal/tasks/p/${project.id}`);
    await page.getByRole("tab", { name: "Timeline" }).click();
    await expect(page.getByText("Project starts")).toBeVisible();
    await expect(page.getByRole("button", { name: `Sign lease ${info.project.name}` })).toBeVisible();
    await expect(page.getByText("Target date")).toBeVisible();
    await fits(page, "timeline");
    expect(errors).toEqual([]);
});

test("10. views personal and shared reports and downloads the CSV", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const done = await createTask(request, { title: `Reported ${info.project.name}` });
    await post(request, `/api/portal/tasks/tasks/${done.id}/complete`, { occurrence: null });
    await page.goto("/portal/tasks/reports?range=4w");
    await expect(page.getByRole("region", { name: /Completed by week/ })).toBeVisible();
    await fits(page, "reports");
    await page
        .getByRole("radio", { name: "Shared" })
        .or(page.getByRole("button", { name: "Shared", exact: true }))
        .first()
        .click();
    await expect(page.getByRole("region", { name: "Open work by person" })).toBeVisible();
    const csv = await request.get("/api/portal/tasks/reports/export?scope=personal&range=4w");
    expect(csv.ok()).toBe(true);
    expect(await csv.text()).toContain("section,key,label");
    expect(errors).toEqual([]);
});

test("11. keeps A's goals, routines and reports away from B", async ({ page, request, browser }, info) => {
    const suffix = info.project.name;
    const goal = (await post(request, "/api/portal/tasks/goals", { title: `Private goal ${suffix}` })) as { goal: { id: string } };
    await post(request, "/api/portal/tasks/routines", { title: `Private routine ${suffix}`, recurrence: { freq: "daily", interval: 1 } });
    const done = await createTask(request, { title: `Private win ${suffix}` });
    await post(request, `/api/portal/tasks/tasks/${done.id}/complete`, { occurrence: null });
    const context = await partner(browser, request);
    const b = await context.newPage();
    for (const path of [
        "/portal/tasks/goals",
        "/portal/tasks/routines",
        "/portal/tasks/reports",
        "/portal/tasks/reports?scope=shared",
        "/portal/tasks/dashboard",
        "/portal/tasks/workload?scope=shared",
    ]) {
        await b.goto(path);
        await expect(b.getByRole("main")).toBeVisible();
        for (const secret of [`Private goal ${suffix}`, `Private routine ${suffix}`, `Private win ${suffix}`]) await expect(b.getByText(secret)).toHaveCount(0);
    }
    expect((await b.goto(`/portal/tasks/goals/${goal.goal.id}`))?.status()).toBe(404);
    expect((await context.request.get(`/api/portal/tasks/goals/${goal.goal.id}`)).status()).toBe(404);
    await context.close();
    await page.goto("/portal/tasks/goals");
    await expect(page.getByRole("link", { name: `Private goal ${suffix}` })).toBeVisible();
});
