import type { RefObject } from "react";

interface ChatHeaderProps {
    readonly displayTitle: string;
    readonly editing: boolean;
    readonly onBeginEdit: () => void;
    readonly onCancelEdit: () => void;
    readonly onCommitEdit: () => void;
    readonly onOpenParent: () => void;
    readonly onTitleDraftChange: (value: string) => void;
    readonly parentSessionId: string | null;
    readonly parentTitle: string | null;
    readonly titleDraft: string;
    readonly titleInputRef: RefObject<HTMLInputElement | null>;
}

export function ChatHeader({
    displayTitle,
    editing,
    onBeginEdit,
    onCancelEdit,
    onCommitEdit,
    onOpenParent,
    onTitleDraftChange,
    parentSessionId,
    parentTitle,
    titleDraft,
    titleInputRef,
}: ChatHeaderProps) {
    return (
        <div
            className="flex h-6 shrink-0 items-center gap-2 px-3 text-[10.5px] leading-none text-text-secondary"
            style={{
                backgroundColor: "var(--color-bg-secondary)",
                borderBottom:
                    "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                boxSizing: "border-box",
                fontFamily: "var(--font-mono)",
            }}
        >
            {editing && !parentSessionId ? (
                <input
                    ref={titleInputRef}
                    className="min-w-0 flex-1 rounded bg-transparent outline-none"
                    style={{
                        border: "none",
                        borderBottom:
                            "1px solid var(--color-accent, var(--color-text-secondary))",
                        color: "var(--color-text-primary)",
                        fontFamily: "var(--font-mono)",
                        fontSize: "10.5px",
                        padding: 0,
                    }}
                    value={titleDraft}
                    onChange={(event) => onTitleDraftChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") onCommitEdit();
                        if (event.key === "Escape") onCancelEdit();
                    }}
                    onBlur={onCommitEdit}
                />
            ) : (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span
                        className="min-w-0 cursor-default truncate"
                        style={{ color: "var(--color-text-primary)" }}
                        onDoubleClick={() => {
                            if (!parentSessionId) onBeginEdit();
                        }}
                        title={
                            parentSessionId
                                ? "Subagent names are managed by Codex"
                                : "Double-click to rename"
                        }
                    >
                        {displayTitle}
                    </span>
                    {parentSessionId ? (
                        <button
                            className="app-no-drag min-w-0 shrink truncate rounded px-1 text-[10px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
                            onClick={onOpenParent}
                            title={`Open parent ${parentTitle ?? "thread"}`}
                            type="button"
                        >
                            Subagent of {parentTitle ?? "parent thread"}
                        </button>
                    ) : null}
                </div>
            )}
        </div>
    );
}
