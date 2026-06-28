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
            "**/*.d.ts",
            // Generated wasm-bindgen glue for the Rust review engine.
            "src/shared/ai-review-engine/wasm/**",
            "build/**",
            "coverage/**",
            "dist/**",
            "dist-electron/**",
            "node_modules/**",
            "out/**",
            "resources/**",
            "scripts/**",
            "vendor/**",
            "electron.vite.config.js",
            "vitest.config.js",
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
            "react-hooks/preserve-manual-memoization": "off",
            "react-hooks/refs": "off",
            "react-hooks/set-state-in-effect": "off",
        },
    },
    {
        files: [
            "src/renderer/src/App.tsx",
            "src/renderer/src/components/workspace/**/*.ts",
            "src/renderer/src/components/workspace/**/*.tsx",
        ],
        rules: {
            "react-hooks/refs": "warn",
            "react-hooks/set-state-in-effect": "warn",
        },
    },
    {
        files: [
            "src/main/ai/**/*.ts",
            "src/main/db/**/*.ts",
            "src/main/git/**/*.ts",
            "src/main/persistence/**/*.ts",
            "src/main/projects/**/*.ts",
            "src/main/workspace/**/*.ts",
        ],
        ignores: ["**/*.test.ts"],
        rules: {
            "@typescript-eslint/no-confusing-void-expression": "warn",
            "@typescript-eslint/no-meaningless-void-operator": "warn",
            "@typescript-eslint/no-unnecessary-condition": "warn",
            "@typescript-eslint/switch-exhaustiveness-check": "warn",
            "@typescript-eslint/use-unknown-in-catch-callback-variable":
                "warn",
        },
    },
);
