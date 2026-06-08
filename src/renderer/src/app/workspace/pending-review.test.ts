import { afterEach, describe, expect, it } from "vitest";

import type { AiTrackedFile, AppBootstrapSnapshot } from "@shared/ipc";
import { useAppStore } from "@renderer/app/store/app-store";

import {
    collectPendingTrackedFilesFromSessions,
    findBestPendingTrackedFile,
    resolveFileTabReviewContext,
} from "./pending-review";

afterEach(() => {
    useAppStore.setState({
        bootstrap: null,
        error: null,
        status: "idle",
    });
});

function setRendererPlatform(platform: string): void {
    useAppStore.setState({
        bootstrap: { platform } as AppBootstrapSnapshot,
        error: null,
        status: "ready",
    });
}

function createTrackedFile(
    overrides: Partial<AiTrackedFile> &
        Pick<AiTrackedFile, "path" | "sessionId">,
): AiTrackedFile {
    const { path, sessionId, ...rest } = overrides;

    return {
        currentText: "const next = true;\n",
        diffBase: "const next = false;\n",
        hunks: [],
        identityKey: `${sessionId}:${path}`,
        isText: true,
        kind: "update",
        newText: "const next = true;\n",
        oldText: "const next = false;\n",
        path,
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId,
        toolCallId: null,
        updatedAt: "2026-04-15T12:00:00.000Z",
        version: 1,
        ...rest,
    };
}

describe("pending review helpers", () => {
    it("preserves the existing review context when reopening a tab without a new context", () => {
        const trackedFiles = [
            createTrackedFile({
                path: "src/app.ts",
                sessionId: "session-a",
                updatedAt: "2026-04-15T12:00:00.000Z",
            }),
        ];

        expect(
            resolveFileTabReviewContext({
                existingReviewContext: {
                    path: "src/app.ts",
                    sessionId: "session-a",
                },
                relativePath: "src/app.ts",
                trackedFiles,
            }),
        ).toEqual({
            path: "src/app.ts",
            sessionId: "session-a",
        });
    });

    it("infers review context for files opened outside the review surfaces", () => {
        const trackedFiles = [
            createTrackedFile({
                path: "src/editor.ts",
                sessionId: "session-b",
            }),
        ];

        expect(
            resolveFileTabReviewContext({
                relativePath: "src/editor.ts",
                trackedFiles,
            }),
        ).toEqual({
            path: "src/editor.ts",
            sessionId: "session-b",
        });
    });

    it("matches pending tracked files across Windows separator aliases", () => {
        const trackedFiles = [
            createTrackedFile({
                path: "src\\editor.ts",
                sessionId: "session-windows-separators",
            }),
        ];

        expect(
            resolveFileTabReviewContext({
                relativePath: "src/editor.ts",
                trackedFiles,
            }),
        ).toEqual({
            path: "src\\editor.ts",
            sessionId: "session-windows-separators",
        });
    });

    it("matches Windows absolute tracked files with equivalent casing", () => {
        const trackedFiles = [
            createTrackedFile({
                path: "C:\\Repo\\src\\Editor.ts",
                sessionId: "session-windows-casing",
            }),
        ];

        expect(
            findBestPendingTrackedFile({
                paths: ["c:\\repo\\src\\editor.ts"],
                trackedFiles,
            }),
        )?.toMatchObject({
            path: "C:\\Repo\\src\\Editor.ts",
            sessionId: "session-windows-casing",
        });
    });

    it("matches relative forward-slash paths with Windows casing aliases", () => {
        setRendererPlatform("win32");

        const trackedFiles = [
            createTrackedFile({
                path: "src/App.ts",
                sessionId: "session-relative-casing",
            }),
        ];

        expect(
            findBestPendingTrackedFile({
                paths: ["src/app.ts"],
                trackedFiles,
            }),
        )?.toMatchObject({
            path: "src/App.ts",
            sessionId: "session-relative-casing",
        });
    });

    it("prefers inline-review capable updates over newer non-inline matches", () => {
        const trackedFiles = [
            createTrackedFile({
                path: "src/file.ts",
                sessionId: "session-inline",
                updatedAt: "2026-04-15T10:00:00.000Z",
            }),
            createTrackedFile({
                isText: false,
                kind: "move",
                newText: null,
                oldText: null,
                path: "src/file.ts",
                previousPath: "src/file-old.ts",
                sessionId: "session-move",
                updatedAt: "2026-04-15T11:00:00.000Z",
            }),
        ];

        expect(
            findBestPendingTrackedFile({
                paths: ["src/file.ts"],
                preferInlineReview: true,
                trackedFiles,
            }),
        )?.toMatchObject({
            path: "src/file.ts",
            sessionId: "session-inline",
        });
    });

    it("honors the explicit review context when multiple sessions match the same file", () => {
        const trackedFiles = [
            createTrackedFile({
                path: "src/shared.ts",
                sessionId: "session-a",
                updatedAt: "2026-04-15T10:00:00.000Z",
            }),
            createTrackedFile({
                path: "src/shared.ts",
                sessionId: "session-b",
                updatedAt: "2026-04-15T11:00:00.000Z",
            }),
        ];

        expect(
            findBestPendingTrackedFile({
                paths: ["src/shared.ts"],
                preferInlineReview: true,
                reviewContext: {
                    path: "src/shared.ts",
                    sessionId: "session-a",
                },
                trackedFiles,
            }),
        )?.toMatchObject({
            path: "src/shared.ts",
            sessionId: "session-a",
        });
    });

    it("collects only pending tracked files from all sessions", () => {
        const pending = createTrackedFile({
            path: "src/pending.ts",
            sessionId: "session-pending",
        });
        const kept = createTrackedFile({
            path: "src/kept.ts",
            reviewState: "kept",
            sessionId: "session-kept",
        });

        expect(
            collectPendingTrackedFilesFromSessions({
                "session-kept": {
                    snapshot: { trackedFiles: [kept] },
                },
                "session-pending": {
                    snapshot: { trackedFiles: [pending] },
                },
            }),
        ).toEqual([pending]);
    });

    it("returns pending tracked files without recomputing their hunks", () => {
        // The renderer trusts that tracked files arriving over IPC (or via
        // local optimistic mutations) have already been syncTrackedFile'd by
        // the main process, so collect is a cheap pass-through. If a caller
        // actually needs re-derived hunks it should call syncTrackedFile
        // explicitly on the returned file.
        const precomputedHunk = {
            id: "precomputed-hunk",
            lines: [
                { id: "1", text: "beta", type: "remove" as const },
                { id: "2", text: "BETA", type: "add" as const },
            ],
            newCount: 1,
            newStart: 2,
            oldCount: 1,
            oldStart: 2,
            visualEndLine: 2,
            visualStartLine: 2,
        };
        const file = createTrackedFile({
            currentText: "alpha\nBETA\ngamma",
            diffBase: "alpha\nbeta\ngamma",
            hunks: [precomputedHunk],
            newText: "alpha\nBETA\ngamma",
            oldText: "alpha\nbeta\ngamma",
            path: "src/stale.ts",
            sessionId: "session-stale",
        });

        expect(
            collectPendingTrackedFilesFromSessions({
                "session-stale": {
                    snapshot: { trackedFiles: [file] },
                },
            })[0]?.hunks,
        ).toBe(file.hunks);
    });
});
