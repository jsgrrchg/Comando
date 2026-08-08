import { useEffect, useRef, useState } from "react";

import type {
    AiSessionDomainEvent,
    AiSessionSnapshot,
    AiSessionStreamPayload,
    AiSessionToolActivityEvent,
    WorkspaceChatTab,
    WorkspaceSurfaceLifecycleState,
} from "@shared/ipc";
import { createTerminalStreamPressureFixture } from "@shared/testing/chatLoadFactories";
import {
    incrementChatPerformanceCounter,
    readChatPerformanceCounters,
    resetChatPerformanceCounters,
    setChatPerformanceCountersEnabledForTests,
} from "@renderer/app/debug/chatPerformanceCounters";
import {
    resetAiStoreRuntimeBuffersForTests,
    useAiStore,
} from "@renderer/app/store/ai-store";
import { createWorkspaceSurfaceAgentPresencePublisher } from "@renderer/app/workspace/workspaceSurfaceAgentPresencePublisher";
import type { WorkspaceSurfaceAgentPresencePublisher } from "@renderer/app/workspace/workspaceSurfaceAgentPresencePublisher";
import {
    AI_SESSION_STREAM_MAX_IN_FLIGHT,
    AI_SESSION_STREAM_MAX_PENDING_PAYLOADS,
    isAiSessionUpdate,
    rememberAiSessionStreamPayloadForDelivery,
    takeNextAiSessionStreamDelivery,
    type AiSessionStreamDeliveryQueue,
} from "../../src/main/ai/session-stream";
import { deliverAiSessionStreamMessage } from "../../src/preload/ai-session-stream";

interface TerminalPressureHarnessSnapshot {
    readonly ackBeforeIngestion: boolean;
    readonly acknowledgedPayloads: number;
    readonly activeTab: string;
    readonly criticalKindsDelivered: readonly string[];
    readonly duplicatePayloads: number;
    readonly expectedFinalOutput: string;
    readonly frameCoalesced: number;
    readonly framePeakPending: number;
    readonly finalDiffCount: number;
    readonly finalExitCode: number | null;
    readonly finalOutput: string;
    readonly lifecycle: WorkspaceSurfaceLifecycleState;
    readonly peakInFlight: number;
    readonly presencePublishes: number;
    readonly producerEvents: number;
    readonly scrollAtBottom: boolean;
    readonly status: "complete" | "idle" | "streaming";
    readonly storeToolApplies: number;
    readonly toolEventsReceived: number;
    readonly transportCoalesced: number;
}

interface ComandoTerminalPressureHarness {
    readonly snapshot: () => TerminalPressureHarnessSnapshot;
    readonly start: () => void;
}

declare global {
    interface Window {
        comandoTerminalPressureHarness: ComandoTerminalPressureHarness;
    }
}

const EVENTS_PER_PRODUCER_FRAME = 250;
const STREAM_SESSION_ID = "session-pressure";
const BACKGROUND_SESSION_ID = "session-background";

const STREAM_TAB = createTab("tab-pressure", STREAM_SESSION_ID, "Pressure");
const BACKGROUND_TAB = createTab(
    "tab-background",
    BACKGROUND_SESSION_ID,
    "Background",
);

class BrowserAiSessionPressureTransport {
    readonly criticalKindsDelivered = new Set<string>();
    private ackBeforeIngestion = false;
    private acknowledgedPayloads = 0;
    private coalesced = 0;
    private duplicatePayloads = 0;
    private readonly deliveredSeqs = new Set<number>();
    private readonly inFlight: Array<{
        readonly payload: AiSessionStreamPayload;
        readonly seq: number;
    }> = [];
    private nextOrder = 0;
    private nextSeq = 1;
    private readonly pending: AiSessionStreamDeliveryQueue = new Map();
    private peakInFlight = 0;
    private producerComplete = false;
    private scheduled = false;

    constructor(
        private readonly deliverPayload: (payload: AiSessionStreamPayload) => void,
        private readonly onIdle: () => void,
    ) {}

