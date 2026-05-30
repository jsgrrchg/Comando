import { afterEach, describe, expect, it, vi } from "vitest";

import {
    getExternalComposerDropItems,
    getExternalProjectDropData,
    hasExternalProjectDropPayload,
    inferMimeTypeFromPath,
    parseComposerProjectEntryListDragData,
    serializeComposerProjectEntryListDragData,
} from "./drag-and-drop";

describe("drag-and-drop", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("infers mime types from dropped file paths", () => {
        expect(inferMimeTypeFromPath("/tmp/mockup.png")).toBe("image/png");
        expect(inferMimeTypeFromPath("/tmp/spec.pdf")).toBe("application/pdf");
        expect(inferMimeTypeFromPath("/tmp/archive.unknown")).toBe(
            "application/octet-stream",
        );
    });

    it("serializes and parses multi-entry composer payloads", () => {
        const serialized = serializeComposerProjectEntryListDragData({
            entries: [
                {
                    kind: "file",
                    name: "app.ts",
                    relativePath: "src/app.ts",
                },
                {
                    kind: "directory",
                    name: "docs",
                    relativePath: "docs",
                },
            ],
        });

        expect(parseComposerProjectEntryListDragData(serialized)).toEqual({
            entries: [
                {
                    kind: "file",
                    name: "app.ts",
                    relativePath: "src/app.ts",
                },
                {
                    kind: "directory",
                    name: "docs",
                    relativePath: "docs",
                },
            ],
        });
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

    it("falls back to the preload bridge when dropped files do not expose path", () => {
        const file = {
            size: 42,
            type: "application/pdf",
        } as unknown as File;

        vi.stubGlobal("window", {
            comando: {
                resolveDroppedFilePath: vi.fn(() => "/tmp/spec.pdf"),
            },
        });

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

    it("detects native file payloads before paths are resolved", () => {
        const dataTransfer = {
            files: [],
            types: ["Files"],
        } as unknown as DataTransfer;

        expect(hasExternalProjectDropPayload(dataTransfer)).toBe(true);
    });

    it("extracts external project drop paths without duplicates", () => {
        const specFile = {
            path: "/tmp/spec.pdf",
            size: 42,
            type: "application/pdf",
        } as unknown as File;
        const readmeFile = {
            path: "/tmp/README.md",
            size: 12,
            type: "text/markdown",
        } as unknown as File;

        const dataTransfer = {
            files: [specFile, readmeFile],
            items: [
                {
                    getAsFile: () => specFile,
                    kind: "file",
                },
                {
                    getAsFile: () => specFile,
                    kind: "file",
                },
                {
                    getAsFile: () => readmeFile,
                    kind: "file",
                },
            ],
            types: ["Files"],
        } as unknown as DataTransfer;

        expect(getExternalProjectDropData(dataTransfer)).toEqual({
            sourcePaths: ["/tmp/spec.pdf", "/tmp/README.md"],
        });
    });
});
