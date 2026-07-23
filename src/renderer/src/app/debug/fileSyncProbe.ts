const FILE_SYNC_TRACE_STORAGE_KEY = "comando:file-sync-trace";
const MAX_FILE_SYNC_TRACE_EVENTS = 512;

export type FileSyncTraceEventName =
    | "draft_changed"
    | "invalidation_received"
    | "model_changed"
    | "read_completed"
    | "read_failed"
    | "read_started"
    | "reload_accepted"
    | "reload_discarded"
    | "reload_skipped"
    | "reload_started"
    | "save_completed"
    | "save_failed"
    | "save_started"
    | "scroll_jump"
    | "selection_changed";

export interface FileSyncTraceFlags {
    readonly hasExternalChange: boolean;
    readonly isDirty: boolean;
    readonly isLoading: boolean;
    readonly isSaving: boolean;
}

export interface FileSyncTraceEvent {
    readonly contentHash: string | null;
    readonly contentLength: number | null;
    readonly contentRevision: number | null;
    readonly event: FileSyncTraceEventName;
    readonly flags: FileSyncTraceFlags | null;
    readonly origin: string | null;
    readonly path: string | null;
    readonly requestId: number | null;
    readonly tabId: string | null;
    readonly timestamp: number;
}

export interface RecordFileSyncTraceInput {
    readonly content?: string | null;
    readonly contentRevision?: number | null;
    readonly event: FileSyncTraceEventName;
    readonly flags?: FileSyncTraceFlags | null;
    readonly origin?: string | null;
    readonly path?: string | null;
    readonly requestId?: number | null;
    readonly tabId?: string | null;
}

interface FileSyncTraceStore {
    readonly events: FileSyncTraceEvent[];
}

type FileSyncTraceRoot = typeof globalThis & {
    __COMANDO_FILE_SYNC_TRACE__?: FileSyncTraceStore;
    __comandoFileSyncTraceDump?: () => readonly FileSyncTraceEvent[];
    __comandoFileSyncTraceReset?: () => void;
};

let enabledForTests: boolean | null = null;
let cachedEnabled: boolean | null = null;

export function isFileSyncTraceEnabled(): boolean {
    if (enabledForTests !== null) {
        return enabledForTests;
    }
    if (cachedEnabled !== null) {
        return cachedEnabled;
    }
    if (typeof window === "undefined") {
        cachedEnabled = false;
        return cachedEnabled;
    }

    try {
        const value = window.localStorage
            .getItem(FILE_SYNC_TRACE_STORAGE_KEY)
            ?.trim()
            .toLowerCase();
        cachedEnabled = value === "1" || value === "true" || value === "on";
    } catch {
        cachedEnabled = false;
    }
    return cachedEnabled;
}

export function recordFileSyncTrace(input: RecordFileSyncTraceInput): void {
    if (!isFileSyncTraceEnabled()) {
        return;
    }

    const store = getFileSyncTraceStore();
    store.events.push({
        contentHash: shortContentHash(input.content),
        contentLength:
            typeof input.content === "string" ? input.content.length : null,
        contentRevision: input.contentRevision ?? null,
        event: input.event,
        flags: input.flags ?? null,
        origin: input.origin ?? null,
        path: normalizeTracePath(input.path),
        requestId: input.requestId ?? null,
        tabId: input.tabId ?? null,
        timestamp: Date.now(),
    });
    if (store.events.length > MAX_FILE_SYNC_TRACE_EVENTS) {
        store.events.splice(0, store.events.length - MAX_FILE_SYNC_TRACE_EVENTS);
    }
}

export function getFileSyncTraceSnapshot(): readonly FileSyncTraceEvent[] {
    const root = globalThis as FileSyncTraceRoot;
    return [...(root.__COMANDO_FILE_SYNC_TRACE__?.events ?? [])];
}

export function resetFileSyncTraceForTests(): void {
    const root = globalThis as FileSyncTraceRoot;
    root.__COMANDO_FILE_SYNC_TRACE__?.events.splice(0);
    cachedEnabled = null;
    enabledForTests = null;
}

export function setFileSyncTraceEnabledForTests(enabled: boolean | null): void {
    enabledForTests = enabled;
}

function getFileSyncTraceStore(): FileSyncTraceStore {
    const root = globalThis as FileSyncTraceRoot;
    if (!root.__COMANDO_FILE_SYNC_TRACE__) {
        root.__COMANDO_FILE_SYNC_TRACE__ = { events: [] };
        root.__comandoFileSyncTraceDump = getFileSyncTraceSnapshot;
        root.__comandoFileSyncTraceReset = resetFileSyncTraceForTests;
    }
    return root.__COMANDO_FILE_SYNC_TRACE__;
}

function normalizeTracePath(path: string | null | undefined): string | null {
    if (!path) {
        return null;
    }

    const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
    return normalized.replace(/\/{2,}/g, "/");
}

function shortContentHash(content: string | null | undefined): string | null {
    if (typeof content !== "string") {
        return null;
    }

    let hash = 2166136261;
    for (let index = 0; index < content.length; index += 1) {
        hash ^= content.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
