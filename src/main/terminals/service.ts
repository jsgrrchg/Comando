import type {
    CreateTerminalSessionInput,
    TerminalSession,
} from "@shared/ipc";

export interface TerminalGateway {
    attachRuntimeSubscriber(
        runtimeOwnerId: string,
        subscriberId: string,
    ): Promise<readonly TerminalSession[]> | readonly TerminalSession[];
    detachRuntimeSubscriber(
        runtimeOwnerId: string,
        subscriberId: string,
    ): boolean;
    resyncRuntimeSubscriber(
        runtimeOwnerId: string,
        subscriberId: string,
    ): Promise<readonly TerminalSession[]> | readonly TerminalSession[];
    createSession(
        input: CreateTerminalSessionInput,
        runtimeOwnerId: string,
    ): Promise<TerminalSession> | TerminalSession;
    writeInput(
        runtimeOwnerId: string,
        sessionId: string,
        data: string,
    ): Promise<void> | void;
    resizeSession(
        runtimeOwnerId: string,
        sessionId: string,
        cols: number,
        rows: number,
    ): Promise<void> | void;
    closeSessionOrOwnedTerminal(
        runtimeOwnerId: string,
        id: string,
    ): Promise<void> | void;
    closeOwnedByWindow(runtimeOwnerId: string): void;
    close(): Promise<void> | void;
}
