import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { PRESET_LABELS, WALLBOARD_PRESETS, presetView } from "../src/shared/centre/wallboard";

// Intelligence Centre 9.1 in a real browser: the new pages (axe, no sideways scrolling, fixture
// labels), the five Wallboard 2.0 presets at 1080p, 1440p and 4K, the high-contrast theme, the
// keyboard layout editor, the assistant without AI, and replay. INVENTED fixtures only
// (scripts/mock-feeds.mjs); every screen says so.

const JSON_HEADERS = { Origin: "http://localhost:8787", "Content-Type": "application/json" };
const ORIGIN = { Origin: "http://localhost:8787" };
const SOURCES = [
    "rfs-incidents",
    "rfs-fire-danger",
    "rfs-incident-alerts",
    "bom-warnings",
    "bom-observations",
    "dea-hotspots",
    "endeavour-outages",
    "ga-earthquakes",
    "tfnsw-live-traffic",
];

const watchErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
    return errors;
};

async function prepare(request: APIRequestContext) {
    // History on first, so these collections are versioned (replay has something to show).
    await request.put("/api/portal/flags/intelligence_centre.history", { headers: JSON_HEADERS, data: { enabled: true } });
    const { sources } = (await (await request.get("/api/portal/centre/sources")).json()) as { sources: { source: { id: string }; status: string }[] };
    for (const id of SOURCES) {
        if (sources.find((s) => s.source.id === id)?.status === "active") continue;
        expect((await request.put(`/api/portal/centre/sources/${id}`, { headers: JSON_HEADERS, data: { enabled: true } })).ok()).toBe(true);
        const r = await request.post(`/api/portal/centre/sources/${id}/refresh`, { headers: JSON_HEADERS, data: {} });
        expect(r.ok(), `${id}: ${await r.text()}`).toBe(true);
    }
}

async function boardWithAllPresets(request: APIRequestContext, name: string, extra: Record<string, unknown> = {}) {
    const watch = (
        await (
            await request.post("/api/portal/centre/watches", {
                headers: JSON_HEADERS,
                data: {
                    name: `${name} area`,
                    definition: { kind: "point", lat: -33.61, lon: 150.61, radiusKm: 30, placeName: "" },
                    fireDistrict: "Example Ranges",
                },
            })
        ).json()
    ).watch as { id: string };
    const board = (
        await (
            await request.post("/api/portal/centre/wallboards", {
                headers: JSON_HEADERS,
                data: {
                    name,
                    layout: "local",
                    watchId: watch.id,
                    rotationSeconds: 20,
                    refreshSeconds: 30,
                    views: WALLBOARD_PRESETS.filter((p) => p !== "map").map(presetView),
                    ...extra,
                },
            })
        ).json()
    ).wallboard as { id: string };
    const issued = (await (
        await request.post(`/api/portal/centre/wallboards/${board.id}/displays`, { headers: JSON_HEADERS, data: { label: `${name} TV` } })
    ).json()) as { token: string };
    return { watch, board, token: issued.token };
}

const cleanup = async (request: APIRequestContext, ids: { board: { id: string }; watch: { id: string } }) => {
    await request.delete(`/api/portal/centre/wallboards/${ids.board.id}`, { headers: ORIGIN });
    await request.delete(`/api/portal/centre/watches/${ids.watch.id}`, { headers: ORIGIN });
};

