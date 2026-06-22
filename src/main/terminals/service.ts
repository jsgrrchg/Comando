import type {
    CreateTerminalSessionInput,
    TerminalSession,
} from "@shared/ipc";

export interface TerminalGateway {
    createSession(
        input: CreateTerminalSessionInput,
        ownerWindowId: string,
    ): Promise<TerminalSession> | TerminalSession;
    writeInput(
        ownerWindowId: string,
        sessionId: string,
        data: string,
    ): Promise<void> | void;
    resizeSession(
        ownerWindowId: string,
        sessionId: string,
        cols: number,
        rows: number,
    ): Promise<void> | void;
    closeSessionOrOwnedTerminal(
        ownerWindowId: string,
        id: string,
    ): Promise<void> | void;
    closeOwnedByWindow(ownerWindowId: string): void;
    close(): Promise<void> | void;
}
