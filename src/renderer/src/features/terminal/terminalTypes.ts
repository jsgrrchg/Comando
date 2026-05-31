export type TerminalSessionStatus =
    | "idle"
    | "starting"
    | "running"
    | "exited"
    | "error";

export interface TerminalSessionSnapshot {
    readonly sessionId: string;
    readonly program: string;
    readonly status: TerminalSessionStatus;
    readonly displayName: string;
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
    readonly exitCode: number | null;
    readonly errorMessage: string | null;
}

export interface TerminalOutputEventPayload {
    readonly sessionId: string;
    readonly chunk: string;
}

export interface TerminalErrorEventPayload {
    readonly sessionId: string;
    readonly message: string;
}

export interface TerminalSessionCreateInput {
    readonly projectId: string | null;
    readonly worktreeId?: string | null;
    readonly cols?: number;
    readonly rows?: number;
    readonly extraEnv?: Record<string, string>;
    readonly terminalId?: string;
}

export type TerminalOutputCommand =
    | { readonly type: "write"; readonly data: string }
    | { readonly type: "clear" };

export interface TerminalReplaySnapshot {
    readonly serialized: string;
    readonly sessionId: string;
}

export interface TerminalSessionView {
    readonly snapshot: TerminalSessionSnapshot;
    readonly hasOutput: boolean;
    readonly busy: boolean;
    readonly writeInput: (input: string) => Promise<void>;
    readonly resize: (cols: number, rows: number) => Promise<void>;
    readonly restart: () => Promise<void>;
    readonly clearViewport: () => void;
    readonly subscribeOutput: (
        listener: (command: TerminalOutputCommand) => void,
    ) => () => void;
    readonly getReplaySnapshot: () => TerminalReplaySnapshot | null;
    readonly saveReplaySnapshot: (serialized: string) => void;
}

export const EMPTY_TERMINAL_SNAPSHOT: TerminalSessionSnapshot = {
    cols: 120,
    cwd: "",
    displayName: "Shell",
    errorMessage: null,
    exitCode: null,
    program: "",
    rows: 24,
    sessionId: "",
    status: "idle",
};
