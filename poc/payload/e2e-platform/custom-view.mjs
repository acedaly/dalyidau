// Phase 0, experiment 2 in a real browser: the existing wedding screens inside Payload's admin.
//   node e2e-platform/custom-view.mjs   (with `wrangler dev --port 8790` running and invented data seeded)
// Chromium resolves daly.id.au to the local Worker, so hostname rules apply exactly as in production.
import { chromium } from "../../../node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { token, OWNER } from "../scripts/test-identity.mjs";

const out = path.resolve(import.meta.dirname, "../.poc-results");
mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP daly.id.au 127.0.0.1:${process.env.POC_PORT ?? 8790}, MAP wedding.daly.id.au 127.0.0.1:${process.env.POC_PORT ?? 8790}`],
});

// Nothing may leave the machine: any request not to the mapped hosts is aborted and fails the run.
const offHost = [];
async function guard(context) {
    await context.route(/^https:|^http:\/\/(?!(daly\.id\.au|wedding\.daly\.id\.au)\/)/, (route) => (offHost.push(route.request().url()), route.abort()));
}
async function signedIn(email, theme = "light") {
    const context = await browser.newContext({ extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": token(email) }, viewport: { width: 1440, height: 1000 }, colorScheme: theme });
    await guard(context);
    // Test-only: the hosts are mapped over plain http here, which isn't a secure context, so the browser
    // withholds crypto.randomUUID (the guest import screen uses it). Real users are always on https, where
    // it exists; headless Chromium ignores --unsafely-treat-insecure-origin-as-secure.
    await context.addInitScript(() => {
        if (!globalThis.isSecureContext && globalThis.crypto && !crypto.randomUUID) {
            crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
        }
    });
    const page = await context.newPage();
    page.errors = [];
    page.on("pageerror", (e) => page.errors.push(e.message));
    // Test-only: the hosts are mapped over plain http here, where Chrome ignores Cross-Origin-Opener-Policy and
    // says so as a console error. On https (always, for real users) the header is honoured; that it is sent
    // is checked in test-platform/platform.test.ts. Nothing else is excused.
    const httpOnlyNotice = (text) => /^The Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was untrustworthy\./.test(text);
    page.on("console", (m) => (m.type() === "error" || /Content Security Policy/i.test(m.text())) && !httpOnlyNotice(m.text()) && page.errors.push(m.text()));
    return page;
}

// 1. Payload's own admin, before any wedding screen: record its computed styles.
const page = await signedIn(OWNER);
await page.goto("http://daly.id.au/admin", { waitUntil: "networkidle" });
const payloadStyle = () =>
    page.evaluate(() => {
        const pick = (el) => (el ? getComputedStyle(el) : null);
        const body = pick(document.body);
        const nav = pick(document.querySelector(".nav__link, nav a"));
        return { bodyFont: body.fontFamily, bodyColor: body.color, bodyBg: body.backgroundColor, navFont: nav?.fontFamily, navColor: nav?.color, sheets: [...document.styleSheets].map((s) => s.href).filter(Boolean) };
    });
const before = await payloadStyle();
await page.screenshot({ path: `${out}/payload-dashboard.png` });
check("Payload admin dashboard renders for an Access-verified owner", (await page.locator("text=Wedding").count()) > 0, "Wedding links in Payload's nav");

// "Website sync" on the dashboard (Phase 2): says the site matches Payload; when it doesn't, names what's
// wrong and Republish (a real click) puts it right.
{
    const panel = page.locator(".daly-sync");
    check("The dashboard says the website matches what's published", (await panel.getAttribute("data-state")) === "ok" && (await panel.innerText()).includes("matches what’s published"), await panel.innerText().catch(() => "no panel"));
    // A page published through Payload, then the site broken behind Payload's back as a failed write could:
    // the page loses its snapshot, and a post appears that Payload has no document for.
    const sql = (command) => execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--command", command], { cwd: path.resolve(import.meta.dirname, ".."), stdio: "pipe" });
    const made = await page.request.post("http://daly.id.au/api/pages?draft=false", {
        data: { title: "Sync panel check", slug: "sync-panel-check", _status: "published", content: { root: { type: "root", format: "", indent: 0, version: 1, direction: "ltr", children: [{ type: "paragraph", format: "", indent: 0, version: 1, direction: "ltr", textFormat: 0, children: [{ type: "text", text: "On the site.", format: 0, detail: 0, mode: "normal", style: "", version: 1 }] }] } } },
    });
    const madeId = (await made.json().catch(() => null))?.doc?.id;
    check("(a page published through Payload is on the site)", made.ok() && !!madeId && (await page.request.get("http://daly.id.au/sync-panel-check")).status() === 200, `${made.status()} ${(await made.text()).slice(0, 200)}`);
    sql(`DELETE FROM meta WHERE key IN ('page:sync-panel-check', 'page-id:${madeId}'); INSERT INTO posts (id, slug, title, tags, featured, body_html, toc, search_text, word_count, reading_minutes, published_at, content_hash, synced_at, source) VALUES ('payload:stray', 'stray-post', 'A stray post', '[]', 0, '<p>x</p>', '[]', 'x', 1, 1, '2026-11-01T00:00:00.000Z', 'h', '2026-11-01T00:00:00.000Z', 'payload'); INSERT INTO meta (key, value) VALUES ('content_version', 'sync-panel-check') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    check("(the site is now wrong: the page is gone)", (await page.request.get("http://daly.id.au/sync-panel-check")).status() === 404);
    await page.reload({ waitUntil: "networkidle" });
    const alert = page.locator(".daly-sync [role=alert]");
    const said = await alert.innerText().catch(() => "");
    check("…and when it doesn't, it says what's wrong", (await panel.getAttribute("data-state")) === "out" && /Page: Sync panel check — published here, but not on the website/.test(said) && said.includes("A stray post"), said);
    await page.screenshot({ path: `${out}/payload-dashboard-out-of-sync.png` });
    await page.getByRole("button", { name: "Republish" }).click();
    await page.waitForFunction(() => !document.querySelector(".daly-sync")?.textContent?.includes("Page: Sync panel check"), null, { timeout: 20000 });
    check("Republish (a real click) puts the page back on the site", (await page.request.get("http://daly.id.au/sync-panel-check")).status() === 200);
    const after = await panel.innerText();
    check(
        "…and never removes what Payload has no document for: the stray post is still up, named, and left for a person to decide",
        (await page.request.get("http://daly.id.au/blog/stray-post")).status() === 200 && after.includes("A stray post") && after.includes("leaves it alone") && (await page.getByRole("button", { name: "Republish" }).count()) === 0,
        after,
    );
    check("…and the panel records the repair: who, when, and what happened to each item", /Last Republish\s+.*owner@example\.test: 1 fixed, 0 failed, 1 left alone/s.test(after) && /Out of step now\s+1 item/.test(after), after);
    // The owner removes the stray post on purpose: two presses, never one.
    await page.getByRole("button", { name: "Remove from the website…" }).click();
    check("Removing asks first", (await page.request.get("http://daly.id.au/blog/stray-post")).status() === 200 && (await page.getByRole("button", { name: /Yes, remove/ }).count()) === 1);
    await page.getByRole("button", { name: /Yes, remove/ }).click();
    await page.waitForFunction(() => document.querySelector(".daly-sync")?.getAttribute("data-state") === "ok", null, { timeout: 20000 });
    check("…then takes it off the website", (await page.request.get("http://daly.id.au/blog/stray-post")).status() === 404);
    await page.request.delete(`http://daly.id.au/api/pages/${madeId}`);
    await page.reload({ waitUntil: "networkidle" });
    check("…and the dashboard says the website matches again", (await panel.getAttribute("data-state")) === "ok", await panel.innerText());
    await page.screenshot({ path: `${out}/payload-dashboard-in-sync.png` });
}

