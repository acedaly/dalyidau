import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

// Browser bundles for the portal (/portal) and the public wedding website (/wedding). Built
// separately from the blog (vite.config.ts): in one build, React Aria's package index makes every
// component the portal uses look shared with the blog, and they leak into the blog's chunks.
export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "./src"),
        },
    },
    // MapLibre's worker (Intelligence Centre maps) is an ES module; bundled and served from this origin.
    worker: { format: "es" },
    build: {
        outDir: "dist/client",
        emptyOutDir: false,
        // The portal is a private, authenticated app; one larger chunk is fine there.
        chunkSizeWarningLimit: 1200,
        rollupOptions: {
            input: {
                portal: path.resolve(import.meta.dirname, "shell-portal.html"),
                wedding: path.resolve(import.meta.dirname, "shell-wedding.html"),
                display: path.resolve(import.meta.dirname, "shell-display.html"),
            },
        },
    },
});
