import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { PNG } from "pngjs";

// Home & Assets (Milestone 10) in a real browser, desktop and Pixel 7: every page fits the screen
// and passes accessibility checks; Quick add needs only a name and a category; completing scheduled
// maintenance moves the schedule on; photos upload from the dropzone; a scanned (typed) label opens
// its asset; Today shows what's due. Both projects share one database, so names carry the project.
// AI is off here (its switch defaults off), so every flow is the by-hand one.

const BASE = "http://localhost:8787";
const JSON_HEADERS = { Origin: BASE, "Content-Type": "application/json" };
const A = `${BASE}/api/portal/assets`;

const send = async (request: APIRequestContext, method: "post" | "put" | "patch", path: string, data: unknown) => {
    const response = await request[method](path, { headers: JSON_HEADERS, data });
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
    return response.json();
};
const watchErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
    return errors;
};
const fits = async (page: Page, label: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
    const results = await new AxeBuilder({ page }).include("main").exclude("main p.bg-warning-primary").analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};
const sydneyToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
const plus = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** A small real PNG (a coloured square), for the photo upload. */
const png = () => {
    const image = new PNG({ width: 64, height: 48 });
    for (let i = 0; i < image.data.length; i += 4) image.data.set([40, 120, 200, 255], i);
    return PNG.sync.write(image);
};

/** Places, assets, a policy and a warranty. With `service`, an overdue service schedule too (kept out of other tests so Today isn't crowded). */
async function seed(request: APIRequestContext, project: string, service = false) {
    const place = await send(request, "post", `${A}/locations`, { name: `Garage (${project})`, kind: "garage" });
    const camper = await send(request, "post", `${A}/items`, {
        name: `Cub Camper Frontier (${project})`,
        category: "trailers",
        locationId: place.location.id,
        vehicle: { kind: "trailer", registrationExpiry: plus(sydneyToday(), 21), atmKg: 1900, specs: { brakeSystem: "Electric" } },
    });
    const hilux = await send(request, "post", `${A}/items`, { name: `Toyota Hilux (${project})`, category: "vehicles", purchasePriceCents: 3000000 });
    const schedule = service
        ? await send(request, "post", `${A}/schedules`, {
              assetId: hilux.asset.id,
              title: "Service",
              category: "service",
              intervalCount: 6,
              intervalUnit: "months",
              lastDoneOn: plus(sydneyToday(), -200),
              templateId: "vehicle-service",
          })
        : null;
    const policy = await send(request, "post", `${A}/policies`, {
        provider: "Example Insurance",
        policyType: "caravan_trailer",
        renewsOn: plus(sydneyToday(), 40),
    });
    await send(request, "post", `${A}/policies/${policy.policy.id}/assets`, { assetId: camper.asset.id });
    await send(request, "post", `${A}/items/${camper.asset.id}/warranties`, { kind: "manufacturer", months: 24, startsOn: plus(sydneyToday(), -700) });
    return {
        place: place.location.id as string,
        camper: camper.asset.id as string,
        hilux: hilux.asset.id as string,
        service: (schedule?.schedule.id ?? "") as string,
        policy: policy.policy.id as string,
    };
}

test("every Home & Assets page loads without errors, fits the screen and passes axe", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const s = await seed(request, info.project.name, true);
    for (const path of [
        "/portal/assets",
        "/portal/assets/all",
        "/portal/assets/vehicles",
        "/portal/assets/property",
        `/portal/assets/property/${s.place}`,
        "/portal/assets/maintenance",
        "/portal/assets/maintenance?view=schedules",
        "/portal/assets/maintenance?view=templates",
        "/portal/assets/insurance",
        `/portal/assets/insurance?policy=${s.policy}`,
        "/portal/assets/warranties",
        "/portal/assets/documents",
        "/portal/assets/reports",
        "/portal/assets/reports/register",
        `/portal/assets/reports/register?kind=claim&assets=${s.camper}`,
        "/portal/assets/settings",
        "/portal/assets/capture?mode=receipt",
        "/portal/assets/capture?mode=scan",
        "/portal/assets/labels",
        "/portal/assets/search?q=camper",
        `/portal/assets/item/${s.camper}`,
        `/portal/assets/item/${s.camper}?tab=maintenance`,
        `/portal/assets/item/${s.camper}?tab=documents`,
        `/portal/assets/item/${s.camper}?tab=cover`,
        `/portal/assets/item/${s.camper}?tab=value`,
        `/portal/assets/item/${s.camper}?tab=history`,
    ]) {
        await page.goto(path);
        await expect(page.getByRole("main")).toBeVisible();
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        await fits(page, path);
    }
    await page.goto("/portal/assets");
    await page.screenshot({ path: `test-results/assets-overview-${info.project.name}.png`, fullPage: true });
    await page.goto(`/portal/assets/item/${s.camper}`);
    await page.screenshot({ path: `test-results/assets-item-${info.project.name}.png`, fullPage: true });
    expect(errors).toEqual([]);
});

