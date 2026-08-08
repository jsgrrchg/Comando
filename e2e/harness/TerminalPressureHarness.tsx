import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AiSessionToolActivityEvent } from "@shared/ipc";
import { createTerminalStreamPressureFixture } from "@shared/testing/chatLoadFactories";
import {
    AiSessionEventFrameBuffer,
} from "@renderer/app/ai/aiSessionEventFrameBuffer";

interface TerminalPressureHarnessSnapshot {
    readonly activeTab: string;
    readonly appliedToolEvents: number;
    readonly composerValue: string;
    readonly expectedFinalOutput: string;
    readonly finalOutput: string;
    readonly producerEvents: number;
    readonly status: "complete" | "idle" | "streaming";
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

export function TerminalPressureHarness() {
    const [activeTab, setActiveTab] = useState("foreground");
    const [appliedToolEvents, setAppliedToolEvents] = useState(0);
    const [finalOutput, setFinalOutput] = useState("");
    const [status, setStatus] = useState<
        TerminalPressureHarnessSnapshot["status"]
    >("idle");
    const composerRef = useRef<HTMLInputElement | null>(null);
    const expectedFinalOutputRef = useRef("");
    const producerEventsRef = useRef(0);
    const runGenerationRef = useRef(0);
    const snapshotRef = useRef<TerminalPressureHarnessSnapshot>({
        activeTab,
        appliedToolEvents,
        composerValue: "",
        expectedFinalOutput: "",
        finalOutput,
        producerEvents: 0,
        status,
    });
    const apply = useCallback((event: AiSessionToolActivityEvent) => {
        setAppliedToolEvents((current) => current + 1);
        if (event.activity.status === "completed") {
            setFinalOutput(event.activity.terminalOutput ?? "");
            setStatus("complete");
        }
    }, []);
    const frameBuffer = useMemo(
        () =>
            new AiSessionEventFrameBuffer({
                apply: (event) => {
                    if (event.kind === "tool-activity") apply(event);
                },
            }),
        [apply],
    );

    useEffect(() => {
        snapshotRef.current = {
            activeTab,
            appliedToolEvents,
            composerValue: composerRef.current?.value ?? "",
            expectedFinalOutput: expectedFinalOutputRef.current,
            finalOutput,
            producerEvents: producerEventsRef.current,
            status,
        };
    }, [activeTab, appliedToolEvents, finalOutput, status]);

    useEffect(() => {
        window.comandoTerminalPressureHarness = {
            snapshot: () => ({
                ...snapshotRef.current,
                composerValue: composerRef.current?.value ?? "",
            }),
            start: () => {
                runGenerationRef.current += 1;
                const generation = runGenerationRef.current;
                frameBuffer.reset();
                setAppliedToolEvents(0);
                setFinalOutput("");
                setStatus("streaming");
                const fixture = createTerminalStreamPressureFixture({
                    chunkBytes: 4,
                    chunkCount: 10_000,
                    durationMs: 10_000,
                    runtimeId: "custom:pressure-e2e",
                });
                expectedFinalOutputRef.current = fixture.expectedFinalOutput;
                producerEventsRef.current = fixture.events.length;
                let cursor = 0;
                const produceFrame = () => {
                    if (generation !== runGenerationRef.current) return;
                    const end = Math.min(
                        fixture.events.length,
                        cursor + EVENTS_PER_PRODUCER_FRAME,
                    );
                    while (cursor < end) {
                        const event = fixture.events[cursor];
                        cursor += 1;
                        if (!event) continue;
                        if (
                            event.activity.status === "pending" ||
                            event.activity.status === "in_progress"
                        ) {
                            frameBuffer.buffer(event);
                        } else {
                            frameBuffer.flushSession(event.sessionId);
                            apply(event);
                        }
                    }
                    if (cursor < fixture.events.length) {
                        requestAnimationFrame(produceFrame);
                    }
                };
                requestAnimationFrame(produceFrame);
            },
        };
        return () => {
            runGenerationRef.current += 1;
            frameBuffer.reset();
        };
    }, [frameBuffer]);

    return (
        <main className="flex h-screen min-h-0 flex-col gap-3 bg-bg-primary p-4 text-text-primary">
            <nav className="flex gap-2" aria-label="Pressure test tabs">
                {(
                    [
                        ["foreground", "Foreground"],
                        ["background", "Background"],
                    ] as const
                ).map(([id, label]) => (
                    <button
                        aria-pressed={activeTab === id}
                        key={id}
                        onClick={() => setActiveTab(id)}
                        type="button"
                    >
                        {label}
                    </button>
                ))}
            </nav>
            <label>
                Composer
                <input
                    aria-label="Composer"
                    className="ml-2 border border-border-default bg-bg-secondary"
                    ref={composerRef}
                />
            </label>
            <div
                className="min-h-0 flex-1 overflow-auto border border-border-default"
                data-pressure-scroll
            >
                {Array.from({ length: 500 }, (_, index) => (
                    <div key={index}>Workspace row {index + 1}</div>
                ))}
            </div>
            <output data-pressure-status>{status}</output>
        </main>
    );
}
