import { describe, expect, it } from "vitest";

import { shortcutDefinitions } from "./registry";

describe("shortcutDefinitions", () => {
    it("includes chat history and git history shortcuts for macOS and Windows", () => {
        const chatHistoryShortcut = shortcutDefinitions.find(
            (shortcut) => shortcut.id === "open_chat_history",
        );
        const gitHistoryShortcut = shortcutDefinitions.find(
            (shortcut) => shortcut.id === "open_git_history",
        );

        expect(chatHistoryShortcut).toMatchObject({
            description:
                "Open the singleton chat history tab for the active project.",
            keys: {
                mac: "Cmd+Shift+H",
                windows: "Ctrl+Shift+H",
            },
            label: "Open chat history",
            section: "General",
        });
        expect(gitHistoryShortcut).toMatchObject({
            description: "Open the Git history tab for the active project.",
            keys: {
                mac: "Cmd+Shift+G",
                windows: "Ctrl+Shift+G",
            },
            label: "Open git history",
            section: "Git",
        });
    });

    it("includes workspace navigation shortcuts", () => {
        const nextWorkspaceShortcut = shortcutDefinitions.find(
            (shortcut) => shortcut.id === "next_workspace",
        );
        const previousWorkspaceShortcut = shortcutDefinitions.find(
            (shortcut) => shortcut.id === "previous_workspace",
        );

        expect(nextWorkspaceShortcut).toMatchObject({
            description: "Switch to the next open workspace.",
            keys: {
                mac: "Cmd+Alt+]",
                windows: "Ctrl+Alt+]",
            },
            label: "Next workspace",
            section: "General",
        });
        expect(previousWorkspaceShortcut).toMatchObject({
            description: "Switch to the previous open workspace.",
            keys: {
                mac: "Cmd+Alt+[",
                windows: "Ctrl+Alt+[",
            },
            label: "Previous workspace",
            section: "General",
        });
    });
});
