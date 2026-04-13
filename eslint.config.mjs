import path from "node:path";
import { fileURLToPath } from "node:url";

import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
    {
        ignores: [
            "coverage/**",
            "dist/**",
            "dist-electron/**",
            "eslint.config.mjs",
            "node_modules/**",
            "out/**",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        files: ["**/*.{ts,tsx,mts,cts}"],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: rootDir,
            },
        },
    },
    {
        files: [
            "src/main/**/*.ts",
            "src/preload/**/*.ts",
            "electron.vite.config.ts",
            "vitest.config.ts",
        ],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },
    {
        files: ["src/renderer/**/*.ts", "src/renderer/**/*.tsx"],
        languageOptions: {
            globals: {
                ...globals.browser,
            },
        },
        plugins: {
            "react-hooks": reactHooks,
        },
        rules: {
            ...reactHooks.configs.recommended.rules,
        },
    },
);
