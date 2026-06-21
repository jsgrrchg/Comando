import { describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_TERMINAL_SETTINGS } from "@shared/terminal-settings";
import type { NativeBackendEvent } from "@shared/native-backend";

import type { ProjectService } from "@main/projects/service";
import type { SettingsGateway } from "@main/settings/service";

import {
    NativeTerminalGateway,
    type NativeTerminalGatewayOptions,
} from "./terminal";

describe("NativeTerminalGateway", () => {
    it("creates native sessions with owner window, cwd, settings, and env", async () => {
        const client = createClient();
        const gateway = new NativeTerminalGateway({
            client,
            onData: vi.fn(),
            onExit: vi.fn(),
            projectService: createProjectService(),
            settingsService: createSettingsService(),
        });

        await expect(
            gateway.createSession(
                {
                    cols: 82,
                    extraEnv: { CLAUDE_CODE_NO_FLICKER: "1" },
                    preferredSessionId: "preferred-session",
                    projectId: "project-1",
                    rows: 18,
                    terminalId: "terminal-tab",
                    worktreeId: "worktree-1",
                },
                "window-1",
            ),
        ).resolves.toMatchObject({
            cols: 82,
            cwd: "/workspace/worktree",
            projectId: "project-1",
            rows: 18,
            sessionId: "native-session",
            status: "running",
        });

        expect(client.request).toHaveBeenCalledWith(
            "terminal_create",
            expect.objectContaining({
                cols: 82,
                cwd: "/workspace/worktree",
                extraEnv: { CLAUDE_CODE_NO_FLICKER: "1" },
                launchedBy: "user",
                launch: { kind: "shell" },
                preferredSessionId: "preferred-session",
                shellPreference: { windowsShell: "pwsh" },
                terminalId: "terminal-tab",
                windowId: "window-1",
            }),
        );
    });

    it("adapts native data and exit events back to terminal IPC events", () => {
        const client = createClient();
        const onData = vi.fn();
        const onExit = vi.fn();
        new NativeTerminalGateway({
            client,
            onData,
            onExit,
            projectService: createProjectService(),
            settingsService: createSettingsService(),
        });

        client.emit({
            eventName: "terminal://data",
            payload: {
                data: "ready\n",
                sessionId: "native-session",
                windowId: "window-1",
            },
            type: "event",
        });
        client.emit({
            eventName: "terminal://exit",
            payload: {
                exitCode: 0,
                sessionId: "native-session",
                signalCode: "15",
                windowId: "window-1",
            },
            type: "event",
        });

        expect(onData).toHaveBeenCalledWith("window-1", {
            data: "ready\n",
            sessionId: "native-session",
        });
        expect(onExit).toHaveBeenCalledWith("window-1", {
            exitCode: 0,
            sessionId: "native-session",
            signalCode: 15,
        });
    });

    it("closes all sessions for a window without surfacing cleanup rejections", () => {
        const client = createClient();
        const diagnostic = vi.fn();
        client.request.mockRejectedValueOnce(new Error("sidecar stopped"));
        const gateway = new NativeTerminalGateway({
            client,
            onData: vi.fn(),
            onDiagnostic: diagnostic,
            onExit: vi.fn(),
            projectService: createProjectService(),
            settingsService: createSettingsService(),
        });

        gateway.closeOwnedByWindow("window-1");

        expect(client.request).toHaveBeenCalledWith("terminal_close_window", {
            windowId: "window-1",
        });
    });
});

function createClient() {
    let listener: ((event: NativeBackendEvent) => void) | null = null;
    const request = vi.fn(<T = unknown>(command: string): Promise<T> => {
        if (command === "terminal_create") {
            return Promise.resolve({
                cols: 82,
                cwd: "/workspace/worktree",
                displayName: "zsh",
                exitCode: null,
                launchedBy: "user",
                program: "/bin/zsh",
                projectId: "project-1",
                purpose: "workspace",
                rows: 18,
                sessionId: "native-session",
                signalCode: null,
                status: "running",
                terminalId: "terminal-tab",
                windowId: "window-1",
                worktreeId: "worktree-1",
            } as T);
        }

        if (command === "terminal_list") {
            return Promise.resolve({ sessions: [] } as T);
        }

        return Promise.resolve({ ok: true } as T);
    });

    return {
        emit(event: NativeBackendEvent) {
            listener?.(event);
        },
        onEvent(callback: (event: NativeBackendEvent) => void) {
            listener = callback;
            return () => {
                listener = null;
            };
        },
        request,
    } as NativeTerminalGatewayOptions["client"] & {
        readonly emit: (event: NativeBackendEvent) => void;
        readonly request: typeof request;
    };
}

function createProjectService() {
    return {
        getProjectRootPath: vi.fn(() => "/workspace/worktree"),
    } as unknown as ProjectService;
}

function createSettingsService() {
    return {
        loadAppTerminalSettings: vi.fn(() => ({
            ...DEFAULT_APP_TERMINAL_SETTINGS,
            windowsShell: "pwsh",
        })),
    } as unknown as SettingsGateway;
}
