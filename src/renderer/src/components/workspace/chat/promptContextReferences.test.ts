import { describe, expect, it } from "vitest";

import type { AiFileContextAttachment } from "@shared/ipc";
import {
    buildFileContextLabel,
    buildFileContextReference,
    buildFileContextTitle,
    serializePromptWithContexts,
} from "./promptContextReferences";

function createFileContext(
    overrides: Partial<AiFileContextAttachment> = {},
): AiFileContextAttachment {
    return {
        extension: "ts",
        id: "ctx-1",
        languageId: "typescript",
        name: "app.ts",
        projectId: "project-1",
        relativePath: "src/app.ts",
        ...overrides,
    };
}

describe("promptContextReferences", () => {
    it("formats file context references with optional line ranges", () => {
        expect(buildFileContextReference(createFileContext())).toBe(
            "src/app.ts",
        );
        expect(
            buildFileContextReference(
                createFileContext({
                    endLine: 18,
                    startLine: 12,
                }),
            ),
        ).toBe("src/app.ts:12-18");
        expect(
            buildFileContextReference(
                createFileContext({
                    endLine: 12,
                    startLine: 12,
                }),
            ),
        ).toBe("src/app.ts:12");
    });

    it("builds labels and titles for line fragments", () => {
        const fileContext = createFileContext({
            endLine: 18,
            selectedText: "const value = 1;",
            startLine: 12,
        });

        expect(buildFileContextLabel(fileContext)).toBe("app.ts:12-18");
        expect(buildFileContextTitle(fileContext)).toContain("src/app.ts:12-18");
        expect(buildFileContextTitle(fileContext)).toContain(
            "const value = 1;",
        );
    });

    it("serializes prompt context references including line fragments", () => {
        expect(
            serializePromptWithContexts("", [
                createFileContext({
                    endLine: 18,
                    startLine: 12,
                }),
            ]),
        ).toBe("Review these references\n\nContext references:\n- src/app.ts:12-18");

        expect(
            serializePromptWithContexts("Please inspect this", [
                createFileContext({
                    endLine: 18,
                    startLine: 12,
                }),
                createFileContext({
                    id: "ctx-2",
                    relativePath: "src/other.ts",
                }),
            ]),
        ).toBe(
            "Please inspect this\n\nContext references:\n- src/app.ts:12-18\n- src/other.ts",
        );
    });
});
