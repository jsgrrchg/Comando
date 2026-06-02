import type { AiHistorySessionSummary } from "@shared/ipc";

type HierarchySessionBase = Pick<
    AiHistorySessionSummary,
    "parentSessionId" | "preview" | "runtimeSessionId" | "sessionId" | "title"
>;

export interface AiSessionHierarchyRow<
    TSession extends HierarchySessionBase = AiHistorySessionSummary,
> {
    readonly depth: number;
    readonly hasChildren: boolean;
    readonly isSubagent: boolean;
    readonly parentSession: TSession | null;
    readonly session: TSession;
}

export interface AiSessionHierarchyGroup<
    TSession extends HierarchySessionBase = AiHistorySessionSummary,
> {
    readonly rows: readonly AiSessionHierarchyRow<TSession>[];
    readonly rootSession: TSession;
}

export type AiSessionHierarchySiblingComparator<
    TSession extends HierarchySessionBase = AiHistorySessionSummary,
> = (
    left: TSession,
    right: TSession,
) => number;

export function getAiHistorySessionLookupKeys(
    session: Pick<HierarchySessionBase, "runtimeSessionId" | "sessionId">,
): readonly string[] {
    return [
        normalizeSessionRef(session.sessionId),
        normalizeSessionRef(session.runtimeSessionId),
    ].filter((value): value is string => Boolean(value));
}

export function isAiHistorySessionChildOfParent(
    parent: Pick<HierarchySessionBase, "runtimeSessionId" | "sessionId">,
    candidate: Pick<
        HierarchySessionBase,
        "parentSessionId" | "runtimeSessionId" | "sessionId"
    >,
): boolean {
    const parentRef = normalizeSessionRef(candidate.parentSessionId);
    if (!parentRef || getAiHistorySessionLookupKeys(candidate).includes(parentRef)) {
        return false;
    }

    return getAiHistorySessionLookupKeys(parent).includes(parentRef);
}

export function countAiHistorySessionChildren(
    parent: AiHistorySessionSummary,
    sessions: readonly AiHistorySessionSummary[],
): number {
    return sessions.filter((session) =>
        isAiHistorySessionChildOfParent(parent, session),
    ).length;
}

export function findAiHistorySessionParent(
    session: AiHistorySessionSummary,
    sessions: readonly AiHistorySessionSummary[],
): AiHistorySessionSummary | null {
    const parentRef = normalizeSessionRef(session.parentSessionId);
    if (!parentRef || getAiHistorySessionLookupKeys(session).includes(parentRef)) {
        return null;
    }

    for (const candidate of sessions) {
        if (getAiHistorySessionLookupKeys(candidate).includes(parentRef)) {
            return candidate;
        }
    }

    return null;
}

export function buildAiSessionHierarchyGroups<
    TSession extends HierarchySessionBase = AiHistorySessionSummary,
>(
    sessions: readonly TSession[],
    options: {
        readonly compareSiblings?: AiSessionHierarchySiblingComparator<TSession> | null;
        readonly filterQuery?: string | null;
    } = {},
): readonly AiSessionHierarchyGroup<TSession>[] {
    if (sessions.length === 0) {
        return [];
    }

    const query = normalizeHierarchyQuery(options.filterQuery);
    const sessionByRef = new Map<string, TSession>();
    for (const session of sessions) {
        for (const key of getAiHistorySessionLookupKeys(session)) {
            if (!sessionByRef.has(key)) {
                sessionByRef.set(key, session);
            }
        }
    }
    const indexBySessionId = new Map(
        sessions.map((session, index) => [session.sessionId, index] as const),
    );
    const compareSiblings = createSiblingComparator(
        options.compareSiblings,
        indexBySessionId,
    );
    const childrenByParentId = new Map<string, TSession[]>();
    const roots: TSession[] = [];

    for (const session of sessions) {
        const parentSessionId = normalizeSessionRef(session.parentSessionId);
        const parentSession =
            parentSessionId &&
            !getAiHistorySessionLookupKeys(session).includes(parentSessionId)
                ? (sessionByRef.get(parentSessionId) ?? null)
                : null;
        if (parentSession) {
            const children =
                childrenByParentId.get(parentSession.sessionId) ?? [];
            children.push(session);
            childrenByParentId.set(parentSession.sessionId, children);
            continue;
        }

        roots.push(session);
    }

    for (const children of childrenByParentId.values()) {
        children.sort(compareSiblings);
    }

    const appendedSessionIds = new Set<string>();
    const groups: AiSessionHierarchyGroup<TSession>[] = [];
    const appendGroup = (rootSession: TSession) => {
        if (appendedSessionIds.has(rootSession.sessionId)) {
            return;
        }

        const rows: AiSessionHierarchyRow<TSession>[] = [];
        appendHierarchyRows({
            appendedSessionIds,
            childrenByParentId,
            compareSiblings,
            depth: 0,
            rows,
            session: rootSession,
            sessionByRef,
        });

        if (
            rows.length > 0 &&
            (!query ||
                rows.some((row) =>
                    sessionMatchesHierarchyQuery(row.session, query),
                ))
        ) {
            groups.push({
                rootSession,
                rows,
            });
        }
    };

    roots.sort(compareSiblings).forEach(appendGroup);

    // Cycles should not happen, but treating leftovers as roots keeps history
    // renderable even if old data has an invalid parent chain.
    for (const session of sessions) {
        appendGroup(session);
    }

    return groups;
}

