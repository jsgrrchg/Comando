export interface ShortcutDefinition {
    readonly description: string;
    readonly id:
        | "attach_line_fragment"
        | "close_focused_surface"
        | "commit_git_changes"
        | "decrease_editor_font_size"
        | "focus_git_search"
        | "force_reload_window"
        | "increase_editor_font_size"
        | "new_agent_from_focused_provider"
        | "new_file"
        | "new_terminal"
        | "new_window"
        | "next_pane_tab"
        | "open_current_project_in_new_window"
        | "open_file_picker"
        | "open_settings"
        | "previous_pane_tab"
        | "reload_window"
        | "reset_editor_font_size"
        | "reveal_active_file_in_tree"
        | "reopen_closed_tab"
        | "save_file"
        | "toggle_sidebar";
    readonly keys: {
        readonly mac: string;
        readonly windows: string;
    };
    readonly label: string;
    readonly section: "Editor" | "File" | "General" | "Git" | "Window";
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
        id: "open_file_picker",
        label: "Quick open file",
        description:
            "Search project files and open the selection in the active pane.",
        keys: {
            mac: "Cmd+T",
            windows: "Ctrl+T",
        },
        section: "File",
    },
    {
        id: "reveal_active_file_in_tree",
        label: "Reveal active file in tree",
        description:
            "Reveal the active file in the project tree and focus it there.",
        keys: {
            mac: "Cmd+Shift+E",
            windows: "Ctrl+Shift+E",
        },
        section: "File",
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
        id: "next_pane_tab",
        label: "Next pane tab",
        description: "Switch to the next tab in the active pane.",
        keys: {
            mac: "Ctrl+Tab",
            windows: "Ctrl+Tab",
        },
        section: "General",
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
        id: "previous_pane_tab",
        label: "Previous pane tab",
        description: "Switch to the previous tab in the active pane.",
        keys: {
            mac: "Ctrl+Shift+Tab",
            windows: "Ctrl+Shift+Tab",
        },
        section: "General",
    },
    {
        id: "reopen_closed_tab",
        label: "Reopen closed tab",
        description: "Restore the most recently closed workspace tab.",
        keys: {
            mac: "Cmd+Shift+T",
            windows: "Ctrl+Shift+T",
        },
        section: "General",
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
        id: "commit_git_changes",
        label: "Commit git changes",
        description:
            "Commit staged changes from the Git composer when a commit message is present.",
        keys: {
            mac: "Cmd+Enter",
            windows: "Ctrl+Enter",
        },
        section: "Git",
    },
    {
        id: "focus_git_search",
        label: "Focus git search",
        description:
            "Focus the commit search input in the Git history view.",
        keys: {
            mac: "Cmd+F",
            windows: "Ctrl+F",
        },
        section: "Git",
    },
    {
        id: "close_focused_surface",
        label: "Close focused surface",
        description:
            "Close the currently focused surface or window. On Windows the app menu quits instead.",
        keys: {
            mac: "Cmd+W",
            windows: "Not available",
        },
        section: "Window",
    },
    {
        id: "force_reload_window",
        label: "Force reload",
        description:
            "Force reload the current window from the native app menu.",
        keys: {
            mac: "Cmd+Alt+Shift+R",
            windows: "Ctrl+Alt+Shift+R",
        },
        section: "Window",
    },
    {
        id: "new_window",
        label: "New window",
        description: "Open a new main window from the native app menu.",
        keys: {
            mac: "Cmd+Alt+Shift+N",
            windows: "Ctrl+Alt+Shift+N",
        },
        section: "Window",
    },
    {
        id: "open_current_project_in_new_window",
        label: "Open current project in new window",
        description:
            "Open the current project in a separate window from the native app menu.",
        keys: {
            mac: "Cmd+Alt+N",
            windows: "Ctrl+Alt+N",
        },
        section: "Window",
    },
    {
        id: "reload_window",
        label: "Reload",
        description: "Reload the current window from the native app menu.",
        keys: {
            mac: "Cmd+Alt+R",
            windows: "Ctrl+Alt+R",
        },
        section: "Window",
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
