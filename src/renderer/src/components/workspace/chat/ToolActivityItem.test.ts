/** @vitest-environment jsdom */
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";

import {
    shouldShowCompactActivitySummary,
    ToolActivityItem,
} from "./ToolActivityItem";
import {
    isFileToolActivity,
    isStatusToolActivity,
} from "./toolActivityKinds";

const mockAiStoreState = vi.hoisted(() => ({
    current: {
        sessions: {},
    },
}));

const mockProjectFileIndexState = vi.hoisted(() => ({
    paths: new Set<string>(),
}));

vi.mock("@renderer/app/store/ai-store", () => ({
    useAiStore: (
        selector: (state: typeof mockAiStoreState.current) => unknown,
    ) => selector(mockAiStoreState.current),
}));

vi.mock("@renderer/app/store/projectFileIndexStore", () => {
    const normalizeIndexPath = (path: string) =>
        path.replace(/^\.\//, "").replace(/\/+$/, "");

    return {
        normalizeIndexPath,
        useFileReferenceValidator: () => (
            _rawReference: string,
            reference: { readonly relativePath: string },
        ) =>
            mockProjectFileIndexState.paths.has(
                normalizeIndexPath(reference.relativePath),
            ),
        useProjectFileIndex: () => mockProjectFileIndexState.paths,
    };
});

vi.mock("@renderer/app/hooks/use-ai-chat-settings", () => ({
    useAiChatSettings: () => ({
        chatFontFamily: "system",
        chatFontSize: 14,
        composerFontFamily: "system",
        composerFontSize: 14,
        requireCmdEnterToSend: false,
        reviewDiffZoom: 0.72,
        screenshotRetentionSeconds: 0,
        historyRetentionDays: 0,
    }),
}));

vi.mock("@renderer/app/debug/renderProbe", () => ({
    useRenderProbe: () => undefined,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULT_PROJECT_FILE_INDEX_PATHS = [
    "src/app.ts",
    "src/claude-reader.ts",
    "src/components/example.cpp",
    "src/example.ts",
    "src/example.tsx",
    "src/raw-input-only.ts",
    "src/renderer/src/components/workspace/chat/ChatTabView.tsx",
    "src/renderer/src/components/workspace/chat/deeply/nested/ToolActivityItem.tsx",
];

function createActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
        diffs: [],
        exitCode: null,
        id: "tool-1",
        kind: "edit",
        locations: [
            {
                endLine: null,
                line: null,
                path: "src/app.ts",
            },
        ],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: "session-1",
        status: "completed",
        summary: "Updated src/app.ts",
        terminalOutput: null,
        title: "Edit file",
        updatedAt: "2026-04-14T00:00:00.000Z",
        ...overrides,
    };
}

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    return {
        hunks: [
            {
                id: "hunk-1",
                lines: [
                    {
                        id: "line-1",
                        text: "const before = true;",
                        type: "remove",
                    },
                    {
                        id: "line-2",
                        text: "const after = true;",
                        type: "add",
                    },
                ],
                newCount: 1,
                newStart: 8,
                oldCount: 1,
                oldStart: 8,
            },
        ],
        identityKey: "file-1",
        isText: true,
        kind: "update",
        newText: "const after = true;\n",
        oldText: "const before = true;\n",
        path: "src/app.ts",
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-1",
        toolCallId: "tool-1",
        updatedAt: "2026-04-14T00:00:00.000Z",
        ...overrides,
    };
}

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

beforeEach(() => {
    mockAiStoreState.current.sessions = {};
    mockProjectFileIndexState.paths = new Set(
        DEFAULT_PROJECT_FILE_INDEX_PATHS,
    );
});

afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
        act(() => {
            root.unmount();
        });
    }

    for (const container of mountedContainers.splice(0)) {
        container.remove();
    }
});

function renderInteractiveToolActivityItem(
    props: ComponentProps<typeof ToolActivityItem>,
): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const root = createRoot(container);
    mountedRoots.push(root);
    mountedContainers.push(container);

    act(() => {
        root.render(createElement(ToolActivityItem, props));
    });

    return container;
}

