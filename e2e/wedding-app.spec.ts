import { type Page, expect, test } from "@playwright/test";

// Wedding Planner as an installable app (worker/portal/pwa.ts) and the wedding-only portal
// navigation (Portal settings → Features → "Other applications", off by default).

const JSON_HEADERS = { Origin: "http://localhost:8787", "Content-Type": "application/json" };

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

test("the portal lists only Wedding Planner by default", async ({ page, isMobile }) => {
    await page.goto("/portal");
    await expect(page.locator("[data-application]")).toHaveCount(1);
    await expect(page.locator('[data-application="wedding"]')).toBeVisible();
    await expect(page.locator('[data-portal-link="today"]')).toHaveCount(0);
    if (isMobile) await page.getByRole("button", { name: "Open navigation" }).click();
    const nav = page.getByRole("navigation", { name: "Portal" });
    await expect(nav.getByRole("link", { name: "All Applications" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Today" })).toHaveCount(0);
    // Still there for anyone (and the Chief of Staff connector) who goes straight to it.
    const calendar = await page.request.get("/portal/calendar");
    expect(calendar.status()).toBe(200);
});

test("installs: manifest, icons and a service worker that controls the portal", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/portal/wedding");
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(href).toBe("/portal/manifest.webmanifest");
    const manifest = await (await page.request.get(href!)).json();
    expect(manifest).toMatchObject({ start_url: "/portal/wedding", scope: "/portal", display: "standalone" });
    for (const icon of manifest.icons as { src: string; type: string }[]) {
        const response = await page.request.get(icon.src);
        expect(response.ok(), icon.src).toBe(true);
        expect(response.headers()["content-type"]).toContain(icon.type);
    }
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe("http://localhost:8787/portal");
    expect(errors).toEqual([]);
});

test("keeps the offline page ready, with nothing personal in its cache", async ({ page }) => {
    // Playwright can't take a service worker's own requests offline (setOffline and route() don't
    // reach them in Chromium), so the network-failure fallback itself is covered in
    // test/wedding-app.test.ts. Here: the real worker precached the offline page, and it renders.
    await page.goto("/portal/wedding");
    const cached = await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        const keys = await caches.keys();
        const cache = await caches.open(keys.find((key) => key.startsWith("wedding-planner-"))!);
        const offline = await cache.match("/portal/offline");
        return { keys, offline: offline ? await offline.text() : null, urls: (await cache.keys()).map((request) => new URL(request.url).pathname) };
    });
    expect(cached.keys.filter((key) => key.startsWith("wedding-planner-"))).toHaveLength(1);
    expect(cached.offline).toContain("You're offline");
    for (const url of cached.urls) expect(url).toMatch(/^(\/portal\/offline|\/assets\/|\/icons\/|\/theme-init\.js$)/);
    await page.goto("/portal/offline");
    await expect(page.getByRole("heading", { level: 1, name: "You're offline" })).toBeVisible();
    await expect(page.locator("#page-data")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Try again" })).toBeVisible();
});

test("the service worker shows the offline page only when the network fails, and never caches pages or data", async ({ request }) => {
    // The real /portal/sw.js, run in Node against stand-ins for the service worker's globals.
    const script = await (await request.get("/portal/sw.js")).text();
    const listeners: Record<string, (event: unknown) => void> = {};
    const stored = new Map<string, Response>();
    const offlinePage = new Response("You're offline", { headers: { "Content-Type": "text/html" } });
    let network: "up" | "down" = "up";
    const caches = {
        match: async (input: Request | string) => {
            const path = new URL(typeof input === "string" ? input : input.url, "http://localhost:8787").pathname;
            return path === "/portal/offline" ? offlinePage.clone() : stored.get(path)?.clone();
        },
        open: async () => ({ put: async (req: Request, res: Response) => void stored.set(new URL(req.url).pathname, res) }),
    };
    const fetch = async (req: Request) => {
        if (network === "down") throw new TypeError("Failed to fetch");
        return new Response(`network ${new URL(req.url).pathname}`, { status: 200 });
    };
    const self = {
        location: new URL("http://localhost:8787/portal/sw.js"),
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

    expect(await handle("/portal/wedding/guests", "navigate")).toBe("network /portal/wedding/guests");
    expect(await handle("/api/portal/wedding/guests", "cors")).toBe("not handled");
    expect(await handle("/media/photo.jpg", "no-cors")).toBe("not handled");
    expect(await handle("/api/portal/wedding/guests", "cors", "POST")).toBe("not handled");
    expect(await handle("/assets/portal-abc.js", "cors")).toBe("network /assets/portal-abc.js");
    network = "down";
    expect(await handle("/portal/wedding/guests", "navigate")).toBe("You're offline");
    // Static build files fetched while online are there offline; nothing else was stored.
    expect(await handle("/assets/portal-abc.js", "cors")).toBe("network /assets/portal-abc.js");
    expect([...stored.keys()]).toEqual(["/assets/portal-abc.js"]);
});

test("wedding pages fit a phone, with tables' last column in view", async ({ page, request, isMobile }, info) => {
    test.skip(!isMobile, "phone width only");
    const response = await request.post("/api/portal/wedding/guests", {
        headers: JSON_HEADERS,
        data: {
            firstName: `Maximiliana (${info.project.name})`,
            lastName: "Featherstonehaugh-Worthington",
            email: "maximiliana.featherstonehaugh@example.com",
        },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const errors = watchErrors(page);
    for (const path of ["guests", "rsvps", "seating", "budget", "suppliers", "tasks", "timeline", "communications"]) {
        await page.goto(`/portal/wedding/${path}`);
        // Seating also has a print-only heading.
        await expect(page.locator("main h1").first()).toBeVisible();
        await noSidewaysScroll(page, path);
    }
    await page.goto("/portal/wedding/guests");
    await page.getByPlaceholder("Search guests").fill(`Maximiliana (${info.project.name})`);
    const badge = page
        .getByRole("row", { name: /Maximiliana/ })
        .getByRole("gridcell")
        .last();
    const box = (await badge.boundingBox())!;
    expect(box.x + box.width, "RSVP column is cut off").toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(errors).toEqual([]);
});