const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const axeSerious = async (page: Page, include?: string) => {
    const builder = new AxeBuilder({ page }).exclude(".maplibregl-map").exclude("main p.bg-warning-primary");
    const results = await (include ? builder.include(include) : builder).analyze();
    return results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

test("the new Intelligence Centre pages load without errors, fit the screen and pass axe", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    await prepare(request);
    const report = (await (await request.post("/api/portal/centre/reports", { headers: JSON_HEADERS, data: { scope: { kind: "nsw" } } })).json()) as {
        summary: { id: string };
    };
    const board = await boardWithAllPresets(request, `Pages ${info.project.name}`);
    for (const path of [
        "/portal/intelligence-centre/changes",
        "/portal/intelligence-centre/changes?significance=all&hazard=fire",
        "/portal/intelligence-centre/timeline",
        "/portal/intelligence-centre/replay",
        "/portal/intelligence-centre/analytics",
        "/portal/intelligence-centre/correlations",
        "/portal/intelligence-centre/rules",
        "/portal/intelligence-centre/reports",
        `/portal/intelligence-centre/reports/${report.summary.id}`,
        "/portal/intelligence-centre/assistant",
        `/portal/intelligence-centre/wallboards/${board.board.id}`,
        "/portal/intelligence-centre/sources",
        "/portal/today",
    ]) {
        await page.goto(path);
        await expect(page.getByRole("main")).toBeVisible();
        expect(await noSidewaysScroll(page), path).toBeLessThanOrEqual(0);
        expect(await axeSerious(page, "main"), path).toEqual([]);
    }
    await page.goto(`/portal/intelligence-centre/reports/${report.summary.id}`);
    await expect(page.getByText("Situation overview").first()).toBeVisible();
    await page.screenshot({ path: `test-results/centre-9-1-report-${info.project.name}.png`, fullPage: true });
    await page.goto("/portal/intelligence-centre/changes");
    await page.screenshot({ path: `test-results/centre-9-1-changes-${info.project.name}.png`, fullPage: true });
    await cleanup(request, board);
    expect(errors).toEqual([]);
});

