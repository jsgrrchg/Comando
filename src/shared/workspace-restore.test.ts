import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    normalizeWindowWorkspaceRestoreRecord,
    normalizeWorkspaceNavigationSnapshot,
} from "./workspace-restore";

describe("workspace restore normalization", () => {
    it("migrates a legacy layout into the supplied window scope", () => {
        const result = normalizeWorkspaceNavigationSnapshot(
            {
                activePaneId: "pane-root",
                rootNode: {
                    activeTabId: "file-1",
                    id: "pane-root",
                    tabIds: ["file-1"],
                    type: "pane",
                },
                tabs: [
                    {
                        createdAt: "2026-01-01T00:00:00.000Z",
                        id: "file-1",
                        kind: "file",
                        projectId: "project-1",
                        relativePath: "README.md",
                        title: "README.md",
                    },
                ],
            },
            { projectId: "project-1", worktreeId: "worktree-1" },
        );

        expect(result.snapshot.activeContextKey).toBe(
            "project-1::worktree-1",
        );
        expect(result.snapshot.contexts).toHaveLength(1);
    });

    it("drops only an invalid context and repairs pane references", () => {
        const result = normalizeWorkspaceNavigationSnapshot({
            activeContextKey: "missing",
            contexts: [
                {
                    key: "wrong-key",
                    lastActivatedAt: "2026-01-01T00:00:00.000Z",
                    projectId: "project-1",
                    workspace: {
                        activePaneId: "missing-pane",
                        rootNode: {
                            activeTabId: "missing-tab",
                            id: "pane-root",
                            pinnedTabIds: ["missing-tab"],
                            tabIds: ["missing-tab"],
                            type: "pane",
                        },
                        tabs: [],
                    },
                    worktreeId: null,
                },
                { key: "broken", projectId: "project-2" },
            ],
            openContextKeys: ["missing", "wrong-key"],
            version: 2,
        });

        expect(result.droppedContextCount).toBe(1);
        expect(result.snapshot.openContextKeys).toEqual([
            "project-1::__primary__",
        ]);
        expect(result.snapshot.version).toBe(3);
        expect(result.snapshot.contexts[0]?.workspace).toMatchObject({
            activePaneId: "pane-root",
            rootNode: { activeTabId: null, pinnedTabIds: [], tabIds: [] },
        });
    });

    it("preserves and normalizes restore revisions", () => {
        const record = normalizeWindowWorkspaceRestoreRecord({
            revision: 4.9,
            schemaVersion: 1,
            snapshot: {
                activeContextKey: null,
                contexts: [],
                openContextKeys: [],
                version: 3,
            },
            updatedAt: "2026-01-01T00:00:00.000Z",
        });

        expect(record.revision).toBe(4);
        expect(record.schemaVersion).toBe(1);
    });

    it("keeps closed v3 contexts out of the open context keys", () => {
        const result = normalizeWorkspaceNavigationSnapshot({
            activeContextKey: "project-1::__primary__",
            contexts: [
                {
                    key: "project-1::__primary__",
                    lastActivatedAt: "2026-01-02T00:00:00.000Z",
                    projectId: "project-1",
                    workspace: {
                        activePaneId: "pane-root",
                        rootNode: { activeTabId: null, id: "pane-root", tabIds: [], type: "pane" },
                        tabs: [],
                    },
                    worktreeId: null,
                },
                {
                    key: "project-2::__primary__",
                    lastActivatedAt: "2026-01-01T00:00:00.000Z",
                    projectId: "project-2",
                    workspace: {
                        activePaneId: "pane-root",
                        rootNode: { activeTabId: null, id: "pane-root", tabIds: [], type: "pane" },
                        tabs: [],
                    },
                    worktreeId: null,
                },
            ],
            openContextKeys: ["project-1::__primary__", "missing", "project-1::__primary__"],
            version: 3,
        });

        expect(result.snapshot.openContextKeys).toEqual(["project-1::__primary__"]);
        expect(result.snapshot.activeContextKey).toBe("project-1::__primary__");
    });

    it("clears an active v3 context that is no longer open", () => {
        const result = normalizeWorkspaceNavigationSnapshot({
            activeContextKey: "project-2::__primary__",
            contexts: [],
            openContextKeys: [],
            version: 3,
        });

        expect(result.snapshot.activeContextKey).toBeNull();
    });

    it("normalizes the frozen v1 and v2 fixtures without losing payloads", () => {
        const v1 = fixture("legacy-v1-layout.json");
        const normalizedV1 = normalizeWorkspaceNavigationSnapshot(v1, {
            projectId: "project-v1",
            worktreeId: null,
        }).snapshot;
        const normalizedV2 = normalizeWorkspaceNavigationSnapshot(
            fixture("legacy-v2-navigation.json"),
        ).snapshot;

        expect(normalizedV1).toMatchObject({
            activeContextKey: "project-v1::__primary__",
            contexts: [
                {
                    workspace: {
                        activePaneId: "pane-main",
                        rootNode: {
                            activeTabId: "chat-v1",
                            pinnedTabIds: ["file-v1"],
                        },
                    },
                },
            ],
        });
        expect(normalizedV1.contexts[0]?.workspace.tabs).toContainEqual(
            expect.objectContaining({
                draft: "preserve v1 draft byte-for-byte",
                sessionId: "session-v1",
            }),
        );
        expect(normalizedV2.activeContextKey).toBe(
            "project-v2::__primary__",
        );
        expect(normalizedV2.openContextKeys).toEqual([
            "project-v2::__primary__",
            "project-v2::worktree-v2-feature",
        ]);
        expect(normalizedV2.contexts[0]?.workspace.tabs).toContainEqual(
            expect.objectContaining({
                draft: "primary draft from v2",
                sessionId: "session-v2-primary",
                worktreeId: null,
            }),
        );
    });

    it("inventories every valid v3 context across open and closed windows", () => {
        const source = fixture<LegacyMultiwindowFixture>(
            "legacy-v3-multiwindow.json",
        );
        const candidates = normalizeLegacyWindows(source.windows);
        const candidatesByScope = groupCandidatesByScope(candidates);

        expect(candidates).toHaveLength(source.expected.normalizedContextCount);
        expect(
            source.windows.reduce(
                (total, window) =>
                    total +
                    normalizeWorkspaceNavigationSnapshot(
                        window.restore.snapshot,
                    ).droppedContextCount,
                0,
            ),
        ).toBe(source.expected.droppedContextCount);
        expect(
            Object.fromEntries(
                [...candidatesByScope].map(([scopeKey, scopeCandidates]) => [
                    scopeKey,
                    scopeCandidates.length,
                ]),
            ),
        ).toEqual(source.expected.candidateCountByScope);

        const drafts = candidates
            .flatMap((candidate) => candidate.context.workspace.tabs)
            .flatMap((tab) =>
                "draft" in tab && typeof tab.draft === "string"
                    ? [tab.draft]
                    : [],
            );
        const sessionIds = candidates
            .flatMap((candidate) => candidate.context.workspace.tabs)
            .flatMap((tab) =>
                "sessionId" in tab && typeof tab.sessionId === "string"
                    ? [tab.sessionId]
                    : [],
            );

        expect([...new Set(drafts)].sort()).toEqual(
            [...source.expected.preservedDrafts].sort(),
        );
        expect([...new Set(sessionIds)].sort()).toEqual(
            [...source.expected.preservedSessionIds].sort(),
        );
    });

    it("freezes deterministic single-window winners and divergent recovery layouts", () => {
        const source = fixture<LegacyMultiwindowFixture>(
            "legacy-v3-multiwindow.json",
        );
        const candidates = normalizeLegacyWindows(source.windows);
        const activeWinner = candidates
            .filter(
                (candidate) =>
                    candidate.context.key === candidate.activeContextKey,
            )
            .toSorted(compareActiveCandidates)[0];

        expect(activeWinner).toMatchObject({
            context: { key: source.expected.activeScopeKey },
            windowId: source.expected.activeSourceWindowId,
        });

        const candidatesByScope = groupCandidatesByScope(candidates);
        const layoutSources: Record<string, string> = {};
        const recoverySources: Record<string, string[]> = {};
        for (const [scopeKey, scopeCandidates] of candidatesByScope) {
            const ranked = scopeCandidates.toSorted(compareLayoutCandidates);
            const winner = ranked[0];
            if (!winner) continue;
            layoutSources[scopeKey] = winner.windowId;
            const winnerLayout = JSON.stringify(winner.context.workspace);
            const alternatives = ranked
                .slice(1)
                .filter(
                    (candidate) =>
                        JSON.stringify(candidate.context.workspace) !==
                        winnerLayout,
                )
                .map((candidate) => candidate.windowId);
            if (alternatives.length > 0) {
                recoverySources[scopeKey] = alternatives;
            }
        }

        expect(layoutSources).toEqual(
            source.expected.layoutSourceWindowIdByScope,
        );
        expect(recoverySources).toEqual(
            source.expected.recoverySourceWindowIdsByScope,
        );

        const alphaWinner = candidatesByScope
            .get("project-alpha::__primary__")
            ?.toSorted(compareLayoutCandidates)[0];
        expect(alphaWinner?.context.workspace).toMatchObject({
            activePaneId: "pane-alpha-chat",
            rootNode: {
                sizes: [0.55, 0.45],
                type: "split",
            },
        });
    });

    it("links streaming AI, terminals and dirty files to migration scopes", () => {
        const source = fixture<LegacyMultiwindowFixture>(
            "legacy-v3-multiwindow.json",
        );
        const runtime = fixture<RuntimeRiskFixture>(
            "runtime-risk-state.json",
        );
        const candidates = normalizeLegacyWindows(source.windows);
        const knownScopeKeys = new Set(
            candidates.map((candidate) => candidate.context.key),
        );
        const knownSessionIds = new Set(
            candidates
                .flatMap((candidate) => candidate.context.workspace.tabs)
                .flatMap((tab) =>
                    "sessionId" in tab && typeof tab.sessionId === "string"
                        ? [tab.sessionId]
                        : [],
                ),
        );
        const knownFilePaths = new Set(
            candidates
                .flatMap((candidate) => candidate.context.workspace.tabs)
                .flatMap((tab) =>
                    "relativePath" in tab &&
                    typeof tab.relativePath === "string"
                        ? [tab.relativePath]
                        : [],
                ),
        );

        for (const scope of runtime.scopes) {
            expect(knownScopeKeys.has(scope.scopeKey)).toBe(true);
            for (const session of scope.aiSessions) {
                expect(knownSessionIds.has(session.sessionId)).toBe(true);
            }
            for (const terminal of scope.terminals) {
                expect(knownSessionIds.has(terminal.sessionId)).toBe(true);
            }
            for (const file of scope.fileBuffers) {
                expect(knownFilePaths.has(file.path)).toBe(true);
            }
        }

        expect(runtime.scopes.map((scope) => scope.runtimeOwnerId)).toEqual(
            runtime.expected.runtimeOwnerIds,
        );
        expect(collectHardLeaseKinds(runtime)).toEqual(
            runtime.expected.hardLeaseKinds,
        );
    });

    it("requires an explicit checksum update when a frozen fixture changes", () => {
        const manifest = fixture<FixtureManifest>("manifest.json");

        for (const entry of manifest.files) {
            const contents = readFileSync(
                path.join(FIXTURE_ROOT, entry.file),
            );
            expect(
                createHash("sha256").update(contents).digest("hex"),
                entry.file,
            ).toBe(entry.sha256);
        }
    });
});

