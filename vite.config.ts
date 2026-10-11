import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

// Builds the browser bundle. The worker (server render) is bundled separately by Wrangler.
export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    build: {
        outDir: "dist/client",
        emptyOutDir: true,
        rollupOptions: {
            input: path.resolve(__dirname, "shell.html"),
        },
    },
});
