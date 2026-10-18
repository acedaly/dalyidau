import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

// Daly Intelligence in a real browser. The e2e Worker uses the deterministic stand-in for Workers AI
// (AI_PROVIDER=mock, development only), so these check the pages and flows, not a model.

const JSON_HEADERS = { Origin: "http://localhost:8787", "Content-Type": "application/json" };

const watchErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
    return errors;
};

/** Switches everything on (both projects share one database, so this is idempotent). */
const switchOn = async (request: APIRequestContext) => {
    const current = (await (await request.get("/api/portal/intelligence/settings")).json()) as { config: { features: Record<string, boolean> }; version: number };
    if (Object.values(current.config.features).every(Boolean)) return;
    const features = Object.fromEntries(Object.keys(current.config.features).map((k) => [k, true]));
    const saved = await request.put("/api/portal/intelligence/settings", { headers: JSON_HEADERS, data: { version: current.version, config: { ...current.config, features } } });
    expect(saved.ok(), await saved.text()).toBe(true);
};

test("every Intelligence page loads without errors, fits the screen and passes axe", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    await switchOn(request);
    const created = await request.post("/api/portal/intelligence/captures", {
        headers: JSON_HEADERS,
        data: { source: "text", text: `TODO: Layout check ${info.project.name}\nDecision: Keep it tidy.` },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const { captureId } = (await created.json()) as { captureId: string };
    for (const path of [
        "/portal/intelligence",
        "/portal/intelligence/inbox",
        "/portal/intelligence/inbox?filter=all",
        "/portal/intelligence/capture",
        `/portal/intelligence/captures/${captureId}`,
        "/portal/intelligence/briefing",
        "/portal/intelligence/briefing/weekly",
        "/portal/intelligence/meetings",
        "/portal/intelligence/settings",
    ]) {
        await page.goto(path);
        await expect(page.getByRole("main")).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, path).toBeLessThanOrEqual(0);
        const results = await new AxeBuilder({ page }).include("main").exclude("main p.bg-warning-primary").analyze();
        const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(serious.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.goto("/portal/intelligence");
    await page.screenshot({ path: `test-results/intelligence-overview-${info.project.name}.png`, fullPage: true });
    expect(errors).toEqual([]);
});

test("captures text, reviews the suggestions and approves a task into Tasks", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    await switchOn(request);
    const title = `Order the timber ${info.project.name}`;
    await page.goto("/portal/intelligence/capture");
    await page.getByLabel("What to capture").fill(`TODO: ${title}\nDecision: We will use the north corner.`);
    await page.getByRole("button", { name: "Capture and analyse" }).click();
    await expect(page).toHaveURL(/\/portal\/intelligence\/captures\/aic_/);
    await expect(page.getByText("Ready", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/intelligence-capture-${info.project.name}.png`, fullPage: true });

    // Approve the task: it appears in Tasks, and the suggestion links to it.
    const card = page.locator("li", { has: page.getByText(title, { exact: true }) });
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(card.getByText("Applied")).toBeVisible();
    await card.getByRole("link", { name: "Open task" }).click();
    await expect(page).toHaveURL(/\/portal\/tasks\/t\/tsk_/);
    await expect(page.getByText(title).first()).toBeVisible();
    expect(errors).toEqual([]);
});

test("the briefing separates facts from AI suggestions and says what it didn't check", async ({ page, request }) => {
    await switchOn(request);
    await page.goto("/portal/intelligence/briefing");
    await expect(page.getByText("AI suggestions, not facts")).toBeVisible();
    await expect(page.getByText(/Not checked: email, calendar/)).toBeVisible();
});