export function filterAiSessionHierarchyRowsForCollapsedParents<
    TSession extends HierarchySessionBase = AiHistorySessionSummary,
>(
    rows: readonly AiSessionHierarchyRow<TSession>[],
    collapsedSessionIds: ReadonlySet<string>,
): readonly AiSessionHierarchyRow<TSession>[] {
    if (rows.length === 0 || collapsedSessionIds.size === 0) {
        return rows;
    }

    const visibleRows: AiSessionHierarchyRow<TSession>[] = [];
    const collapsedAncestorDepths: number[] = [];

    for (const row of rows) {
        while (
            collapsedAncestorDepths.length > 0 &&
            row.depth <= collapsedAncestorDepths[collapsedAncestorDepths.length - 1]
        ) {
            collapsedAncestorDepths.pop();
        }

        const hiddenByAncestor = collapsedAncestorDepths.length > 0;
        if (!hiddenByAncestor) {
            visibleRows.push(row);
        }

        if (
            !hiddenByAncestor &&
            row.hasChildren &&
            collapsedSessionIds.has(row.session.sessionId)
        ) {
            collapsedAncestorDepths.push(row.depth);
        }
    }

    return visibleRows;
}

function appendHierarchyRows<TSession extends HierarchySessionBase>({
    appendedSessionIds,
    childrenByParentId,
    compareSiblings,
    depth,
    rows,
    session,
    sessionByRef,
}: {
    readonly appendedSessionIds: Set<string>;
    readonly childrenByParentId: Map<string, TSession[]>;
    readonly compareSiblings: AiSessionHierarchySiblingComparator<TSession>;
    readonly depth: number;
    readonly rows: AiSessionHierarchyRow<TSession>[];
    readonly session: TSession;
    readonly sessionByRef: Map<string, TSession>;
}) {
    if (appendedSessionIds.has(session.sessionId)) {
        return;
    }

    appendedSessionIds.add(session.sessionId);

    const parentSessionId = normalizeSessionRef(session.parentSessionId);
    const parentSession =
        parentSessionId &&
        !getAiHistorySessionLookupKeys(session).includes(parentSessionId)
            ? (sessionByRef.get(parentSessionId) ?? null)
            : null;
    const children = childrenByParentId.get(session.sessionId) ?? [];

    rows.push({
        depth,
        hasChildren: children.length > 0,
        isSubagent: parentSessionId !== null && parentSessionId !== session.sessionId,
        parentSession,
        session,
    });

    for (const child of children) {
        appendHierarchyRows({
            appendedSessionIds,
            childrenByParentId,
            compareSiblings,
            depth: depth + 1,
            rows,
            session: child,
            sessionByRef,
        });
    }
}

function normalizeHierarchyQuery(value: string | null | undefined): string {
    return (value ?? "").trim().toLowerCase();
}

function createSiblingComparator<TSession extends HierarchySessionBase>(
    compareSiblings:
        | AiSessionHierarchySiblingComparator<TSession>
        | null
        | undefined,
    indexBySessionId: ReadonlyMap<string, number>,
): AiSessionHierarchySiblingComparator<TSession> {
    return (left, right) => {
        const customComparison = compareSiblings?.(left, right) ?? 0;
        if (customComparison !== 0) {
            return customComparison;
        }

        return (
            (indexBySessionId.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER) -
            (indexBySessionId.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER)
        );
    };
}

function normalizeSessionRef(value: string | null | undefined): string | null {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 ? trimmed : null;
}

function sessionMatchesHierarchyQuery(
    session: HierarchySessionBase,
    query: string,
): boolean {
    return (
        session.title.toLowerCase().includes(query) ||
        (session.preview ?? "").toLowerCase().includes(query)
    );
}
