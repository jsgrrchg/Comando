export interface SyntaxHighlightFixture {
    readonly content: string;
    readonly filePath: string;
    readonly id: string;
    readonly languageId: string;
}

export interface LargeSyntaxHighlightFixture {
    readonly createContent: () => string;
    readonly filePath: string;
    readonly id: string;
    readonly languageId: string;
    readonly minBytes: number;
}

export const MINIFIED_TYPESCRIPT_FIXTURE_MIN_BYTES = 2 * 1024 * 1024 + 1;
export const LARGE_JSON_FIXTURE_MIN_BYTES = 10 * 1024 * 1024 + 1;

export const SYNTAX_HIGHLIGHT_BASELINE_FIXTURES: readonly SyntaxHighlightFixture[] =
    [
        {
            content: [
                "type User = { readonly id: string; name?: string };",
                "export async function loadUser(id: string): Promise<User> {",
                '    return { id, name: "Ada" };',
                "}",
            ].join("\n"),
            filePath: "fixtures/sample.ts",
            id: "typescript",
            languageId: "typescript",
        },
        {
            content: [
                "type Props = { title: string; count?: number };",
                "export function Card({ title, count = 0 }: Props) {",
                "    return <section data-count={count}><h1>{title}</h1></section>;",
                "}",
            ].join("\n"),
            filePath: "fixtures/Card.tsx",
            id: "tsx",
            languageId: "tsx",
        },
        {
            content: [
                "const value = new Map([[\"answer\", 42]]);",
                "export function read(key) {",
                "    return value.get(key) ?? null;",
                "}",
            ].join("\n"),
            filePath: "fixtures/module.js",
            id: "javascript",
            languageId: "javascript",
        },
        {
            content: [
                "export const View = ({ label }) => (",
                "    <button aria-label={label}>{label.toUpperCase()}</button>",
                ");",
            ].join("\n"),
            filePath: "fixtures/View.jsx",
            id: "jsx",
            languageId: "jsx",
        },
        {
            content: JSON.stringify(
                {
                    dependencies: { comando: "workspace:*" },
                    private: true,
                    scripts: { test: "vitest run" },
                },
                null,
                2,
            ),
            filePath: "fixtures/package.json",
            id: "json",
            languageId: "json",
        },
        {
            content: [
                "{",
                "    // Comments are part of the JSONC baseline.",
                '    "editor.tabSize": 4,',
                '    "files.associations": { "*.tsx": "typescriptreact" }',
                "}",
            ].join("\n"),
            filePath: "fixtures/settings.jsonc",
            id: "jsonc",
            languageId: "jsonc",
        },
        {
            content: [
                "# Syntax Highlight Baseline",
                "",
                "## Embedded Blocks",
                "",
                "A paragraph with `inlineCode` and a link to [Comando](./README.md).",
                "",
                "- TypeScript fence",
                "- JSON fence",
                "- Shell fence",
                "",
                "```ts",
                "export const answer: number = 42;",
                "```",
                "",
                "```json",
                '{ "ok": true, "items": [1, 2, 3] }',
                "```",
                "",
                "```bash",
                'printf "%s\\n" "$COMANDO_ENV"',
                "```",
            ].join("\n"),
            filePath: "fixtures/README.md",
            id: "markdown",
            languageId: "markdown",
        },
        {
            content: [
                "<!doctype html>",
                '<html lang="en">',
                "    <body>",
                '        <main class="shell"><h1>Comando</h1></main>',
                "    </body>",
                "</html>",
            ].join("\n"),
            filePath: "fixtures/index.html",
            id: "html",
            languageId: "html",
        },
        {
            content: [
                ":root { --accent: #6366f1; }",
                ".button {",
                "    color: rgb(255 255 255);",
                "    background: var(--accent);",
                "}",
            ].join("\n"),
            filePath: "fixtures/styles.css",
            id: "css",
            languageId: "css",
        },
        {
            content: [
                "$accent: #6366f1;",
                ".button {",
                "    &:hover { color: lighten($accent, 10%); }",
                "}",
            ].join("\n"),
            filePath: "fixtures/styles.scss",
            id: "scss",
            languageId: "scss",
        },
        {
            content: [
                "name: Comando",
                "on:",
                "  push:",
                "    branches: [main]",
            ].join("\n"),
            filePath: "fixtures/workflow.yml",
            id: "yaml",
            languageId: "yaml",
        },
        {
            content: [
                "<template>",
                '  <button :class="{ active }">{{ label }}</button>',
                "</template>",
                "<script setup lang=\"ts\">",
                "defineProps<{ label: string; active?: boolean }>();",
                "</script>",
            ].join("\n"),
            filePath: "fixtures/ActionButton.vue",
            id: "vue",
            languageId: "vue",
        },
        {
            content: [
                "<script lang=\"ts\">",
                "    export let label: string;",
                "</script>",
                "",
                "<button class:primary>{label}</button>",
            ].join("\n"),
            filePath: "fixtures/ActionButton.svelte",
            id: "svelte",
            languageId: "svelte",
        },
        {
            content: [
                "model User {",
                "  id    String @id @default(cuid())",
                "  email String @unique",
                "}",
            ].join("\n"),
            filePath: "fixtures/schema.prisma",
            id: "prisma",
            languageId: "prisma",
        },
        {
            content: [
                "query UserCard($id: ID!) {",
                "  user(id: $id) { id name repositories(first: 3) { nodes { name } } }",
                "}",
            ].join("\n"),
            filePath: "fixtures/query.graphql",
            id: "graphql",
            languageId: "graphql",
        },
        {
            content: [
                "select users.id, count(*) as total",
                "from users",
                "where users.active = true",
                "group by users.id;",
            ].join("\n"),
            filePath: "fixtures/report.sql",
            id: "sql",
            languageId: "sql",
        },
        {
            content: [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                'for file in "$@"; do echo "checking $file"; done',
            ].join("\n"),
            filePath: "fixtures/script.sh",
            id: "shell",
            languageId: "shell",
        },
        {
            content: [
                "from dataclasses import dataclass",
                "",
                "@dataclass(frozen=True)",
                "class User:",
                "    name: str",
            ].join("\n"),
            filePath: "fixtures/model.py",
            id: "python",
            languageId: "python",
        },
        {
            content: [
                "pub fn greet(name: &str) -> String {",
                "    format!(\"hello {name}\")",
                "}",
            ].join("\n"),
            filePath: "fixtures/lib.rs",
            id: "rust",
            languageId: "rust",
        },
        {
            content: ["COMANDO_ENV=development", "VITE_DEBUG=true"].join("\n"),
            filePath: "fixtures/.env",
            id: "env",
            languageId: "shell",
        },
        {
            content: [
                "export COMANDO_ENV=development",
                "source .env.local",
            ].join("\n"),
            filePath: "fixtures/.envrc",
            id: "envrc",
            languageId: "shell",
        },
        {
            content: ["node_modules/", "dist/", ".DS_Store"].join("\n"),
            filePath: "fixtures/.gitignore",
            id: "gitignore",
            languageId: "plaintext",
        },
    ];

