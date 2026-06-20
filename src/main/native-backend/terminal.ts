import type {
    CreateTerminalSessionInput,
    TerminalDataEvent,
    TerminalExitEvent,
    TerminalSession,
} from "@shared/ipc";
import {
    nativeTerminalDataEventToIpc,
    nativeTerminalExitEventToIpc,
    type NativeBackendEvent,
    type NativeTerminalCreateInput,
    type NativeTerminalDataEvent,
    type NativeTerminalExitEvent,
    type NativeTerminalSession,
    type NativeTerminalWindowsShell,
} from "@shared/native-backend";

import type { ProjectService } from "@main/projects/service";
import type { SettingsGateway } from "@main/settings/service";
import type { TerminalGateway } from "@main/terminals/service";

import type { NativeBackendRequester } from "./persistence";

export const NATIVE_TERMINAL_ENABLED_ENV = "COMANDO_NATIVE_TERMINAL";
export const NATIVE_TERMINAL_MODE_ENV = "COMANDO_NATIVE_TERMINAL_MODE";

type NativeTerminalClient = NativeBackendRequester & {
    onEvent(listener: (event: NativeBackendEvent) => void): () => void;
};

export interface NativeTerminalGatewayOptions {
    readonly client: NativeTerminalClient;
    readonly onData: (ownerWindowId: string, event: TerminalDataEvent) => void;
    readonly onDiagnostic?: (message: string) => void;
    readonly onExit: (ownerWindowId: string, event: TerminalExitEvent) => void;
    readonly projectService: ProjectService;
    readonly settingsService: SettingsGateway;
}

export class NativeTerminalGateway implements TerminalGateway {
    readonly #client: NativeTerminalClient;
    readonly #disposeEventListener: () => void;
    readonly #onData: (ownerWindowId: string, event: TerminalDataEvent) => void;
    readonly #onDiagnostic?: (message: string) => void;
    readonly #onExit: (ownerWindowId: string, event: TerminalExitEvent) => void;
    readonly #projectService: ProjectService;
    readonly #settingsService: SettingsGateway;

    constructor(options: NativeTerminalGatewayOptions) {
        this.#client = options.client;
        this.#onData = options.onData;
        this.#onDiagnostic = options.onDiagnostic;
        this.#onExit = options.onExit;
        this.#projectService = options.projectService;
        this.#settingsService = options.settingsService;
        this.#disposeEventListener = this.#client.onEvent((event) => {
            this.#handleNativeEvent(event);
        });
    }

    async createSession(
        input: CreateTerminalSessionInput,
        ownerWindowId: string,
    ): Promise<TerminalSession> {
        const cwd = input.projectId
            ? this.#projectService.getProjectRootPath(
                  input.projectId,
                  input.worktreeId ?? null,
              )
            : process.cwd();
        const request: NativeTerminalCreateInput = {
            cols: input.cols ?? null,
            cwd,
            extraEnv: sanitizeExtraEnv(input.extraEnv),
            launchedBy: "user",
            launch: { kind: "shell" },
            preferredSessionId: input.preferredSessionId ?? null,
            projectId: input.projectId,
            purpose: "workspace",
            rows: input.rows ?? null,
            shellPreference: {
                windowsShell: normalizeNativeTerminalWindowsShell(
                    this.#settingsService.loadAppTerminalSettings().windowsShell,
                ),
            },
            terminalId: input.terminalId ?? null,
            windowId: ownerWindowId,
            worktreeId: input.worktreeId ?? null,
        };
        const session = await this.#client.request<NativeTerminalSession>(
            "terminal_create",
            request,
        );

        return nativeTerminalSessionToIpc(session);
    }

    async writeInput(
        ownerWindowId: string,
        sessionId: string,
        data: string,
    ): Promise<void> {
        await this.#client.request("terminal_write", {
            data,
            sessionId,
            windowId: ownerWindowId,
        });
    }

    async resizeSession(
        ownerWindowId: string,
        sessionId: string,
        cols: number,
        rows: number,
    ): Promise<void> {
        await this.#client.request("terminal_resize", {
            cols,
            rows,
            sessionId,
            windowId: ownerWindowId,
        });
    }

    async closeSessionOrOwnedTerminal(
        ownerWindowId: string,
        id: string,
    ): Promise<void> {
        await this.#client.request("terminal_close", {
            id,
            reason: "user",
            windowId: ownerWindowId,
        });
    }

    closeOwnedByWindow(ownerWindowId: string): void {
        void this.#client
            .request("terminal_close_window", { windowId: ownerWindowId })
            .catch((error) => {
                this.#reportDiagnostic(
                    `Native terminal window cleanup failed: ${formatError(error)}`,
                );
            });
    }

    async close(): Promise<void> {
        this.#disposeEventListener();
        await this.#closeAll().catch((error) => {
            this.#reportDiagnostic(
                `Native terminal shutdown cleanup failed: ${formatError(error)}`,
            );
        });
    }

    async #closeAll(): Promise<void> {
        const result = await this.#client.request<{
            readonly sessions?: readonly NativeTerminalSession[];
        }>("terminal_list", { windowId: null });
        for (const session of result.sessions ?? []) {
            await this.#client.request("terminal_close", {
                id: session.sessionId,
                reason: "user",
                windowId: session.windowId,
            });
        }
    }

    #handleNativeEvent(event: NativeBackendEvent): void {
        if (event.eventName === "terminal://data") {
            const payload = requireRecord(
                event.payload,
                "Native terminal data event",
            ) as unknown as NativeTerminalDataEvent;
            this.#onData(payload.windowId, nativeTerminalDataEventToIpc(payload));
            return;
        }

        if (event.eventName === "terminal://exit") {
            const payload = requireRecord(
                event.payload,
                "Native terminal exit event",
            ) as unknown as NativeTerminalExitEvent;
            this.#onExit(payload.windowId, nativeTerminalExitEventToIpc(payload));
            return;
        }

        if (event.eventName === "terminal://error") {
            const payload = requireRecord(
                event.payload,
                "Native terminal error event",
            );
            const message =
                typeof payload.message === "string"
                    ? payload.message
                    : "Native terminal error.";
            this.#reportDiagnostic(message);
        }
    }

    #reportDiagnostic(message: string): void {
        this.#onDiagnostic?.(message);
    }
}

export function shouldUseNativeTerminal(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    if (env[NATIVE_TERMINAL_ENABLED_ENV] !== "1") {
        return false;
    }

    const mode = env[NATIVE_TERMINAL_MODE_ENV];
    return mode === undefined || mode === "" || mode === "native";
}

function nativeTerminalSessionToIpc(
    session: NativeTerminalSession,
): TerminalSession {
    return {
        cols: session.cols,
        cwd: session.cwd,
        exitCode: session.exitCode,
        projectId: session.projectId,
        rows: session.rows,
        sessionId: session.sessionId,
        status: session.status,
        worktreeId: session.worktreeId,
    };
}

function sanitizeExtraEnv(
    extraEnv: Record<string, string> | undefined,
): Record<string, string> {
    if (!extraEnv) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(extraEnv).filter(
            (entry): entry is [string, string] =>
                typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
    );
}

function requireRecord(
    value: unknown,
    label: string,
): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }

    return value as Record<string, unknown>;
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function normalizeNativeTerminalWindowsShell(
    value: string,
): NativeTerminalWindowsShell {
    switch (value) {
        case "cmd":
        case "powershell":
        case "pwsh":
            return value;
        case "default":
        default:
            return "default";
    }
}