// The wedding menu is in collapsible groups (Payload's NavGroup): clicking a label closes and reopens it.
{
    // Payload's sidebar starts closed for a new user: open it with the menu button first.
    if (!(await page.evaluate(() => !!document.querySelector(".template-default--nav-open")))) {
        await page.locator(".nav-toggler, button[aria-label*='enu']").first().click();
        await page.waitForTimeout(500);
    }
    const toggle = page.locator("[id=\"nav-group-Wedding Planning\"] > button.nav-group__toggle");
    // Open: the group's links take up space. Closed: the toggle loses --open and the links' box has no height.
    const state = () =>
        page.evaluate(() => {
            const group = document.querySelector("[id='nav-group-Wedding Planning']");
            const link = group?.querySelector('a[href="/admin/wedding/seating"]');
            const box = link?.closest(".rah-static, [aria-hidden], .nav-group__content") ?? link?.parentElement;
            return { open: !!group?.querySelector(".nav-group__toggle--open"), height: box ? box.getBoundingClientRect().height : -1 };
        });
    const before = await state();
    await toggle.click();
    await page.waitForTimeout(500);
    const closed = await state();
    await toggle.click();
    await page.waitForTimeout(500);
    const reopened = await state();
    check(
        "the Wedding Planning menu group collapses and expands",
        before.open && before.height > 0 && !closed.open && closed.height === 0 && reopened.open && reopened.height > 0,
        JSON.stringify({ before, closed, reopened }),
    );
    check("the Wedding menu group has its own toggle", (await page.locator("#nav-group-Wedding > button.nav-group__toggle").count()) === 1);
}

