import { describe, expect, it } from "vitest";

import {
    getExternalComposerDropItems,
    inferMimeTypeFromPath,
} from "./drag-and-drop";

describe("drag-and-drop", () => {
    it("infers mime types from dropped file paths", () => {
        expect(inferMimeTypeFromPath("/tmp/mockup.png")).toBe("image/png");
        expect(inferMimeTypeFromPath("/tmp/spec.pdf")).toBe("application/pdf");
        expect(inferMimeTypeFromPath("/tmp/archive.unknown")).toBe(
            "application/octet-stream",
        );
    });

    it("extracts external composer drop items from native files", () => {
        const file = {
            path: "/tmp/spec.pdf",
            size: 42,
            type: "application/pdf",
        } as unknown as File;

        const dataTransfer = {
            files: [file],
            items: [
                {
                    getAsFile: () => file,
                    kind: "file",
                },
            ],
        } as unknown as DataTransfer;

        expect(getExternalComposerDropItems(dataTransfer)).toEqual([
            {
                filePath: "/tmp/spec.pdf",
                kind: "file_attachment",
                label: "spec.pdf",
                mimeType: "application/pdf",
            },
        ]);
    });

    it("treats directory drops as folder mention pills when available", () => {
        const folder = {
            path: "/tmp/research",
            size: 0,
            type: "",
        } as unknown as File;

        const dataTransfer = {
            files: [folder],
            items: [
                {
                    getAsFile: () => folder,
                    kind: "file",
                    webkitGetAsEntry: () => ({
                        isDirectory: true,
                        isFile: false,
                    }),
                },
            ],
        } as unknown as DataTransfer;

        expect(getExternalComposerDropItems(dataTransfer)).toEqual([
            {
                folderPath: "/tmp/research",
                kind: "folder_mention",
                label: "research",
            },
        ]);
    });
});
