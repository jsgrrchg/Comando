import type {
    AiPromptQueueSnapshot,
    AiQueuedPrompt,
    AiSessionDomainEvent,
    AiSessionSnapshot,
    EnqueueAiPromptInput,
    SendAiPromptInput,
    UpdateAiQueuedPromptInput,
} from "@shared/ipc";
import { isSessionBusyErrorMessage } from "@shared/ai-errors";

interface PromptQueueRecord {
    activeItem: AiQueuedPrompt | null;
    editingItem: AiQueuedPrompt | null;
    editingPosition: QueuePosition | null;
    items: AiQueuedPrompt[];
    ownerWindowId: string | null;
    paused: boolean;
    resumeAfterActiveSettles: boolean;
    revision: number;
    sessionId: string;
    terminal: boolean;
}

interface QueuePosition {
    readonly nextPromptId: string | null;
    readonly previousPromptId: string | null;
    readonly queueIndex: number;
}

export interface AiPromptQueueOptions {
    readonly cancelSession: (sessionId: string) => Promise<void>;
    readonly dispatchPrompt: (
        input: SendAiPromptInput,
        ownerWindowId: string,
    ) => Promise<{
        readonly stopReason: string;
    }>;
    readonly getSessionSnapshot: (sessionId: string) => AiSessionSnapshot | null;
    readonly loadSnapshots?: () => readonly AiPromptQueueSnapshot[];
    readonly onSnapshot: (
        ownerWindowId: string,
        snapshot: AiPromptQueueSnapshot,
    ) => void;
    readonly saveSnapshots?: (
        snapshots: readonly AiPromptQueueSnapshot[],
    ) => Promise<void> | void;
}

export class AiPromptQueue {
    readonly #options: AiPromptQueueOptions;
    readonly #records = new Map<string, PromptQueueRecord>();

