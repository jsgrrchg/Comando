import type { ReactNode } from "react";

import { ChatContentColumn } from "./ChatContentColumn";

export function ChatComposerShell({
    children,
    expanded,
}: {
    readonly children: ReactNode;
    readonly expanded: boolean;
}) {
    return (
        <div
            className={
                expanded
                    ? "flex min-h-0 flex-1 flex-col border-t"
                    : "flex shrink-0 flex-col border-t"
            }
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--color-accent) 4%, var(--color-bg-panel))",
                borderTopColor:
                    "color-mix(in srgb, var(--color-accent) 14%, var(--color-border))",
            }}
        >
            <ChatContentColumn
                className={expanded ? "flex min-h-0 flex-1 flex-col" : undefined}
            >
                {children}
            </ChatContentColumn>
        </div>
    );
}
