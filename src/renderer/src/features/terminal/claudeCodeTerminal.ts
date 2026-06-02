import {
    ALLOWED_CLAUDE_CODE_MODELS,
    DEFAULT_APP_TERMINAL_SETTINGS,
} from "@shared/terminal-settings";
import type { RuntimeWorkspaceTab } from "@renderer/app/workspace/tree";
import { useSettingsStore } from "@renderer/app/store/settings-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import {
    getClaudeCodeSidebarSessions,
    registerClaudeCodeSidebarSession,
    resetClaudeCodeSidebarSessionsForTests,
} from "./claudeCodeSidebarSession";
import { useTerminalRuntimeStore } from "./terminalRuntimeStore";

let claudeCodeInstalledCache: boolean | null = null;

const CLAUDE_CODE_TITLE_PATTERN = /^Claude Code(?: (\d+))?$/;
const SAFE_SHELL_TOKEN_PATTERN = /^[A-Za-z0-9_./:@%+=,-]+$/;
const DEFAULT_TERMINAL_RUNNING_TIMEOUT_MS = 10_000;

export interface LaunchClaudeCodeTerminalInput {
    readonly paneId?: string | null;
    readonly projectId: string | null;
    readonly timeoutMs?: number;
    readonly worktreeId?: string | null;
}

export interface LaunchClaudeCodeTerminalResult {
    readonly commandWritten: boolean;
    readonly terminalId: string | null;
    readonly terminalTabId: string | null;
    readonly transcriptSessionId: string | null;
}

export async function checkClaudeCodeInstalled(): Promise<boolean> {
    if (claudeCodeInstalledCache !== null) {
        return claudeCodeInstalledCache;
    }

    try {
        const api = getComandoApi();
        const result = await api.checkCommandAvailability({ name: "claude" });
        claudeCodeInstalledCache = result.found;
    } catch {
        claudeCodeInstalledCache = false;
    }

    return claudeCodeInstalledCache;
}

export function resetClaudeCodeInstalledCacheForTests(): void {
    claudeCodeInstalledCache = null;
}

export async function launchClaudeCodeTerminal(
    input: LaunchClaudeCodeTerminalInput,
): Promise<LaunchClaudeCodeTerminalResult> {
    const title = getNextClaudeCodeTerminalTitle(
        Object.values(useWorkspaceStore.getState().tabsById),
    );
    const terminalTabId = await useWorkspaceStore
        .getState()
        .createTerminalTab(input.projectId, input.worktreeId ?? null, {
            paneId: input.paneId ?? null,
            title,
        });

    if (!terminalTabId) {
        return createLaunchResult(null, null, null, false);
    }

    const terminalTab = useWorkspaceStore.getState().tabsById[terminalTabId];
    if (!terminalTab || terminalTab.kind !== "terminal") {
        return createLaunchResult(terminalTabId, null, null, false);
    }

    const terminalId = terminalTab.terminalId;
    const running = await waitForTerminalRunning(
        terminalId,
        input.timeoutMs ?? DEFAULT_TERMINAL_RUNNING_TIMEOUT_MS,
    );
    if (!running) {
        return createLaunchResult(terminalTabId, terminalId, null, false);
    }

    const runtime =
        useTerminalRuntimeStore.getState().runtimesById[terminalId] ?? null;
    const terminalSettings =
        useSettingsStore.getState().terminal ?? DEFAULT_APP_TERMINAL_SETTINGS;
    const transcriptSessionId = getPinnedTranscriptSessionId(
        terminalSettings.claudeCodeContinueSession,
    );
    const command = buildShellCommand(
        buildClaudeCodeCommandArgs({
            continueSession: terminalSettings.claudeCodeContinueSession,
            maxTurns: terminalSettings.claudeCodeMaxTurns,
            model: terminalSettings.claudeCodeModel,
            skipPermissions: terminalSettings.claudeCodeSkipPermissions,
            transcriptSessionId,
        }),
    );

    registerClaudeCodeSidebarSession({
        cwd: runtime?.snapshot.cwd ?? "",
        projectId: terminalTab.projectId,
        terminalId,
        terminalTabId,
        title,
        transcriptSessionId,
        worktreeId: terminalTab.worktreeId ?? null,
    });

    await useTerminalRuntimeStore.getState().writeInput(terminalId, command);

    return createLaunchResult(
        terminalTabId,
        terminalId,
        transcriptSessionId,
        true,
    );
}