const FIXTURE_ROOT = path.join(
    process.cwd(),
    "fixtures",
    "workspace-migration",
);

interface FixtureManifest {
    readonly files: readonly {
        readonly file: string;
        readonly sha256: string;
    }[];
}

interface LegacyFixtureWindow {
    readonly isOpen: boolean;
    readonly restore: {
        readonly revision: number;
        readonly snapshot: unknown;
        readonly updatedAt: string;
    };
    readonly windowId: string;
}

interface LegacyMultiwindowFixture {
    readonly expected: {
        readonly activeScopeKey: string;
        readonly activeSourceWindowId: string;
        readonly candidateCountByScope: Readonly<Record<string, number>>;
        readonly droppedContextCount: number;
        readonly layoutSourceWindowIdByScope: Readonly<Record<string, string>>;
        readonly normalizedContextCount: number;
        readonly preservedDrafts: readonly string[];
        readonly preservedSessionIds: readonly string[];
        readonly recoverySourceWindowIdsByScope: Readonly<
            Record<string, readonly string[]>
        >;
    };
    readonly windows: readonly LegacyFixtureWindow[];
}

interface NormalizedLegacyCandidate {
    readonly activeContextKey: string | null;
    readonly context: ReturnType<
        typeof normalizeWorkspaceNavigationSnapshot
    >["snapshot"]["contexts"][number];
    readonly isContextOpen: boolean;
    readonly isWindowOpen: boolean;
    readonly restoreRevision: number;
    readonly restoreUpdatedAt: string;
    readonly windowId: string;
}

