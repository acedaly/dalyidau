#!/usr/bin/env node
// Captures of the public wedding homepage for docs/design/wedding-redesign (and before/after review).
//   node scripts/wedding-captures.mjs <outdir> [origin]   (default origin http://localhost:8787, path /wedding)
// Turn the wedding site on in the local database first; this script never changes settings.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [outdir, origin = "http://localhost:8787"] = process.argv.slice(2);
if (!outdir) throw new Error("usage: wedding-captures.mjs <outdir> [origin]");
mkdirSync(outdir, { recursive: true });
const VIEWPORTS = { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } };
// Section captures by the first matching selector.
const SECTIONS = {
    venue: ["#the-day", "#venue"],
    accommodation: ["#stay-and-travel", "#stay"],
    faq: ["#faq"],
    rsvp: ["#rsvp"],
    footer: ["footer"],
};
const browser = await chromium.launch();
for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
        isMobile: name === "mobile",
        hasTouch: name === "mobile",
    });
    const page = await context.newPage();
    await page.goto(`${origin}/wedding`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    const shot = (file, opts) => page.screenshot({ path: join(outdir, `${file}-${name}.jpg`), type: "jpeg", quality: 82, animations: "disabled", ...opts });
    await shot("hero", {});
    await shot("homepage", { fullPage: true });
    for (const [file, selectors] of Object.entries(SECTIONS)) {
        for (const selector of selectors) {
            const el = page.locator(selector).first();
            if ((await el.count()) && (await el.boundingBox())?.height) {
                await el.scrollIntoViewIfNeeded();
                await el.screenshot({ path: join(outdir, `${file}-${name}.jpg`), type: "jpeg", quality: 82, animations: "disabled" });
                break;
            }
        }
    }
    await context.close();
}
await browser.close();
console.log(`captured in ${outdir}`);
