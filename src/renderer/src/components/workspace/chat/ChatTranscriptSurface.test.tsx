/** @vitest-environment jsdom */
import { act, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatTranscriptSurface } from "./ChatTranscriptSurface";

describe("ChatTranscriptSurface", () => {
    afterEach(() => {
        document.body.innerHTML = "";
    });

    it("forwards pointer and keyboard navigation from the scroll container", () => {
        const container = document.createElement("div");
        const root = createRoot(container);
        const onKeyDown = vi.fn();
        const onPointerDown = vi.fn();
        const scrollRef: RefObject<HTMLDivElement | null> = { current: null };
        const timelineContentRef: RefObject<HTMLDivElement | null> = {
            current: null,
        };
        document.body.appendChild(container);

        act(() => {
            root.render(
                <ChatTranscriptSurface
                    covered={false}
                    jumpToBottom={null}
                    onKeyDown={onKeyDown}
                    onPointerDown={onPointerDown}
                    onScroll={() => {}}
                    scopeKey="session-1"
                    scrollRef={scrollRef}
                    timelineContentRef={timelineContentRef}
                >
                    <div>Timeline</div>
                </ChatTranscriptSurface>,
            );
        });

        const scrollContainer = container.querySelector(".chat-scroll");
        if (!scrollContainer) {
            throw new Error("expected the chat scroll container");
        }

        act(() => {
            scrollContainer.dispatchEvent(
                new Event("pointerdown", { bubbles: true }),
            );
            scrollContainer.dispatchEvent(
                new KeyboardEvent("keydown", {
                    bubbles: true,
                    key: "PageDown",
                }),
            );
        });

        expect(onPointerDown).toHaveBeenCalledTimes(1);
        expect(onKeyDown).toHaveBeenCalledTimes(1);

        root.unmount();
    });
});