    constructor(options: AiPromptQueueOptions) {
        this.#options = options;
        for (const snapshot of options.loadSnapshots?.() ?? []) {
            const terminal = isClosedSessionSnapshot(
                options.getSessionSnapshot(snapshot.sessionId),
            );
            const restoredItems = [
                ...(snapshot.activeItem
                    ? [
                          {
                              ...snapshot.activeItem,
                              error: null,
                              status: "pending_dispatch" as const,
                          },
                      ]
                    : []),
                ...(snapshot.editingItem
                    ? [
                          {
                              ...snapshot.editingItem,
                              error: null,
                              status: "queued" as const,
                          },
                      ]
                    : []),
                ...snapshot.items.map((item) => ({
                    ...item,
                    status:
                        item.status === "running" || item.status === "sending"
                            ? ("pending_dispatch" as const)
                            : item.status,
                })),
            ];
            this.#records.set(snapshot.sessionId, {
                activeItem: null,
                editingItem: null,
                editingPosition: null,
                items: terminal
                    ? deduplicateItems(
                          restoredItems.map((item) =>
                              failedQueuedPrompt(
                                  item,
                                  CLOSED_SESSION_QUEUE_ERROR,
                              ),
                          ),
                      )
                    : deduplicateItems(restoredItems),
                ownerWindowId: null,
                paused: terminal || restoredItems.length > 0,
                resumeAfterActiveSettles: false,
                revision: snapshot.revision + 1,
                sessionId: snapshot.sessionId,
                terminal,
            });
        }
    }

    bindSession(sessionId: string, ownerWindowId: string): AiPromptQueueSnapshot {
        const record = this.#getRecord(sessionId);
        record.ownerWindowId = ownerWindowId;
        this.#isTerminal(record);
        return this.#snapshot(record);
    }

    getSnapshot(
        sessionId: string,
        ownerWindowId?: string,
    ): AiPromptQueueSnapshot {
        const record = this.#getRecord(sessionId);
        if (ownerWindowId) {
            record.ownerWindowId = ownerWindowId;
        }
        this.#isTerminal(record);
        return this.#snapshot(record);
    }

    enqueue(
        input: EnqueueAiPromptInput,
        ownerWindowId: string,
    ): AiPromptQueueSnapshot {
        const record = this.#getRecord(input.sessionId);
        record.ownerWindowId = ownerWindowId;
        const item = createQueuedPrompt(input);
        if (this.#isTerminal(record)) {
            record.items = [
                ...record.items,
                failedQueuedPrompt(item, CLOSED_SESSION_QUEUE_ERROR),
            ];
            record.paused = true;
            this.#commit(record);
            return this.#snapshot(record);
        }
        if (record.paused) {
            record.items = [item, ...record.items];
            record.paused = false;
        } else {
            record.items = [...record.items, item];
        }
        this.#commit(record);
        this.#drain(record);
        return this.#snapshot(record);
    }

    beginEdit(
        sessionId: string,
        promptId: string,
        ownerWindowId: string,
    ): AiPromptQueueSnapshot {
        const record = this.#getRecord(sessionId);
        record.ownerWindowId = ownerWindowId;
        if (this.#isTerminal(record)) {
            return this.#snapshot(record);
        }
        if (record.editingItem?.id === promptId) {
            return this.#snapshot(record);
        }
        const itemsWithCurrentEditRestored = record.editingItem
            ? insertAtPosition(
                record.items,
                { ...record.editingItem, status: "queued" },
                record.editingPosition,
            )
            : record.items;
        const queueIndex = itemsWithCurrentEditRestored.findIndex(
            (item) => item.id === promptId,
        );
        if (queueIndex < 0) {
            return this.#snapshot(record);
        }
        const item = itemsWithCurrentEditRestored[queueIndex];
        record.editingPosition = createPosition(
            itemsWithCurrentEditRestored,
            queueIndex,
        );
        record.editingItem = { ...item, status: "editing" };
        record.items = itemsWithCurrentEditRestored.filter(
            (candidate) => candidate.id !== promptId,
        );
        this.#commit(record);
        return this.#snapshot(record);
    }

    cancelEdit(sessionId: string, ownerWindowId: string): AiPromptQueueSnapshot {
        const record = this.#getRecord(sessionId);
        record.ownerWindowId = ownerWindowId;
        if (this.#isTerminal(record)) {
            return this.#snapshot(record);
        }
        if (!record.editingItem) {
            return this.#snapshot(record);
        }
        record.items = insertAtPosition(
            record.items,
            { ...record.editingItem, status: "queued" },
            record.editingPosition,
        );
        record.editingItem = null;
        record.editingPosition = null;
        this.#commit(record);
        this.#drain(record);
        return this.#snapshot(record);
    }

    update(
        input: UpdateAiQueuedPromptInput,
        ownerWindowId: string,
    ): AiPromptQueueSnapshot {
        const record = this.#getRecord(input.sessionId);
        record.ownerWindowId = ownerWindowId;
        if (this.#isTerminal(record)) {
            return this.#snapshot(record);
        }
        const existing =
            record.editingItem?.id === input.promptId
                ? record.editingItem
                : record.items.find((item) => item.id === input.promptId) ?? null;
        if (!existing) {
            return this.enqueue(input, ownerWindowId);
        }
        const updated = createQueuedPrompt(input, existing);
        record.items = insertAtPosition(
            record.items.filter((item) => item.id !== input.promptId),
            updated,
            record.editingPosition,
        );
        record.editingItem = null;
        record.editingPosition = null;
        record.paused = false;
        this.#commit(record);
        this.#drain(record);
        return this.#snapshot(record);
    }

    remove(
        sessionId: string,
        promptId: string,
        ownerWindowId: string,
    ): AiPromptQueueSnapshot {
        const record = this.#getRecord(sessionId);
        record.ownerWindowId = ownerWindowId;
        const nextItems = record.items.filter((item) => item.id !== promptId);
        const removesEditingItem = record.editingItem?.id === promptId;
        if (nextItems.length === record.items.length && !removesEditingItem) {
            return this.#snapshot(record);
        }
        record.items = nextItems;
        if (removesEditingItem) {
            record.editingItem = null;
            record.editingPosition = null;
        }
        this.#commit(record);
        this.#drain(record);
        return this.#snapshot(record);
    }

    clear(sessionId: string, ownerWindowId: string): AiPromptQueueSnapshot {
        const record = this.#getRecord(sessionId);
        record.ownerWindowId = ownerWindowId;
        const terminal = this.#isTerminal(record);
        record.items = [];
        record.editingItem = null;
        record.editingPosition = null;
        record.paused = terminal;
        record.resumeAfterActiveSettles = false;
        this.#commit(record);
        return this.#snapshot(record);
    }

    async steer(
        sessionId: string,
        promptId: string,
        ownerWindowId: string,
    ): Promise<AiPromptQueueSnapshot> {
        const record = this.#getRecord(sessionId);
        record.ownerWindowId = ownerWindowId;
        if (this.#isTerminal(record)) {
            return this.#snapshot(record);
        }
        const selected = record.items.find((item) => item.id === promptId);
        if (!selected) {
            return this.#snapshot(record);
        }
        record.items = [
            { ...selected, error: null, status: "queued" },
            ...record.items.filter((item) => item.id !== promptId),
        ];

        const sessionIsBusy = isBusySnapshot(
            this.#options.getSessionSnapshot(sessionId),
        );
        if (record.activeItem || sessionIsBusy) {
            record.paused = true;
            record.resumeAfterActiveSettles = true;
            this.#commit(record);
            try {
                await this.#options.cancelSession(sessionId);
            } catch (error) {
                record.resumeAfterActiveSettles = false;
                this.#commit(record);
                throw error;
            }
            return this.#snapshot(record);
        }

        record.paused = false;
        this.#commit(record);
        this.#drain(record);
        return this.#snapshot(record);
    }

    pause(sessionId: string, ownerWindowId?: string): AiPromptQueueSnapshot {
        const record = this.#getRecord(sessionId);
        if (ownerWindowId) {
            record.ownerWindowId = ownerWindowId;
        }
        if (!record.paused) {
            record.paused = true;
            record.resumeAfterActiveSettles = false;
            this.#commit(record);
        }
        return this.#snapshot(record);
    }

    handleSessionSnapshot(snapshot: AiSessionSnapshot): void {
        const record = this.#records.get(snapshot.sessionId);
        if (!record) {
            return;
        }
        if (isClosedSessionSnapshot(snapshot)) {
            this.#terminalize(record);
            return;
        }
        if (record.terminal) {
            // A prepared historical session can replace a previously closed
            // runtime session. Terminal queue artifacts do not carry over.
            record.activeItem = null;
            record.editingItem = null;
            record.editingPosition = null;
            record.items = record.items.filter(
                (item) => item.error !== CLOSED_SESSION_QUEUE_ERROR,
            );
            record.paused = false;
            record.resumeAfterActiveSettles = false;
            record.terminal = false;
            this.#commit(record);
        }
        if (record.activeItem) {
            return;
        }
        if (
            record.resumeAfterActiveSettles &&
            !isBusySnapshot(snapshot)
        ) {
            this.#resumeAfterActiveSettles(record);
            return;
        }
        if (record.paused) {
            return;
        }
        if (!isBusySnapshot(snapshot)) {
            this.#drain(record);
        }
    }

    handleSessionEvent(event: AiSessionDomainEvent): void {
        const record = this.#records.get(event.sessionId);
        if (!record) {
            return;
        }

        if (event.kind === "session-closed") {
            this.#terminalize(record);
            return;
        }

        if (event.kind === "turn-status") {
            if (record.activeItem?.messageId !== event.turnId) {
                if (!record.activeItem && record.resumeAfterActiveSettles) {
                    this.#resumeAfterActiveSettles(record);
                }
                return;
            }
            const activeItem = record.activeItem;
            record.activeItem = null;
            if (event.status === "failed") {
                record.items = [
                    {
                        ...activeItem,
                        error: event.error,
                        status: "failed",
                    },
                    ...record.items,
                ];
            }
            if (record.resumeAfterActiveSettles) {
                record.paused = false;
                record.resumeAfterActiveSettles = false;
            }
            this.#commit(record);
            if (event.status !== "failed") {
                this.#drain(record);
            }
            return;
        }

        if (
            record.activeItem &&
            isUserMessageEventForId(event, record.activeItem.messageId) &&
            record.activeItem.status !== "running"
        ) {
            record.activeItem = {
                ...record.activeItem,
                status: "running",
            };
            this.#commit(record);
            return;
        }

        if (
            event.kind === "status" &&
            event.status === "idle" &&
            !record.activeItem &&
            record.resumeAfterActiveSettles
        ) {
            this.#resumeAfterActiveSettles(record);
        }
    }

    async deleteSession(sessionId: string): Promise<void> {
        if (this.#records.delete(sessionId)) {
            await this.#persist();
        }
    }

    #getRecord(sessionId: string): PromptQueueRecord {
        const current = this.#records.get(sessionId);
        if (current) {
            return current;
        }
        const record: PromptQueueRecord = {
            activeItem: null,
            editingItem: null,
            editingPosition: null,
            items: [],
            ownerWindowId: null,
            paused: false,
            resumeAfterActiveSettles: false,
            revision: 0,
            sessionId,
            terminal: isClosedSessionSnapshot(
                this.#options.getSessionSnapshot(sessionId),
            ),
        };
        this.#records.set(sessionId, record);
        return record;
    }

    #drain(record: PromptQueueRecord): void {
        if (
            record.activeItem ||
            record.paused ||
            this.#isTerminal(record) ||
            !record.ownerWindowId ||
            record.items.length === 0 ||
            isBusySnapshot(this.#options.getSessionSnapshot(record.sessionId))
        ) {
            return;
        }
        const nextIndex = record.items.findIndex(isDispatchableItem);
        if (nextIndex < 0) {
            return;
        }
        const nextItem = record.items[nextIndex];
        record.items = record.items.filter((item) => item.id !== nextItem.id);
        record.activeItem = {
            ...nextItem,
            error: null,
            status: "sending",
        };
        this.#commit(record);
        void this.#dispatch(record, record.activeItem, record.ownerWindowId);
    }

    async #dispatch(
        record: PromptQueueRecord,
        activeItem: AiQueuedPrompt,
        ownerWindowId: string,
    ): Promise<void> {
        try {
            const result = await this.#options.dispatchPrompt(
                queuedPromptToSendInput(activeItem),
                ownerWindowId,
            );
            if (record.activeItem?.id !== activeItem.id) {
                return;
            }
            if (result.stopReason !== "accepted") {
                record.activeItem = null;
                record.items = [
                    {
                        ...activeItem,
                        error: "The runtime rejected the prompt.",
                        status: "failed",
                    },
                    ...record.items,
                ];
                this.#commit(record);
                return;
            }
            record.activeItem = {
                ...record.activeItem,
                status: "running",
            };
            this.#commit(record);
        } catch (error) {
            if (record.activeItem?.id !== activeItem.id) {
                return;
            }
            const errorMessage = formatError(error);
            const busy = isSessionBusyErrorMessage(errorMessage);
            record.activeItem = null;
            record.items = [
                {
                    ...activeItem,
                    error: busy ? null : errorMessage,
                    status: busy ? "pending_dispatch" : "failed",
                },
                ...record.items,
            ];
            this.#commit(record);
        }
    }

    #resumeAfterActiveSettles(record: PromptQueueRecord): void {
        if (this.#isTerminal(record)) {
            return;
        }
        record.paused = false;
        record.resumeAfterActiveSettles = false;
        this.#commit(record);
        this.#drain(record);
    }

    #commit(record: PromptQueueRecord): void {
        record.revision += 1;
        void this.#persist().catch(() => undefined);
        if (record.ownerWindowId) {
            this.#options.onSnapshot(
                record.ownerWindowId,
                this.#snapshot(record),
            );
        }
    }

    async #persist(): Promise<void> {
        await this.#options.saveSnapshots?.(
            [...this.#records.values()]
                .map((record) => this.#snapshot(record))
                .filter(
                    (snapshot) =>
                        snapshot.activeItem ||
                        snapshot.editingItem ||
                        snapshot.items.length > 0,
                ),
        );
    }

    #snapshot(record: PromptQueueRecord): AiPromptQueueSnapshot {
        return {
            activeItem: record.activeItem,
            editingItem: record.editingItem,
            items: [...record.items],
            paused: record.paused,
            revision: record.revision,
            sessionId: record.sessionId,
        };
    }

    #isTerminal(record: PromptQueueRecord): boolean {
        if (record.terminal) {
            return true;
        }
        if (!isClosedSessionSnapshot(this.#options.getSessionSnapshot(record.sessionId))) {
            return false;
        }
        this.#terminalize(record);
        return true;
    }

    #terminalize(record: PromptQueueRecord): void {
        if (
            record.terminal &&
            !record.activeItem &&
            !record.editingItem &&
            record.items.every((item) => item.status === "failed")
        ) {
            return;
        }
        const failedItems = [
            ...(record.activeItem ? [record.activeItem] : []),
            ...(record.editingItem ? [record.editingItem] : []),
            ...record.items,
        ].map((item) => failedQueuedPrompt(item, CLOSED_SESSION_QUEUE_ERROR));
        record.activeItem = null;
        record.editingItem = null;
        record.editingPosition = null;
        record.items = deduplicateItems(failedItems);
        record.paused = true;
        record.resumeAfterActiveSettles = false;
        record.terminal = true;
        this.#commit(record);
    }
}

