// Wedding website publishing from Payload, with REAL mouse clicks (Playwright's locator.click sends
// pointer events), against the real combined Worker. Regression test for the Phase 3 defect: inside
// Payload the wedding screens live in a shadow root, and React Aria cancelled every mouse press there, so
// "Publish changes" and every other button did nothing. Element.click() (used by custom-view.mjs) took a
// different path and hid it.
//
//   node e2e-platform/wedding-publish.mjs   (plain `wrangler dev --local --port 8790`, invented data seeded)
// Chromium maps daly.id.au and wedding.daly.id.au to the local Worker, so both public addresses are checked.
import { chromium } from "../../../node_modules/playwright/index.mjs";
import { token, OWNER } from "../scripts/test-identity.mjs";
import http from "node:http";

const PORT = process.env.POC_PORT ?? 8790;
let failures = 0;
const check = (name, ok, detail = "") => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${String(detail).slice(0, 300)})` : ""}`);
};

const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP daly.id.au 127.0.0.1:${PORT}, MAP wedding.daly.id.au 127.0.0.1:${PORT}`] });
const context = await browser.newContext({ extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": token(OWNER) }, viewport: { width: 1440, height: 1000 } });
await context.route(/^https:|^http:\/\/(?!(daly\.id\.au|wedding\.daly\.id\.au)\/)/, (route) => route.abort());
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const api = (method, path, body) =>
    page.evaluate(
        async ([method, path, body]) => {
            const r = await fetch(path, { method, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
            return { status: r.status, json: await r.json().catch(() => null) };
        },
        [method, path, body],
    );
// The public pages, fetched with no identity at all (plain HTTP to the local Worker with the real Host).
const publicText = (url) =>
    new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({ host: "127.0.0.1", port: PORT, path: u.pathname, headers: { Host: u.host } }, (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode, text }));
        });
        req.on("error", reject);
        req.end();
    });

await page.goto("http://daly.id.au/admin/wedding/website", { waitUntil: "networkidle" });
const screen = page.locator('[data-testid="wedding-screen"]');
await screen.locator("text=Wedding website").first().waitFor();

// The website must be visible for the public check.
const flags = await api("PUT", "/api/portal/flags/wedding.site.public", { enabled: true });
check("website made visible for the test", flags.status === 200, flags.status);
await page.reload({ waitUntil: "networkidle" });
await screen.locator("text=Wedding website").first().waitFor();

const original = (await api("GET", "/api/platform/wedding-page?path=/portal/wedding/website")).json.data.published.heroEyebrow;
const marker = `Publishing test ${Date.now()}`;

// 1. Edit and publish with the mouse.
const field = screen.getByLabel("Small heading");
await field.click();
await field.fill(marker);
await screen.getByRole("button", { name: "Publish changes" }).click();
const dialog = screen.getByRole("alertdialog").or(screen.getByRole("dialog"));
await dialog.waitFor({ timeout: 5000 }).catch(() => {});
check("clicking Publish changes opens the confirmation", await dialog.isVisible());
const confirm = dialog.getByRole("button", { name: "Publish" });
const published = page.waitForResponse((r) => r.url().endsWith("/api/portal/wedding/website/publish"), { timeout: 10000 }).catch(() => null);
await confirm.click().catch(() => {});
const response = await published;
check("confirming sends the publish request, and it succeeds", response?.status() === 200, response?.status());
await screen.locator("text=Changes published").first().waitFor({ timeout: 5000 }).catch(() => {});
check("the editor says the changes are published", (await screen.locator("text=Changes published").count()) > 0);

// 2. Both public addresses show it straight away, without an identity.
const host = await publicText("http://wedding.daly.id.au/");
check("wedding.daly.id.au shows the published change", host.status === 200 && host.text.includes(marker), host.status);
const byPath = await publicText("http://daly.id.au/wedding");
check("daly.id.au/wedding shows the published change", byPath.status === 200 && byPath.text.includes(marker), byPath.status);

// 3. A draft stays private.
const draftMarker = `Draft only ${Date.now()}`;
await field.click();
await field.fill(draftMarker);
await screen.getByRole("button", { name: "Save draft" }).click();
await page.waitForResponse((r) => r.url().endsWith("/api/portal/settings/website_draft"), { timeout: 10000 }).catch(() => null);
check("Save draft (mouse) saves the draft", (await api("GET", "/api/platform/wedding-page?path=/portal/wedding/website")).json.data.content.heroEyebrow === draftMarker);
check("a saved draft isn't public", !(await publicText("http://wedding.daly.id.au/")).text.includes(draftMarker));

// 4. Other screens' buttons respond to the mouse too (Add guest opens its form).
await page.goto("http://daly.id.au/admin/wedding/guests", { waitUntil: "networkidle" });
await screen.locator("text=Guests").first().waitFor();
const add = screen.getByRole("button", { name: /add guest/i }).first();
await add.click();
const form = screen.getByRole("dialog");
await form.waitFor({ timeout: 5000 }).catch(() => {});
check("Guests → Add guest (mouse) opens its form", await form.isVisible());
await page.keyboard.press("Escape");

// Restore: publish the original text again, and check both addresses.
await api("PUT", "/api/portal/settings/website_draft", { ...(await api("GET", "/api/platform/wedding-page?path=/portal/wedding/website")).json.data.published, heroEyebrow: original });
await api("POST", "/api/portal/wedding/website/publish", {});
const restored = await publicText("http://wedding.daly.id.au/");
check("original text restored on the wedding host", !restored.text.includes(marker), restored.status);
check("no browser errors", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
