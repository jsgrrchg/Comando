import { describe, expect, it } from "vitest";

import type { AIComposerPart } from "./composerParts";
import {
    appendFileAttachmentPart,
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
                label: "(12:18) const value = 1;",
                path: "src/app.ts",
                selectedText: "const value = 1;",
                startLine: 12,
            },
            { type: "text", text: " " },
        ]);
    });

    it("serializes selection mentions for the prompt as line references", () => {
        const parts: AIComposerPart[] = [
            { type: "text", text: "Inspect " },
            {
                type: "selection_mention",
                endLine: 18,
                label: "(12:18) const value = 1;",
                path: "src/app.ts",
                selectedText: "const value = 1;",
                startLine: 12,
            },
        ];

        expect(serializeComposerPartsForPrompt(parts)).toBe(
            "Inspect src/app.ts:12-18",
        );
        expect(composerPartsToPlainText(parts)).toBe(
            "Inspect [(12:18) const value = 1;]",
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
