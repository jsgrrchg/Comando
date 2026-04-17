// Sentinel embedded in the error message so the renderer can recognize a
// "session busy" rejection even after Electron's IPC layer wraps the error
// ("Error invoking remote method '...': Error: ..."). Message substrings are
// preserved across the IPC boundary; custom Error subclasses and extra
// properties are not.
export const AI_SESSION_BUSY_MARKER = "[ai:session-busy]";

export const AI_SESSION_BUSY_MESSAGE = `${AI_SESSION_BUSY_MARKER} The session is still busy.`;

export class SessionBusyError extends Error {
    constructor(message: string = AI_SESSION_BUSY_MESSAGE) {
        super(message);
        this.name = "SessionBusyError";
    }
}

export function isSessionBusyErrorMessage(message: unknown): boolean {
    return (
        typeof message === "string" && message.includes(AI_SESSION_BUSY_MARKER)
    );
}
