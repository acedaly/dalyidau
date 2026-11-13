import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

// Wedding Planner, the installable phone app (docs/PLANNER.md), at /portal/planner: the phone companion to
// the wedding admin in Payload, over the same API. Both projects (desktop, mobile) share one database, so
// names include the project.

const JSON_HEADERS = { Origin: "http://localhost:8787", "Content-Type": "application/json" };
const APP = "/portal/planner";

const watchErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
    return errors;
};

const noSidewaysScroll = async (page: Page, label: string) => {
    const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
    expect(scroll, `${label} scrolls sideways`).toBeLessThanOrEqual(width);
};

const axe = async (page: Page, label: string) => {
    const results = await new AxeBuilder({ page }).include("main").exclude("main p.bg-warning-primary").analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};

/** The app's own navigation: the bottom bar on phones, the rail on wider screens. */
const tab = (page: Page, name: string) => page.getByRole("navigation", { name: "Wedding Planner" }).getByRole("link", { name, exact: true });

test("Wedding Planner's views load, fit the screen and pass axe", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(APP);
    await expect(page.getByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "RSVPs" })).toBeVisible();
    await noSidewaysScroll(page, "home");
    await axe(page, "home");
    for (const [name, heading] of [
        ["Guests", "Guests"],
        ["Tasks", "Tasks"],
        ["Budget", "Budget"],
        ["More", "More"],
    ] as const) {
        await tab(page, name).click();
        await expect(page).toHaveURL(new RegExp(`${APP}/${name.toLowerCase()}$`));
        await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
        await expect(tab(page, name)).toHaveAttribute("aria-current", "page");
        await noSidewaysScroll(page, name);
        await axe(page, name);
    }
    for (const name of ["Seating", "Timeline", "Suppliers"]) {
        await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
        await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
        await expect(tab(page, "More")).toHaveAttribute("aria-current", "page");
        await noSidewaysScroll(page, name);
        await axe(page, name);
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "More" })).toBeVisible();
    }
    // Every view has its own address, so a reload (or a shortcut) opens it directly.
    await page.goto(`${APP}/tasks`);
    await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
    expect(errors).toEqual([]);
});

test("adds a task with a due date, ticks it off and finds it under Done", async ({ page }, info) => {
    const title = `Order the cake (${info.project.name})`;
    await page.goto(`${APP}/tasks`);
    await page.getByRole("textbox", { name: "New task" }).fill(title);
    await page.getByLabel("Due date (optional)").fill("2026-12-01");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Task added")).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: title });
    await expect(row).toContainText("1 Dec 2026");
    // Untitled UI checkboxes hide the native input under the styled box (as in the other specs).
    await page.getByRole("checkbox", { name: `Mark "${title}" done` }).check({ force: true });
    await expect(
        page
            .getByText("Done", { exact: true })
            .filter({ hasNot: page.getByRole("radio") })
            .first(),
    ).toBeVisible();
    // It leaves the open list once the list reloads, and is listed under Done.
    await expect(page.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
    await page.getByRole("radio", { name: "Done" }).click({ force: true });
    await expect(page.getByRole("listitem").filter({ hasText: title })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: `Mark "${title}" not done` })).toBeChecked();
});

test("records a guest's RSVP from their sheet, and the guest list follows", async ({ page, request }, info) => {
    const name = `Rosa (${info.project.name})`;
    const events = (await (await request.get("/api/portal/wedding/events")).json()) as { items: { id: string; name: string }[] };
    let eventId = events.items[0]?.id;
    if (!eventId) {
        const made = await request.post("/api/portal/wedding/events", { headers: JSON_HEADERS, data: { name: `Ceremony (${info.project.name})` } });
        eventId = ((await made.json()) as { item: { id: string } }).item.id;
    }
    const created = await request.post("/api/portal/wedding/guests", {
        headers: JSON_HEADERS,
        data: { firstName: name, lastName: "Planner", events: [eventId] },
    });
    expect(created.ok(), await created.text()).toBe(true);

    await page.goto(`${APP}/guests`);
    await page.getByRole("textbox", { name: "Search guests" }).fill(name);
    await page.getByRole("button", { name: new RegExp(name.replace(/[()]/g, "\\$&")) }).click();
    const sheet = page.getByRole("dialog", { name: `${name} Planner` });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("radio", { name: "Coming" }).click();
    await expect(page.getByText(`${name}: coming`)).toBeVisible();
    await expect(sheet.getByRole("radio", { name: "Coming" })).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: new RegExp(name.replace(/[()]/g, "\\$&")) })).toContainText("Coming");
});

