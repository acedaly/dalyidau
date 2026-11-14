// Renders the default sharing image (1200×630) from the Daly logo pack. Run from the repository root.
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
const logo = readFileSync("public/brand/daly-logo-reversed.svg", "utf8").replace(/<\?xml[^>]*>/, "");
const font = readFileSync("node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-600-normal.woff2").toString("base64");
const html = `<!doctype html><html><head><style>
@font-face { font-family: "Space Grotesk"; font-weight: 600; src: url(data:font/woff2;base64,${font}) format("woff2"); }
html, body { margin: 0; }
body { width: 1200px; height: 630px; background: #10203a; display: flex; flex-direction: column; justify-content: space-between; box-sizing: border-box; padding: 88px 96px; font-family: "Space Grotesk", sans-serif; }
.logo svg { height: 150px; width: auto; display: block; }
.rule { width: 96px; height: 8px; background: #e4572e; border-radius: 4px; }
.address { color: #b6c0ce; font-size: 40px; font-weight: 600; letter-spacing: -0.01em; }
</style></head><body><div class="logo">${logo}</div><div><div class="rule"></div><p class="address" style="margin:28px 0 0">daly.id.au</p></div></body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
writeFileSync(process.argv[2], await page.screenshot({ type: "png" }));
await browser.close();
