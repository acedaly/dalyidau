import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Browser, type Page, expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Daly Tasks in a real browser. The e2e Worker acts as e2e-owner@example.com (User A); a browser
// context with the portal_dev_identity=alt cookie acts as e2e-partner@example.com (User B), which
// works only in local development (worker/portal/auth.ts). Both projects (desktop, mobile) share
// one database, so every title includes the project name. All data is invented.

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

interface Task {
    id: string;
    version: number;
    title: string;
    dueDate: string | null;
}
const createTask = async (request: APIRequestContext, data: Record<string, unknown>) =>
    ((await post(request, "/api/portal/tasks/tasks", data)) as { task: Task }).task;
const createProject = async (request: APIRequestContext, data: Record<string, unknown>) =>
    ((await post(request, "/api/portal/tasks/projects", data)) as { project: { id: string } }).project;

/** User B, as a portal admin (so B can open Tasks), in a browser context of its own. */
const partner = async (browser: Browser, request: APIRequestContext) => {
    const added = await request.post("/api/portal/users", { headers: JSON_HEADERS, data: { email: PARTNER, role: "admin" } });
    // Already added by an earlier test (or the other project) is fine.
    expect(added.ok() || added.status() === 409 || added.status() === 422, await added.text()).toBe(true);
    const context = await browser.newContext({ ...test.info().project.use });
    await context.addCookies([{ name: "portal_dev_identity", value: "alt", url: BASE }]);
    return context;
};

/** The completion circle's visible label (the input itself is visually hidden), so the click waits for overlays to clear. */
const circle = (scope: Page | ReturnType<Page["locator"]>, page: Page, name: string) =>
    scope.locator("label").filter({ has: page.getByRole("checkbox", { name, exact: true }) });

const row = (page: Page, title: string) => page.locator("li[data-task-id]").filter({ has: page.getByRole("button", { name: title, exact: true }) });

