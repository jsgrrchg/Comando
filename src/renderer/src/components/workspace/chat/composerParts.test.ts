import { describe, expect, it } from "vitest";

import type { AIComposerPart } from "./composerParts";
import {
    appendComposerParts,
    appendFileAttachmentPart,
    appendGitCommitMentionPart,
    appendGitHubIssueMentionPart,
    appendGitHubPullRequestMentionPart,
    appendSelectionMentionPart,
    collectExternalComposerRoots,
    composerPartsToPlainText,
    serializeComposerPartsForPrompt,
} from "./composerParts";

describe("composerParts", () => {
    it("appends selection mentions as pills with trailing spacing", () => {
        const parts = appendSelectionMentionPart(
            [{ type: "text", text: "Review" }],
            {
                endLine: 18,
                path: "src/app.ts",
                selectedText: "const value = 1;",
                startLine: 12,
            },
        );

        expect(parts).toEqual([
            { type: "text", text: "Review " },
            {
                type: "selection_mention",
                endLine: 18,
                label: "(12:18) - const value = 1;",
                path: "src/app.ts",
                selectedText: "const value = 1;",
                startLine: 12,
            },
            { type: "text", text: " " },
        ]);
    });

    it("keeps the full selection preview in composer mentions", () => {
        const selectedText =
            "const descriptiveVariableName = buildSomethingWithoutTruncation();";
        const parts = appendSelectionMentionPart([], {
            endLine: 12,
            path: "src/app.ts",
            selectedText,
            startLine: 12,
        });

        expect(parts.find((part) => part.type === "selection_mention")).toMatchObject({
            label: `(12) - ${selectedText}`,
            type: "selection_mention",
        });
    });

    it("serializes selection mentions for the prompt as line references", () => {
        const parts: AIComposerPart[] = [
            { type: "text", text: "Inspect " },
            {
                type: "selection_mention",
                endLine: 18,
                label: "(12:18) - const value = 1;",
                path: "src/app.ts",
                selectedText: "const value = 1;",
                startLine: 12,
            },
        ];

        expect(serializeComposerPartsForPrompt(parts)).toBe(
            "Inspect src/app.ts:12-18",
        );
        expect(composerPartsToPlainText(parts)).toBe(
            "Inspect [(12:18) - const value = 1;]",
        );
    });

    it("appends external file attachments as pills with trailing spacing", () => {
        const parts = appendFileAttachmentPart(
            [{ type: "text", text: "Review" }],
            {
                filePath: "/tmp/spec.pdf",
                label: "spec.pdf",
                mimeType: "application/pdf",
            },
        );

        expect(parts).toEqual([
            { type: "text", text: "Review " },
            {
                type: "file_attachment",
                filePath: "/tmp/spec.pdf",
                label: "spec.pdf",
                mimeType: "application/pdf",
            },
            { type: "text", text: " " },
        ]);
    });

    it("serializes external file attachments as readable prompt paths", () => {
        const parts: AIComposerPart[] = [
            { type: "text", text: "Inspect " },
            {
                type: "file_attachment",
                filePath: "/tmp/spec.pdf",
                label: "spec.pdf",
                mimeType: "application/pdf",
            },
        ];

        expect(serializeComposerPartsForPrompt(parts)).toBe(
            "Inspect /tmp/spec.pdf",
        );
        expect(composerPartsToPlainText(parts)).toBe("Inspect [spec.pdf]");
    });

    it("serializes commit pills as explicit commit references", () => {
        const parts = appendGitCommitMentionPart(
            [{ type: "text", text: "Review" }],
            {
                commitSha: "abcdef1234567890",
                label: "abcdef1",
            },
        );

        expect(parts).toEqual([
            { type: "text", text: "Review " },
            {
                type: "git_commit_mention",
                commitSha: "abcdef1234567890",
                label: "abcdef1",
            },
            { type: "text", text: " " },
        ]);

        expect(serializeComposerPartsForPrompt(parts)).toBe(
            "Review commit: abcdef1234567890 ",
        );
        expect(composerPartsToPlainText(parts)).toBe("Review commit: abcdef1 ");
    });

    it("serializes GitHub issue pills as useful prompt references", () => {
        const parts = appendGitHubIssueMentionPart(
            [{ type: "text", text: "Investigate" }],
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
        );

        expect(composerPartsToPlainText(parts)).toBe("Investigate #123 ");
        expect(serializeComposerPartsForPrompt(parts)).toBe(
            "Investigate GitHub issue comando/app#123: Crash on launch (https://github.com/comando/app/issues/123) ",
        );
    });

    it("serializes GitHub PR pills as useful prompt references", () => {
        const parts = appendGitHubPullRequestMentionPart(
            [{ type: "text", text: "Review" }],
            {
                host: "github.com",
                label: "PR #456",
                number: 456,
                owner: "comando",
                repo: "app",
                title: "Add GitHub API integration",
                type: "github_pull_request_mention",
                url: "https://github.com/comando/app/pull/456",
            },
        );

        expect(composerPartsToPlainText(parts)).toBe("Review PR #456 ");
        expect(serializeComposerPartsForPrompt(parts)).toBe(
            "Review GitHub PR comando/app#456: Add GitHub API integration (https://github.com/comando/app/pull/456) ",
        );
    });

    it("separates appended composer pills from existing draft text", () => {
        const partsToAppend = appendGitHubIssueMentionPart(
            [{ type: "text", text: "" }],
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
        );

        expect(
            appendComposerParts(
                [{ type: "text", text: "Investigate" }],
                partsToAppend,
            ),
        ).toEqual([
            { type: "text", text: "Investigate " },
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
            { type: "text", text: " " },
        ]);
    });

    it("collects additional roots for external file and folder pills", () => {
        const parts: AIComposerPart[] = [
            {
                type: "file_attachment",
                filePath: "/Users/test/Desktop/spec.pdf",
                label: "spec.pdf",
                mimeType: "application/pdf",
            },
            { type: "text", text: " " },
            {
                type: "folder_mention",
                folderPath: "/Users/test/Desktop/research",
                label: "research",
            },
        ];

        expect(collectExternalComposerRoots(parts)).toEqual([
            "/Users/test/Desktop",
            "/Users/test/Desktop/research",
        ]);
    });
});
