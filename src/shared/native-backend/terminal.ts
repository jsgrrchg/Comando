import type {
    NativeProjectId,
    NativeTerminalSessionId,
    NativeWindowId,
    NativeWorktreeId,
} from "./ids";

export type NativeTerminalCloseReason =
    | "error"
    | "process_exit"
    | "user"
    | "window_closed";

export type NativeTerminalStatus = "error" | "exited" | "running";

export type NativeTerminalPurpose = "auth" | "workspace";

export type NativeTerminalLaunchedBy = "agent" | "system" | "user";

export type NativeTerminalWindowsShell =
    | "cmd"
    | "default"
    | "powershell"
    | "pwsh";

export type NativeTerminalShellPreference = {
    readonly windowsShell: NativeTerminalWindowsShell;
};

export type NativeTerminalLaunch =
    | {
          readonly kind: "shell";
      }
    | {
          readonly args: readonly string[];
          readonly displayName: string | null;
          readonly kind: "command";
          readonly program: string;
      };

export type NativeTerminalSession = {
    readonly sessionId: NativeTerminalSessionId;
    readonly windowId: NativeWindowId;
    readonly terminalId: string | null;
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
    readonly status: NativeTerminalStatus;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    readonly program: string;
    readonly displayName: string;
    readonly purpose: NativeTerminalPurpose;
    readonly launchedBy: NativeTerminalLaunchedBy;
};

export type NativeTerminalCreateInput = {
    readonly windowId: NativeWindowId;
    readonly terminalId: string | null;
    readonly preferredSessionId: NativeTerminalSessionId | null;
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
    readonly cwd: string | null;
    readonly cols: number | null;
    readonly rows: number | null;
    readonly extraEnv: Readonly<Record<string, string>>;
    readonly shellPreference: NativeTerminalShellPreference | null;
    readonly purpose: NativeTerminalPurpose;
    readonly launchedBy: NativeTerminalLaunchedBy;
    readonly launch: NativeTerminalLaunch;
};

export type NativeTerminalWriteInput = {
    readonly windowId: NativeWindowId;
    readonly sessionId: NativeTerminalSessionId;
    readonly data: string;
};

export type NativeTerminalResizeInput = {
    readonly windowId: NativeWindowId;
    readonly sessionId: NativeTerminalSessionId;
    readonly cols: number;
    readonly rows: number;
};

export type NativeTerminalKillInput = {
    readonly windowId: NativeWindowId;
    readonly sessionId: NativeTerminalSessionId;
};

export type NativeTerminalCloseInput = {
    readonly windowId: NativeWindowId;
    readonly id: NativeTerminalSessionId;
    readonly reason: NativeTerminalCloseReason;
};

export type NativeTerminalCloseWindowInput = {
    readonly windowId: NativeWindowId;
};

export type NativeTerminalListInput = {
    readonly windowId: NativeWindowId | null;
};

export type NativeTerminalListResult = {
    readonly sessions: readonly NativeTerminalSession[];
};

export type NativeTerminalCreatedEvent = {
    readonly session: NativeTerminalSession;
};

export type NativeTerminalDataEvent = {
    readonly windowId: NativeWindowId;
    readonly sessionId: NativeTerminalSessionId;
    readonly data: string;
};

export type NativeTerminalExitEvent = {
    readonly windowId: NativeWindowId;
    readonly sessionId: NativeTerminalSessionId;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
};

export type NativeTerminalClosedEvent = {
    readonly windowId: NativeWindowId;
    readonly sessionId: NativeTerminalSessionId;
    readonly terminalId: string | null;
    readonly reason: NativeTerminalCloseReason;
};

export type NativeTerminalErrorEvent = {
    readonly windowId: NativeWindowId;
    readonly sessionId: NativeTerminalSessionId | null;
    readonly terminalId: string | null;
    readonly message: string;
    readonly retryable: boolean;
};
