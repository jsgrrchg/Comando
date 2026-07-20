import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
    root: path.resolve(rootDir, "e2e/harness"),
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@main": path.resolve(rootDir, "src/main"),
            "@preload": path.resolve(rootDir, "src/preload"),
            "@renderer": path.resolve(rootDir, "src/renderer/src"),
            "@shared": path.resolve(rootDir, "src/shared"),
        },
    },
    server: {
        port: 5181,
        strictPort: true,
    },
    build: {
        outDir: path.resolve(rootDir, "e2e/dist"),
    },
});