test("installs: manifest, icons and a service worker for the app", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(APP);
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(href).toBe(`${APP}/manifest.webmanifest`);
    const manifest = await (await page.request.get(href!)).json();
    expect(manifest).toMatchObject({ start_url: APP, scope: APP, display: "standalone", name: "Wedding Planner" });
    for (const icon of manifest.icons as { src: string; type: string }[]) {
        const response = await page.request.get(icon.src);
        expect(response.ok(), icon.src).toBe(true);
        expect(response.headers()["content-type"]).toContain(icon.type);
    }
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe(`http://localhost:8787${APP}`);
    expect(errors).toEqual([]);
});

test("keeps the offline page ready, with nothing personal in its cache", async ({ page }) => {
    // Playwright can't take a service worker's own requests offline (setOffline and route() don't
    // reach them in Chromium), so the network-failure fallback itself is checked by the next test.
    await page.goto(APP);
    const cached = await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        const keys = await caches.keys();
        const cache = await caches.open(keys.find((key) => key.startsWith("planner-"))!);
        const offline = await cache.match("/portal/planner/offline");
        return { keys, offline: offline ? await offline.text() : null, urls: (await cache.keys()).map((request) => new URL(request.url).pathname) };
    });
    expect(cached.keys.filter((key) => key.startsWith("planner-"))).toHaveLength(1);
    expect(cached.offline).toContain("You're offline");
    for (const url of cached.urls) expect(url).toMatch(/^(\/portal\/planner\/offline|\/assets\/|\/icons\/|\/theme-init\.js$)/);
    await page.goto(`${APP}/offline`);
    await expect(page.getByRole("heading", { level: 1, name: "You're offline" })).toBeVisible();
    await expect(page.locator("#page-data")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Try again" })).toBeVisible();
});

test("the service worker shows the offline page only when the network fails, and never caches pages or data", async ({ request }) => {
    // The real service worker, run in Node against stand-ins for its globals.
    const script = await (await request.get(`${APP}/sw.js`)).text();
    const listeners: Record<string, (event: unknown) => void> = {};
    const stored = new Map<string, Response>();
    const offlinePage = new Response("You're offline", { headers: { "Content-Type": "text/html" } });
    let network: "up" | "down" = "up";
    const caches = {
        match: async (input: Request | string) => {
            const path = new URL(typeof input === "string" ? input : input.url, "http://localhost:8787").pathname;
            return path === `${APP}/offline` ? offlinePage.clone() : stored.get(path)?.clone();
        },
        open: async () => ({ put: async (req: Request, res: Response) => void stored.set(new URL(req.url).pathname, res) }),
    };
    const fetch = async (req: Request) => {
        if (network === "down") throw new TypeError("Failed to fetch");
        return new Response(`network ${new URL(req.url).pathname}`, { status: 200 });
    };
    const self = {
        location: new URL(`http://localhost:8787${APP}/sw.js`),
        addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] = fn),
    };
    new Function("self", "caches", "fetch", script)(self, caches, fetch);

    const handle = async (path: string, mode: RequestMode, method = "GET") => {
        let responded: Promise<Response> | undefined;
        const req = new Request(`http://localhost:8787${path}`, { method });
        Object.defineProperty(req, "mode", { value: mode });
        listeners.fetch({ request: req, respondWith: (r: Promise<Response>) => (responded = r), waitUntil: (p: Promise<unknown>) => p });
        return responded ? (await responded).text() : "not handled";
    };

    expect(await handle(`${APP}/guests`, "navigate")).toBe(`network ${APP}/guests`);
    expect(await handle("/api/portal/wedding/guests", "cors")).toBe("not handled");
    expect(await handle("/media/photo.jpg", "no-cors")).toBe("not handled");
    expect(await handle("/api/portal/wedding/tasks", "cors", "POST")).toBe("not handled");
    expect(await handle("/assets/planner-abc.js", "cors")).toBe("network /assets/planner-abc.js");
    network = "down";
    expect(await handle(`${APP}/guests`, "navigate")).toBe("You're offline");
    expect(await handle("/assets/planner-abc.js", "cors")).toBe("network /assets/planner-abc.js");
    expect([...stored.keys()]).toEqual(["/assets/planner-abc.js"]);
});
