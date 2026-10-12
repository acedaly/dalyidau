import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

// Builds the browser bundle for the personal site and blog. The portal and the wedding site are a
// second, independent build (vite.apps.config.ts) so their components never end up in the blog's
// chunks. The worker (server render) is bundled separately by Wrangler.
export default defineConfig({
    plugins: [react(), tailwindcss()],
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
