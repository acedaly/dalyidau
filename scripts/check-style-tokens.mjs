// Portal and wedding compositions must use Untitled UI semantic tokens so light/dark/wedding
// themes remain consistent. Installed design-system primitives are validated upstream and excluded.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "src/portal", "src/wedding"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((file) => /\.(?:ts|tsx|css)$/.test(file));
const palette = /\b(?:text|bg|border|ring|outline|fill|stroke)-(?:gray|blue|red|green|yellow|purple|orange|slate|zinc|neutral|stone)-\d{2,3}\b/g;
const failures = [];
for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(palette)) {
        const line = source.slice(0, match.index).split("\n").length;
        failures.push(`${file}:${line}: ${match[0]}`);
    }
}
if (failures.length) {
    console.error("Use Untitled UI semantic tokens in portal and wedding compositions:\n" + failures.join("\n"));
    process.exit(1);
}
console.log(`Style tokens OK (${files.length} portal/wedding files)`);