interface RuntimeRiskFixture {
    readonly expected: {
        readonly hardLeaseKinds: readonly string[];
        readonly runtimeOwnerIds: readonly string[];
    };
    readonly scopes: readonly {
        readonly aiSessions: readonly {
            readonly pendingPermission: boolean;
            readonly sessionId: string;
            readonly status: string;
        }[];
        readonly fileBuffers: readonly {
            readonly externalConflict: boolean;
            readonly path: string;
            readonly saveState: string;
            readonly status: string;
        }[];
        readonly pendingActions: readonly { readonly status: string }[];
        readonly runtimeOwnerId: string;
        readonly scopeKey: string;
        readonly terminals: readonly {
            readonly sessionId: string;
            readonly status: string;
        }[];
    }[];
}

function fixture<T = unknown>(fileName: string): T {
    return JSON.parse(
        readFileSync(path.join(FIXTURE_ROOT, fileName), "utf8"),
    ) as T;
}

function normalizeLegacyWindows(
    windows: readonly LegacyFixtureWindow[],
): readonly NormalizedLegacyCandidate[] {
    return windows.flatMap((window) => {
        const record = normalizeWindowWorkspaceRestoreRecord(window.restore);
        const openContextKeys = new Set(record.snapshot.openContextKeys);
        return record.snapshot.contexts.map((context) => ({
            activeContextKey: record.snapshot.activeContextKey,
            context,
            isContextOpen: openContextKeys.has(context.key),
            isWindowOpen: window.isOpen,
            restoreRevision: record.revision,
            restoreUpdatedAt: record.updatedAt,
            windowId: window.windowId,
        }));
    });
}