test("the launcher leads to Home & Assets, and Quick add needs only a name and a category", async ({ page }, info) => {
    await page.goto("/portal");
    await page.locator('[data-application="assets"]').click();
    await expect(page).toHaveURL(/\/portal\/assets$/);
    await page.getByRole("link", { name: "Add asset" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add an asset" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name").fill(`Cordless drill (${info.project.name})`);
    await dialog.getByLabel("Category").selectOption("tools");
    await dialog.getByRole("button", { name: "Add asset" }).click();
    await expect(page).toHaveURL(/\/portal\/assets\/item\/ast_[a-z0-9]{14}/);
    await expect(page.getByRole("heading", { level: 1, name: `Cordless drill (${info.project.name})` })).toBeVisible();
    // Nothing invented: unrecorded values say so.
    await expect(page.getByText("Not recorded").first()).toBeVisible();
});

test("completing scheduled maintenance moves the schedule on and adds the next one", async ({ page, request }, info) => {
    const s = await seed(request, `${info.project.name}-maint`, true);
    await page.goto(`/portal/assets/item/${s.hilux}?tab=maintenance`);
    await expect(page.getByText("Overdue").first()).toBeVisible();
    // Make the open record for the schedule, then complete it in the browser.
    await send(request, "post", `${A}/maintenance`, { assetId: s.hilux, scheduleId: s.service, title: "Service" });
    await page.reload();
    const todo = page.locator("section").filter({ has: page.getByRole("heading", { name: "To do", exact: true }) });
    await todo.getByRole("button", { name: "Done" }).first().click();
    const dialog = page.getByRole("dialog", { name: /^Complete:/ });
    await dialog.getByLabel("Odometer").fill("150000");
    await dialog.getByRole("button", { name: "Mark as done" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/last done/).first()).toBeVisible();
    const detail = await (await request.get(`${A}/items/${s.hilux}`)).json();
    expect(detail.detail.schedules[0].lastDoneOn).toBe(sydneyToday());
    expect(detail.detail.schedules[0].openRecordId).toMatch(/^amr_/);
});

test("photos upload from the dropzone and show in the gallery", async ({ page, request }, info) => {
    const s = await seed(request, `${info.project.name}-photo`);
    await page.goto(`/portal/assets/item/${s.camper}?tab=documents`);
    await page.locator('input[type="file"]').first().setInputFiles({ name: "camper.png", mimeType: "image/png", buffer: png() });
    await expect(page.getByRole("img", { name: /photo of Cub Camper/i }).first()).toBeVisible();
    const detail = await (await request.get(`${A}/items/${s.camper}`)).json();
    const photo = detail.detail.files.find((f: { kind: string }) => f.kind === "photo");
    // Re-encoded in the browser as JPEG, with a preview.
    expect(photo).toMatchObject({ contentType: "image/jpeg", hasThumb: true });
});

test("a scanned label's address opens its asset, and other addresses are never followed", async ({ page, request }, info) => {
    const s = await seed(request, `${info.project.name}-scan`);
    await page.goto("/portal/assets/capture?mode=scan");
    await page.getByLabel("Or type a code").fill("https://example.com/portal/assets/item/ast_abcdefghjkmnpq");
    await page.getByRole("button", { name: "Find" }).click();
    await expect(page.getByText("Not a Home & Assets label")).toBeVisible();
    await expect(page).toHaveURL(/capture\?mode=scan/);
    // On a phone the toast sits over the form, and pausing on hover keeps it there: dismiss it.
    await page.getByRole("button", { name: "Dismiss" }).click();
    await page.getByLabel("Or type a code").fill(`${BASE}/portal/assets/item/${s.camper}?v=1`);
    await page.getByRole("button", { name: "Find" }).click();
    await expect(page).toHaveURL(new RegExp(`/portal/assets/item/${s.camper}`));
    await expect(page.getByRole("heading", { level: 1, name: /Cub Camper Frontier/ })).toBeVisible();
});

test("Today shows Home & Assets dates", async ({ page, request }, info) => {
    await seed(request, `${info.project.name}-today`);
    // Room for every seeded item: other tests in this shared database add their own.
    const prefs = await (await request.get(`${A}/preferences`)).json();
    await send(request, "put", `${A}/preferences`, {
        version: prefs.version,
        preferences: { ...prefs.preferences, today: { enabled: true, horizonDays: 30, maxItems: 10 } },
    });
    await page.goto("/portal/today");
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Home & Assets", exact: true }) });
    await expect(section.getByText(/Cub Camper Frontier \(.+\) registration is due in 21 days\./).first()).toBeVisible();
    // Daly Tasks is retired: nothing offers to make a task from it.
    await expect(section.getByText(/Task/)).toHaveCount(0);
});