test.describe("Wallboard 2.0", () => {
    test.beforeAll(async ({ request }) => {
        await request.put("/api/portal/flags/intelligence_centre.wallboard", { headers: JSON_HEADERS, data: { enabled: true } });
    });
    test.afterAll(async ({ request }) => {
        await request.put("/api/portal/flags/intelligence_centre.wallboard", { headers: JSON_HEADERS, data: { enabled: false } });
    });

    test("five presets at 1080p, 1440p and 4K: everything fits, every widget is shown, axe passes", async ({ browser, request }, info) => {
        test.skip(info.project.name !== "desktop", "Wallboards are large screens; checked once");
        test.setTimeout(180_000);
        await prepare(request);
        const ids = await boardWithAllPresets(request, "Presets screen");
        for (const [width, height] of [
            [1920, 1080],
            [2560, 1440],
            [3840, 2160],
        ]) {
            const context = await browser.newContext({ viewport: { width, height } });
            const page = await context.newPage();
            const errors = watchErrors(page);
            await page.clock.install();
            await page.goto(`/display#t=${ids.token}`);
            await expect(page.getByRole("heading", { level: 1, name: "Presets screen" })).toBeVisible();
            const presets = WALLBOARD_PRESETS.filter((p) => p !== "map");
            for (const [i, preset] of presets.entries()) {
                await expect(page.getByText(`${PRESET_LABELS[preset]} · view ${i + 1} of ${presets.length}`)).toBeVisible({ timeout: 10_000 });
                expect(await noSidewaysScroll(page), `${preset} ${width}`).toBeLessThanOrEqual(0);
                // Nothing scrolls on a wallboard-sized screen: the grid fills it.
                expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight), `${preset} ${width}`).toBeLessThanOrEqual(1);
                await expect(page.getByText("not an official warning service", { exact: false }).first()).toBeVisible();
                if (width === 1920) {
                    expect(await axeSerious(page), `${preset}`).toEqual([]);
                    await page.waitForTimeout(800);
                    await page.screenshot({ path: `test-results/wallboard-${preset}-1080p.png` });
                }
                if (width === 3840 && preset === "local") await page.screenshot({ path: "test-results/wallboard-local-4k.png" });
                if (width === 2560 && preset === "nsw") await page.screenshot({ path: "test-results/wallboard-nsw-1440p.png" });
                await page.clock.runFor(21_000);
            }
            expect(errors.filter((e) => !e.includes("net::ERR_FAILED"))).toEqual([]);
            await context.close();
        }
        await cleanup(request, ids);
    });

    test("pauses, steps between views with the keyboard, and passes axe in high contrast", async ({ browser, request }, info) => {
        test.skip(info.project.name !== "desktop", "Checked once");
        await prepare(request);
        const ids = await boardWithAllPresets(request, "Contrast screen", { theme: "high_contrast", burnIn: true });
        const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
        const page = await context.newPage();
        await page.goto(`/display#t=${ids.token}`);
        await expect(page.getByText("Local Situation · view 1 of 5")).toBeVisible();
        await page.keyboard.press("Space");
        await expect(page.getByRole("button", { name: "Resume rotation" })).toBeVisible();
        await page.keyboard.press("ArrowRight");
        await expect(page.getByText("NSW Situation Overview · view 2 of 5")).toBeVisible();
        await page.keyboard.press("ArrowLeft");
        await expect(page.getByText("Local Situation · view 1 of 5")).toBeVisible();
        await expect(page.getByRole("button", { name: /full screen/i })).toBeVisible();
        expect(await axeSerious(page)).toEqual([]);
        await page.waitForTimeout(800);
        await page.screenshot({ path: "test-results/wallboard-high-contrast-1080p.png" });
        await context.close();
        await cleanup(request, ids);
    });

    test("the layout editor moves and resizes widgets with the keyboard, refuses overlaps, and saves", async ({ page, request }, info) => {
        test.skip(info.project.name !== "desktop", "The editor is a desktop tool; checked once");
        await prepare(request);
        const ids = await boardWithAllPresets(request, "Editor screen");
        await page.goto(`/portal/intelligence-centre/wallboards/${ids.board.id}`);
        const map = page.getByRole("button", { name: /^Incident map: column 1, row 1, 8 by 10 cells/ });
        await expect(map).toBeVisible();
        await map.focus();
        // Right would overlap the summary: refused, nothing moves.
        await page.keyboard.press("ArrowRight");
        await expect(page.getByRole("button", { name: /^Incident map: column 1, row 1, 8 by 10 cells/ })).toBeVisible();
        // Shift+Left makes it narrower.
        await page.keyboard.press("Shift+ArrowLeft");
        await expect(page.getByRole("button", { name: /^Incident map: column 1, row 1, 7 by 10 cells/ })).toBeVisible();
        expect(await axeSerious(page, "main")).toEqual([]);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByText(/saved/i).first()).toBeVisible();
        await page.reload();
        await expect(page.getByRole("button", { name: /^Incident map: column 1, row 1, 7 by 10 cells/ })).toBeVisible();
        await page.screenshot({ path: "test-results/wallboard-editor.png", fullPage: true });
        await cleanup(request, ids);
    });
});

test("the assistant answers from stored records without AI, and says so", async ({ page, request }, info) => {
    test.skip(info.project.name !== "desktop", "Checked once");
    await prepare(request);
    await page.goto("/portal/intelligence-centre/assistant");
    await page.getByRole("textbox").first().fill("What information is missing or stale?");
    await page.getByRole("button", { name: /^Ask/ }).click();
    await expect(page.getByText(/built-in question types/i).first()).toBeVisible();
    await expect(page.getByText("Missing or stale information").first()).toBeVisible();
    await page.screenshot({ path: "test-results/centre-9-1-assistant.png", fullPage: true });
});

test("replay shows a recorded moment beside the map", async ({ page, request }, info) => {
    test.skip(info.project.name !== "desktop", "Checked once");
    await prepare(request);
    await page.goto("/portal/intelligence-centre/replay");
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Example Ridge Rd, Exampleville").first()).toBeVisible({ timeout: 15_000 });
    expect(await axeSerious(page, "main")).toEqual([]);
    await page.screenshot({ path: "test-results/centre-9-1-replay.png", fullPage: true });
});
