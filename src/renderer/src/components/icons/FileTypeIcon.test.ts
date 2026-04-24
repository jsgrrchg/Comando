import { describe, expect, it } from "vitest";

import { hasCatppuccinIcon } from "./catppuccin-icons";
import { resolveCatppuccinFileIcon } from "./FileTypeIcon";

describe("resolveCatppuccinFileIcon", () => {
    it.each([
        ["package.json", "package-json"],
        ["package-lock.json", "npm-lock"],
        ["pnpm-lock.yaml", "pnpm-lock"],
        ["yarn.lock", "yarn-lock"],
        ["bun.lockb", "bun-lock"],
        ["Cargo.lock", "cargo-lock"],
        [".gitignore", "git"],
        [".gitattributes", "git"],
        [".env.local", "env"],
        ["tsconfig.app.json", "typescript-config"],
        ["vite.config.ts", "vite"],
        ["vitest.config.ts", "vitest"],
        ["eslint.config.mjs", "eslint"],
        [".prettierrc.json", "prettier"],
        ["prettier.config.cjs", "prettier"],
        ["Dockerfile.dev", "docker"],
    ])("maps special file %s to %s", (fileName, iconName) => {
        const resolved = resolveCatppuccinFileIcon(fileName);

        expect(resolved.iconName).toBe(iconName);
        expect(hasCatppuccinIcon(resolved.iconName)).toBe(true);
    });

    it.each([
        ["src/App.tsx", "typescript-react"],
        ["src/App.jsx", "javascript-react"],
        ["README.md", "markdown"],
        ["docs/intro.mdx", "markdown-mdx"],
        ["src/index.ts", "typescript"],
        ["src/index.js", "javascript"],
        ["styles/app.css", "css"],
        ["styles/app.scss", "sass"],
        ["scripts/build.sh", "bash"],
        ["src/main.py", "python"],
        ["src/main.rs", "rust"],
        ["src/main.go", "go"],
        ["schema.prisma", "prisma"],
        ["data/query.sql", "database"],
        ["image.png", "image"],
        ["icon.svg", "image"],
    ])("maps language file %s to %s", (fileName, iconName) => {
        const resolved = resolveCatppuccinFileIcon(fileName);

        expect(resolved.iconName).toBe(iconName);
        expect(hasCatppuccinIcon(resolved.iconName)).toBe(true);
    });

    it("falls back to the generic file icon for unknown files", () => {
        expect(resolveCatppuccinFileIcon("unknown.customthing").iconName).toBe(
            "file",
        );
    });
});
