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

export type NativeTerminalSession = {
    readonly sessionId: NativeTerminalSessionId;
    readonly windowId: NativeWindowId;
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
    readonly status: string;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
};

export type NativeTerminalCreateInput = {
    readonly windowId: NativeWindowId;
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
    readonly cwd: string | null;
    readonly cols: number;
    readonly rows: number;
};

export type NativeTerminalWriteInput = {
    readonly sessionId: NativeTerminalSessionId;
    readonly data: string;
};

export type NativeTerminalResizeInput = {
    readonly sessionId: NativeTerminalSessionId;
    readonly cols: number;
    readonly rows: number;
};

export type NativeTerminalDataEvent = {
    readonly sessionId: NativeTerminalSessionId;
    readonly data: string;
};

export type NativeTerminalExitEvent = {
    readonly sessionId: NativeTerminalSessionId;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
};
