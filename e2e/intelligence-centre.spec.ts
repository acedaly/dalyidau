import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

// The Intelligence Centre and Wallboard Mode in a real browser. The e2e Worker reads the INVENTED
// fixtures served by scripts/mock-feeds.mjs (CENTRE_FEED_BASE, development only), never a real
// provider, so every record here is marked "Recorded fixture data, not live". Both projects share
// one database: setup is idempotent, and the wallboard switch is turned back off at the end.

const JSON_HEADERS = { Origin: "http://localhost:8787", "Content-Type": "application/json" };
const SOURCES = [
    "rfs-incidents",
    "rfs-fire-danger",
    "rfs-incident-alerts",
    "bom-warnings",
    "bom-observations",
    "dea-hotspots",
    "endeavour-outages",
    "ga-earthquakes",
    "noaa-space-weather",
    "tfnsw-live-traffic",
];

const watchErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
    return errors;
};

async function collectFixtures(request: APIRequestContext) {
    const { sources } = (await (await request.get("/api/portal/centre/sources")).json()) as { sources: { source: { id: string }; status: string }[] };
    for (const id of SOURCES) {
        if (sources.find((s) => s.source.id === id)?.status === "active") continue;
        expect((await request.put(`/api/portal/centre/sources/${id}`, { headers: JSON_HEADERS, data: { enabled: true } })).ok()).toBe(true);
        const refreshed = await request.post(`/api/portal/centre/sources/${id}/refresh`, { headers: JSON_HEADERS, data: {} });
        expect(refreshed.ok(), `${id}: ${await refreshed.text()}`).toBe(true);
    }
}

const switchWallboards = (request: APIRequestContext, enabled: boolean) =>
    request.put("/api/portal/flags/intelligence_centre.wallboard", { headers: JSON_HEADERS, data: { enabled } });

test("every Intelligence Centre page loads without errors, fits the screen, passes axe and labels fixture data", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    await collectFixtures(request);
    for (const path of [
        "/portal/intelligence-centre",
        "/portal/intelligence-centre/map",
        "/portal/intelligence-centre/records",
        "/portal/intelligence-centre/records?minLevel=2",
        "/portal/intelligence-centre/hazards/weather",
        "/portal/intelligence-centre/hazards/fire-danger",
        "/portal/intelligence-centre/hazards/flood",
        "/portal/intelligence-centre/hazards/transport",
        "/portal/intelligence-centre/hazards/environment",
        "/portal/intelligence-centre/hazards/infrastructure",
        "/portal/intelligence-centre/history",
        "/portal/intelligence-centre/briefings",
        "/portal/intelligence-centre/watches",
        "/portal/intelligence-centre/wallboards",
        "/portal/intelligence-centre/sources",
        "/portal/intelligence-centre/settings",
    ]) {
        await page.goto(path);
        await expect(page.getByRole("main")).toBeVisible();
        await expect(page.getByText("Recorded fixture data, not live")).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, path).toBeLessThanOrEqual(0);
        // The map canvas is MapLibre's own (its accessibility is the list beside it).
        const results = await new AxeBuilder({ page }).include("main").exclude("main p.bg-warning-primary").exclude(".maplibregl-map").analyze();
        const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(serious.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.goto("/portal/intelligence-centre");
    await page.screenshot({ path: `test-results/centre-overview-${info.project.name}.png`, fullPage: true });
    expect(errors).toEqual([]);
});

test("the live map draws records, layers can be switched, and the list is the accessible alternative", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    await collectFixtures(request);
    await page.goto("/portal/intelligence-centre/map");
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible({ timeout: 15_000 });
    const box = await page.locator(".maplibregl-map").boundingBox();
    expect(box!.height).toBeGreaterThan(200);
    const list = page.getByRole("list", { name: "Records on the map" });
    await expect(list.getByRole("link", { name: "Example Ridge Rd, Exampleville", exact: true })).toBeVisible();
    const before = await list.getByRole("listitem").count();
    // Untitled UI checkboxes hide the native input under the styled box: click the label, as a person would.
    await page.getByText("Satellite thermal detections", { exact: true }).click();
    await expect.poll(() => list.getByRole("listitem").count()).toBeLessThan(before);
    await page.getByText("Satellite thermal detections", { exact: true }).click();
    // Search, then open the record.
    await page.getByLabel("Search").fill("Example Ridge");
    await list.getByRole("link", { name: "Example Ridge Rd, Exampleville", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Example Ridge Rd, Exampleville" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Official source" })).toBeVisible();
    await expect(page.getByText("© State of New South Wales (NSW Rural Fire Service)").first()).toBeVisible();
    await page.screenshot({ path: `test-results/centre-record-${info.project.name}.png`, fullPage: true });
    expect(errors).toEqual([]);
});

test("adds a private watch area with the keyboard and sees what concerns it", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    await collectFixtures(request);
    const name = `Example home ${info.project.name}`;
    await page.goto("/portal/intelligence-centre/watches");
    await page.getByRole("button", { name: "Add a watch area" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: /^Name/ }).fill(name);
    await dialog.getByLabel("Latitude").fill("-33.6");
    await dialog.getByLabel("Longitude").fill("150.6");
    await dialog.getByLabel("Radius (km)").fill("25");
    await dialog.getByRole("textbox", { name: /^Name/ }).press("Enter");
    await expect(page.getByRole("link", { name })).toBeVisible();
    await page.getByRole("link", { name }).click();
    await expect(page.getByRole("link", { name: "Example Ridge Rd, Exampleville", exact: true })).toBeVisible();
    await expect(page.getByText("The published area covers this place").first()).toBeVisible();
    // Clean up so the other project starts from the same state.
    const { watches } = (await (await request.get("/api/portal/centre/watches")).json()) as { watches: { id: string; name: string }[] };
    for (const w of watches.filter((x) => x.name === name))
        await request.delete(`/api/portal/centre/watches/${w.id}`, { headers: { Origin: "http://localhost:8787" } });
    expect(errors).toEqual([]);
});

