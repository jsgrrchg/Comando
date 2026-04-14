export interface ShortcutDefinition {
    readonly description: string;
    readonly id:
        | "attach_line_fragment"
        | "new_agent_from_focused_provider"
        | "new_file"
        | "new_terminal"
        | "open_settings"
        | "save_file"
        | "toggle_sidebar"
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
        id: "attach_line_fragment",
        label: "Attach selected lines",
        description:
            "Insert the selected editor lines into the chat composer as a pill.",
        keys: {
            mac: "Cmd+L",
            windows: "Ctrl+L",
        },
        section: "Editor",
    },
    {
        id: "new_file",
        label: "New file",
        description: "Create a new file in the active project.",
        keys: {
            mac: "Cmd+N",
            windows: "Ctrl+N",
        },
        section: "File",
    },
    {
        id: "new_agent_from_focused_provider",
        label: "New agent from focused provider",
        description: "Open a new chat for the provider that was last in focus.",
        keys: {
            mac: "Cmd+Shift+N",
            windows: "Ctrl+Shift+N",
        },
        section: "General",
    },
    {
        id: "new_terminal",
        label: "New terminal",
        description: "Open a new terminal in the active project.",
        keys: {
            mac: "Cmd+R",
            windows: "Ctrl+R",
        },
        section: "File",
    },
    {
        id: "open_settings",
        label: "Open settings",
        description:
            "Open the standalone settings window for the current scope.",
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
        id: "toggle_sidebar",
        label: "Toggle sidebar",
        description: "Collapse or expand the project sidebar.",
        keys: {
            mac: "Cmd+B",
            windows: "Ctrl+B",
        },
        section: "General",
    },
    {
        id: "increase_editor_font_size",
        label: "Increase editor text size",
        description:
            "Increase the editor font size for the current project scope.",
        keys: {
            mac: "Cmd+Alt+Plus",
            windows: "Ctrl+Alt+Plus",
        },
        section: "Editor",
    },
    {
        id: "decrease_editor_font_size",
        label: "Decrease editor text size",
        description:
            "Decrease the editor font size for the current project scope.",
        keys: {
            mac: "Cmd+Alt+-",
            windows: "Ctrl+Alt+-",
        },
        section: "Editor",
    },
    {
        id: "reset_editor_font_size",
        label: "Reset editor text size",
        description:
            "Reset the editor font size to the default for the current scope.",
        keys: {
            mac: "Cmd+Alt+0",
            windows: "Ctrl+Alt+0",
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
