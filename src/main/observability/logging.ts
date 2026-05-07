// Lightweight observability helper for errors that are expected to be benign
// (e.g. best-effort OS APIs, torn-down windows, stale ports). Previous code
// used bare `catch {}` which made diagnostics impossible: there is now a
// single place to route these — flip to a structured logger when available.

export function debugBenignError(tag: string, error: unknown): void {
    if (process.env.COMANDO_DEBUG_BENIGN_ERRORS !== "1") {
        return;
    }

    const message = error instanceof Error ? error.message : String(error);
    try {
        console.debug(`[comando] benign (${tag}): ${message}`);
    } catch {
        // Logging must never turn a benign best-effort failure into a crash.
    }
}
