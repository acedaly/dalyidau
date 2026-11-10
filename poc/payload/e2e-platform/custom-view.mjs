// Phase 0, experiment 2 in a real browser: the existing wedding screens inside Payload's admin.
//   node e2e-platform/custom-view.mjs   (with `wrangler dev --port 8790` running and invented data seeded)
// Chromium resolves daly.id.au to the local Worker, so hostname rules apply exactly as in production.
import { chromium } from "../../../node_modules/playwright/index.mjs";
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
    page.on("console", (m) => (m.type() === "error" || /Content Security Policy/i.test(m.text())) && page.errors.push(m.text()));
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
check("Wedding links inside a screen open the Payload view, not the old portal", clicked !== null && new URL(page.url()).pathname === clicked.replace(/^\/portal\//, "/admin/").replace(/[?#].*$/, ""), `${clicked} → ${new URL(page.url()).pathname}`);

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
