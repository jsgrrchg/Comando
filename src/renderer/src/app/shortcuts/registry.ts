export interface ShortcutDefinition {
    readonly description: string;
    readonly id:
        | "open_settings"
        | "save_file"
        | "increase_editor_font_size"
        | "decrease_editor_font_size"
        | "reset_editor_font_size";
    readonly keys: {
        readonly mac: string;
        readonly windows: string;
    };
    readonly label: string;
    readonly section: "Editor" | "File" | "General";
}

export const shortcutDefinitions: readonly ShortcutDefinition[] = [
    {
        id: "open_settings",
        label: "Open settings",
        description: "Open the standalone settings window for the current scope.",
        keys: {
            mac: "Cmd+,",
            windows: "Ctrl+,",
        },
        section: "General",
    },
    {
        id: "save_file",
        label: "Save file",
        description: "Save the active file tab.",
        keys: {
            mac: "Cmd+S",
            windows: "Ctrl+S",
        },
        section: "File",
    },
    {
        id: "increase_editor_font_size",
        label: "Increase editor size",
        description: "Increase the editor font size for the current project scope.",
        keys: {
            mac: "Cmd+=",
            windows: "Ctrl+=",
        },
        section: "Editor",
    },
    {
        id: "decrease_editor_font_size",
        label: "Decrease editor size",
        description: "Decrease the editor font size for the current project scope.",
        keys: {
            mac: "Cmd+-",
            windows: "Ctrl+-",
        },
        section: "Editor",
    },
    {
        id: "reset_editor_font_size",
        label: "Reset editor size",
        description: "Reset the editor font size to the default for the current scope.",
        keys: {
            mac: "Cmd+0",
            windows: "Ctrl+0",
        },
        section: "Editor",
    },
];

export function isMacShortcutPlatform(): boolean {
    return /mac|iphone|ipad/i.test(navigator.platform);
}

export function formatShortcut(id: ShortcutDefinition["id"]): string {
    const definition = shortcutDefinitions.find((entry) => entry.id === id);
    if (!definition) {
        return "";
    }

    return isMacShortcutPlatform()
        ? definition.keys.mac
        : definition.keys.windows;
}
