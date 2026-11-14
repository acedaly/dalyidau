import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { type Plugin, defineConfig } from "vite";

// Builds the browser bundle for the personal site and blog. The portal and the wedding site are a
// second, independent build (vite.apps.config.ts) so their components never end up in the blog's
// chunks. The worker (server render) is bundled separately by Wrangler.
/**
 * Preloads the two fonts every page's first screen is set in, so text doesn't wait for the stylesheet to be
 * read before its font is even requested (docs/AUDIT-2026-11.md, M10): Inter (body) always, and Space Grotesk
 * (headings) for the projects-first design. The Worker drops the second on pages that don't use it
 * (worker/index.ts renderDocument). Only the Latin files: other scripts load on demand, as before.
 */
const preloadFonts = (): Plugin => ({
    name: "daly-preload-fonts",
    transformIndexHtml: {
        order: "post",
        handler(html, ctx) {
            const files = Object.keys(ctx.bundle ?? {});
            const find = (pattern: RegExp) => files.find((file) => pattern.test(file));
            const fonts = [
                { file: find(/inter-latin-wght-normal-[\w-]+\.woff2$/), design: null },
                { file: find(/space-grotesk-latin-600-normal-[\w-]+\.woff2$/), design: "projects" },
            ];
            return fonts
                .filter((font) => font.file)
                .map((font) => ({
                    tag: "link",
                    attrs: {
                        rel: "preload",
                        as: "font",
                        type: "font/woff2",
                        href: `/${font.file}`,
                        crossorigin: "",
                        ...(font.design ? { "data-design": font.design } : {}),
                    },
                    injectTo: "head-prepend" as const,
                }));
        },
    },
});

export default defineConfig({
    plugins: [react(), tailwindcss(), preloadFonts()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    build: {
        outDir: "dist/client",
        // build:client clears dist/client once before both builds run.
        emptyOutDir: false,
        rollupOptions: {
            input: path.resolve(__dirname, "shell.html"),
        },
    },
});