// 2. The existing households screen as a Payload view.
for (const [screen, expectText] of [["households", "The Fictionals"], ["guests", "Fern"], ["rsvps", "RSVP"], ["seating", "Seating"], ["", "Welcome back"]]) {
    await page.goto(`http://daly.id.au/admin/wedding${screen ? `/${screen}` : ""}`, { waitUntil: "networkidle" });
    const host = page.locator('[data-testid="wedding-screen"]');
    await host.waitFor();
    const inside = page.locator('[data-testid="wedding-screen"] >> css=.wedding-root');
    await inside.waitFor({ timeout: 15000 }).catch(() => {});
    const text = await page.evaluate(() => document.querySelector('[data-testid="wedding-screen"]')?.shadowRoot?.textContent ?? "");
    check(`/admin/wedding/${screen} renders the existing screen inside Payload`, text.includes(expectText), `${text.length} chars in shadow root`);
    await page.screenshot({ path: `${out}/wedding-${screen || "dashboard"}.png`, fullPage: false });
}

// 2b. Every other wedding screen renders inside Payload (portal content, not an error or not-found page).
for (const screen of ["events", "invitations", "communications", "communications/texts", "communications/providers", "tasks", "timeline", "catering", "budget", "suppliers", "website", "settings", "settings/general", "settings/fields", "guests/import"]) {
    const response = await page.goto(`http://daly.id.au/admin/wedding/${screen}`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="wedding-screen"] >> css=.wedding-root').waitFor({ timeout: 15000 }).catch(() => {});
    const text = await page.evaluate(() => document.querySelector('[data-testid="wedding-screen"]')?.shadowRoot?.textContent ?? "");
    const failed = /isn.t available here|Page not found|Couldn.t load|don.t have access/i.test(text);
    check(`/admin/wedding/${screen} renders inside Payload`, response.status() === 200 && text.length > 200 && !failed, `HTTP ${response.status()}, ${text.length} chars`);
}
const errorsBefore = page.errors.length;
const unknown = await page.goto("http://daly.id.au/admin/wedding/finance", { waitUntil: "load" });
check("A path that isn't a wedding screen is a 404 inside Payload", unknown.status() === 404, `HTTP ${unknown.status()}`);
page.errors.length = errorsBefore; // the deliberate 404 above logs a console error; it isn't a defect