export function buildShellCommand(args: readonly string[]): string {
    if (args.length === 0) {
        throw new Error("Expected at least one command token.");
    }

    for (const arg of args) {
        if (!SAFE_SHELL_TOKEN_PATTERN.test(arg)) {
            throw new Error(`Unsafe shell token: ${arg}`);
        }
    }

    return `${args.join(" ")}\n`;
}

export function getSafeClaudeCodeModel(model: string): string | null {
    const normalized = model.trim();
    if (!normalized) {
        return null;
    }
    if (
        ALLOWED_CLAUDE_CODE_MODELS.includes(
            normalized as (typeof ALLOWED_CLAUDE_CODE_MODELS)[number],
        )
    ) {
        return normalized;
    }

    console.warn("[claude-code-terminal] Ignoring unsafe Claude Code model.");
    return null;
}

export function getNextClaudeCodeTerminalTitle(
    tabs: readonly RuntimeWorkspaceTab[],
): string {
    let maxValue = 0;
    for (const tab of tabs) {
        if (tab.kind !== "terminal") {
            continue;
        }
        const match = CLAUDE_CODE_TITLE_PATTERN.exec(tab.title.trim());
        if (!match) {
            continue;
        }
        const value = match[1] ? Number.parseInt(match[1], 10) : 1;
        if (Number.isFinite(value)) {
            maxValue = Math.max(maxValue, value);
        }
    }

    return `Claude Code ${maxValue + 1}`;
}

export function getPinnedTranscriptSessionId(
    continueSession: boolean,
): string | null {
    return continueSession ? null : createUuid();
}

export function getClaudeCodeTerminalSidebarItemsForTests() {
    return getClaudeCodeSidebarSessions();
}

export function resetClaudeCodeTerminalStateForTests(): void {
    claudeCodeInstalledCache = null;
    resetClaudeCodeSidebarSessionsForTests();
}

interface BuildClaudeCodeCommandArgsInput {
    readonly continueSession: boolean;
    readonly maxTurns: number;
    readonly model: string;
    readonly skipPermissions: boolean;
    readonly transcriptSessionId: string | null;
}

function buildClaudeCodeCommandArgs({
    continueSession,
    maxTurns,
    model,
    skipPermissions,
    transcriptSessionId,
}: BuildClaudeCodeCommandArgsInput): readonly string[] {
    const args = ["claude"];
    if (skipPermissions) {
        args.push("--dangerously-skip-permissions");
    }
    if (transcriptSessionId) {
        args.push("--session-id", transcriptSessionId);
    }
    const safeModel = getSafeClaudeCodeModel(model);
    if (safeModel) {
        args.push("--model", safeModel);
    }
    if (continueSession) {
        args.push("--continue");
    }
    const safeMaxTurns = Math.max(0, Math.floor(maxTurns));
    if (safeMaxTurns > 0) {
        args.push("--max-turns", String(safeMaxTurns));
    }
    return args;
}

function waitForTerminalRunning(
    terminalId: string,
    timeoutMs = DEFAULT_TERMINAL_RUNNING_TIMEOUT_MS,
): Promise<boolean> {
    if (isTerminalRunning(terminalId)) {
        return Promise.resolve(true);
    }
    if (timeoutMs <= 0) {
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        const cleanup = (value: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            unsubscribe?.();
            clearTimeout(timeout);
            resolve(value);
        };
        const timeout = setTimeout(() => cleanup(false), timeoutMs);

        unsubscribe = useTerminalRuntimeStore.subscribe((state) => {
            if (state.runtimesById[terminalId]?.snapshot.status === "running") {
                cleanup(true);
            }
        });
    });
}

function isTerminalRunning(terminalId: string): boolean {
    return (
        useTerminalRuntimeStore.getState().runtimesById[terminalId]?.snapshot
            .status === "running"
    );
}

function createLaunchResult(
    terminalTabId: string | null,
    terminalId: string | null,
    transcriptSessionId: string | null,
    commandWritten: boolean,
): LaunchClaudeCodeTerminalResult {
    return {
        commandWritten,
        terminalId,
        terminalTabId,
        transcriptSessionId,
    };
}

function createUuid(): string {
    return (
        globalThis.crypto?.randomUUID?.() ??
        "00000000-0000-4000-8000-000000000000"
    );
}

function getComandoApi() {
    const comandoWindow = globalThis.window;
    if (!comandoWindow?.comando) {
        throw new Error(
            "The desktop bridge is not available yet. Restart the Electron app and try again.",
        );
    }

    return comandoWindow.comando;
}