describe("ToolActivityItem", () => {
    it("hides the redundant terminal output availability summary", () => {
        expect(
            shouldShowCompactActivitySummary(
                "Terminal output available.",
                "command",
                true,
            ),
        ).toBe(false);
        expect(
            shouldShowCompactActivitySummary(
                "Command failed before producing output.",
                "command",
                true,
            ),
        ).toBe(true);
        expect(
            shouldShowCompactActivitySummary(
                "Terminal output available.",
                "command",
                false,
            ),
        ).toBe(true);
    });

    it.each(["unknown", "mcp"])(
        "uses the hammer icon for %s tools",
        (kind) => {
            const markup = renderToStaticMarkup(
                createElement(ToolActivityItem, {
                    activity: createActivity({ kind, summary: null }),
                    onOpenFile: async () => {},
                    projectId: "project-1",
                    surface: "rail-row",
                    trackedFiles: [],
                    worktreeId: null,
                }),
            );

            expect(markup).toContain('data-tool-icon="hammer"');
        },
    );

    it("renders safe file activity as a dense rail row without raw details", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    kind: "read",
                    locations: [],
                    rawInputJson: JSON.stringify({
                        file_path: "src/app.ts",
                        secret: "raw-secret",
                    }),
                    summary: null,
                    title: "Read file",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                surface: "rail-row",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain('data-tool-activity-surface="rail-row"');
        expect(markup).toContain("Read file");
        expect(markup).toContain("src/app.ts");
        expect(markup).not.toContain("raw-secret");
        expect(markup).not.toContain("rounded-lg");
    });

    it("renders successful terminal activity as a dense completed row", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    exitCode: 0,
                    kind: "shell",
                    locations: [],
                    rawInputJson: JSON.stringify({ command: "pnpm test" }),
                    status: "completed",
                    summary: null,
                    terminalOutput: "Tests passed\n",
                    title: "Run pnpm test",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                surface: "rail-row",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain('data-tool-activity-surface="rail-row"');
        expect(markup).toContain("Run pnpm test");
        expect(markup).toContain("Done");
        expect(markup).not.toContain("Tests passed");
        expect(markup).not.toContain("var(--diff-add)");
    });

    it("reveals dense rail row details only through its disclosure", () => {
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "search",
                locations: [],
                rawInputJson: JSON.stringify({ query: "activity-segment" }),
                rawOutputJson: JSON.stringify("3 matches"),
                summary: null,
                title: "Search activity-segment",
            }),
            onOpenFile: async () => {},
            projectId: "project-1",
            surface: "rail-row",
            trackedFiles: [],
            worktreeId: null,
        });
        const disclosure = container.querySelector<HTMLButtonElement>(
            'button[aria-label="Expand details"]',
        );

        expect(container.textContent).not.toContain("3 matches");
        act(() => disclosure?.click());
        expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
        expect(container.textContent).toContain("3 matches");
    });

    it("preserves file navigation from a dense rail row", () => {
        const onOpenFileReference = vi.fn();
        const reference = {
            endLine: null,
            isAbsolute: false,
            path: "src/app.ts",
            relativePath: "src/app.ts",
            startLine: null,
        };
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [],
                rawInputJson: JSON.stringify({ file_path: "src/app.ts" }),
                summary: null,
                title: "Read src/app.ts",
            }),
            onOpenFile: async () => {},
            onOpenFileReference,
            projectId: "project-1",
            resolveFileReference: () => reference,
            surface: "rail-row",
            trackedFiles: [],
            worktreeId: null,
        });
        const openButton = Array.from(
            container.querySelectorAll<HTMLButtonElement>("button"),
        ).find((button) => button.textContent === "Read src/app.ts");

        act(() => openButton?.click());
        expect(onOpenFileReference).toHaveBeenCalledWith(reference);
    });

    it("classifies native read_file activity as a file tool card", () => {
        expect(
            isFileToolActivity(
                createActivity({
                    kind: "read_file",
                    locations: [],
                    summary: "Read src/app.ts",
                    title: "Read file",
                }),
                [],
            ),
        ).toBe(true);
    });

    it("renders raw output details for native search file tools", () => {
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "search",
                locations: [],
                rawOutputJson: JSON.stringify(
                    "20/722 matches\nSidebarAgentsPanel.tsx git:clean",
                ),
                summary: "2 lines of output",
                title: "List .personal",
            }),
            onOpenFile: async () => {},
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });
        const chevronButton = container.querySelector<HTMLButtonElement>(
            'button[aria-label="Expand details"]',
        );
        expect(chevronButton).not.toBeNull();

        act(() => {
            chevronButton?.click();
        });

        expect(container.textContent).toContain("20/722 matches");
        expect(container.textContent).toContain(
            "SidebarAgentsPanel.tsx git:clean",
        );
    });

    it("uses ChangeReviewPanel when tracked files or reviewable diffs exist", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    diffs: [
                        {
                            hunks: [
                                {
                                    id: "hunk-1",
                                    lines: [
                                        {
                                            id: "line-1",
                                            text: "const before = true;",
                                            type: "remove",
                                        },
                                        {
                                            id: "line-2",
                                            text: "const after = true;",
                                            type: "add",
                                        },
                                    ],
                                    newCount: 1,
                                    newStart: 8,
                                    oldCount: 1,
                                    oldStart: 8,
                                },
                            ],
                            isText: true,
                            kind: "update",
                            newText: "const after = true;\n",
                            oldText: "const before = true;\n",
                            path: "src/app.ts",
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [createTrackedFile()],
                worktreeId: null,
            }),
        );

        expect(markup).toContain(">Edited<");
        expect(markup).toContain(">app.ts<");
        expect(markup).toContain('data-change-review-surface="rail-row"');
        expect(markup).not.toContain("Accept");
        expect(markup).not.toContain("Reject");
    });

    it("renders activity-only diffs with the rich preview instead of a summary card", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    diffs: [
                        {
                            hunks: [
                                {
                                    id: "hunk-1",
                                    lines: [
                                        {
                                            id: "line-1",
                                            text: "const before = true;",
                                            type: "remove",
                                        },
                                        {
                                            id: "line-2",
                                            text: "const after = true;",
                                            type: "add",
                                        },
                                    ],
                                    newCount: 1,
                                    newStart: 8,
                                    oldCount: 1,
                                    oldStart: 8,
                                },
                            ],
                            isText: true,
                            kind: "update",
                            newText: "const after = true;\n",
                            oldText: "const before = true;\n",
                            path: "src/app.ts",
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain(">Edited<");
        expect(markup).toContain(">app.ts<");
        expect(markup).not.toContain("change-review-panel:");
        expect(markup).not.toContain("const before = true;");
        expect(markup).not.toContain("const after = true;");
        expect(markup).not.toContain("Updates 1 line(s).");
        expect(markup).not.toContain("Accept");
        expect(markup).not.toContain("Reject");
    });

    it("renders review diffs below terminal tools instead of hiding them", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    diffs: [
                        {
                            hunks: [
                                {
                                    id: "hunk-1",
                                    lines: [
                                        {
                                            id: "line-1",
                                            text: "const before = true;",
                                            type: "remove",
                                        },
                                        {
                                            id: "line-2",
                                            text: "const after = true;",
                                            type: "add",
                                        },
                                    ],
                                    newCount: 1,
                                    newStart: 8,
                                    oldCount: 1,
                                    oldStart: 8,
                                },
                            ],
                            isText: true,
                            kind: "update",
                            newText: "const after = true;\n",
                            oldText: "const before = true;\n",
                            path: "src/app.ts",
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                    kind: "shell",
                    rawInputJson: JSON.stringify({ command: "node patch.js" }),
                    terminalOutput: "patched src/app.ts\n",
                    title: "Run node patch.js",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Run node patch.js");
        expect(markup).not.toContain("change-review-panel:");
        expect(markup).not.toContain("const before = true;");
        expect(markup).not.toContain("const after = true;");
    });

    it("falls back to file tool card when no reviewable preview exists", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity(),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Edit file");
        expect(markup).not.toContain("done");
        expect(markup).not.toContain("Accept");
        expect(markup).not.toContain("Reject");
    });

    it("shows historical diffs after tracked files are cleared without review actions", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    diffs: [
                        {
                            hunks: [
                                {
                                    id: "hunk-1",
                                    lines: [
                                        {
                                            id: "line-1",
                                            text: "const before = true;",
                                            type: "remove",
                                        },
                                    ],
                                    newCount: 0,
                                    newStart: 8,
                                    oldCount: 1,
                                    oldStart: 8,
                                },
                            ],
                            isText: true,
                            kind: "update",
                            newText: "",
                            oldText: "const before = true;\n",
                            path: "src/app.ts",
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain(">Edited<");
        expect(markup).toContain(">app.ts<");
        expect(markup).not.toContain("change-review-panel:");
        expect(markup).not.toContain("Accept");
        expect(markup).not.toContain("Reject");
    });

    it("renders read tool titles as clickable internal links when they target a project file", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    kind: "read",
                    locations: [],
                    summary: null,
                    title: "Read src/components/example.cpp",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Read ");
        expect(markup).toContain("src/components/example.cpp");
        expect(markup).toContain("Open src/components/example.cpp");
        expect(markup).toContain("color:inherit");
        expect(markup).toContain("text-decoration:none");
    });

    it("compacts long read targets while keeping the full path as the open target", () => {
        const longPath =
            "src/renderer/src/components/workspace/chat/deeply/nested/ToolActivityItem.tsx";
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [],
                rawInputJson: JSON.stringify({ file_path: longPath }),
                summary: null,
                title: `Read ${longPath}`,
            }),
            onOpenFile: async () => {},
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });
        const linkButton = container.querySelector<HTMLButtonElement>(
            `button[title="Open ${longPath}"]`,
        );

        expect(linkButton).not.toBeNull();
        expect(linkButton?.textContent).toBe(
            "src/renderer/.../nested/ToolActivityItem.tsx",
        );
        expect(linkButton?.style.textOverflow).toBe("ellipsis");
        expect(linkButton?.style.whiteSpace).toBe("nowrap");
    });

    it("uses structured read locations when the runtime sends a generic title", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    kind: "read",
                    locations: [
                        {
                            endLine: null,
                            line: 12,
                            path: "src/claude-reader.ts",
                        },
                    ],
                    rawInputJson: JSON.stringify({
                        file_path: "src/claude-reader.ts",
                    }),
                    summary: null,
                    title: "Read ...",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Read ");
        expect(markup).toContain("src/claude-reader.ts");
        expect(markup).toContain("Open src/claude-reader.ts");
        expect(markup).not.toContain("Read ...");
    });

    it("opens the structured read path when the title only contains a basename", () => {
        const onOpenFile = vi.fn(async () => {});
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [
                    {
                        endLine: null,
                        line: null,
                        path: "src/renderer/src/components/workspace/chat/ChatTabView.tsx",
                    },
                ],
                rawInputJson: JSON.stringify({
                    file_path:
                        "src/renderer/src/components/workspace/chat/ChatTabView.tsx",
                }),
                summary: null,
                title: "Read ChatTabView.tsx",
            }),
            onOpenFile,
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });
        const linkButton = container.querySelector<HTMLButtonElement>(
            'button[title="Open src/renderer/src/components/workspace/chat/ChatTabView.tsx"]',
        );
        expect(linkButton).not.toBeNull();
        expect(linkButton?.textContent).toBe("ChatTabView.tsx");

        act(() => {
            linkButton?.click();
        });

        expect(onOpenFile).toHaveBeenCalledWith(
            "project-1",
            "src/renderer/src/components/workspace/chat/ChatTabView.tsx",
            null,
        );
    });

    it("does not make unresolved basename-only read titles clickable", () => {
        const onOpenFile = vi.fn(async () => {});
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [],
                rawInputJson: null,
                summary: null,
                title: "Read contracts.ts",
            }),
            onOpenFile,
            projectId: "project-1",
            resolveFileReference: () => null,
            trackedFiles: [],
            worktreeId: null,
        });
        const linkButton = container.querySelector<HTMLButtonElement>(
            'button[title="Open contracts.ts"]',
        );

        expect(linkButton).toBeNull();
        expect(onOpenFile).not.toHaveBeenCalled();
    });

    it("opens a basename-only read target when the project index has one match", () => {
        mockProjectFileIndexState.paths = new Set([
            ...DEFAULT_PROJECT_FILE_INDEX_PATHS,
            "src/shared/ipc.ts",
        ]);
        const onOpenFile = vi.fn(async () => {});
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [],
                rawInputJson: JSON.stringify({ file_path: "ipc.ts" }),
                summary: null,
                title: "Read ipc.ts",
            }),
            onOpenFile,
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });
        const linkButton = container.querySelector<HTMLButtonElement>(
            'button[title="Open ipc.ts"]',
        );

        expect(linkButton).not.toBeNull();

        act(() => {
            linkButton?.click();
        });

        expect(onOpenFile).toHaveBeenCalledWith(
            "project-1",
            "src/shared/ipc.ts",
            null,
        );
    });

    it("does not open an ambiguous basename-only read target", () => {
        mockProjectFileIndexState.paths = new Set([
            ...DEFAULT_PROJECT_FILE_INDEX_PATHS,
            "src/shared/ipc.ts",
            "src/main/ipc.ts",
        ]);
        const onOpenFile = vi.fn(async () => {});
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [],
                rawInputJson: JSON.stringify({ file_path: "ipc.ts" }),
                summary: null,
                title: "Read ipc.ts",
            }),
            onOpenFile,
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });
        const linkButton = container.querySelector<HTMLButtonElement>(
            'button[title="Open ipc.ts"]',
        );

        expect(linkButton).toBeNull();
        expect(onOpenFile).not.toHaveBeenCalled();
    });

    it("prefers structured read input over basename-only locations", () => {
        const onOpenFile = vi.fn(async () => {});
        const fullPath = "src/domain/contracts.ts";
        mockProjectFileIndexState.paths = new Set([
            ...DEFAULT_PROJECT_FILE_INDEX_PATHS,
            fullPath,
        ]);
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [
                    {
                        endLine: null,
                        line: null,
                        path: "contracts.ts",
                    },
                ],
                rawInputJson: JSON.stringify({ file_path: fullPath }),
                summary: null,
                title: "Read contracts.ts",
            }),
            onOpenFile,
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });
        const linkButton = container.querySelector<HTMLButtonElement>(
            `button[title="Open ${fullPath}"]`,
        );

        expect(linkButton).not.toBeNull();

        act(() => {
            linkButton?.click();
        });

        expect(onOpenFile).toHaveBeenCalledWith(
            "project-1",
            fullPath,
            null,
        );
    });

    it("passes raw relative location line ranges when no resolver is available", () => {
        const onOpenFile = vi.fn(async () => {});
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [
                    {
                        endLine: 11,
                        line: 10,
                        path: "src/example.ts",
                    },
                ],
                summary: null,
                title: "Read src/example.ts",
            }),
            onOpenFile,
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });
        const chevronButton = container.querySelector<HTMLButtonElement>(
            'button[aria-label="Expand details"]',
        );
        expect(chevronButton).not.toBeNull();

        act(() => {
            chevronButton?.click();
        });

        const locationButton = Array.from(
            container.querySelectorAll<HTMLButtonElement>("button"),
        ).find((button) => button.textContent === "src/example.ts:10-11");
        expect(locationButton).not.toBeNull();

        act(() => {
            locationButton?.click();
        });

        expect(onOpenFile).toHaveBeenCalledWith(
            "project-1",
            "src/example.ts",
            null,
            undefined,
            {
                endLine: 11,
                startLine: 10,
            },
        );
    });

    it("activates read title links visually on hover and keyboard focus", () => {
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [],
                summary: null,
                title: "Read src/components/example.cpp",
            }),
            onOpenFile: async () => {},
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });
        const linkButton = container.querySelector<HTMLButtonElement>(
            'button[title="Open src/components/example.cpp"]',
        );
        expect(linkButton).not.toBeNull();
        expect(linkButton?.style.textDecoration).toBe("none");

        act(() => {
            linkButton?.dispatchEvent(
                new MouseEvent("mouseover", { bubbles: true }),
            );
        });
        expect(linkButton?.style.textDecoration).toBe("underline");

        act(() => {
            linkButton?.dispatchEvent(
                new MouseEvent("mouseout", { bubbles: true }),
            );
        });
        expect(linkButton?.style.textDecoration).toBe("none");

        act(() => {
            linkButton?.focus();
        });
        expect(linkButton?.style.textDecoration).toBe("underline");

        act(() => {
            linkButton?.blur();
        });
        expect(linkButton?.style.textDecoration).toBe("none");
    });

    it("falls back to raw read input when ACP locations are missing", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    kind: "read",
                    locations: [],
                    rawInputJson: JSON.stringify({
                        filePath: "src/raw-input-only.ts",
                    }),
                    summary: null,
                    title: "Read",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("src/raw-input-only.ts");
        expect(markup).toContain("Open src/raw-input-only.ts");
    });

    it("lets the read details chevron handle keyboard activation without opening the file", () => {
        const onOpenFile = vi.fn(async () => {});
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [],
                summary: "Read details stay keyboard accessible.",
                title: "Read src/components/example.cpp",
            }),
            onOpenFile,
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });
        const chevronButton = container.querySelector<HTMLButtonElement>(
            'button[aria-label="Expand details"]',
        );
        expect(chevronButton).not.toBeNull();

        const keyDown = new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
        });
        act(() => {
            const defaultWasNotPrevented =
                chevronButton?.dispatchEvent(keyDown) ?? false;
            if (defaultWasNotPrevented) {
                chevronButton?.click();
            }
        });

        expect(keyDown.defaultPrevented).toBe(false);
        expect(onOpenFile).not.toHaveBeenCalled();
        expect(container.textContent).toContain(
            "Read details stay keyboard accessible.",
        );
    });

    it("shows read output content in expanded details", () => {
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [
                    {
                        endLine: null,
                        line: null,
                        path: "package.json",
                    },
                ],
                rawOutputJson: JSON.stringify(
                    '{\n  "scripts": {\n    "typecheck": "tsc --noEmit"\n  }\n}',
                ),
                summary: "1 line of output",
                title: "Read package.json",
            }),
            onOpenFile: async () => {},
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });

        expect(container.textContent).not.toContain("typecheck");

        const chevronButton = container.querySelector<HTMLButtonElement>(
            'button[aria-label="Expand details"]',
        );
        expect(chevronButton).not.toBeNull();

        act(() => {
            chevronButton?.click();
        });

        expect(container.textContent).toContain('"typecheck"');
        expect(container.textContent).toContain("package.json");
        expect(container.textContent).not.toContain("1 line of output");

        const codeBlock = container.querySelector("pre");
        expect(codeBlock?.style.whiteSpace).toBe("pre");
        expect(codeBlock?.style.overflowX).toBe("auto");
    });

    it("normalizes double-encoded read output before rendering details", () => {
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [
                    {
                        endLine: 11,
                        line: 10,
                        path: "src/example.ts",
                    },
                ],
                rawOutputJson: JSON.stringify(
                    JSON.stringify("function run() {\n    return true;\n}"),
                ),
                summary: "1 line of output",
                title: "Read example.ts",
            }),
            onOpenFile: async () => {},
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });

        const chevronButton = container.querySelector<HTMLButtonElement>(
            'button[aria-label="Expand details"]',
        );
        act(() => {
            chevronButton?.click();
        });

        expect(container.textContent).toContain("function run() {");
        expect(container.textContent).toContain("    return true;");
        expect(container.textContent).toContain("src/example.ts:10-11");
        expect(container.textContent).not.toContain("\\n");
        expect(container.textContent).not.toContain("1 line of output");
    });

    it("decodes escaped read output into visible code lines", () => {
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [
                    {
                        endLine: null,
                        line: null,
                        path: "src/example.tsx",
                    },
                ],
                rawOutputJson: JSON.stringify(
                    'const label = \\"Open\\";\\nfunction render() {\\n\\treturn label;\\n}',
                ),
                summary: "1 line of output",
                title: "Read example.tsx",
            }),
            onOpenFile: async () => {},
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });

        const chevronButton = container.querySelector<HTMLButtonElement>(
            'button[aria-label="Expand details"]',
        );
        act(() => {
            chevronButton?.click();
        });

        expect(container.textContent).toContain('const label = "Open";');
        expect(container.textContent).toContain("function render() {");
        expect(container.textContent).not.toContain("\\n");
        expect(container.textContent).not.toContain('\\"Open\\"');
        expect(container.textContent).not.toContain("1 line of output");
    });

    it("preserves legitimate quoted read output", () => {
        const container = renderInteractiveToolActivityItem({
            activity: createActivity({
                kind: "read",
                locations: [
                    {
                        endLine: null,
                        line: null,
                        path: "value.json",
                    },
                ],
                rawOutputJson: JSON.stringify('"hello"'),
                summary: "Read value.json",
                title: "Read value.json",
            }),
            onOpenFile: async () => {},
            projectId: "project-1",
            trackedFiles: [],
            worktreeId: null,
        });

        const chevronButton = container.querySelector<HTMLButtonElement>(
            'button[aria-label="Expand details"]',
        );
        act(() => {
            chevronButton?.click();
        });

        const codeBlock = container.querySelector("pre");
        expect(codeBlock?.textContent).toBe('"hello"');
    });

    it("does not render turn_started activities", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    id: "codex-acp:status:turn:turn-1",
                    kind: "other",
                    summary: "Context window: 128000",
                    title: "New turn",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toBe("");
    });

    it("renders lifecycle statuses as compact rows instead of generic tools", () => {
        const activity = createActivity({
            id: "codex-acp:status:item:compact-1",
            kind: "other",
            rawInputJson: JSON.stringify({ internal: true }),
            summary: "Context window was compacted.",
            title: "Compacting context",
        });
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity,
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(isStatusToolActivity(activity)).toBe(true);
        expect(markup).toContain('data-testid="status-activity-item"');
        expect(markup).toContain("Compacting context");
        expect(markup).toContain("Context window was compacted.");
        expect(markup).not.toContain("internal");
    });

    it("renders open-session actions for subagent breadcrumbs", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    action: {
                        kind: "open_session",
                        sessionId: "child-session",
                    },
                    kind: "unknown",
                    locations: [],
                    summary: null,
                    title: "Spawned Galileo",
                }),
                onOpenFile: async () => {},
                onOpenSession: async () => {},
                projectId: "project-1",
                surface: "rail-row",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Open Galileo");
        expect(markup).toContain("app-no-drag");
        expect(markup).toContain('data-tool-activity-surface="rail-row"');
    });

    it("uses the child session title for subagent breadcrumbs", () => {
        mockAiStoreState.current.sessions = {
            "child-session": {
                snapshot: { title: "Kierkegaard" },
            },
        };
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    action: {
                        kind: "open_session",
                        sessionId: "child-session",
                    },
                    kind: "unknown",
                    locations: [],
                    summary: null,
                    title: "Started saludo_nuevo_tres",
                }),
                onOpenFile: async () => {},
                onOpenSession: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Open Kierkegaard");
        expect(markup).not.toContain("Open saludo_nuevo_tres");
    });

    it("highlights structured payloads and terminal output in details", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    kind: "shell",
                    rawInputJson: JSON.stringify({ command: "cat Cargo.toml" }),
                    rawOutputJson: JSON.stringify({
                        package: { name: "comando" },
                    }),
                    status: "failed",
                    terminalOutput: '[package]\nname = "comando"\n',
                    title: "Run shell command",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("cm-static-code");
        expect(markup).toContain("Cargo.toml");
        expect(markup).toContain("comando");
        expect(markup.indexOf("comando")).toBeLessThan(
            markup.indexOf("Cargo.toml"),
        );
    });

    it("renders failed terminals as compact rail rows without empty output", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    exitCode: 1,
                    kind: "shell",
                    rawInputJson: JSON.stringify({
                        command: "pnpm run typecheck",
                    }),
                    status: "failed",
                    summary: null,
                    terminalOutput: null,
                    title: "Run pnpm run typecheck",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Run pnpm run typecheck");
        expect(markup).toContain("exit 1");
        expect(markup).toContain(
            'data-terminal-activity-surface="rail-row"',
        );
        expect(markup).not.toContain("rounded-lg");
        expect(markup).not.toContain("space-y-1");
        expect(markup).not.toContain("cm-static-code");
    });

    it("colors successful terminal rows green without rendering an exit badge", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    exitCode: 0,
                    kind: "shell",
                    locations: [],
                    rawInputJson: JSON.stringify({ command: "echo ok" }),
                    status: "completed",
                    summary: null,
                    terminalOutput: null,
                    title: "Run echo ok",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Run echo ok");
        expect(markup).toContain("var(--diff-add)");
        expect(markup).not.toContain("exit 0");
    });

    it("colors non-zero terminal rows red and renders the exit status", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    exitCode: 1,
                    kind: "shell",
                    locations: [],
                    rawInputJson: JSON.stringify({ command: "false" }),
                    status: "completed",
                    summary: null,
                    terminalOutput: null,
                    title: "Run false",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Run false");
        expect(markup).toContain("#ef4444");
        expect(markup).toContain("exit 1");
    });

    it("keeps in-progress terminal rows neutral and shows the live indicator", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    exitCode: null,
                    kind: "shell",
                    locations: [],
                    rawInputJson: JSON.stringify({ command: "pnpm dev" }),
                    status: "in_progress",
                    summary: null,
                    terminalOutput: null,
                    title: "Run pnpm dev",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Run pnpm dev");
        expect(markup).toContain("#6b7280");
        expect(markup).toContain("animate-pulse");
    });

    it("treats terminal output as danger when exit code is non-zero", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    exitCode: 1,
                    kind: "shell",
                    locations: [],
                    rawInputJson: JSON.stringify({ command: "pnpm test" }),
                    status: "completed",
                    summary: null,
                    terminalOutput: "Tests failed\n",
                    title: "Run pnpm test",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Tests failed");
        expect(markup).toContain("background-color:transparent");
        expect(markup).toContain("border:none");
        expect(markup).toContain("color:#ef4444");
    });

    it("keeps failed terminal output collapsed in compact contexts", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    exitCode: 1,
                    kind: "shell",
                    locations: [],
                    rawInputJson: JSON.stringify({ command: "pnpm test" }),
                    status: "completed",
                    summary: null,
                    terminalOutput: "Tests failed\n",
                    title: "Run pnpm test",
                }),
                compactTerminal: true,
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Run pnpm test");
        expect(markup).toContain("exit 1");
        expect(markup).not.toContain("Tests failed");
    });

    it("does not repeat duplicated terminal commands in expanded output", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivityItem, {
                activity: createActivity({
                    exitCode: 1,
                    kind: "shell",
                    rawInputJson: JSON.stringify({
                        command: "pnpm run typecheck",
                    }),
                    status: "failed",
                    summary: null,
                    terminalOutput: "Type error\n",
                    title: "Run pnpm run typecheck",
                }),
                onOpenFile: async () => {},
                projectId: "project-1",
                trackedFiles: [],
                worktreeId: null,
            }),
        );

        expect(markup).toContain("Type error");
        expect(markup).toContain("space-y-1");
        expect(markup.match(/pnpm run typecheck/g)).toHaveLength(1);
    });
});
