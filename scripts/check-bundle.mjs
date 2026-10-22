// Guards the client build (run after `npm run build:client`):
//  - the blog's assets contain no portal or wedding code, and stay within a size budget;
//  - Tailwind scans exactly the source files the blog imports (see src/styles/globals.css);
//  - no client asset contains server-only configuration names or anything that looks like a secret.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

// Tailwind scans only the files globals.css lists, so it must list every file the blog imports (or
// that file's classes are silently missing) and nothing else (or unused classes creep back in).
const STYLES = join(ROOT, "src", "styles");
const globalsCss = readFileSync(join(STYLES, "globals.css"), "utf8");
const sources = [...globalsCss.matchAll(/@source (not )?"([^"]+)"/g)].map((m) => ({ not: Boolean(m[1]), path: relative(ROOT, resolve(STYLES, m[2])) }));
const under = (path, file) => file === path || file.startsWith(`${path}/`);
const scanned = (file) => sources.some((s) => !s.not && under(s.path, file)) && !sources.some((s) => s.not && under(s.path, file));
const isFile = (file) => existsSync(join(ROOT, file)) && statSync(join(ROOT, file)).isFile();
const resolveImport = (from, spec) => {
    const base = spec.startsWith("@/") ? join("src", spec.slice(2)) : spec.startsWith(".") ? join(dirname(from), spec) : null;
    return base && ["", ".tsx", ".ts", "/index.tsx", "/index.ts"].map((ext) => base + ext).find((f) => /\.tsx?$/.test(f) && isFile(f));
};
const blogSources = new Set();
for (const queue = ["src/entry-client.tsx"]; queue.length;) {
    const file = queue.pop();
    if (blogSources.has(file)) continue;
    blogSources.add(file);
    for (const m of readFileSync(join(ROOT, file), "utf8").matchAll(/^(?:import|export) (?!type\b)[^;]*?from "([^"]+)"/gm)) {
        const target = resolveImport(file, m[1]);
        if (target) queue.push(target);
    }
}
const unscanned = [...blogSources].filter((f) => !scanned(f));
report.check(
    unscanned.length === 0,
    `Tailwind scans all ${blogSources.size} files the blog imports`,
    `globals.css doesn't scan files the blog imports (add an @source): ${unscanned.join(", ")}`,
);
const listFiles = (path) => (statSync(join(ROOT, path)).isDirectory() ? readdirSync(join(ROOT, path)).flatMap((f) => listFiles(join(path, f))) : [path]);
const extra = [...new Set(sources.filter((s) => !s.not).flatMap((s) => listFiles(s.path)))].filter(
    (f) => /\.tsx?$/.test(f) && scanned(f) && !blogSources.has(f),
);
report.check(
    extra.length === 0,
    "Tailwind scans nothing the blog doesn't import",
    `globals.css scans files the blog doesn't import (narrow the @source or add an @source not): ${extra.join(", ")}`,
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
