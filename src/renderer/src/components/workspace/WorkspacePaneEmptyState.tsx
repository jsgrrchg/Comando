import {
    formatShortcutSymbols,
    type ShortcutDefinition,
} from "@renderer/app/shortcuts/registry";

// Resolve the binding from the shortcut registry at render time so the hint
// stays accurate (and uses the correct platform modifier) if it ever changes.
function ShortcutHint({ action }: { action: ShortcutDefinition["id"] }) {
    const label = formatShortcutSymbols(action);
    if (!label) {
        return null;
    }

    return (
        <kbd
            className="ml-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium text-text-primary"
            style={{
                background: "var(--color-bg-tertiary)",
                border: "1px solid color-mix(in srgb, var(--color-border) 80%, transparent)",
                fontFamily: "inherit",
            }}
        >
            {label}
        </kbd>
    );
}

export interface WorkspacePaneRecentProject {
    readonly id: string;
    readonly name: string;
}

// Project selection belongs to the persistent navigator, keeping empty panes
// focused on the actions available inside the current workspace.
export function WorkspacePaneEmptyState() {
    return (
        <div className="flex h-full items-center justify-center p-6">
            <div className="flex w-full max-w-[260px] flex-col items-center gap-4">
                <p className="max-w-[240px] text-center text-[11px] leading-6 text-text-secondary">
                    Open a file
                    <ShortcutHint action="open_file_picker" />, start a chat
                    <ShortcutHint action="new_agent_from_focused_provider" />,
                    or launch a terminal
                    <ShortcutHint action="new_terminal" />.
                </p>

            </div>
        </div>
    );
}
