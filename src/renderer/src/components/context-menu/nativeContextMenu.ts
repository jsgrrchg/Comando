import type { NativeContextMenuEntry } from "@shared/ipc";

import type { ContextMenuEntry } from "./ContextMenu";

export async function requestNativeContextMenuAction(
    entries: readonly ContextMenuEntry[],
    position: { readonly x: number; readonly y: number },
): Promise<(() => void) | null> {
    const serialized = serializeNativeContextMenuEntries(entries);
    const selectedId =
        (await window.comando?.showNativeContextMenu({
            entries: serialized.entries,
            x: position.x,
            y: position.y,
        })) ?? null;

    return selectedId ? (serialized.actions.get(selectedId) ?? null) : null;
}

function serializeNativeContextMenuEntries(
    entries: readonly ContextMenuEntry[],
): {
    readonly actions: ReadonlyMap<string, () => void>;
    readonly entries: readonly NativeContextMenuEntry[];
} {
    const actions = new Map<string, () => void>();
    let nextId = 0;

    const serialize = (
        sourceEntries: readonly ContextMenuEntry[],
    ): readonly NativeContextMenuEntry[] =>
        sourceEntries.map((entry) => {
            if (entry.type === "separator") {
                return { type: "separator" };
            }

            const id = `native-menu-${nextId++}`;
            if (entry.action) actions.set(id, entry.action);
            return {
                id,
                label: entry.label,
                enabled: !entry.disabled,
                children: entry.children ? serialize(entry.children) : undefined,
            };
        });

    return { actions, entries: serialize(entries) };
}