test.describe("Wallboard Mode", () => {
    test.afterAll(async ({ request }) => {
        await switchWallboards(request, false);
    });

    test("shows the board full screen at 1080p, rotates and pauses, warns when stale, and stops when revoked", async ({ browser, request }, info) => {
        test.skip(info.project.name !== "desktop", "A wallboard is a large screen; checked once");
        await collectFixtures(request);
        expect((await switchWallboards(request, true)).ok()).toBe(true);
        const watch = await (
            await request.post("/api/portal/centre/watches", {
                headers: JSON_HEADERS,
                data: {
                    name: "Board area",
                    definition: { kind: "point", lat: -33.6, lon: 150.6, radiusKm: 30, placeName: "" },
                    fireDistrict: "Example Ranges",
                },
            })
        ).json();
        const board = await (
            await request.post("/api/portal/centre/wallboards", {
                headers: JSON_HEADERS,
                data: { name: "E2E screen", layout: "local", watchId: watch.watch.id, rotation: ["local", "weather"], rotationSeconds: 20, refreshSeconds: 30 },
            })
        ).json();
        const issued = (await (
            await request.post(`/api/portal/centre/wallboards/${board.wallboard.id}/displays`, { headers: JSON_HEADERS, data: { label: "E2E TV" } })
        ).json()) as { token: string; id: string; path: string };

        // A separate, signed-out browser context: the display has only its credential.
        const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, extraHTTPHeaders: {} });
        const page = await context.newPage();
        const errors = watchErrors(page);
        await page.clock.install();
        await page.goto(`/display#t=${issued.token}`);
        await expect(page.getByRole("heading", { level: 1, name: "E2E screen" })).toBeVisible();
        await expect(page.getByText("Local Situation · view 1 of 2")).toBeVisible();
        await expect(page.getByText("Warnings and incidents here")).toBeVisible();
        await expect(page.getByText("Official", { exact: true }).first()).toBeVisible();
        await expect(page.getByText("Observed", { exact: true }).first()).toBeVisible();
        await expect(page.getByText("not an official warning service and not guaranteed real-time", { exact: false })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        const axe = await new AxeBuilder({ page }).exclude(".maplibregl-map").analyze();
        expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
        await page.screenshot({ path: "test-results/centre-wallboard-1080p.png" });

        // Rotation, and pausing it with the keyboard.
        await page.clock.runFor(21_000);
        await expect(page.getByText("Weather & Environment · view 2 of 2")).toBeVisible();
        await page.keyboard.press("Space");
        await expect(page.getByRole("button", { name: "Resume rotation" })).toBeVisible();
        await page.clock.runFor(45_000);
        await expect(page.getByText("Weather & Environment · view 2 of 2")).toBeVisible();

        // The display schedules its next refresh only once the previous request settles, and requests
        // take real time while the page clock is fake, so a refresh may still be in flight when the
        // clock jumps. Advance one refresh at a time until the screen reacts. The 3 s limit keeps the
        // total jump under the 3-minute "no update" threshold, so the offline warning below can only
        // come from the failed refreshes themselves.
        const afterRefreshes = (ms: number, check: () => Promise<void>) =>
            expect(async () => {
                await page.clock.runFor(ms);
                await check();
            }).toPass({ timeout: 3_000, intervals: [100] });

        // Losing the connection: the last data stays, with a prominent warning; reconnecting clears it.
        await page.route("**/api/display/wallboard", (route) => route.abort());
        await afterRefreshes(31_000, () => expect(page.getByRole("alert").filter({ hasText: "Not updating" })).toBeVisible({ timeout: 500 }));
        await expect(page.getByRole("heading", { level: 1, name: "E2E screen" })).toBeVisible();
        await page.unroute("**/api/display/wallboard");
        await afterRefreshes(60_000, () => expect(page.getByRole("alert").filter({ hasText: "Not updating" })).toHaveCount(0, { timeout: 500 }));

        // 4K: the same layout scales up.
        await page.setViewportSize({ width: 3840, height: 2160 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        await page.screenshot({ path: "test-results/centre-wallboard-4k.png" });

        // Revoked: the screen says so at its next refresh.
        await request.delete(`/api/portal/centre/wallboards/${board.wallboard.id}/displays/${issued.id}`, { headers: { Origin: "http://localhost:8787" } });
        await afterRefreshes(31_000, () => expect(page.getByRole("alert").filter({ hasText: "stopped receiving updates" })).toBeVisible({ timeout: 500 }));
        expect(errors.filter((e) => !e.includes("net::ERR_FAILED"))).toEqual([]);
        await context.close();
        await request.delete(`/api/portal/centre/wallboards/${board.wallboard.id}`, { headers: { Origin: "http://localhost:8787" } });
        await request.delete(`/api/portal/centre/watches/${watch.watch.id}`, { headers: { Origin: "http://localhost:8787" } });
    });

    test("a display without a valid address explains itself and shows nothing", async ({ page, request }) => {
        expect((await switchWallboards(request, true)).ok()).toBe(true);
        await page.goto("/display");
        await expect(page.getByText("This screen needs its display address")).toBeVisible();
        await page.goto(`/display#t=${"x".repeat(43)}`);
        await expect(page.getByText("This display address isn't valid")).toBeVisible();
    });
});
