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
        ).toBe("/workspace/comando/src/app.ts::workspace-tab::tab-1::editor");
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
