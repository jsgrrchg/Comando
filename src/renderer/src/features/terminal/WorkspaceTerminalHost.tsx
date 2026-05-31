import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceTerminalTab } from "@renderer/app/workspace/tree";

import { useTerminalRuntimeStore } from "./terminalRuntimeStore";

const MAX_COALESCED_OUTPUT_CHARS = 256_000;
const COALESCED_OUTPUT_FLUSH_MS = 16;

function getComandoApiOrNull() {
    return globalThis.window?.comando ?? null;
}

export function WorkspaceTerminalHost() {
    const terminalTabs = useWorkspaceStore(
        useShallow((state) =>
            Object.values(state.tabsById).filter(
                (tab): tab is RuntimeWorkspaceTerminalTab =>
                    tab.kind === "terminal",
            ),
        ),
    );
    const ensureTerminal = useTerminalRuntimeStore(
        (state) => state.ensureTerminal,
    );
    const closeMissingTerminals = useTerminalRuntimeStore(
        (state) => state.closeMissingTerminals,
    );

    useEffect(() => {
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
    }, []);

    useEffect(() => {
        for (const tab of terminalTabs) {
            ensureTerminal(tab);
        }
        closeMissingTerminals(terminalTabs.map((tab) => tab.terminalId));
    }, [closeMissingTerminals, ensureTerminal, terminalTabs]);

    useEffect(
        () => () => {
            useTerminalRuntimeStore.getState().closeMissingTerminals([]);
        },
        [],
    );

    return null;
}
