import { describe, expect, it } from "vitest";
import { resolveEditorLanguage, shouldWrapEditorLanguage, } from "./editor-language";
describe("resolveEditorLanguage", () => {
    it("detects exact filenames before extensions", () => {
        expect(resolveEditorLanguage({
            filePath: "/workspace/Dockerfile",
        })).toEqual({
            id: "dockerfile",
            label: "Dockerfile",
        });
        expect(resolveEditorLanguage({
            filePath: "/workspace/Gemfile",
        })).toEqual({
            id: "ruby",
            label: "Ruby",
        });
    });
    it("detects known extensions automatically", () => {
        expect(resolveEditorLanguage({
            filePath: "/workspace/api/main.go",
        })).toEqual({
            id: "go",
            label: "Go",
        });
        expect(resolveEditorLanguage({
            filePath: "/workspace/app/schema.graphql",
        })).toEqual({
            id: "graphql",
            label: "GraphQL",
        });
    });
    it("falls back to the shebang for extensionless scripts", () => {
        expect(resolveEditorLanguage({
            filePath: "/workspace/scripts/dev",
            probeContent: "#!/usr/bin/env bash\nset -e\n",
        })).toEqual({
            id: "shell",
            label: "Shell",
        });
        expect(resolveEditorLanguage({
            filePath: "/workspace/scripts/task",
            probeContent: "#!/usr/bin/python3.11\nprint('ok')\n",
        })).toEqual({
            id: "python",
            label: "Python",
        });
    });
    it("returns plain text when no language matches", () => {
        expect(resolveEditorLanguage({
            filePath: "/workspace/notes/README",
        })).toEqual({
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