export const SYNTAX_HIGHLIGHT_LARGE_FIXTURES: readonly LargeSyntaxHighlightFixture[] =
    [
        {
            createContent: createMinifiedTypeScriptFixture,
            filePath: "fixtures/bundle.min.ts",
            id: "minified-typescript",
            languageId: "typescript",
            minBytes: MINIFIED_TYPESCRIPT_FIXTURE_MIN_BYTES,
        },
        {
            createContent: createLargeJsonFixture,
            filePath: "fixtures/large.json",
            id: "large-json",
            languageId: "json",
            minBytes: LARGE_JSON_FIXTURE_MIN_BYTES,
        },
    ];

export function createMinifiedTypeScriptFixture(
    minBytes = MINIFIED_TYPESCRIPT_FIXTURE_MIN_BYTES,
): string {
    const prefix = "export const bundle=[";
    const suffix = "0] as const;";
    const repeatedItem = "1,";
    const repeatCount = Math.max(
        0,
        Math.ceil((minBytes - prefix.length - suffix.length) / repeatedItem.length),
    );

    return `${prefix}${repeatedItem.repeat(repeatCount)}${suffix}`;
}

export function createLargeJsonFixture(
    minBytes = LARGE_JSON_FIXTURE_MIN_BYTES,
): string {
    const prefix = '{"items":[';
    const suffix = '{"id":"last","enabled":false}]}';
    const repeatedItem =
        '{"id":"fixture","enabled":true,"tags":["alpha","beta"],"count":42},';
    const repeatCount = Math.max(
        0,
        Math.ceil((minBytes - prefix.length - suffix.length) / repeatedItem.length),
    );

    return `${prefix}${repeatedItem.repeat(repeatCount)}${suffix}`;
}