function groupCandidatesByScope(
    candidates: readonly NormalizedLegacyCandidate[],
): ReadonlyMap<string, readonly NormalizedLegacyCandidate[]> {
    const output = new Map<string, NormalizedLegacyCandidate[]>();
    for (const candidate of candidates) {
        const scopeCandidates = output.get(candidate.context.key) ?? [];
        scopeCandidates.push(candidate);
        output.set(candidate.context.key, scopeCandidates);
    }
    return output;
}

function compareActiveCandidates(
    left: NormalizedLegacyCandidate,
    right: NormalizedLegacyCandidate,
): number {
    return (
        compareBoolean(right.isWindowOpen, left.isWindowOpen) ||
        right.context.lastActivatedAt.localeCompare(
            left.context.lastActivatedAt,
        ) ||
        right.restoreUpdatedAt.localeCompare(left.restoreUpdatedAt) ||
        right.restoreRevision - left.restoreRevision ||
        left.windowId.localeCompare(right.windowId)
    );
}

function compareLayoutCandidates(
    left: NormalizedLegacyCandidate,
    right: NormalizedLegacyCandidate,
): number {
    const leftOpen = left.isWindowOpen && left.isContextOpen;
    const rightOpen = right.isWindowOpen && right.isContextOpen;
    return (
        compareBoolean(rightOpen, leftOpen) ||
        compareBoolean(
            right.context.key === right.activeContextKey,
            left.context.key === left.activeContextKey,
        ) ||
        right.context.lastActivatedAt.localeCompare(
            left.context.lastActivatedAt,
        ) ||
        right.restoreUpdatedAt.localeCompare(left.restoreUpdatedAt) ||
        right.restoreRevision - left.restoreRevision ||
        left.windowId.localeCompare(right.windowId)
    );
}

function compareBoolean(left: boolean, right: boolean): number {
    return Number(left) - Number(right);
}

function collectHardLeaseKinds(runtime: RuntimeRiskFixture): readonly string[] {
    const kinds = new Set<string>();
    for (const scope of runtime.scopes) {
        if (
            scope.aiSessions.some(
                (session) =>
                    session.status === "streaming" ||
                    session.pendingPermission,
            )
        ) {
            kinds.add("ai-streaming");
        }
        if (scope.terminals.some((terminal) => terminal.status === "running")) {
            kinds.add("terminal-running");
        }
        if (scope.fileBuffers.some((file) => file.status === "dirty")) {
            kinds.add("file-dirty");
        }
        if (scope.fileBuffers.some((file) => file.saveState === "saving")) {
            kinds.add("file-saving");
        }
        if (scope.fileBuffers.some((file) => file.externalConflict)) {
            kinds.add("file-conflict");
        }
        if (scope.pendingActions.some((action) => action.status === "claimed")) {
            kinds.add("pending-action");
        }
    }
    return [...kinds].sort();
}
