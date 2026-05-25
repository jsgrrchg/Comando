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

interface PackageJson {
    readonly dependencies?: Record<string, string>;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// In Vite 8 / Rolldown, ssr.noExternal:true (set by electron-vite's preset) overrides
// externals added via plugin config() hooks. Static rollupOptions.external still works,
// so we compute the list here rather than relying solely on externalizeDepsPlugin().
const pkg = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as PackageJson;
const dependencies = Object.keys(pkg.dependencies ?? {});
const mainExternal = [
    "electron",
    /^electron\/.+/,
    ...dependencies,
    new RegExp(`^(${dependencies.map(escapeRegExp).join("|")})/.+`),
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
