import {
    memo,
    type KeyboardEvent,
    type PointerEvent,
    type ReactNode,
    type RefObject,
    type TouchEvent,
    type WheelEvent,
} from "react";

import { ChatContentColumn } from "./ChatContentColumn";
import { ToolExpansionStoreProvider } from "./toolExpansionStore";

interface ChatTranscriptSurfaceProps {
    readonly chatFontFamily?: string;
    readonly children: ReactNode;
    readonly covered: boolean;
    readonly jumpToBottom: ReactNode;
    readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
    readonly onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
    readonly onScroll: () => void;
    readonly onTouchStart?: (event: TouchEvent<HTMLDivElement>) => void;
    readonly onWheelCapture?: (event: WheelEvent<HTMLDivElement>) => void;
    readonly scopeKey: string;
    readonly scrollRef: RefObject<HTMLDivElement | null>;
    readonly timelineContentRef: RefObject<HTMLDivElement | null>;
}

// Keeps viewport listeners and virtual history in one memoizable surface.
export const ChatTranscriptSurface = memo(function ChatTranscriptSurface({
    chatFontFamily,
    children,
    covered,
    jumpToBottom,
    onKeyDown,
    onPointerDown,
    onScroll,
    onTouchStart,
    onWheelCapture,
    scopeKey,
    scrollRef,
    timelineContentRef,
}: ChatTranscriptSurfaceProps) {
    return (
        <ToolExpansionStoreProvider scopeKey={scopeKey}>
            <div
                aria-hidden={covered}
                className={
                    covered
                        ? "pointer-events-none invisible absolute inset-0 min-h-0 min-w-0"
                        : "relative min-h-0 min-w-0 flex-1"
                }
                inert={covered ? true : undefined}
            >
                <div
                    ref={scrollRef}
                    className="chat-scroll h-full min-h-0 min-w-0 overflow-y-auto px-3 py-3"
                    onKeyDown={onKeyDown}
                    onPointerDown={onPointerDown}
                    onScroll={onScroll}
                    onTouchStart={onTouchStart}
                    onWheelCapture={onWheelCapture}
                >
                    <ChatContentColumn
                        ref={timelineContentRef}
                        className="min-w-0 space-y-2"
                        style={{ fontFamily: chatFontFamily }}
                    >
                        {children}
                    </ChatContentColumn>
                </div>
                {jumpToBottom}
            </div>
        </ToolExpansionStoreProvider>
    );
});
