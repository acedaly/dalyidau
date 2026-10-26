// Draws the Wedding Planner app icons (the installable /portal app, docs/PORTAL.md#installing-wedding-planner)
// from Untitled UI's HeartRounded icon on the brand colour, the same mark the portal sidebar uses.
// Writes public/icons/wedding-planner*.{svg,png}. Run after changing the design:
//   node scripts/wedding-app-icons.mjs
// sharp comes with Wrangler's miniflare; it's only needed when regenerating, never at build or run time.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const BRAND = "#7f56d9"; // --color-brand-600 in src/styles/theme.css
const HEART =
    "M16.111 3C19.633 3 22 6.353 22 9.48 22 15.814 12.178 21 12 21c-.178 0-10-5.186-10-11.52C2 6.352 4.367 3 7.889 3 9.91 3 11.233 4.024 12 4.924 12.767 4.024 14.089 3 16.111 3Z";

/** A square icon. `heart` is the heart's width as a share of the icon; `radius` rounds the corners (0 for full bleed). */
const svg = ({ heart, radius }) => {
    const size = 512;
    const scale = (size * heart) / 20; // the path spans x 2–22 of its 24-unit box
    const offset = size / 2 - 12 * scale;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius * size}" fill="${BRAND}"/>
  <g transform="translate(${offset} ${offset + 0.5 * scale}) scale(${scale})">
    <path d="${HEART}" fill="#ffffff" fill-opacity="0.16" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
`;
};

const out = path.resolve(import.meta.dirname, "../public/icons");
await mkdir(out, { recursive: true });

// "any": rounded like the portal's other marks. Maskable and Apple: full bleed, because the system
// applies its own mask, with the heart inside the maskable safe zone (the middle 80%).
const rounded = svg({ heart: 0.56, radius: 0.225 });
const bleed = svg({ heart: 0.5, radius: 0 });

await writeFile(path.join(out, "wedding-planner.svg"), rounded);
const icons = [
    { name: "wedding-planner-192.png", source: rounded, size: 192 },
    { name: "wedding-planner-512.png", source: rounded, size: 512 },
    { name: "wedding-planner-maskable-512.png", source: bleed, size: 512 },
    { name: "wedding-planner-apple-180.png", source: bleed, size: 180 },
];
for (const icon of icons) {
    await sharp(Buffer.from(icon.source)).resize(icon.size, icon.size).png({ compressionLevel: 9 }).toFile(path.join(out, icon.name));
}
console.log(`Wrote ${icons.length + 1} icons to ${path.relative(process.cwd(), out)}`);
