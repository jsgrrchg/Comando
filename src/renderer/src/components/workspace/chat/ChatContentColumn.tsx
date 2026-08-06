import { forwardRef, type CSSProperties, type ReactNode } from "react";

import { CHAT_CONTENT_MAX_WIDTH_PX } from "./chatContentLayout";
import { useSettingsStore } from "@renderer/app/store/settings-store";

export { CHAT_CONTENT_MAX_WIDTH_PX } from "./chatContentLayout";

interface ChatContentColumnProps {
    readonly children?: ReactNode;
    readonly className?: string;
    readonly style?: CSSProperties;
}

export const ChatContentColumn = forwardRef<
    HTMLDivElement,
    ChatContentColumnProps
>(function ChatContentColumn({ children, className, style }, ref) {
    const chatContentWidth = useSettingsStore(
        (state) => state.appearance.chatContentWidth,
    );

    return (
        <div
            ref={ref}
            className={className}
            data-chat-content-column="true"
            style={{
                marginInline: "auto",
                // `width: 100%` keeps narrow panes responsive below this user-selected limit.
                maxWidth: chatContentWidth ?? CHAT_CONTENT_MAX_WIDTH_PX,
                width: "100%",
                ...style,
            }}
        >
            {children}
        </div>
    );
});
