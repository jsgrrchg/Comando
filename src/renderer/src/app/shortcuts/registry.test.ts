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
});
