import type { CreateTerminalSessionInput, TerminalDataEvent, TerminalExitEvent, TerminalSession } from "@shared/ipc";
import type { ProjectService } from "@main/projects/service";
interface TerminalServiceOptions {
    readonly onData: (event: TerminalDataEvent) => void;
    readonly onExit: (event: TerminalExitEvent) => void;
    readonly projectService: ProjectService;
}
export declare class TerminalService {
    #private;
    constructor(options: TerminalServiceOptions);
    createSession(input: CreateTerminalSessionInput): TerminalSession;
    writeInput(sessionId: string, data: string): void;
    resizeSession(sessionId: string, cols: number, rows: number): void;
    closeSession(sessionId: string): void;
    close(): void;
}
export {};
