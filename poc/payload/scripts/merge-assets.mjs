// Copies the existing site's build (../../dist/client) into OpenNext's asset directory so one asset
// binding serves both. Refuses to overwrite: a name clash between the two builds fails the build.
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const from = path.resolve(root, "../../dist/client");
const to = path.resolve(root, ".open-next/assets");
if (!existsSync(from)) throw new Error("Run `npm run build:client` in the repository root first.");

const clashes = [];
const walk = (dir) => {
    for (const name of readdirSync(dir)) {
        const source = path.join(dir, name);
        const rel = path.relative(from, source);
        if (statSync(source).isDirectory()) walk(source);
        else if (rel !== "_headers" && existsSync(path.join(to, rel))) clashes.push(rel);
    }
};
walk(from);
if (clashes.length) throw new Error(`Asset name clash between Payload and the existing site: ${clashes.join(", ")}`);
cpSync(from, to, { recursive: true, filter: (source) => path.relative(from, source) !== "_headers" });
// _headers rules from both builds (the Worker runs first, but files it passes through keep these).
const headers = [path.join(to, "_headers"), path.join(from, "_headers")].filter(existsSync).map((file) => readFileSync(file, "utf8").trim());
writeFileSync(path.join(to, "_headers"), `${headers.join("\n\n")}\n`);
console.log(`Merged ${from} into ${to}`);