// 2c. A link inside a screen to another wedding screen stays in Payload.
await page.goto("http://daly.id.au/admin/wedding", { waitUntil: "networkidle" });
await page.locator('[data-testid="wedding-screen"] >> css=.wedding-root').waitFor({ timeout: 15000 }).catch(() => {});
const clicked = await page.evaluate(() => {
    const link = [...(document.querySelector('[data-testid="wedding-screen"]')?.shadowRoot?.querySelectorAll('a[href^="/portal/wedding/"]') ?? [])][0];
    if (!link) return null;
    link.click();
    return link.getAttribute("href");
});
await page.waitForURL(/\/admin\/wedding\//, { timeout: 10000 }).catch(() => {});
const landed = new URL(page.url());
check(
    "Wedding links inside a screen open the Payload view (query kept), not the old portal",
    clicked !== null && landed.pathname + landed.search === clicked.replace(/^\/portal\//, "/admin/").replace(/#.*$/, ""),
    `${clicked} → ${landed.pathname}${landed.search}`,
);

// 2d. Payload's own collection screens still work with its sign-in routes and internal collections blocked.
for (const screen of ["collections/pages", "collections/pages/create", "collections/media"]) {
    const response = await page.goto(`http://daly.id.au/admin/${screen}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const body = await page.evaluate(() => document.body.innerText);
    check(`Payload's /admin/${screen} works for the owner`, response.status() === 200 && !/session has expired|log in|login/i.test(body), `HTTP ${response.status()}`);
}

// 2e. Phone width: the Payload admin with a wedding screen doesn't scroll sideways.
{
    const phone = await signedIn(OWNER);
    await phone.setViewportSize({ width: 390, height: 844 });
    for (const screen of ["", "guests", "rsvps", "communications"]) {
        await phone.goto(`http://daly.id.au/admin/wedding${screen ? `/${screen}` : ""}`, { waitUntil: "networkidle" });
        await phone.locator('[data-testid="wedding-screen"] >> css=.wedding-root').waitFor({ timeout: 15000 }).catch(() => {});
        const widths = await phone.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: window.innerWidth }));
        check(`Phone width (390 px): /admin/wedding/${screen} doesn't scroll sideways`, widths.page <= widths.viewport + 1, `${widths.page} px content in ${widths.viewport} px`);
        if (!screen || screen === "guests") await phone.screenshot({ path: `${out}/phone-wedding-${screen || "dashboard"}.png` });
    }
    await phone.context().close();
}

// 3. Isolation both ways.
await page.goto("http://daly.id.au/admin/wedding/households", { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector('[data-testid="wedding-screen"]')?.shadowRoot?.textContent?.includes("The Fictionals"));
const after = await payloadStyle();
check("Payload's own styles are unchanged with a wedding screen open", JSON.stringify({ ...before, sheets: 0 }) === JSON.stringify({ ...after, sheets: 0 }), `${before.bodyFont.slice(0, 40)} / ${before.navColor}`);
check("The portal stylesheet is never added to Payload's document", !after.sheets.some((href) => /\/assets\/apps-.*\.css/.test(href)), after.sheets.map((h) => h.split("/").pop()).join(", "));
const inner = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="wedding-screen"]').shadowRoot;
    const h = root.querySelector("h1, h2");
    const button = root.querySelector("button");
    const cs = (el) => (el ? getComputedStyle(el) : null);
    return { headingFont: cs(h)?.fontFamily, headingColor: cs(h)?.color, buttonRadius: cs(button)?.borderRadius, hasPayloadClassesStyled: !!root.querySelector(".btn") };
});
check("The wedding screen uses the portal's own typography, not Payload's", /^Inter/.test(inner.headingFont ?? "") && !/^Inter/.test(before.bodyFont), `${inner.headingFont?.slice(0, 40)} vs Payload ${before.bodyFont.slice(0, 30)}`);

const cspHeader = (await page.goto("http://daly.id.au/admin/wedding/households", { waitUntil: "networkidle" })).headers()["content-security-policy"] ?? "";
await page.waitForFunction(() => document.querySelector('[data-testid="wedding-screen"]')?.shadowRoot?.textContent?.includes("The Fictionals"));
check("The admin is served with the portal's CSP directives (nonce scripts, frame-ancestors 'none')", /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/.test(cspHeader) && cspHeader.includes("frame-ancestors 'none'") && cspHeader.includes("object-src 'none'"));
const ring = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="wedding-screen"]').shadowRoot.querySelector("[aria-haspopup]")).boxShadow);
check("Tailwind ring and shadow utilities work inside the shadow root", /0px 0px 0px 1px inset/.test(ring), ring.slice(-60));