    get metrics() {
        return {
            ackBeforeIngestion: this.ackBeforeIngestion,
            acknowledgedPayloads: this.acknowledgedPayloads,
            duplicatePayloads: this.duplicatePayloads,
            peakInFlight: this.peakInFlight,
            transportCoalesced: this.coalesced,
        };
    }

    finishProducer(): void {
        this.producerComplete = true;
        this.scheduleDrain();
    }

    post(payload: AiSessionStreamPayload): void {
        if (this.inFlight.length < AI_SESSION_STREAM_MAX_IN_FLIGHT) {
            this.send(payload);
            return;
        }
        const result = rememberAiSessionStreamPayloadForDelivery({
            maxPayloads: AI_SESSION_STREAM_MAX_PENDING_PAYLOADS,
            order: this.nextOrder,
            payload,
            queue: this.pending,
        });
        this.nextOrder += 1;
        if (result.coalesced) this.coalesced += 1;
        if (!result.preserved || result.droppedOldest) {
            throw new Error("Pressure transport could not preserve a payload.");
        }
        this.scheduleDrain();
    }

    private deliver(envelope: {
        readonly payload: AiSessionStreamPayload;
        readonly seq: number;
    }): void {
        let ingested = false;
        deliverAiSessionStreamMessage(
            { payload: envelope.payload, seq: envelope.seq, type: "payload" },
            {
                acknowledge: (seq) => {
                    if (!ingested) this.ackBeforeIngestion = true;
                    this.acknowledgedPayloads += 1;
                    if (this.deliveredSeqs.has(seq)) this.duplicatePayloads += 1;
                    this.deliveredSeqs.add(seq);
                },
                notifyPayload: (payload) => {
                    ingested = true;
                    const typedPayload = payload as AiSessionStreamPayload;
                    if (!isAiSessionUpdate(typedPayload)) {
                        if (
                            typedPayload.kind === "permission-request" ||
                            typedPayload.kind === "user-input-request" ||
                            typedPayload.kind === "turn-status" ||
                            typedPayload.kind === "status"
                        ) {
                            this.criticalKindsDelivered.add(typedPayload.kind);
                        }
                    }
                    this.deliverPayload(typedPayload);
                },
                reportDispatchError: (_message, error) => {
                    throw error;
                },
                reportWarning: (message) => {
                    throw new Error(message);
                },
            },
        );
    }

    private drain = () => {
        this.scheduled = false;
        const delivered = this.inFlight.splice(0);
        for (const envelope of delivered) this.deliver(envelope);
        while (this.inFlight.length < AI_SESSION_STREAM_MAX_IN_FLIGHT) {
            const pending = takeNextAiSessionStreamDelivery(this.pending);
            if (!pending) break;
            this.send(pending.payload);
        }
        if (this.inFlight.length > 0 || this.pending.size > 0) {
            this.scheduleDrain();
            return;
        }
        if (this.producerComplete) requestAnimationFrame(this.onIdle);
    };

    private scheduleDrain(): void {
        if (this.scheduled) return;
        this.scheduled = true;
        requestAnimationFrame(this.drain);
    }

    private send(payload: AiSessionStreamPayload): void {
        this.inFlight.push({ payload, seq: this.nextSeq });
        this.nextSeq += 1;
        this.peakInFlight = Math.max(this.peakInFlight, this.inFlight.length);
        this.scheduleDrain();
    }
}

