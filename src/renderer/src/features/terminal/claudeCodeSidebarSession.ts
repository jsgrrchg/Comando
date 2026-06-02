import type { AiHistorySessionSummary, AiRuntimeId } from "@shared/ipc";

import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import {
    collectPaneNodes,
    type RuntimeWorkspaceTerminalTab,
    type RuntimeWorkspaceTab,
} from "@renderer/app/workspace/tree";

export const CLAUDE_CODE_TERMINAL_RUNTIME_ID = "claude-code-terminal" as const;

export type SidebarAgentRuntimeId =
    | AiRuntimeId
    | typeof CLAUDE_CODE_TERMINAL_RUNTIME_ID;

export type SidebarAgentSessionSummary = Omit<
    AiHistorySessionSummary,
    "runtimeId"
> & {
    readonly runtimeId: SidebarAgentRuntimeId;
    readonly isTerminalAgent?: boolean;
    readonly terminalId?: string;
};

export interface ClaudeCodeSidebarSessionSummary
    extends Omit<AiHistorySessionSummary, "runtimeId"> {
    readonly cwd: string;
    readonly defaultTitle: string;
    readonly isTerminalAgent: true;
    readonly runtimeId: typeof CLAUDE_CODE_TERMINAL_RUNTIME_ID;
    readonly terminalId: string;
    readonly terminalTabId: string;
    readonly transcriptMtimeMs: number | null;
    readonly transcriptSessionId: string | null;
}

export interface RegisterClaudeCodeSidebarSessionInput {
    readonly cwd: string;
    readonly projectId: string | null;
    readonly terminalId: string;
    readonly terminalTabId: string;
    readonly title: string;
    readonly transcriptSessionId: string | null;
    readonly worktreeId: string | null;
}

type MutableClaudeCodeSidebarSession = ClaudeCodeSidebarSessionSummary & {
    readonly customTitle: string | null;
};

const sessionsByTerminalId = new Map<string, MutableClaudeCodeSidebarSession>();
const listeners = new Set<() => void>();

export function registerClaudeCodeSidebarSession(
    input: RegisterClaudeCodeSidebarSessionInput,
): ClaudeCodeSidebarSessionSummary {
    const now = new Date().toISOString();
    const existing = sessionsByTerminalId.get(input.terminalId);
    const next: MutableClaudeCodeSidebarSession = {
        createdAt: existing?.createdAt ?? now,
        customTitle: existing?.customTitle ?? null,
        cwd: input.cwd,
        defaultTitle: input.title,
        isTerminalAgent: true,
        messageCount: 0,
        preview: existing?.preview ?? null,
        projectId: input.projectId,
        runtimeId: CLAUDE_CODE_TERMINAL_RUNTIME_ID,
        runtimeSessionId: input.transcriptSessionId,
        sessionId: createSidebarSessionId(input.terminalId),
        terminalId: input.terminalId,
        terminalTabId: input.terminalTabId,
        title: existing?.title ?? input.title,
        transcriptMtimeMs: existing?.transcriptMtimeMs ?? null,
        transcriptSessionId: input.transcriptSessionId,
        updatedAt: existing?.updatedAt ?? now,
        worktreeId: input.worktreeId,
    };

    sessionsByTerminalId.set(input.terminalId, next);
    notifyClaudeCodeSidebarSessionListeners();
    return toPublicSession(next);
}

export function subscribeClaudeCodeSidebarSessions(
    listener: () => void,
): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getClaudeCodeSidebarSessions(): readonly ClaudeCodeSidebarSessionSummary[] {
    return [...sessionsByTerminalId.values()].map(toPublicSession);
}

export function getClaudeCodeSidebarSessionByTerminalId(
    terminalId: string,
): ClaudeCodeSidebarSessionSummary | null {
    const session = sessionsByTerminalId.get(terminalId);
    return session ? toPublicSession(session) : null;
}

export function isClaudeCodeSidebarSession(
    session: SidebarAgentSessionSummary,
): session is ClaudeCodeSidebarSessionSummary {
    return (
        session.runtimeId === CLAUDE_CODE_TERMINAL_RUNTIME_ID &&
        session.isTerminalAgent === true &&
        typeof session.terminalId === "string"
    );
}

export async function focusClaudeCodeSidebarSession(
    session: ClaudeCodeSidebarSessionSummary,
): Promise<void> {
    const tab = findTerminalTabForSession(session);
    if (!tab) {
        removeClaudeCodeSidebarSession(session.terminalId);
        return;
    }

    const pane = collectPaneNodes(useWorkspaceStore.getState().rootNode).find(
        (candidate) => candidate.tabIds.includes(tab.id),
    );
    if (!pane) {
        return;
    }

    await useWorkspaceStore.getState().selectTab(pane.id, tab.id);
}

