export const MAX_RETIRED_TERMINAL_SESSION_IDS = 256;

export function allocateTerminalSessionVersion(
    versionsByTerminalId: Map<string, number>,
    nextVersionRef: { current: number },
    terminalId: string,
): number {
    const nextVersion = nextVersionRef.current;
    nextVersionRef.current += 1;
    versionsByTerminalId.set(terminalId, nextVersion);
    return nextVersion;
}

export function deleteTerminalSessionVersions(
    versionsByTerminalId: Map<string, number>,
    terminalIds: Iterable<string>,
): void {
    for (const terminalId of terminalIds) {
        versionsByTerminalId.delete(terminalId);
    }
}

export function collectSessionIdsToClose(
    sessionIds: readonly string[],
    retiredSessionIds: Map<string, true>,
    pendingOutputBySessionId: Map<string, string>,
    maxTrackedRetiredSessionIds = MAX_RETIRED_TERMINAL_SESSION_IDS,
): string[] {
    const nextSessionIds: string[] = [];

    for (const sessionId of new Set(sessionIds)) {
        if (!sessionId) {
            continue;
        }

        pendingOutputBySessionId.delete(sessionId);

        if (retiredSessionIds.has(sessionId)) {
            continue;
        }

        retiredSessionIds.set(sessionId, true);
        nextSessionIds.push(sessionId);

        while (retiredSessionIds.size > maxTrackedRetiredSessionIds) {
            const oldestSessionId = retiredSessionIds.keys().next().value;
            if (!oldestSessionId) {
                break;
            }
            retiredSessionIds.delete(oldestSessionId);
        }
    }

    return nextSessionIds;
}