// 4. A React Aria overlay (menu/dialog) opens inside the shadow root, styled.
const opened = await page.evaluate(async () => {
    const root = document.querySelector('[data-testid="wedding-screen"]').shadowRoot;
    const trigger = [...root.querySelectorAll("button")].find((b) => /add|new|import|more|actions|filter/i.test(b.textContent + (b.getAttribute("aria-label") ?? "")));
    if (!trigger) return { trigger: null };
    trigger.click();
    await new Promise((r) => setTimeout(r, 600));
    const overlay = root.querySelector('[role="dialog"], [role="menu"], [role="listbox"]');
    const outside = document.body.querySelector(':scope > [role="dialog"], :scope > [data-react-aria-top-layer], :scope > div > [role="menu"]');
    return { trigger: trigger.textContent?.trim() || trigger.getAttribute("aria-label"), inside: !!overlay, outside: !!outside, bg: overlay ? getComputedStyle(overlay).backgroundColor : null };
});
check("React Aria overlays open inside the isolation boundary", opened.inside && !opened.outside, JSON.stringify(opened));
await page.screenshot({ path: `${out}/wedding-overlay.png` });
check("No browser errors or CSP violations on the wedding screens", page.errors.length === 0, page.errors.slice(0, 3).join(" | "));

// 5. Dark mode follows Payload's theme, inside the boundary only.
const dark = await signedIn(OWNER, "dark");
await dark.goto("http://daly.id.au/admin/wedding/households", { waitUntil: "networkidle" });
await dark.waitForFunction(() => document.querySelector('[data-testid="wedding-screen"]')?.shadowRoot?.textContent?.includes("The Fictionals"));
const darkState = await dark.evaluate(() => ({ theme: document.documentElement.dataset.theme, inner: document.querySelector('[data-testid="wedding-screen"]').shadowRoot.querySelector(".wedding-root").classList.contains("dark-mode"), htmlHasDarkMode: document.documentElement.classList.contains("dark-mode") }));
check("Dark mode follows Payload's theme without touching Payload's document", darkState.theme !== "dark" || (darkState.inner && !darkState.htmlHasDarkMode), JSON.stringify(darkState));
await dark.screenshot({ path: `${out}/wedding-households-dark.png` });

// 6. Roles: a viewer sees the screen without RSVP codes; a stranger gets nothing.
const viewer = await signedIn("viewer@example.test");
// Fetched from inside the browser, so it goes to the local Worker (Node-side request APIs ignore the host mapping).
await viewer.goto("http://daly.id.au/admin/wedding/households", { waitUntil: "load" });
await viewer.screenshot({ path: `${out}/viewer-households.png` });
const viewerText = await viewer.evaluate(async () => (await fetch("/api/platform/wedding-page?path=/portal/wedding/households")).text());
check("A viewer gets the screen's data without RSVP codes", viewerText.includes('"route":"households"') && !/"rsvpCode":"[^"]/.test(viewerText), `${(viewerText.match(/"rsvpCode":null/g) ?? []).length} codes redacted`);
const stranger = await signedIn("stranger@example.test");
const strangerAdmin = await stranger.goto("http://daly.id.au/admin/wedding/households");
check("A signed-in stranger with no portal role is refused the admin", strangerAdmin.status() === 403, `HTTP ${strangerAdmin.status()}`);
const anonymousContext = await browser.newContext();
await guard(anonymousContext);
const anonymous = await anonymousContext.newPage();
check("No Access token: the admin is refused", (await anonymous.goto("http://daly.id.au/admin")).status() === 401);
check("Wedding host never serves the admin", (await anonymous.goto("http://wedding.daly.id.au/admin")).status() === 404);

check("No request left the machine", offHost.length === 0, offHost.slice(0, 3).join(", "));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed. Screenshots in .poc-results/`);
process.exit(failed.length ? 1 : 0);