export function TerminalPressureHarness() {
    const [activeTab, setActiveTab] = useState("foreground");
    const [lifecycle, setLifecycle] =
        useState<WorkspaceSurfaceLifecycleState>("visible");
    const [status, setStatus] =
        useState<TerminalPressureHarnessSnapshot["status"]>("idle");
    const activeTabRef = useRef(activeTab);
    const expectedFinalOutputRef = useRef("");
    const lifecycleRef = useRef(lifecycle);
    const producerEventsRef = useRef(0);
    const publisherRef =
        useRef<WorkspaceSurfaceAgentPresencePublisher | null>(null);
    const runGenerationRef = useRef(0);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const transportRef = useRef<BrowserAiSessionPressureTransport | null>(null);
    const workspaceListenersRef = useRef(new Set<() => void>());

    useEffect(() => {
        activeTabRef.current = activeTab;
        for (const listener of workspaceListenersRef.current) listener();
    }, [activeTab]);

    useEffect(() => {
        lifecycleRef.current = lifecycle;
    }, [lifecycle]);

    useEffect(() => {
        setChatPerformanceCountersEnabledForTests(true);
        resetHarnessStore();
        const unsubscribeStore = useAiStore.subscribe(() => {
            const snapshot = pressureSnapshot();
            if (
                snapshot?.status === "idle" &&
                snapshot.toolActivity.some(
                    (activity) => activity.status === "completed",
                )
            ) {
                setStatus("complete");
            }
        });
        const publisher = createWorkspaceSurfaceAgentPresencePublisher({
            getAiSessions: () => useAiStore.getState().sessions,
            getWorkspaceProjection: () => ({
                activeTab:
                    activeTabRef.current === "background"
                        ? BACKGROUND_TAB
                        : STREAM_TAB,
                tabsById: {
                    [BACKGROUND_TAB.id]: BACKGROUND_TAB,
                    [STREAM_TAB.id]: STREAM_TAB,
                },
            }),
            publish: () => {
                incrementChatPerformanceCounter("workspace_presence_publishes");
                return Promise.resolve({ delivered: true });
            },
            subscribeAiSessions: (listener) => useAiStore.subscribe(listener),
            subscribeWorkspace: (listener) => {
                workspaceListenersRef.current.add(listener);
                return () => workspaceListenersRef.current.delete(listener);
            },
        });
        publisherRef.current = publisher;
        publisher.updateContext(publisherContext("visible"));

        window.comandoTerminalPressureHarness = {
            snapshot: () => readHarnessSnapshot(),
            start: () => {
                runGenerationRef.current += 1;
                const generation = runGenerationRef.current;
                resetHarnessStore();
                resetChatPerformanceCounters();
                setStatus("streaming");
                const fixture = createTerminalStreamPressureFixture({
                    chunkBytes: 4,
                    chunkCount: 10_000,
                    durationMs: 10_000,
                    runtimeId: "custom:pressure-e2e",
                    sessionId: STREAM_SESSION_ID,
                    toolCallId: "tool-pressure-1",
                });
                expectedFinalOutputRef.current = fixture.expectedFinalOutput;
                const criticalEvents = createCriticalEvents(
                    fixture.events.at(-1)?.updatedAt ?? new Date().toISOString(),
                );
                producerEventsRef.current =
                    fixture.events.length + criticalEvents.length + 1;
                const transport = new BrowserAiSessionPressureTransport(
                    applyStreamPayload,
                    () => {
                        if (generation !== runGenerationRef.current) return;
                        transportRef.current = transport;
                    },
                );
                transportRef.current = transport;
                transport.post(createStreamingStatusEvent());
                let cursor = 0;
                let criticalSent = false;
                const produceFrame = () => {
                    if (generation !== runGenerationRef.current) return;
                    const end = Math.min(
                        fixture.events.length,
                        cursor + EVENTS_PER_PRODUCER_FRAME,
                    );
                    while (cursor < end) {
                        const sourceEvent = fixture.events[cursor];
                        cursor += 1;
                        if (!sourceEvent) continue;
                        transport.post(withFinalDiff(sourceEvent));
                    }
                    if (!criticalSent && cursor >= fixture.events.length / 2) {
                        criticalSent = true;
                        for (const event of criticalEvents.slice(0, 2)) {
                            transport.post(event);
                        }
                    }
                    if (cursor < fixture.events.length) {
                        requestAnimationFrame(produceFrame);
                        return;
                    }
                    for (const event of criticalEvents.slice(2)) {
                        transport.post(event);
                    }
                    transport.finishProducer();
                };
                requestAnimationFrame(produceFrame);
            },
        };

        return () => {
            runGenerationRef.current += 1;
            publisherRef.current = null;
            publisher.dispose();
            unsubscribeStore();
            resetAiStoreRuntimeBuffersForTests();
            setChatPerformanceCountersEnabledForTests(null);
        };
    }, []);

    useEffect(() => {
        lifecycleRef.current = lifecycle;
        publisherRef.current?.updateContext(publisherContext(lifecycle));
    }, [lifecycle]);

    const readHarnessSnapshot = (): TerminalPressureHarnessSnapshot => {
        const counters = readChatPerformanceCounters();
        const snapshot = pressureSnapshot();
        const finalActivity = snapshot?.toolActivity.find(
            (activity) => activity.id === "tool-pressure-1",
        );
        const scroll = scrollRef.current;
        const transportMetrics = transportRef.current?.metrics ?? {
            ackBeforeIngestion: false,
            acknowledgedPayloads: 0,
            duplicatePayloads: 0,
            peakInFlight: 0,
            transportCoalesced: 0,
        };
        return {
            ...transportMetrics,
            activeTab: activeTabRef.current,
            criticalKindsDelivered: [
                ...(transportRef.current?.criticalKindsDelivered ?? []),
            ].sort(),
            expectedFinalOutput: expectedFinalOutputRef.current,
            frameCoalesced: counters.ai_frame_payloads_coalesced,
            framePeakPending: counters.ai_frame_peak_pending_per_session,
            finalDiffCount: finalActivity?.diffs.length ?? 0,
            finalExitCode: finalActivity?.exitCode ?? null,
            finalOutput: finalActivity?.terminalOutput ?? "",
            lifecycle: lifecycleRef.current,
            presencePublishes: counters.workspace_presence_publishes,
            producerEvents: producerEventsRef.current,
            scrollAtBottom: Boolean(
                scroll &&
                    scroll.scrollTop + scroll.clientHeight >=
                        scroll.scrollHeight - 1,
            ),
            status:
                snapshot?.status === "idle" &&
                finalActivity?.status === "completed"
                    ? "complete"
                    : producerEventsRef.current > 0
                      ? "streaming"
                      : "idle",
            storeToolApplies: counters.tool_activity_store_applies,
            toolEventsReceived: counters.tool_activity_events_received,
        };
    };

    return (
        <main className="flex h-screen min-h-0 flex-col gap-3 bg-bg-primary p-4 text-text-primary">
            <nav className="flex gap-2" aria-label="Pressure test tabs">
                <button
                    aria-pressed={activeTab === "foreground"}
                    onClick={() => setActiveTab("foreground")}
                    type="button"
                >
                    Foreground
                </button>
                <button
                    aria-pressed={activeTab === "background"}
                    onClick={() => setActiveTab("background")}
                    type="button"
                >
                    Background
                </button>
                <button onClick={() => setLifecycle("suspended")} type="button">
                    Suspend
                </button>
            </nav>
            <label>
                Composer
                <input
                    aria-label="Composer"
                    className="ml-2 border border-border-default bg-bg-secondary"
                />
            </label>
            <div
                className="min-h-0 flex-1 overflow-auto border border-border-default"
                data-pressure-scroll
                ref={scrollRef}
            >
                {Array.from({ length: 500 }, (_, index) => (
                    <div key={index}>Workspace row {index + 1}</div>
                ))}
            </div>
            <output data-pressure-status>{status}</output>
        </main>
    );
}