test("every Tasks page loads without errors, fits the screen and passes axe", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const project = await createProject(request, { name: `Layout ${info.project.name}`, sections: ["One", "Two"] });
    const task = await createTask(request, {
        title: `Layout task ${info.project.name}`,
        projectId: project.id,
        dueDate: null,
        labels: ["layout"],
        priority: 1,
    });
    await createTask(request, { title: `Layout child ${info.project.name}`, parentId: task.id });
    for (const path of [
        "/portal",
        "/portal/tasks",
        "/portal/tasks/inbox",
        "/portal/tasks/upcoming",
        "/portal/tasks/overdue",
        "/portal/tasks/completed",
        "/portal/tasks/projects",
        "/portal/tasks/projects?kind=shared",
        `/portal/tasks/p/${project.id}`,
        `/portal/tasks/p/${project.id}?view=board`,
        `/portal/tasks/p/${project.id}?view=overview`,
        "/portal/tasks/labels",
        "/portal/tasks/filters?labels=layout",
        "/portal/tasks/search?q=layout",
        "/portal/tasks/activity",
        "/portal/tasks/settings",
        `/portal/tasks/t/${task.id}`,
    ]) {
        await page.goto(path);
        await expect(page.getByRole("main")).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, path).toBeLessThanOrEqual(0);
        const results = await new AxeBuilder({ page }).include("main").exclude("main p.bg-warning-primary").analyze();
        const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(serious.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    // The task link opens its panel, and the panel passes axe too.
    await expect(page.getByRole("dialog").getByRole("textbox", { name: "Task name" })).toHaveValue(`Layout task ${info.project.name}`);
    const panel = await new AxeBuilder({ page }).include("[role=dialog]").analyze();
    expect(panel.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    expect(errors).toEqual([]);
});

test("A. captures with Quick Add, edits in the panel and completes from the Inbox", async ({ page }, info) => {
    const errors = watchErrors(page);
    const title = `Renew passport ${info.project.name}`;
    await page.goto("/portal/tasks/inbox");
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

    // Quick Add from the keyboard (desktop) or the button (both).
    if (info.project.name === "desktop") await page.keyboard.press("q");
    else await page.getByRole("button", { name: "Add task" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add a task" });
    await dialog.getByRole("textbox", { name: "Task name" }).fill(`${title} tomorrow p2 @admin`);
    // What was understood is shown before saving.
    await expect(dialog.getByText("Due: Tomorrow")).toBeVisible();
    await expect(dialog.getByText("Priority: P2 High")).toBeVisible();
    await expect(dialog.getByText("Label: admin")).toBeVisible();
    await dialog.getByRole("textbox", { name: "Task name" }).press("Enter");
    await expect(dialog).toBeHidden();

    const added = row(page, title);
    await expect(added).toBeVisible();
    await expect(added.getByText("Tomorrow")).toBeVisible();
    await expect(added.getByText("P2")).toBeVisible();

    // Edit in the panel: description and priority save on their own.
    await added.getByRole("button", { name: title, exact: true }).click();
    const panel = page.getByRole("dialog").filter({ has: page.getByRole("textbox", { name: "Task name" }) });
    await panel.getByRole("textbox", { name: "Description" }).fill("Bring the old passport and two photos");
    await panel.getByRole("textbox", { name: "Task name" }).click();
    await expect(panel.getByText("Saving…")).toBeHidden({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(added.getByText("Bring the old passport")).toBeVisible();

    // Complete: it leaves the Inbox, and Undo is offered.
    await circle(added, page, `Complete “${title}”`).click();
    await expect(page.getByText("Task completed")).toBeVisible();
    await expect(row(page, title)).toBeHidden();
    await page.goto("/portal/tasks/completed");
    await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible();
    expect(errors).toEqual([]);
});

test("A. keeps what was typed if saving fails", async ({ page }, info) => {
    await page.goto("/portal/tasks/inbox");
    await page.getByRole("button", { name: "Add task" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add a task" });
    const text = `Offline task ${info.project.name}`;
    await dialog.getByRole("textbox", { name: "Task name" }).fill(text);
    await page.route("**/api/portal/tasks/tasks", (route) => route.abort());
    await dialog.getByRole("button", { name: "Add task" }).click();
    await expect(dialog.getByText("Couldn't reach the server")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Task name" })).toHaveValue(text);
    await page.unroute("**/api/portal/tasks/tasks");
    await dialog.getByRole("button", { name: "Add task" }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, text)).toBeVisible();
});

test("B. Today follows the date as it changes", async ({ page, request }, info) => {
    const today = await page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date()));
    const title = `Call the bank ${info.project.name}`;
    await createTask(request, { title, dueDate: today });
    await page.goto("/portal/tasks/today");
    const task = row(page, title);
    await expect(task).toBeVisible();
    await task.getByRole("button", { name: `Actions for “${title}”` }).click();
    await page.getByRole("menuitem", { name: "Due tomorrow" }).click();
    await expect(row(page, title)).toBeHidden();
    await page.goto("/portal/tasks/upcoming");
    await expect(row(page, title)).toBeVisible();
});

test("C. plans a project with sections, ordering and progress", async ({ page }, info) => {
    const errors = watchErrors(page);
    const name = `Holiday ${info.project.name}`;
    await page.goto("/portal/tasks/projects");
    await page.getByRole("button", { name: "New project" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.getByRole("textbox", { name: "Name" }).fill(name);
    await dialog.getByRole("textbox", { name: "Sections" }).fill("Bookings\nPacking");
    await dialog.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

    const bookings = page.getByRole("region", { name: "Bookings" });
    for (const t of ["Book flights", "Book hotel"]) {
        await bookings.getByRole("button", { name: "Add task" }).click();
        await bookings.getByRole("textbox", { name: "Task name" }).fill(`${t} ${info.project.name}`);
        await bookings.getByRole("textbox", { name: "Task name" }).press("Enter");
        await expect(row(page, `${t} ${info.project.name}`)).toBeVisible();
        await bookings.getByRole("button", { name: "Cancel" }).click();
    }
    // Reorder with the menu (the keyboard alternative to dragging).
    const hotel = `Book hotel ${info.project.name}`;
    await row(page, hotel)
        .getByRole("button", { name: `Actions for “${hotel}”` })
        .click();
    await page.getByRole("menuitem", { name: "Move up" }).click();
    await expect(bookings.locator("li[data-task-id]").first()).toContainText(hotel);
    await page.reload();
    await expect(page.getByRole("region", { name: "Bookings" }).locator("li[data-task-id]").first()).toContainText(hotel);

    await circle(row(page, hotel), page, `Complete “${hotel}”`).click();
    await expect(page.getByText("1 of 2 done")).toBeVisible();

    // Board: move a card to another column from its menu.
    await page.getByRole("tab", { name: "Board" }).click();
    const flights = `Book flights ${info.project.name}`;
    await page.getByRole("button", { name: `Move “${flights}”` }).click();
    await page.getByRole("menuitem", { name: "Packing" }).click();
    await expect(page.getByRole("listitem", { name: "Packing" }).getByText(flights)).toBeVisible();
    expect(errors).toEqual([]);
});

test("D. subtasks complete on their own, and completing the parent asks first", async ({ page, request }, info) => {
    const parent = await createTask(request, { title: `Prepare for camping ${info.project.name}` });
    await page.goto(`/portal/tasks/t/${parent.id}`);
    const panel = page.getByRole("dialog").filter({ has: page.getByRole("textbox", { name: "Task name" }) });
    for (const child of ["Tent", "Stove"]) {
        await panel.getByRole("button", { name: "Add subtask" }).click();
        await panel.getByRole("textbox", { name: "Task name" }).last().fill(`${child} ${info.project.name}`);
        await panel.getByRole("textbox", { name: "Task name" }).last().press("Enter");
        await expect(panel.getByRole("button", { name: `${child} ${info.project.name}`, exact: true })).toBeVisible();
        await panel.getByRole("button", { name: "Cancel" }).click();
    }
    await circle(panel, page, `Complete “Tent ${info.project.name}”`).click();
    await expect(panel.getByRole("heading", { name: "Subtasks (1/2)" })).toBeVisible();
    await panel.getByRole("button", { name: "Complete", exact: true }).click();
    const ask = page.getByRole("dialog", { name: "Complete the subtasks too?" });
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Complete all" }).click();
    await expect(panel.getByRole("button", { name: "Reopen" })).toBeVisible();
});

test("E. completes a weekly repeat and moves to the next occurrence", async ({ page }, info) => {
    const title = `Take bins out ${info.project.name}`;
    await page.goto("/portal/tasks/inbox");
    await page.getByRole("button", { name: "Add task" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add a task" });
    await dialog.getByRole("textbox", { name: "Task name" }).fill(`${title} every wednesday`);
    await expect(dialog.getByText(/Repeats: Every week on Wed/)).toBeVisible();
    await dialog.getByRole("textbox", { name: "Task name" }).press("Enter");
    const task = row(page, title);
    await expect(task.getByText("Every week on Wed", { exact: false })).toHaveCount(1);
    await circle(task, page, `Complete “${title}”`).click();
    await expect(page.getByText(/Done\. Next:/)).toBeVisible();
    await expect(row(page, title)).toBeVisible();
    await row(page, title).getByRole("button", { name: title, exact: true }).click();
    const panel = page.getByRole("dialog").filter({ has: page.getByRole("textbox", { name: "Task name" }) });
    await expect(panel.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(panel.getByText(/Completed .* → next/)).toBeVisible();
});

test("F and G. shares a project with B and keeps A's private tasks private", async ({ page, request, browser }, info) => {
    const suffix = info.project.name;
    const context = await partner(browser, request);
    const shared = await createProject(request, { name: `Household ${suffix}`, kind: "shared" });
    await post(request, `/api/portal/tasks/projects/${shared.id}/members`, { email: PARTNER, role: "editor" });
    await createTask(request, { title: `Mow the lawn ${suffix}`, projectId: shared.id, assignee: PARTNER });
    const secret = await createTask(request, { title: `Anniversary gift ${suffix}`, description: "Engraved watch" });

    const b = await context.newPage();
    const errors = watchErrors(b);
    // B sees the shared project and the task assigned to them, and can edit it.
    await b.goto("/portal/tasks/projects?kind=shared");
    await b
        .getByRole("link", { name: `Household ${suffix}` })
        .first()
        .click();
    const mow = row(b, `Mow the lawn ${suffix}`);
    await expect(mow).toBeVisible();
    await circle(mow, b, `Complete “Mow the lawn ${suffix}”`).click();
    await expect(b.getByText("Task completed")).toBeVisible();

    // B can't reach A's private task by link, list, search or API.
    const page404 = await b.goto(`/portal/tasks/t/${secret.id}`);
    expect(page404?.status()).toBe(404);
    await b.goto(`/portal/tasks/search?q=${encodeURIComponent("Anniversary")}`);
    await expect(b.getByText(`Anniversary gift ${suffix}`)).toHaveCount(0);
    await b.goto("/portal/tasks/inbox");
    await expect(b.getByText(`Anniversary gift ${suffix}`)).toHaveCount(0);
    const api = await context.request.get(`/api/portal/tasks/tasks/${secret.id}`);
    expect(api.status()).toBe(404);
    expect(await api.text()).not.toContain("Engraved");
    const exported = await context.request.get("/api/portal/tasks/export");
    expect(await exported.text()).not.toContain("Anniversary");

    // A sees B's completion in the project.
    await page.goto(`/portal/tasks/p/${shared.id}`);
    await expect(page.getByText("1 of 1 done")).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
});

test("H. links Knowledge, and hides it from someone without access", async ({ page, request, browser }, info) => {
    const suffix = info.project.name;
    const spaces = ((await (await request.get("/api/portal/knowledge/spaces")).json()) as { spaces: { id: string; kind: string }[] }).spaces;
    const note = (
        (await post(request, `/api/portal/knowledge/spaces/${spaces.find((s) => s.kind === "personal")!.id}/objects`, {
            title: `Venue shortlist ${suffix}`,
        })) as { object: { id: string } }
    ).object;
    const context = await partner(browser, request);
    const shared = await createProject(request, { name: `Wedding ${suffix}`, kind: "shared" });
    await post(request, `/api/portal/tasks/projects/${shared.id}/members`, { email: PARTNER, role: "editor" });
    const task = await createTask(request, { title: `Confirm venue ${suffix}`, projectId: shared.id });

    await page.goto(`/portal/tasks/t/${task.id}`);
    const panel = page.getByRole("dialog").filter({ has: page.getByRole("textbox", { name: "Task name" }) });
    await panel.getByRole("button", { name: "Link", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Link Knowledge" });
    await picker
        .getByRole("searchbox")
        .or(picker.getByRole("textbox", { name: "Search Knowledge" }))
        .fill(`Venue shortlist ${suffix}`);
    await picker.getByRole("button", { name: `Venue shortlist ${suffix}` }).click();
    const link = panel.getByRole("link", { name: new RegExp(`Venue shortlist ${suffix}`) });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/portal/knowledge/o/${note.id}`));

    // B is in the project but not in A's Knowledge space: the reference exists, the title doesn't.
    const b = await context.newPage();
    await b.goto(`/portal/tasks/t/${task.id}`);
    await expect(b.getByText("A Knowledge item you don't have access to")).toBeVisible();
    await expect(b.getByText(`Venue shortlist ${suffix}`)).toHaveCount(0);
    const detail = await (await context.request.get(`/api/portal/tasks/tasks/${task.id}`)).text();
    expect(detail).not.toContain("Venue shortlist");
    expect(detail).not.toContain(note.id);
    await context.close();
});

test("I. exports projects, tasks, subtasks and labels with their relationships", async ({ page, request }, info) => {
    const suffix = info.project.name;
    const project = await createProject(request, { name: `Export ${suffix}`, sections: ["Stage 1"] });
    const parent = await createTask(request, { title: `Export parent ${suffix}`, projectId: project.id, labels: ["exported"] });
    await createTask(request, { title: `Export child ${suffix}`, parentId: parent.id });
    await page.goto("/portal/tasks/settings");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Everything (JSON)" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^daly-tasks-\d{4}-\d{2}-\d{2}\.json$/);
    const data = JSON.parse(await readFile((await download.path())!, "utf8")) as {
        format: string;
        version: number;
        projects: { id: string; name: string; sections: { name: string }[] }[];
        tasks: { id: string; title: string; parentId: string | null; projectId: string; labels: string[] }[];
    };
    expect(data).toMatchObject({ format: "daly.tasks", version: 1 });
    const exported = data.projects.find((p) => p.id === project.id)!;
    expect(exported.sections.map((s) => s.name)).toEqual(["Stage 1"]);
    const child = data.tasks.find((t) => t.title === `Export child ${suffix}`)!;
    const exportedParent = data.tasks.find((t) => t.id === child.parentId)!;
    expect(exportedParent).toMatchObject({ title: `Export parent ${suffix}`, projectId: project.id, labels: ["exported"] });

    const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Everything (CSV)" }).click()]);
    const text = await readFile((await csv.path())!, "utf8");
    expect(text).toContain(`Export child ${suffix}`);
});
