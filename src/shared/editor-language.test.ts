import { describe, expect, it } from "vitest";

import {
    resolveEditorLanguage,
    shouldWrapEditorLanguage,
} from "./editor-language";

describe("resolveEditorLanguage", () => {
    it("detects exact filenames before extensions", () => {
        expect(
            resolveEditorLanguage({
                filePath: "/workspace/Dockerfile",
            }),
        ).toEqual({
            id: "dockerfile",
            label: "Dockerfile",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/Gemfile",
            }),
        ).toEqual({
            id: "ruby",
            label: "Ruby",
        });
    });

    it("detects known extensions automatically", () => {
        expect(
            resolveEditorLanguage({
                filePath: "/workspace/api/main.go",
            }),
        ).toEqual({
            id: "go",
            label: "Go",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/app/schema.graphql",
            }),
        ).toEqual({
            id: "graphql",
            label: "GraphQL",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/config/Cargo.toml",
            }),
        ).toEqual({
            id: "toml",
            label: "TOML",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/src/App.tsx",
            }),
        ).toEqual({
            id: "tsx",
            label: "TSX",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/src/view.jsx",
            }),
        ).toEqual({
            id: "jsx",
            label: "JSX",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/docs/README.md",
            }),
        ).toEqual({
            id: "markdown",
            label: "Markdown",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/src/App.vue",
            }),
        ).toEqual({
            id: "vue",
            label: "Vue",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/src/App.svelte",
            }),
        ).toEqual({
            id: "svelte",
            label: "Svelte",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/src/pages/index.astro",
            }),
        ).toEqual({
            id: "astro",
            label: "Astro",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/prisma/schema.prisma",
            }),
        ).toEqual({
            id: "prisma",
            label: "Prisma",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/infra/main.tf",
            }),
        ).toEqual({
            id: "hcl",
            label: "HCL / Terraform",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/infra/variables.tfvars",
            }),
        ).toEqual({
            id: "hcl",
            label: "HCL / Terraform",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/infra/shared.hcl",
            }),
        ).toEqual({
            id: "hcl",
            label: "HCL / Terraform",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/src/Program.cs",
            }),
        ).toEqual({
            id: "csharp",
            label: "C#",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/app/Main.kt",
            }),
        ).toEqual({
            id: "kotlin",
            label: "Kotlin",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/app/main.kts",
            }),
        ).toEqual({
            id: "kotlin",
            label: "Kotlin",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/app/Main.scala",
            }),
        ).toEqual({
            id: "scala",
            label: "Scala",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/lib/demo.ex",
            }),
        ).toEqual({
            id: "elixir",
            label: "Elixir",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/lib/demo.exs",
            }),
        ).toEqual({
            id: "elixir",
            label: "Elixir",
        });
    });

    it("falls back to the shebang for extensionless scripts", () => {
        expect(
            resolveEditorLanguage({
                filePath: "/workspace/scripts/dev",
                probeContent: "#!/usr/bin/env bash\nset -e\n",
            }),
        ).toEqual({
            id: "shell",
            label: "Shell",
        });

        expect(
            resolveEditorLanguage({
                filePath: "/workspace/scripts/task",
                probeContent: "#!/usr/bin/python3.11\nprint('ok')\n",
            }),
        ).toEqual({
            id: "python",
            label: "Python",
        });
    });

    it("returns plain text when no language matches", () => {
        expect(
            resolveEditorLanguage({
                filePath: "/workspace/notes/README",
            }),
        ).toEqual({
            id: "plaintext",
            label: "Plain Text",
        });
    });
});

describe("shouldWrapEditorLanguage", () => {
    it("wraps markdown-like content only", () => {
        expect(shouldWrapEditorLanguage("markdown")).toBe(true);
        expect(shouldWrapEditorLanguage("mdx")).toBe(true);
        expect(shouldWrapEditorLanguage("typescript")).toBe(false);
    });
});
