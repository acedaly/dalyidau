#!/usr/bin/env node
// Screenshots of the public site at desktop and phone widths, light and dark, for before/after comparison.
//
//   node scripts/visual-baseline.mjs capture <dir> [origin]     (default origin https://daly.id.au)
//   node scripts/visual-baseline.mjs compare <before> <after>   (pixel diff; exits 1 on any difference above the threshold)
//
// Only public pages. Dates that change by themselves (the footer year) are the same on both sides.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";

const PAGES = ["/", "/blog", "/blog/building-my-ai-chief-of-staff", "/about", "/contact", "/does-not-exist"];
const VIEWPORTS = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
];
const SCHEMES = ["light", "dark"];
const name = (path, vp, scheme) => `${(path === "/" ? "home" : path.slice(1).replace(/\//g, "_")) || "home"}.${vp}.${scheme}.png`;

async function capture(dir, origin) {
    mkdirSync(dir, { recursive: true });
    const browser = await chromium.launch();
    for (const vp of VIEWPORTS)
        for (const scheme of SCHEMES) {
            const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, reducedMotion: "reduce" });
            const page = await context.newPage();
            for (const path of PAGES) {
                await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
                await page.evaluate(() => document.fonts.ready);
                await page.screenshot({ path: join(dir, name(path, vp.name, scheme)), fullPage: true, animations: "disabled" });
            }
            await context.close();
        }
    await browser.close();
    console.log(`captured ${PAGES.length * VIEWPORTS.length * SCHEMES.length} screenshots in ${dir}`);
}

function compare(before, after) {
    let failed = 0;
    for (const file of readdirSync(before).filter((f) => f.endsWith(".png"))) {
        if (!existsSync(join(after, file))) {
            console.log(`MISSING ${file}`);
            failed++;
            continue;
        }
        const a = PNG.sync.read(readFileSync(join(before, file)));
        const b = PNG.sync.read(readFileSync(join(after, file)));
        if (a.width !== b.width || a.height !== b.height) {
            console.log(`SIZE    ${file}: ${a.width}x${a.height} → ${b.width}x${b.height}`);
            failed++;
            continue;
        }
        let diff = 0;
        for (let i = 0; i < a.data.length; i += 4)
            if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 30) diff++;
        const pct = (100 * diff) / (a.width * a.height);
        const ok = pct < 0.1;
        if (!ok) failed++;
        console.log(`${ok ? "same   " : "DIFF   "} ${file}: ${pct.toFixed(3)}% of pixels differ`);
    }
    writeFileSync(join(after, "compare.txt"), `failed=${failed}\n`);
    console.log(failed ? `${failed} screenshot(s) differ` : "all screenshots match");
    process.exit(failed ? 1 : 0);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "capture") await capture(a, b ?? "https://daly.id.au");
else if (cmd === "compare") compare(a, b);
else {
    console.error("usage: visual-baseline.mjs capture <dir> [origin] | compare <before> <after>");
    process.exit(2);
}