const CLOSED_SESSION_QUEUE_ERROR = "The session was closed before this prompt could run.";

function isClosedSessionSnapshot(snapshot: AiSessionSnapshot | null): boolean {
    return snapshot?.closedAt !== null && snapshot?.closedAt !== undefined;
}

function failedQueuedPrompt(
    item: AiQueuedPrompt,
    error: string,
): AiQueuedPrompt {
    return {
        ...item,
        error,
        status: "failed",
    };
}

function createQueuedPrompt(
    input: EnqueueAiPromptInput,
    existing?: AiQueuedPrompt | null,
): AiQueuedPrompt {
    const id = existing?.id ?? input.messageId;
    return {
        additionalRoots: input.additionalRoots,
        attachments: input.attachments.map((attachment) => ({ ...attachment })),
        composerPartsSnapshot: (input.composerParts ?? [
            { text: input.prompt, type: "text" as const },
        ]).map((part) => ({ ...part })),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        error: null,
        fileContextsSnapshot: (input.fileContextsSnapshot ?? []).map((context) => ({
            ...context,
        })),
        id,
        messageId: existing?.messageId ?? input.messageId,
        optimisticMessageId: existing?.messageId ?? input.messageId,
        projectId: input.projectId,
        prompt: input.prompt,
        runtimeId: input.runtimeId,
        sessionId: input.sessionId,
        status: "queued",
        title: input.title,
        worktreeId: input.worktreeId ?? null,
    };
}

