/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiMessage, AiToolActivity } from "@shared/ipc";
import {
    resetSettingsStoreForTests,
    useSettingsStore,
} from "@renderer/app/store/settings-store";
import { useShellStore } from "@renderer/app/store/shell-store";

import type {
    ChatTimelineActivitySegmentRow,
    ToolActivitySegmentEntry,
} from "./chatTimelineModel";
import type { ToolActivityReviewEntry } from "./toolActivityReviewModel";
import { deriveActivitySegmentChangeStats } from "./activitySegmentChangeStats";
import { ToolActivitySegment } from "./ToolActivitySegment";
import {
    resetScopedToolUiStateStoresForTests,
    ToolExpansionStoreProvider,
} from "./toolExpansionStore";

vi.mock("./ToolActivityItem", () => ({
    ToolActivityItem: ({
        activity,
        compactTerminal,
        surface,
    }: {
        readonly activity: AiToolActivity;
        readonly compactTerminal: boolean;
        readonly surface: string;
    }) => (
        <div
            data-child-activity={activity.id}
            data-compact-terminal={String(compactTerminal)}
            data-tool-surface={surface}
        >
            {activity.title}
        </div>
    ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

afterEach(() => {
    while (mountedRoots.length > 0) {
        const root = mountedRoots.pop();
        if (root) {
            act(() => root.unmount());
        }
    }
    resetSettingsStoreForTests();
    useShellStore.setState({ isResizingPanel: false });
    resetScopedToolUiStateStoresForTests();
    vi.unstubAllGlobals();
});

function createActivity(
    id: string,
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    const index = Number(id.match(/\d+$/)?.[0] ?? "1");
    const createdAt = `2026-07-10T00:00:${String(index).padStart(2, "0")}.000Z`;
    return {
        action: null,
        createdAt,
        diffs: [],
        exitCode: null,
        id,
        kind: "read",
        locations: [],
        rawInputJson: JSON.stringify({ file_path: `src/${id}.ts` }),
        rawOutputJson: null,
        sessionId: "session-1",
        status: "completed",
        summary: null,
        terminalOutput: null,
        title: `Read src/${id}.ts`,
        updatedAt: createdAt,
        ...overrides,
    };
}

function createReviewEntry(activity: AiToolActivity): ToolActivityReviewEntry {
    return {
        activity,
        hasPendingTrackedFiles: false,
        pendingTrackedFiles: [],
        trackedFiles: [],
    };
}

function createSegment(
    entries: readonly ToolActivitySegmentEntry[],
    overrides: Partial<ChatTimelineActivitySegmentRow["summary"]> = {},
): ChatTimelineActivitySegmentRow {
    const first = entries[0]?.reviewEntry.activity;
    const latest = entries.at(-1)?.reviewEntry.activity;
    if (!first || !latest) {
        throw new Error("A test segment requires activity.");
    }

    return {
        changeStats: deriveActivitySegmentChangeStats(entries),
        entries,
        id: `activity-segment:session-1:${first.id}`,
        items: entries.map((entry) => ({ entry, kind: "tool" as const })),
        kind: "activity-segment",
        summary: {
            actionCount: entries.length,
            changeCount: entries.filter(
                (entry) => entry.policy === "standalone-change",
            ).length,
            changedFileCount: 0,
            commandCount: 0,
            failureCount: 0,
            fileCount: entries.length,
            hiddenActivityCount: entries.length,
            isInProgress: false,
            latestActivityId: latest.id,
            latestTitle: latest.title,
            searchCount: 0,
            startedAt: first.createdAt,
            updatedAt: latest.updatedAt,
            ...overrides,
        },
    };
}

function createEntry(
    id: string,
    policy: ToolActivitySegmentEntry["policy"] = "groupable",
    overrides: Partial<AiToolActivity> = {},
): ToolActivitySegmentEntry {
    return {
        policy,
        reviewEntry: createReviewEntry(createActivity(id, overrides)),
    };
}

function createThinkingSegment(
    status: AiMessage["status"] = "completed",
): ChatTimelineActivitySegmentRow {
    const message: AiMessage = {
        attachments: [],
        content: "Inspect the activity model before changing it.",
        createdAt: "2026-07-10T00:00:01.000Z",
        id: "thinking-1",
        kind: "thinking",
        status,
    };
    return {
        changeStats: { additions: 0, approximate: false, deletions: 0 },
        entries: [],
        id: "activity-segment:thinking:thinking-1",
        items: [{ kind: "thinking", message }],
        kind: "activity-segment",
        summary: {
            actionCount: 0,
            changeCount: 0,
            changedFileCount: 0,
            commandCount: 0,
            failureCount: 0,
            fileCount: 0,
            hiddenActivityCount: 0,
            isInProgress: status === "streaming",
            latestActivityId: message.id,
            latestTitle: status === "streaming" ? "Thinking..." : "Thinking",
            searchCount: 0,
            startedAt: message.createdAt,
            updatedAt: message.createdAt,
        },
    };
}

const DEFAULT_PROPS = {
    onOpenFile: async () => {},
    onOpenFileReference: () => {},
    projectId: "project-1",
    resolveFileReference: () => null,
    worktreeId: null,
};

function renderInteractive(segment: ChatTimelineActivitySegmentRow) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(container, "clientHeight", {
        configurable: true,
        value: 720,
    });
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
        root.render(
            createElement(ToolActivitySegment, {
                ...DEFAULT_PROPS,
                segment,
            }),
        );
    });
    return container;
}

describe("ToolActivitySegment", () => {
    it("acts as a summary-only row when details belong to the virtual timeline", () => {
        const onExpandedChange = vi.fn();
        const markup = renderToStaticMarkup(
            createElement(ToolActivitySegment, {
                ...DEFAULT_PROPS,
                expanded: true,
                onExpandedChange,
                renderDetails: false,
                segment: createThinkingSegment(),
            }),
        );

        expect(markup).toContain('aria-expanded="true"');
        expect(markup).not.toContain("data-thinking-message-id");
        expect(markup).not.toContain("aria-controls");
    });

    it("renders thinking-only work as an expandable activity rail", () => {
        const container = renderInteractive(createThinkingSegment());
        expect(container.textContent).toContain("Thought");
        expect(container.querySelector("[data-thinking-message-id]")).toBeNull();

        const railButton = container.querySelector("button");
        act(() => {
            railButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(
            container
                .querySelector("[data-thinking-message-id]")
                ?.getAttribute("data-thinking-message-id"),
        ).toBe("thinking-1");
        expect(container.textContent).toContain("Thinking");
    });

    it("forwards the transcript search query to thinking content", () => {
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);
        act(() => {
            root.render(
                <ToolActivitySegment
                    {...DEFAULT_PROPS}
                    highlightQuery="activity"
                    segment={createThinkingSegment()}
                />,
            );
        });
        act(() => {
            container
                .querySelector("button")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        act(() => {
            container
                .querySelectorAll("button")[1]
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(container.querySelector("mark")?.textContent).toBe("activity");
    });

    it("keeps a single action compact while naming it in the summary", () => {
        const segment = createSegment(
            [
                createEntry("command-1", "groupable", {
                    kind: "shell",
                    rawInputJson: JSON.stringify({
                        command: "git status --short",
                    }),
                    title: "Running command",
                }),
            ],
            { commandCount: 1 },
        );
        const markup = renderToStaticMarkup(
            createElement(ToolActivitySegment, {
                ...DEFAULT_PROPS,
                segment,
            }),
        );

        expect(markup).toContain("Worked · 1 action");
        expect(markup).toContain("git status --short");
        expect(markup).not.toContain("Latest:");
        expect(markup).toContain('data-activity-rail-prefix="true"');
    });

    it("uses the same activity prefix for explored work", () => {
        const markup = renderToStaticMarkup(
            createElement(ToolActivitySegment, {
                ...DEFAULT_PROPS,
                segment: createSegment([createEntry("read-1")], {
                    commandCount: 0,
                    fileCount: 1,
                    searchCount: 0,
                }),
            }),
        );

        expect(markup).toContain("Explored 1 file");
        expect(markup).toContain('data-activity-rail-prefix="true"');
    });

    it("uses the turn tail rather than stale tool state for the headline", () => {
        const segment = createSegment(
            [
                createEntry("command-1", "groupable", {
                    kind: "shell",
                    status: "in_progress",
                    title: "Run checks",
                }),
                createEntry("command-2", "groupable", {
                    kind: "shell",
                    status: "completed",
                    title: "Check results",
                }),
            ],
            { commandCount: 2, isInProgress: true },
        );

        const historicalMarkup = renderToStaticMarkup(
            createElement(ToolActivitySegment, {
                ...DEFAULT_PROPS,
                segment,
            }),
        );
        const activeMarkup = renderToStaticMarkup(
            createElement(ToolActivitySegment, {
                ...DEFAULT_PROPS,
                isCurrentTurnTail: true,
                segment,
            }),
        );

        expect(historicalMarkup).toContain("Worked · 2 actions");
        expect(historicalMarkup).toContain("Latest: Check results");
        expect(activeMarkup).toContain("Working · 2 actions");
        expect(activeMarkup).toContain("Current: Check results");
    });

    it("renders a transparent tree rail when activity is expanded", () => {
        const container = renderInteractive(
            createSegment([
                createEntry("read-1"),
                createEntry("edit-2", "standalone-change"),
            ]),
        );
        const segment = container.querySelector<HTMLElement>(
            "[data-tool-activity-segment]",
        );

        expect(segment?.dataset.activityRail).toBe("true");
        expect(segment?.style.backgroundColor).toBe("");
        expect(segment?.style.border).toBe("");
        expect(segment?.className).not.toContain("overflow-hidden");
        expect(segment?.className).not.toContain("rounded-lg");

        expect(
            container.querySelectorAll<HTMLElement>(
                "[data-activity-rail-decoration]",
            ),
        ).toHaveLength(0);
        expect(container.querySelector('[role="region"]')).toBeNull();
        const disclosure = container.querySelector<HTMLButtonElement>(
            'button[aria-label^="Show full activity:"]',
        );
        expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
        expect(disclosure?.getAttribute("aria-controls")).toContain(
            ":activity",
        );
        expect(disclosure?.textContent).not.toContain("Show full activity");

        act(() => disclosure?.click());

        expect(
            container.querySelectorAll("[data-activity-rail-decoration]"),
        ).toHaveLength(2);
        expect(
            Array.from(
                container.querySelectorAll<HTMLElement>(
                    "[data-activity-rail-decoration]",
                ),
            ).map((member) => member.dataset.activityRailDecoration),
        ).toEqual(["branch", "branch"]);
        expect(
            container
                .querySelector('[role="region"]')
                ?.getAttribute("aria-label"),
        ).toBe("Full activity");
    });

    it("renders all activity when a large safe burst is expanded", () => {
        const entries = Array.from({ length: 50 }, (_, index) =>
            createEntry(`read-${index + 1}`),
        );
        const container = renderInteractive(createSegment(entries));

        expect(
            container
                .querySelector("[data-tool-activity-segment]")
                ?.getAttribute("data-activity-count"),
        ).toBe("50");
        expect(container.querySelectorAll("[data-child-activity]")).toHaveLength(
            0,
        );
        expect(
            container
                .querySelector<HTMLButtonElement>("button")
                ?.getAttribute("aria-label"),
        ).toContain("Show full activity");
        expect(container.querySelectorAll("*").length).toBeLessThan(30);

        act(() =>
            container.querySelector<HTMLButtonElement>("button")?.click(),
        );
        const expandedEntries = Array.from(
            container.querySelectorAll<HTMLElement>("[data-child-activity]"),
        );
        expect(expandedEntries).toHaveLength(50);
        expect(
            expandedEntries.every(
                (entry) => entry.dataset.toolSurface === "rail-row",
            ),
        ).toBe(true);
        expect(
            container
                .querySelector('[role="region"]')
                ?.getAttribute("aria-label"),
        ).toBe("Full activity");

    });

    it("renders every activity in an expanded large segment", () => {
        const entries = Array.from({ length: 20_000 }, (_, index) =>
            createEntry(`read-${index + 1}`),
        );
        const container = renderInteractive(createSegment(entries));

        act(() => container.querySelector<HTMLButtonElement>("button")?.click());

        const mountedActivities = container.querySelectorAll(
            "[data-child-activity]",
        );
        expect(mountedActivities).toHaveLength(20_000);
        expect(
            container.querySelector('[role="region"]')?.getAttribute("aria-label"),
        ).toBe("Full activity");
    });

    it("does not remount activity rows when the parent layout changes", () => {
        const entries = Array.from({ length: 200 }, (_, index) =>
            createEntry(`read-${index + 1}`),
        );
        const container = renderInteractive(createSegment(entries));
        container.scrollTop = 4_000;

        act(() => container.querySelector<HTMLButtonElement>("button")?.click());

        expect(
            container.querySelector<HTMLElement>("[data-child-activity]")
                ?.dataset.childActivity,
        ).toBe("read-1");

        act(() => {
            window.dispatchEvent(new Event("resize"));
        });

        expect(
            container.querySelector<HTMLElement>("[data-child-activity]")
                ?.dataset.childActivity,
        ).toBe("read-1");
    });

    it("does not observe parent transform mutations while scrolling", () => {
        const mutationObserver = vi.fn();
        vi.stubGlobal("MutationObserver", mutationObserver);
        const entries = Array.from({ length: 200 }, (_, index) =>
            createEntry(`read-${index + 1}`),
        );
        const container = renderInteractive(createSegment(entries));

        act(() => container.querySelector<HTMLButtonElement>("button")?.click());

        expect(mutationObserver).not.toHaveBeenCalled();
    });

    it("uses the AI setting as the initial state without overriding manual changes", () => {
        act(() =>
            useSettingsStore.setState((state) => ({
                aiChat: {
                    ...state.aiChat,
                    toolActivityDefaultExpansion: "expanded",
                },
            })),
        );
        const container = renderInteractive(
            createSegment([createEntry("read-91"), createEntry("read-92")]),
        );
        const disclosure = container.querySelector<HTMLButtonElement>(
            'button[aria-label^="Hide full activity:"]',
        );

        expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
        expect(container.querySelectorAll("[data-child-activity]")).toHaveLength(
            2,
        );

        act(() => disclosure?.click());
        expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
        expect(container.querySelectorAll("[data-child-activity]")).toHaveLength(
            0,
        );

        act(() =>
            useSettingsStore.setState((state) => ({
                aiChat: {
                    ...state.aiChat,
                    toolActivityDefaultExpansion: "collapsed",
                },
            })),
        );
        expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    });

    it("applies an asynchronously hydrated expansion default to untouched segments", () => {
        const container = renderInteractive(
            createSegment([createEntry("read-93")]),
        );
        const disclosure = container.querySelector<HTMLButtonElement>(
            'button[aria-label^="Show full activity:"]',
        );

        expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
        act(() =>
            useSettingsStore.setState((state) => ({
                aiChat: {
                    ...state.aiChat,
                    toolActivityDefaultExpansion: "expanded",
                },
            })),
        );

        expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
        expect(container.querySelectorAll("[data-child-activity]")).toHaveLength(
            1,
        );
    });

    it("hides safe and important entries behind the same summary", () => {
        const segment = createSegment(
            [
                createEntry("read-1"),
                createEntry("edit-2", "standalone-change", {
                    diffs: [
                        {
                            hunks: [],
                            isText: true,
                            kind: "update",
                            newText: "after\n",
                            oldText: "before\n",
                            path: "src/app.ts",
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                    kind: "edit",
                    title: "Edit src/app.ts",
                }),
                createEntry("read-3"),
                createEntry("failed-4", "standalone-attention", {
                    kind: "shell",
                    status: "failed",
                    title: "Tests failed",
                }),
            ],
            { changedFileCount: 1, failureCount: 1 },
        );
        const markup = renderToStaticMarkup(
            createElement(ToolActivitySegment, {
                ...DEFAULT_PROPS,
                segment,
            }),
        );

        expect(markup).toContain(
            "Worked · 4 actions · 1 file changed · 1 failure",
        );
        expect(markup).toContain(">+1<");
        expect(markup).toContain(">-1<");
        expect(markup).toContain("Changed");
        expect(markup).not.toContain("Edit src/app.ts");
        expect(markup).toContain("Latest: Tests failed");
        expect(markup).not.toContain("Read src/read-1.ts");
        expect(markup).not.toContain("Read src/read-3.ts");
        expect(markup).not.toContain("data-child-activity");
        expect(markup).not.toContain("data-compact-terminal");
    });

    it("reveals the complete chronological sequence without duplicates", () => {
        const container = renderInteractive(
            createSegment([
                createEntry("read-1"),
                createEntry("edit-2", "standalone-change"),
                createEntry("read-3"),
            ]),
        );
        const button = container.querySelector<HTMLButtonElement>("button");

        expect(button?.type).toBe("button");
        expect(button?.getAttribute("aria-expanded")).toBe("false");
        expect(button?.className).toContain(
            "focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
        );
        expect(
            Array.from(
                container.querySelectorAll<HTMLElement>(
                    "[data-child-activity]",
                ),
            ).map((member) => member.dataset.childActivity),
        ).toEqual([]);

        act(() => button?.click());

        expect(button?.getAttribute("aria-expanded")).toBe("true");
        expect(button?.getAttribute("aria-label")).toContain(
            "Hide full activity",
        );
        expect(button?.textContent).not.toContain("Hide full activity");
        expect(
            Array.from(
                container.querySelectorAll<HTMLElement>(
                    "[data-child-activity]",
                ),
            ).map((member) => member.dataset.childActivity),
        ).toEqual(["read-1", "edit-2", "read-3"]);
        const surfaces = Array.from(
            container.querySelectorAll<HTMLElement>("[data-tool-surface]"),
        ).map((member) => member.dataset.toolSurface);
        expect(surfaces).toEqual(["rail-row", "card", "rail-row"]);
        const indents = Array.from(
            container.querySelectorAll<HTMLElement>(
                "[data-activity-rail-indent]",
            ),
        ).map((member) => member.dataset.activityRailIndent);
        expect(indents).toEqual(["child", "child", "child"]);
        expect(
            container.querySelector<HTMLElement>(
                '[data-activity-rail-indent="child"]',
            )?.className,
        ).toContain("pl-10");
    });

    it("uses rail rows for coordination and unknown activity", () => {
        const container = renderInteractive(
            createSegment([
                createEntry("read-1"),
                createEntry("agent-2", "standalone-attention", {
                    action: {
                        kind: "open_session",
                        sessionId: "child-session",
                    },
                    kind: "other",
                    title: "Started child agent",
                }),
                createEntry("unknown-3", "standalone-unknown", {
                    kind: "other",
                    title: "Unknown tool",
                }),
            ]),
        );

        expect(container.textContent).not.toContain("Started child agent");
        expect(container.textContent).toContain("Latest: Unknown tool");
        expect(container.querySelectorAll("[data-child-activity]")).toHaveLength(
            0,
        );
        act(() =>
            container.querySelector<HTMLButtonElement>("button")?.click(),
        );

        expect(container.textContent).toContain("Started child agent");
        expect(container.textContent).toContain("Unknown tool");
        expect(
            container.querySelectorAll('[data-tool-surface="card"]'),
        ).toHaveLength(0);
        expect(
            container.querySelectorAll('[data-tool-surface="rail-row"]'),
        ).toHaveLength(3);
    });

    it("keeps changed files as individual review cards below Worked", () => {
        const container = renderInteractive(
            createSegment([
                createEntry("read-1"),
                createEntry("edit-2", "standalone-change", {
                    kind: "edit",
                    title: "Updated ChatTabView.tsx",
                }),
            ]),
        );

        act(() =>
            container.querySelector<HTMLButtonElement>("button")?.click(),
        );

        expect(
            container
                .querySelector<HTMLElement>('[data-child-activity="edit-2"]')
                ?.dataset.toolSurface,
        ).toBe("card");
        expect(
            container
                .querySelector<HTMLElement>('[data-child-activity="read-1"]')
                ?.dataset.toolSurface,
        ).toBe("rail-row");
    });

    it("hides important-only segments behind the same disclosure", () => {
        const container = renderInteractive(
            createSegment([
                createEntry("edit-1", "standalone-change"),
                createEntry("failed-2", "standalone-attention"),
            ]),
        );

        const disclosure = container.querySelector<HTMLButtonElement>(
            'button[aria-label^="Show full activity:"]',
        );
        expect(disclosure).not.toBeNull();
        expect(container.querySelectorAll("[data-child-activity]")).toHaveLength(
            0,
        );

        act(() => disclosure?.click());
        expect(container.querySelectorAll("[data-child-activity]")).toHaveLength(
            2,
        );
    });

    it("restores expansion by segment id after a virtualized unmount", () => {
        const segment = createSegment([
            createEntry("read-1"),
            createEntry("read-2"),
        ]);
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);

        function Harness({ show }: { readonly show: boolean }) {
            return (
                <ToolExpansionStoreProvider>
                    {show ? (
                        <ToolActivitySegment
                            {...DEFAULT_PROPS}
                            segment={segment}
                        />
                    ) : null}
                </ToolExpansionStoreProvider>
            );
        }

        act(() => root.render(<Harness show />));
        act(() => container.querySelector<HTMLButtonElement>("button")?.click());
        act(() => root.render(<Harness show={false} />));
        act(() => root.render(<Harness show />));

        expect(
            container
                .querySelector<HTMLButtonElement>("button")
                ?.getAttribute("aria-expanded"),
        ).toBe("true");
    });

    it("restores expansion after the scoped provider remounts", () => {
        const segment = createSegment([
            createEntry("read-11"),
            createEntry("read-12"),
        ]);
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);

        const renderChat = () =>
            root.render(
                <ToolExpansionStoreProvider scopeKey="session-1">
                    <ToolActivitySegment
                        {...DEFAULT_PROPS}
                        segment={segment}
                    />
                </ToolExpansionStoreProvider>,
            );

        act(renderChat);
        act(() => container.querySelector<HTMLButtonElement>("button")?.click());
        act(() => root.render(null));
        act(renderChat);

        expect(
            container
                .querySelector<HTMLButtonElement>("button")
                ?.getAttribute("aria-expanded"),
        ).toBe("true");

        act(() => root.render(null));
        act(() =>
            root.render(
                <ToolExpansionStoreProvider scopeKey="session-2">
                    <ToolActivitySegment
                        {...DEFAULT_PROPS}
                        segment={segment}
                    />
                </ToolExpansionStoreProvider>,
            ),
        );

        expect(
            container
                .querySelector<HTMLButtonElement>("button")
                ?.getAttribute("aria-expanded"),
        ).toBe("false");
    });
});
