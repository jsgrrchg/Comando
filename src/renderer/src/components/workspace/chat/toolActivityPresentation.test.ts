import { describe, expect, it } from "vitest";

import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";

import {
    getToolActivityPresentationPolicy,
    type ToolActivityPresentationContext,
} from "./toolActivityPresentation";
import type { ToolActivityReviewEntry } from "./toolActivityReviewModel";

const EMPTY_CONTEXT: ToolActivityPresentationContext = {
    attentionToolCallIds: new Set(),
};

function createActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        action: null,
        createdAt: "2026-07-10T00:00:00.000Z",
        diffs: [],
        exitCode: null,
        id: "tool-1",
        kind: "read",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: "session-1",
        status: "completed",
        summary: null,
        terminalOutput: null,
        title: "Read file",
        updatedAt: "2026-07-10T00:00:00.000Z",
        ...overrides,
    };
}

function createEntry(
    activityOverrides: Partial<AiToolActivity> = {},
    entryOverrides: Partial<ToolActivityReviewEntry> = {},
): ToolActivityReviewEntry {
    return {
        activity: createActivity(activityOverrides),
        hasPendingTrackedFiles: false,
        pendingTrackedFiles: [],
        trackedFiles: [],
        ...entryOverrides,
    };
}

function classify(
    entry: ToolActivityReviewEntry,
    context: ToolActivityPresentationContext = EMPTY_CONTEXT,
) {
    return getToolActivityPresentationPolicy(entry, context);
}

describe("getToolActivityPresentationPolicy", () => {
    it.each([
        "read",
        "read_file",
        "search",
        "grep",
        "list",
        "glob",
        "find",
        "fetch",
    ])("groups known observation kind %s", (kind) => {
        expect(classify(createEntry({ kind }))).toBe("groupable");
    });

    it("groups only terminal activity with proven success or active execution", () => {
        expect(
            classify(
                createEntry({
                    exitCode: 0,
                    kind: "execute",
                    status: "completed",
                }),
            ),
        ).toBe("groupable");
        expect(
            classify(createEntry({ kind: "shell", status: "in_progress" })),
        ).toBe("groupable");
        expect(
            classify(
                createEntry({
                    exitCode: null,
                    kind: "execute",
                    status: "completed",
                }),
            ),
        ).toBe("standalone-unknown");
        expect(
            classify(createEntry({ kind: "bash", status: "pending" })),
        ).toBe("standalone-unknown");
    });

    it("keeps failed and non-zero activity standalone", () => {
        expect(classify(createEntry({ status: "failed" }))).toBe(
            "standalone-attention",
        );
        expect(classify(createEntry({ exitCode: 2 }))).toBe(
            "standalone-attention",
        );
    });

    it("keeps mutations and all review evidence standalone", () => {
        const trackedFile = {} as AiTrackedFile;
        expect(classify(createEntry({ kind: "edit" }))).toBe(
            "standalone-change",
        );
        expect(
            classify(
                createEntry(
                    { kind: "generic" },
                    { trackedFiles: [trackedFile] },
                ),
            ),
        ).toBe("standalone-change");
        expect(
            classify(
                createEntry(
                    { kind: "generic" },
                    {
                        hasPendingTrackedFiles: true,
                        pendingTrackedFiles: [trackedFile],
                    },
                ),
            ),
        ).toBe("standalone-change");
    });

    it("keeps actions and active permission or input tool calls standalone", () => {
        expect(
            classify(
                createEntry({
                    action: {
                        kind: "open_session",
                        sessionId: "child-session",
                    },
                }),
            ),
        ).toBe("standalone-attention");
        expect(
            classify(createEntry(), {
                attentionToolCallIds: new Set(["tool-1"]),
            }),
        ).toBe("standalone-attention");
    });

    it("keeps normalized status activity structural", () => {
        expect(
            classify(
                createEntry({
                    id: "comando:status:turn:turn-1",
                    kind: "status",
                    title: "New turn",
                }),
            ),
        ).toBe("structural");
        expect(
            classify(
                createEntry({
                    id: "codex-acp:status:item:compact-1",
                    kind: "item_activity",
                    status: "in_progress",
                    title: "Compacting context",
                }),
            ),
        ).toBe("structural");
    });

    it("keeps unknown and MCP activity standalone", () => {
        expect(classify(createEntry({ kind: "other" }))).toBe(
            "standalone-unknown",
        );
        expect(classify(createEntry({ kind: "mcp" }))).toBe(
            "standalone-unknown",
        );
    });

    it("prioritizes structural and change evidence over attention", () => {
        expect(
            classify(
                createEntry({
                    exitCode: 1,
                    id: "comando:status:turn:turn-1",
                    kind: "status",
                    status: "failed",
                }),
            ),
        ).toBe("structural");
        expect(
            classify(createEntry({ exitCode: 1, kind: "write" })),
        ).toBe("standalone-change");
    });

    it("does not change policy with provider-shaped ids, sessions, or titles", () => {
        const variants = [
            createEntry({
                id: "claude-tool-1",
                sessionId: "claude-session",
                title: "Read src/app.ts",
            }),
            createEntry({
                id: "codex-tool-1",
                sessionId: "codex-session",
                title: "Viewing a file",
            }),
            createEntry({
                id: "native-tool-1",
                sessionId: "native-session",
                title: "Inspect",
            }),
        ];

        expect(variants.map((entry) => classify(entry))).toEqual([
            "groupable",
            "groupable",
            "groupable",
        ]);
    });
});
