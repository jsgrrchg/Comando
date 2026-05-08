import { describe, expect, it } from "vitest";

import type { AiFileContextAttachment } from "@shared/ipc";
import {
    buildGitHubComposerReferences,
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

    it("serializes GitHub composer references in a dedicated prompt block", () => {
        expect(
            serializePromptWithContexts(
                "Compare these",
                [],
                [
                    {
                        host: "github.com",
                        label: "#123",
                        number: 123,
                        owner: "comando",
                        repo: "app",
                        title: "Crash on launch",
                        type: "github_issue_mention",
                        url: "https://github.com/comando/app/issues/123",
                    },
                    {
                        host: "github.com",
                        label: "PR #456",
                        number: 456,
                        owner: "comando",
                        repo: "app",
                        title: "Fix launch crash",
                        type: "github_pull_request_mention",
                        url: "https://github.com/comando/app/pull/456",
                    },
                ],
            ),
        ).toBe(
            "Compare these\n\nGitHub references:\n- Issue comando/app#123: Crash on launch (https://github.com/comando/app/issues/123)\n- Pull request comando/app#456: Fix launch crash (https://github.com/comando/app/pull/456)",
        );
    });

    it("deduplicates repeated GitHub composer references", () => {
        expect(
            buildGitHubComposerReferences([
                {
                    host: "github.com",
                    label: "#123",
                    number: 123,
                    owner: "comando",
                    repo: "app",
                    title: "Crash on launch",
                    type: "github_issue_mention",
                    url: "https://github.com/comando/app/issues/123",
                },
                {
                    host: "github.com",
                    label: "#123",
                    number: 123,
                    owner: "comando",
                    repo: "app",
                    title: "Crash on launch",
                    type: "github_issue_mention",
                    url: "https://github.com/comando/app/issues/123",
                },
            ]),
        ).toEqual([
            "Issue comando/app#123: Crash on launch (https://github.com/comando/app/issues/123)",
        ]);
    });
});