export async function closeClaudeCodeSidebarSession(
    session: ClaudeCodeSidebarSessionSummary,
): Promise<void> {
    const tab = findTerminalTabForSession(session);
    if (tab) {
        await useWorkspaceStore.getState().closeTab(tab.id);
    }
    removeClaudeCodeSidebarSession(session.terminalId);
}

export async function renameClaudeCodeSidebarSession(
    session: ClaudeCodeSidebarSessionSummary,
    title: string,
): Promise<void> {
    const current = sessionsByTerminalId.get(session.terminalId);
    if (!current) {
        return;
    }

    const trimmedTitle = title.trim();
    if (!trimmedTitle || trimmedTitle === current.title) {
        return;
    }

    sessionsByTerminalId.set(session.terminalId, {
        ...current,
        customTitle: trimmedTitle,
        title: trimmedTitle,
        updatedAt: new Date().toISOString(),
    });
    notifyClaudeCodeSidebarSessionListeners();

    await useWorkspaceStore
        .getState()
        .updateTerminalTabTitle(current.terminalTabId, trimmedTitle);
}

export function reconcileClaudeCodeSidebarSessions(
    tabs: readonly RuntimeWorkspaceTab[],
): void {
    let changed = false;

    for (const [terminalId, session] of sessionsByTerminalId) {
        const tab = tabs.find(
            (candidate) =>
                candidate.kind === "terminal" &&
                candidate.terminalId === terminalId,
        );
        if (!tab) {
            sessionsByTerminalId.delete(terminalId);
            changed = true;
            continue;
        }
        if (tab.id !== session.terminalTabId) {
            sessionsByTerminalId.set(terminalId, {
                ...session,
                terminalTabId: tab.id,
            });
            changed = true;
        }
    }

    if (changed) {
        notifyClaudeCodeSidebarSessionListeners();
    }
}

export async function refreshClaudeCodeSidebarSessionTranscript(
    session: ClaudeCodeSidebarSessionSummary,
): Promise<void> {
    if (!session.transcriptSessionId || !session.cwd) {
        return;
    }

    const current = sessionsByTerminalId.get(session.terminalId);
    if (!current) {
        return;
    }

    const api = getComandoApi();
    if (!api) {
        return;
    }

    const result = await api.readClaudeCodeTranscript({
        cwd: current.cwd,
        sessionId: session.transcriptSessionId,
        sinceMtimeMs: current.transcriptMtimeMs,
    });
    if (!result.found || !result.changed) {
        return;
    }

    const previousTitle = current.title;
    const nextTitle =
        current.customTitle ?? normalizeTranscriptText(result.title) ?? current.title;
    const nextPreview = normalizeTranscriptText(result.preview) ?? current.preview;
    const nextSession: MutableClaudeCodeSidebarSession = {
        ...current,
        preview: nextPreview,
        title: nextTitle,
        transcriptMtimeMs: result.mtimeMs,
        updatedAt: new Date().toISOString(),
    };
    sessionsByTerminalId.set(current.terminalId, nextSession);
    notifyClaudeCodeSidebarSessionListeners();

    if (current.customTitle || nextTitle === previousTitle) {
        return;
    }

    const tab = useWorkspaceStore.getState().tabsById[current.terminalTabId];
    if (
        tab?.kind === "terminal" &&
        (tab.title === previousTitle || tab.title === current.defaultTitle)
    ) {
        await useWorkspaceStore
            .getState()
            .updateTerminalTabTitle(current.terminalTabId, nextTitle);
    }
}

export function resetClaudeCodeSidebarSessionsForTests(): void {
    sessionsByTerminalId.clear();
    listeners.clear();
}

function findTerminalTabForSession(
    session: ClaudeCodeSidebarSessionSummary,
): RuntimeWorkspaceTerminalTab | null {
    const tabs = Object.values(useWorkspaceStore.getState().tabsById);
    return (
        tabs.find(
            (tab): tab is RuntimeWorkspaceTerminalTab =>
                tab.kind === "terminal" &&
                (tab.id === session.terminalTabId ||
                    tab.terminalId === session.terminalId),
        ) ?? null
    );
}

function removeClaudeCodeSidebarSession(terminalId: string): void {
    if (sessionsByTerminalId.delete(terminalId)) {
        notifyClaudeCodeSidebarSessionListeners();
    }
}

function notifyClaudeCodeSidebarSessionListeners(): void {
    for (const listener of listeners) {
        listener();
    }
}

function toPublicSession(
    session: MutableClaudeCodeSidebarSession,
): ClaudeCodeSidebarSessionSummary {
    const { customTitle, ...publicSession } = session;
    void customTitle;
    return publicSession;
}

function createSidebarSessionId(terminalId: string): string {
    return `${CLAUDE_CODE_TERMINAL_RUNTIME_ID}:${terminalId}`;
}

function normalizeTranscriptText(value: string | null): string | null {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 ? trimmed : null;
}

function getComandoApi() {
    return typeof window !== "undefined" ? (window.comando ?? null) : null;
}
