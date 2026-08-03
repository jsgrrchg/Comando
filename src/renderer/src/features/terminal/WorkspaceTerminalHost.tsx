import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import type { WorkspaceNode } from "@shared/ipc";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import {
    collectPaneNodes,
    type RuntimeWorkspaceTerminalTab,
} from "@renderer/app/workspace/tree";

import { useTerminalRuntimeStore } from "./terminalRuntimeStore";

const MAX_COALESCED_OUTPUT_CHARS = 256_000;
const COALESCED_OUTPUT_FLUSH_MS = 16;

function getComandoApiOrNull() {
    return globalThis.window?.comando ?? null;
}

export function getReadyActiveWorkspaceTabIds(
    rootNode: WorkspaceNode,
    deferredPaneIds: ReadonlySet<string>,
    activePaneId: string,
): ReadonlySet<string> {
    return new Set(
        collectPaneNodes(rootNode).flatMap((pane) =>
            pane.activeTabId &&
            (pane.id === activePaneId || !deferredPaneIds.has(pane.id))
                ? [pane.activeTabId]
                : [],
        ),
    );
}

export function WorkspaceTerminalHost({
    presentationActive = true,
}: {
    readonly presentationActive?: boolean;
}) {
    const {
        activePaneId,
        deferredPaneIds,
        rootNode,
        tabsById,
    } = useWorkspaceStore(
        useShallow((state) => ({
            activePaneId: state.activePaneId,
            deferredPaneIds: state.deferredPaneIds,
            rootNode: state.rootNode,
            tabsById: state.tabsById,
        })),
    );
    const visibleTerminalTabs = useMemo(
        () =>
            Object.values(tabsById).filter(
                (tab): tab is RuntimeWorkspaceTerminalTab =>
                    tab.kind === "terminal",
            ),
        [tabsById],
    );
    const activeTerminalTabs = useMemo(() => {
        const activeTabIds = getReadyActiveWorkspaceTabIds(
            rootNode,
            deferredPaneIds,
            activePaneId,
        );

        return visibleTerminalTabs.filter((tab) => activeTabIds.has(tab.id));
    }, [activePaneId, deferredPaneIds, rootNode, visibleTerminalTabs]);
    const liveTerminalIds = useMemo(
        () => visibleTerminalTabs.map((tab) => tab.terminalId),
        [visibleTerminalTabs],
    );
    const ensureTerminal = useTerminalRuntimeStore(
        (state) => state.ensureTerminal,
    );
    const closeMissingTerminals = useTerminalRuntimeStore(
        (state) => state.closeMissingTerminals,
    );

    useEffect(() => {
        if (!presentationActive) {
            return;
        }
        const comandoApi = getComandoApiOrNull();
        if (!comandoApi) {
            return;
        }

        const pendingBySessionId = new Map<string, string>();
        let pendingChars = 0;
        let rafId: number | null = null;
        let flushTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let cancelled = false;

        const flushPending = () => {
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            if (flushTimeoutId !== null) {
                clearTimeout(flushTimeoutId);
                flushTimeoutId = null;
            }
            rafId = null;
            const store = useTerminalRuntimeStore.getState();
            for (const [sessionId, chunk] of pendingBySessionId) {
                store.handleTerminalOutput({ chunk, sessionId });
            }
            pendingBySessionId.clear();
            pendingChars = 0;
        };

        const scheduleFlush = () => {
            if (rafId === null) {
                rafId = requestAnimationFrame(flushPending);
            }
            if (flushTimeoutId === null) {
                flushTimeoutId = setTimeout(
                    flushPending,
                    COALESCED_OUTPUT_FLUSH_MS,
                );
            }
        };

        const unsubscribeData = comandoApi.onTerminalData((event) => {
            if (cancelled) {
                return;
            }

            pendingBySessionId.set(
                event.sessionId,
                (pendingBySessionId.get(event.sessionId) ?? "") + event.data,
            );
            pendingChars += event.data.length;
            if (pendingChars >= MAX_COALESCED_OUTPUT_CHARS) {
                flushPending();
                return;
            }
            scheduleFlush();
        });
        const unsubscribeExit = comandoApi.onTerminalExit((event) => {
            if (cancelled) {
                return;
            }

            if (pendingBySessionId.has(event.sessionId)) {
                flushPending();
            }
            useTerminalRuntimeStore.getState().handleTerminalExited({
                exitCode: event.exitCode,
                sessionId: event.sessionId,
            });
        });

        return () => {
            cancelled = true;
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            if (flushTimeoutId !== null) {
                clearTimeout(flushTimeoutId);
                flushTimeoutId = null;
            }
            if (pendingBySessionId.size > 0) {
                flushPending();
            }
            unsubscribeData();
            unsubscribeExit();
        };
    }, [presentationActive]);

    useEffect(() => {
        if (!presentationActive) {
            return;
        }
        for (const tab of activeTerminalTabs) {
            ensureTerminal(tab);
        }
        closeMissingTerminals(liveTerminalIds);
    }, [
        activeTerminalTabs,
        closeMissingTerminals,
        ensureTerminal,
        liveTerminalIds,
        presentationActive,
    ]);

    return null;
}
