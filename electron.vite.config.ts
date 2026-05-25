import { readFileSync } from "node:fs";
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

// In Vite 8 / Rolldown, ssr.noExternal:true (set by electron-vite's preset) overrides
// externals added via plugin config() hooks. Static rollupOptions.external still works,
// so we compute the list here rather than relying solely on externalizeDepsPlugin().
const pkg = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
);
const mainExternal = [
    "electron",
    /^electron\/.+/,
    ...Object.keys(pkg.dependencies ?? {}),
];

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        resolve: {
            alias: aliases,
        },
        build: {
            outDir: "out/main",
            rollupOptions: {
                external: mainExternal,
            },
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
                external: mainExternal,
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
