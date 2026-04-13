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
            "node_modules/**",
            "out/**",
        ],
    },
    js.configs.recommended,
    {
        files: ["**/*.{ts,tsx,mts,cts}"],
        extends: tseslint.configs.recommendedTypeChecked,
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: rootDir,
            },
        },
    },
    {
        files: ["eslint.config.mjs"],
        extends: [tseslint.configs.disableTypeChecked],
        languageOptions: {
            globals: {
                ...globals.node,
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
