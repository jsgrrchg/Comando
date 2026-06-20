export type NativeProtocolVersion = number;
export type NativeDomain =
    | "ai"
    | "backend"
    | "fs"
    | "git"
    | "index"
    | "persistence"
    | "projects"
    | "review"
    | "search"
    | "secret"
    | "settings"
    | "terminal"
    | "workspace";

export type NativeCommandName = string;
export type NativeEventName = string;

export type NativeOperationStatus =
    | "cancelled"
    | "completed"
    | "failed"
    | "pending"
    | "running";

export type NativeCancellationToken = {
    readonly operationId: string;
    readonly reason?: string | null;
};

export type NativePageCursor = string;

export type NativePage<T> = {
    readonly items: readonly T[];
    readonly nextCursor: NativePageCursor | null;
    readonly totalCount: number | null;
};
