import { useMemo } from "react";

import type { RuntimeWorkspaceTerminalTab } from "@renderer/app/workspace/tree";

import { TerminalViewport } from "./TerminalViewport";
import {
    createTerminalSessionView,
    useTerminalRuntimeStore,
} from "./terminalRuntimeStore";

interface WorkspaceTerminalViewProps {
    readonly tab: RuntimeWorkspaceTerminalTab;
    readonly active: boolean;
    readonly activePane: boolean;
}

export function WorkspaceTerminalView({
    tab,
    active,
    activePane,
}: WorkspaceTerminalViewProps) {
    const runtime = useTerminalRuntimeStore(
        (state) => state.runtimesById[tab.terminalId] ?? null,
    );
    const session = useMemo(
        () => (runtime ? createTerminalSessionView(runtime) : null),
        [runtime],
    );

    return (
        <div
            aria-hidden={!active}
            className="absolute inset-0 min-h-0 min-w-0"
            data-terminal-active={active || undefined}
            data-terminal-id={tab.terminalId}
            data-testid="workspace-terminal-view"
            style={{
                pointerEvents: active ? "auto" : "none",
                visibility: active ? "visible" : "hidden",
            }}
        >
            {session ? (
                <TerminalViewport
                    active={active}
                    autoFocus={active && activePane}
                    session={session}
                />
            ) : (
                <div className="flex h-full items-center justify-center bg-editor text-xs text-text-secondary">
                    Starting shell...
                </div>
            )}
        </div>
    );
}
