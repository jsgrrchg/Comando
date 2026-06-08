import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            "@main": path.resolve(rootDir, "src/main"),
            "@preload": path.resolve(rootDir, "src/preload"),
            "@renderer": path.resolve(rootDir, "src/renderer/src"),
            "@shared": path.resolve(rootDir, "src/shared"),
        },
    },
    test: {
        environment: "node",
        include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    },
});
