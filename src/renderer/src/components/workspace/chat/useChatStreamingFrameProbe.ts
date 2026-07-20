import { useEffect, useRef, type RefObject } from "react";

import {
    hashChatPerformanceLabel,
    isChatPerformanceProbeEnabled,
    markChatPerformanceFrame,
    recordChatPerformanceMetric,
} from "@renderer/app/debug/chatPerformanceProbe";

// The opt-in probe records only numeric geometry and revision metadata. User
// content never leaves the rendered component tree.
export function useChatStreamingFrameProbe({
    active,
    getNavigationGeneration,
    isStreaming,
    scrollRef,
    sessionId,
    timelineContentRef,
}: {
    readonly active: boolean;
    readonly getNavigationGeneration: () => number;
    readonly isStreaming: boolean;
    readonly scrollRef: RefObject<HTMLElement | null>;
    readonly sessionId: string;
    readonly timelineContentRef: RefObject<HTMLElement | null>;
}): void {
    const performanceFrameIdRef = useRef(0);

    useEffect(() => {
        if (
            !active ||
            !isStreaming ||
            !isChatPerformanceProbeEnabled() ||
            typeof window.requestAnimationFrame !== "function"
        ) {
            return;
        }

        let cancelled = false;
        let frameId: number | null = null;
        let previousFrameAt = performance.now();
        const sampleFrame = (frameAt: number) => {
            if (cancelled) {
                return;
            }

            const scrollElement = scrollRef.current;
            markChatPerformanceFrame(frameAt);
            const currentTurnElement =
                timelineContentRef.current?.querySelector<HTMLElement>(
                    '[data-current-turn-tail="true"]',
                ) ?? null;
            const measuredElement = currentTurnElement?.closest<HTMLElement>(
                "[data-measurement-key]",
            );
            const markdownElement =
                currentTurnElement?.querySelector<HTMLElement>(
                    '[data-markdown-live="true"]',
                ) ?? null;
            performanceFrameIdRef.current += 1;
            recordChatPerformanceMetric("chat_frame", {
                sessionId,
                values: {
                    bottomGap: scrollElement
                        ? scrollElement.scrollHeight -
                          scrollElement.clientHeight -
                          scrollElement.scrollTop
                        : 0,
                    clientHeight: scrollElement?.clientHeight ?? 0,
                    frameDuration: Math.max(0, frameAt - previousFrameAt),
                    frameId: performanceFrameIdRef.current,
                    markdownContentChars: Number(
                        markdownElement?.dataset.markdownContentChars ?? 0,
                    ),
                    markdownRenderedChars: Number(
                        markdownElement?.dataset.markdownRenderedChars ?? 0,
                    ),
                    measurementKeyRevision: measuredElement?.dataset
                        .measurementKey
                        ? hashChatPerformanceLabel(
                              measuredElement.dataset.measurementKey,
                          )
                        : 0,
                    navigationGeneration: getNavigationGeneration(),
                    rowRevision: measuredElement?.dataset.listKey
                        ? hashChatPerformanceLabel(
                              measuredElement.dataset.listKey,
                          )
                        : 0,
                    scrollHeight: scrollElement?.scrollHeight ?? 0,
                    scrollTop: scrollElement?.scrollTop ?? 0,
                },
            });
            previousFrameAt = frameAt;
            frameId = window.requestAnimationFrame(sampleFrame);
        };

        frameId = window.requestAnimationFrame(sampleFrame);
        return () => {
            cancelled = true;
            if (frameId !== null) {
                window.cancelAnimationFrame(frameId);
            }
        };
    }, [
        active,
        getNavigationGeneration,
        isStreaming,
        scrollRef,
        sessionId,
        timelineContentRef,
    ]);
}
