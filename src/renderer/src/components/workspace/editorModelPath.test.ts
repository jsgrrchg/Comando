import { describe, expect, it } from "vitest";

import { buildWorkspaceEditorModelPath } from "./editorModelPath";

describe("buildWorkspaceEditorModelPath", () => {
    it("creates stable model paths for a specific tab and variant", () => {
        expect(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/app.ts",
                "tab-1",
                "editor",
            ),
        ).toBe("/workspace/comando/src/app__workspace-tab__tab-1__editor.ts");
    });

    it("preserves the real extension for TSX files", () => {
        expect(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/App.tsx",
                "tab-1",
                "editor",
            ),
        ).toBe("/workspace/comando/src/App__workspace-tab__tab-1__editor.tsx");
    });

    it("preserves compound declaration extensions", () => {
        expect(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/types.d.ts",
                "tab-1",
                "editor",
            ),
        ).toBe(
            "/workspace/comando/src/types__workspace-tab__tab-1__editor.d.ts",
        );
    });

    it("keeps extensionless paths stable", () => {
        expect(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/Makefile",
                "tab-1",
                "editor",
            ),
        ).toBe("/workspace/comando/Makefile__workspace-tab__tab-1__editor");
    });

    it("creates different model paths for duplicate tabs of the same file", () => {
        expect(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/app.ts",
                "tab-1",
                "editor",
            ),
        ).not.toBe(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/app.ts",
                "tab-2",
                "editor",
            ),
        );
    });

    it("creates different model paths for editor and review variants", () => {
        expect(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/app.ts",
                "tab-1",
                "editor",
            ),
        ).not.toBe(
            buildWorkspaceEditorModelPath(
                "/workspace/comando/src/app.ts",
                "tab-1",
                "review-modified",
            ),
        );
    });
});