function queuedPromptToSendInput(item: AiQueuedPrompt): SendAiPromptInput {
    return {
        additionalRoots: item.additionalRoots,
        attachments: item.attachments,
        composerParts: item.composerPartsSnapshot,
        messageId: item.messageId,
        projectId: item.projectId,
        prompt: item.prompt,
        runtimeId: item.runtimeId,
        sessionId: item.sessionId,
        title: item.title,
        worktreeId: item.worktreeId,
    };
}

function isBusySnapshot(snapshot: AiSessionSnapshot | null): boolean {
    return Boolean(
        snapshot &&
            (snapshot.status === "starting" ||
                snapshot.status === "streaming" ||
                snapshot.status === "waiting_permission" ||
                snapshot.status === "waiting_user_input"),
    );
}

function isDispatchableItem(item: AiQueuedPrompt): boolean {
    return (
        item.status === "pending_dispatch" ||
        item.status === "queued"
    );
}

function isUserMessageEventForId(
    event: AiSessionDomainEvent,
    messageId: string,
): boolean {
    if (event.kind === "message-started") {
        return event.messageKind === "user" && event.message.id === messageId;
    }
    if (event.kind === "message-delta" || event.kind === "message-completed") {
        return event.messageKind === "user" && event.messageId === messageId;
    }
    return false;
}

