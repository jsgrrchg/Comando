import type { AiHistorySessionSummary } from "@shared/ipc";

export interface AiSessionHierarchyRow {
    readonly depth: number;
    readonly hasChildren: boolean;
    readonly isSubagent: boolean;
    readonly parentSession: AiHistorySessionSummary | null;
    readonly session: AiHistorySessionSummary;
}

export interface AiSessionHierarchyGroup {
    readonly rows: readonly AiSessionHierarchyRow[];
    readonly rootSession: AiHistorySessionSummary;
}

export type AiSessionHierarchySiblingComparator = (
    left: AiHistorySessionSummary,
    right: AiHistorySessionSummary,
) => number;

export function getAiHistorySessionLookupKeys(
    session: Pick<AiHistorySessionSummary, "runtimeSessionId" | "sessionId">,
): readonly string[] {
    return [
        normalizeSessionRef(session.sessionId),
        normalizeSessionRef(session.runtimeSessionId),
    ].filter((value): value is string => Boolean(value));
}

export function isAiHistorySessionChildOfParent(
    parent: Pick<AiHistorySessionSummary, "runtimeSessionId" | "sessionId">,
    candidate: Pick<
        AiHistorySessionSummary,
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

export function buildAiSessionHierarchyGroups(
    sessions: readonly AiHistorySessionSummary[],
    options: {
        readonly compareSiblings?: AiSessionHierarchySiblingComparator | null;
        readonly filterQuery?: string | null;
    } = {},
): readonly AiSessionHierarchyGroup[] {
    if (sessions.length === 0) {
        return [];
    }

    const query = normalizeHierarchyQuery(options.filterQuery);
    const sessionByRef = new Map<string, AiHistorySessionSummary>();
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
    const childrenByParentId = new Map<string, AiHistorySessionSummary[]>();
    const roots: AiHistorySessionSummary[] = [];

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
    const groups: AiSessionHierarchyGroup[] = [];
    const appendGroup = (rootSession: AiHistorySessionSummary) => {
        if (appendedSessionIds.has(rootSession.sessionId)) {
            return;
        }

        const rows: AiSessionHierarchyRow[] = [];
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

export function filterAiSessionHierarchyRowsForCollapsedParents(
    rows: readonly AiSessionHierarchyRow[],
    collapsedSessionIds: ReadonlySet<string>,
): readonly AiSessionHierarchyRow[] {
    if (rows.length === 0 || collapsedSessionIds.size === 0) {
        return rows;
    }

    const visibleRows: AiSessionHierarchyRow[] = [];
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

function appendHierarchyRows({
    appendedSessionIds,
    childrenByParentId,
    compareSiblings,
    depth,
    rows,
    session,
    sessionByRef,
}: {
    readonly appendedSessionIds: Set<string>;
    readonly childrenByParentId: Map<string, AiHistorySessionSummary[]>;
    readonly compareSiblings: AiSessionHierarchySiblingComparator;
    readonly depth: number;
    readonly rows: AiSessionHierarchyRow[];
    readonly session: AiHistorySessionSummary;
    readonly sessionByRef: Map<string, AiHistorySessionSummary>;
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

function createSiblingComparator(
    compareSiblings: AiSessionHierarchySiblingComparator | null | undefined,
    indexBySessionId: ReadonlyMap<string, number>,
): AiSessionHierarchySiblingComparator {
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
    session: AiHistorySessionSummary,
    query: string,
): boolean {
    return (
        session.title.toLowerCase().includes(query) ||
        (session.preview ?? "").toLowerCase().includes(query)
    );
}
