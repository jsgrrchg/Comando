import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

const aliases = {
    "@main": path.resolve(rootDir, "src/main"),
    "@preload": path.resolve(rootDir, "src/preload"),
    "@renderer": path.resolve(rootDir, "src/renderer/src"),
    "@shared": path.resolve(rootDir, "src/shared"),
};

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        resolve: {
            alias: aliases,
        },
        build: {
            outDir: "out/main",
        },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        resolve: {
            alias: aliases,
        },
        build: {
            outDir: "out/preload",
            rollupOptions: {
                output: {
                    entryFileNames: "[name].cjs",
                    format: "cjs",
                },
            },
        },
    },
    renderer: {
        resolve: {
            alias: aliases,
        },
        plugins: [react(), tailwindcss()],
        build: {
            outDir: "out/renderer",
        },
    },
});