function applyStreamPayload(payload: AiSessionStreamPayload): void {
    if (isAiSessionUpdate(payload)) {
        useAiStore.getState().applySessionUpdate(payload);
        return;
    }
    useAiStore.getState().applySessionEvent(payload);
}

function createCriticalEvents(updatedAt: string): readonly AiSessionDomainEvent[] {
    const base = eventBase(updatedAt);
    return [
        {
            ...base,
            kind: "permission-request",
            request: {
                description: "Allow the command",
                options: [
                    {
                        description: null,
                        kind: "allow_once",
                        name: "Allow",
                        optionId: "allow",
                    },
                ],
                requestId: "permission-pressure",
                sessionId: STREAM_SESSION_ID,
                title: "Permission",
                toolCallId: "tool-pressure-1",
                updatedAt,
            },
        },
        {
            ...base,
            kind: "user-input-request",
            request: {
                questions: [
                    {
                        customAnswerId: null,
                        header: "Input",
                        id: "question-pressure",
                        isOther: false,
                        isSecret: false,
                        options: [],
                        question: "Continue?",
                    },
                ],
                requestId: "input-pressure",
                sessionId: STREAM_SESSION_ID,
                title: "Input",
                toolCallId: "tool-pressure-1",
                turnId: "turn-pressure",
                updatedAt,
            },
        },
        {
            ...base,
            error: null,
            kind: "turn-status",
            status: "completed",
            turnId: "turn-pressure",
        },
        {
            ...base,
            activeTurnStartedAt: null,
            kind: "status",
            lastError: null,
            status: "idle",
        },
    ];
}