function createPosition(
    items: readonly AiQueuedPrompt[],
    index: number,
): QueuePosition {
    return {
        nextPromptId: items[index + 1]?.id ?? null,
        previousPromptId: index > 0 ? (items[index - 1]?.id ?? null) : null,
        queueIndex: index,
    };
}

function insertAtPosition(
    items: readonly AiQueuedPrompt[],
    item: AiQueuedPrompt,
    position: QueuePosition | null,
): AiQueuedPrompt[] {
    const remaining = items.filter((candidate) => candidate.id !== item.id);
    if (position?.nextPromptId) {
        const index = remaining.findIndex(
            (candidate) => candidate.id === position.nextPromptId,
        );
        if (index >= 0) {
            return [...remaining.slice(0, index), item, ...remaining.slice(index)];
        }
    }
    if (position?.previousPromptId) {
        const index = remaining.findIndex(
            (candidate) => candidate.id === position.previousPromptId,
        );
        if (index >= 0) {
            return [
                ...remaining.slice(0, index + 1),
                item,
                ...remaining.slice(index + 1),
            ];
        }
    }
    const index = Math.min(
        Math.max(position?.queueIndex ?? remaining.length, 0),
        remaining.length,
    );
    return [...remaining.slice(0, index), item, ...remaining.slice(index)];
}

function deduplicateItems(items: readonly AiQueuedPrompt[]): AiQueuedPrompt[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        if (seen.has(item.id)) {
            return false;
        }
        seen.add(item.id);
        return true;
    });
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
