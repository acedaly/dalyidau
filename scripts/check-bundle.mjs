// Guards the client build (run after `npm run build:client`):
//  - the blog's assets contain no portal or wedding code, and stay within a size budget;
//  - no client asset contains server-only configuration names or anything that looks like a secret.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT, Report } from "./lib/ops.mjs";

const dist = join(ROOT, "dist", "client");
const report = new Report();
const assetsOf = (html) => [...readFileSync(join(dist, html), "utf8").matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);

// The blog's own code, followed through static imports.
const blog = new Set(assetsOf("shell.html"));
for (const file of [...blog]) {
    if (!file.endsWith(".js")) continue;
    for (const m of readFileSync(join(dist, file), "utf8").matchAll(/from"\.\/([\w.-]+\.js)"/g)) blog.add(`assets/${m[1]}`);
}
const blogJs = [...blog].filter((f) => f.endsWith(".js"));
const blogCss = [...blog].filter((f) => f.endsWith(".css"));
const size = (files) => files.reduce((n, f) => n + statSync(join(dist, f)).size, 0);

const PORTAL_MARKERS = ["/api/portal/", "Wedding portal", "wedding-theme", "recharts", "Cormorant Garamond", "rsvp-test"];
for (const file of blogJs) {
    const text = readFileSync(join(dist, file), "utf8");
    const found = PORTAL_MARKERS.filter((m) => text.includes(m));
    report.check(found.length === 0, `${file} has no portal or wedding code`, `${file} contains portal/wedding code: ${found.join(", ")}`);
}
const JS_BUDGET = 480 * 1024;
const CSS_BUDGET = 180 * 1024;
report.check(
    size(blogJs) <= JS_BUDGET,
    `Blog JavaScript ${(size(blogJs) / 1024).toFixed(0)} KB (budget ${JS_BUDGET / 1024} KB)`,
    `Blog JavaScript is ${(size(blogJs) / 1024).toFixed(0)} KB, over the ${JS_BUDGET / 1024} KB budget`,
);
report.check(
    size(blogCss) <= CSS_BUDGET,
    `Blog CSS ${(size(blogCss) / 1024).toFixed(0)} KB (budget ${CSS_BUDGET / 1024} KB)`,
    `Blog CSS is ${(size(blogCss) / 1024).toFixed(0)} KB, over the ${CSS_BUDGET / 1024} KB budget`,
);

// Nothing secret anywhere in the client build. Setting NAMES may appear in help text; VALUES never.
const values = new Set();
for (const file of [".dev.vars", "e2e/e2e.vars"]) {
    let text = "";
    try {
        text = readFileSync(join(ROOT, file), "utf8");
    } catch {
        continue;
    }
    for (const line of text.split("\n")) {
        const m = /^(ACCESS_\w+|PORTAL_OWNER_EMAILS|ADMIN_TOKEN|CAPACITIES_API_TOKEN)=(.+)$/.exec(line.trim());
        if (m)
            for (const v of m[2]
                .split(",")
                .map((x) => x.trim())
                .filter((x) => x.length >= 6))
                values.add(v);
    }
}
const PATTERNS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, /[a-z0-9-]+\.cloudflareaccess\.com/];
const all = readdirSync(join(dist, "assets")).filter((f) => /\.(js|css)$/.test(f));
let leaks = 0;
for (const file of [...all.map((f) => `assets/${f}`), "shell.html", "shell-portal.html", "shell-wedding.html"]) {
    const text = readFileSync(join(dist, file), "utf8");
    for (const value of values) if (text.includes(value)) (leaks++, report.fail(`${file} contains a configured secret or owner email`));
    for (const pattern of PATTERNS)
        if (pattern.test(text)) (leaks++, report.fail(`${file} contains something that looks like a secret (${pattern.source.slice(0, 24)}…)`));
}
if (!leaks) report.pass(`No secrets or owner emails in ${all.length + 3} client files`);
report.finish();