function createStreamingStatusEvent(): AiSessionDomainEvent {
    return {
        ...eventBase("2026-08-08T12:00:00.000Z"),
        activeTurnStartedAt: "2026-08-08T12:00:00.000Z",
        kind: "status",
        lastError: null,
        status: "streaming",
    };
}

function createSnapshot(sessionId: string, title: string): AiSessionSnapshot {
    return {
        activeTurnStartedAt: null,
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: "project-pressure",
        runtimeId: "custom:pressure-e2e",
        runtimeSessionId: `runtime-${sessionId}`,
        sessionId,
        status: "idle",
        title,
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-08-08T12:00:00.000Z",
        worktreeId: "worktree-pressure",
    };
}

function createTab(id: string, sessionId: string, title: string): WorkspaceChatTab {
    return {
        createdAt: "2026-08-08T12:00:00.000Z",
        draft: "",
        id,
        kind: "chat",
        projectId: "project-pressure",
        runtimeId: "custom:pressure-e2e",
        sessionId,
        title,
        worktreeId: "worktree-pressure",
    };
}

function eventBase(updatedAt: string) {
    return {
        origin: "live" as const,
        parentSessionId: null,
        runtimeId: "custom:pressure-e2e" as const,
        runtimeSessionId: "runtime-pressure",
        sessionId: STREAM_SESSION_ID,
        updatedAt,
    };
}

function pressureSnapshot(): AiSessionSnapshot | null {
    return useAiStore.getState().sessions[STREAM_SESSION_ID]?.snapshot ?? null;
}

function publisherContext(lifecycle: WorkspaceSurfaceLifecycleState) {
    return {
        contextKey: "project-pressure:worktree-pressure",
        lifecycle,
        projectId: "project-pressure",
        terminalSessions: [],
        worktreeId: "worktree-pressure",
    };
}

function resetHarnessStore(): void {
    resetAiStoreRuntimeBuffersForTests();
    useAiStore.setState({ sessions: {} });
    useAiStore
        .getState()
        .applySessionSnapshot(createSnapshot(STREAM_SESSION_ID, "Pressure"));
    useAiStore
        .getState()
        .applySessionSnapshot(createSnapshot(BACKGROUND_SESSION_ID, "Background"));
}

function withFinalDiff(
    event: AiSessionToolActivityEvent,
): AiSessionToolActivityEvent {
    if (event.activity.status !== "completed") return event;
    return {
        ...event,
        activity: {
            ...event.activity,
            diffs: [
                {
                    hunks: [],
                    isText: true,
                    kind: "update",
                    newText: "after\n",
                    oldText: "before\n",
                    path: "src/pressure.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
        },
    };
}
