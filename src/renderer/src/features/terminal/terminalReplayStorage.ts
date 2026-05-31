const REPLAY_SNAPSHOT_STORAGE_PREFIX = "comando.terminal.replay:";
const MAX_REPLAY_SNAPSHOT_CHARS = 512_000;

interface StoredReplaySnapshot {
    readonly generation: number;
    readonly serialized: string;
    readonly sessionId: string;
}

const replaySnapshotsByTerminalId = new Map<string, StoredReplaySnapshot>();

function getStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function replaySnapshotStorageKey(terminalId: string): string {
    return `${REPLAY_SNAPSHOT_STORAGE_PREFIX}${terminalId}`;
}

function parseStoredReplaySnapshot(value: string | null): StoredReplaySnapshot | null {
    if (!value) {
        return null;
    }

    try {
        const parsed = JSON.parse(value) as Partial<StoredReplaySnapshot>;
        if (
            typeof parsed.sessionId !== "string" ||
            typeof parsed.generation !== "number" ||
            typeof parsed.serialized !== "string" ||
            parsed.serialized.length > MAX_REPLAY_SNAPSHOT_CHARS
        ) {
            return null;
        }
        return {
            generation: parsed.generation,
            serialized: parsed.serialized,
            sessionId: parsed.sessionId,
        };
    } catch {
        return null;
    }
}

function matchesSnapshot(
    snapshot: StoredReplaySnapshot,
    sessionId: string | null,
    generation: number | null,
): boolean {
    return (
        !!sessionId &&
        generation !== null &&
        snapshot.sessionId === sessionId &&
        snapshot.generation === generation
    );
}

export function getReplaySnapshot(
    terminalId: string,
    sessionId: string | null,
    generation: number | null,
): string | null {
    const inMemory = replaySnapshotsByTerminalId.get(terminalId);
    if (inMemory !== undefined) {
        return matchesSnapshot(inMemory, sessionId, generation)
            ? inMemory.serialized
            : null;
    }

    try {
        const stored = parseStoredReplaySnapshot(
            getStorage()?.getItem(replaySnapshotStorageKey(terminalId)) ?? null,
        );
        if (!stored) {
            return null;
        }
        replaySnapshotsByTerminalId.set(terminalId, stored);
        return matchesSnapshot(stored, sessionId, generation)
            ? stored.serialized
            : null;
    } catch {
        return null;
    }
}

export function saveReplaySnapshot(
    terminalId: string,
    sessionId: string | null,
    generation: number | null,
    serialized: string,
): void {
    if (
        !serialized ||
        !sessionId ||
        generation === null ||
        serialized.length > MAX_REPLAY_SNAPSHOT_CHARS
    ) {
        clearReplaySnapshot(terminalId);
        return;
    }

    const snapshot: StoredReplaySnapshot = {
        generation,
        serialized,
        sessionId,
    };
    const encoded = JSON.stringify(snapshot);
    const storage = getStorage();
    replaySnapshotsByTerminalId.set(terminalId, snapshot);

    if (!storage) {
        return;
    }

    try {
        storage.setItem(replaySnapshotStorageKey(terminalId), encoded);
    } catch {
        replaySnapshotsByTerminalId.delete(terminalId);
    }
}

export function clearReplaySnapshot(terminalId: string): void {
    replaySnapshotsByTerminalId.delete(terminalId);
    try {
        getStorage()?.removeItem(replaySnapshotStorageKey(terminalId));
    } catch {
        // Reattach snapshots are best-effort.
    }
}

export function clearAllReplaySnapshotsForTests(): void {
    replaySnapshotsByTerminalId.clear();
}
