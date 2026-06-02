import { describe, expect, it, vi } from "vitest";

import { buildWorkspaceAgentsQuickCreateEntries } from "./WorkspaceView";

describe("WorkspaceView quick create agents menu", () => {
    it("includes Claude Code after Claude and keeps Claude as a runtime thread", () => {
        const createChatTab = vi.fn();
        const openClaudeCodeTerminal = vi.fn();

        const entries = buildWorkspaceAgentsQuickCreateEntries({
            claudeCodeAvailable: true,
            defaultProjectId: "project-1",
            defaultWorktreeId: "worktree-1",
            onCreateChatTab: createChatTab,
            onOpenClaudeCodeTerminal: openClaudeCodeTerminal,
        });

        expect(entries.map((entry) => entry.type === "separator" ? "" : entry.label))
            .toEqual([
                "Codex",
                "Claude",
                "Claude Code",
                "Gemini",
                "Grok",
                "Kilo",
                "OpenCode",
            ]);

        const claudeEntry = entries.find(
            (entry) => entry.type !== "separator" && entry.label === "Claude",
        );
        const claudeCodeEntry = entries.find(
            (entry) =>
                entry.type !== "separator" && entry.label === "Claude Code",
        );
        const grokEntry = entries.find(
            (entry) => entry.type !== "separator" && entry.label === "Grok",
        );

        if (claudeEntry?.type === "separator" || !claudeEntry?.action) {
            throw new Error("Expected Claude entry.");
        }
        if (
            claudeCodeEntry?.type === "separator" ||
            !claudeCodeEntry?.action
        ) {
            throw new Error("Expected Claude Code entry.");
        }
        if (grokEntry?.type === "separator" || !grokEntry?.action) {
            throw new Error("Expected Grok entry.");
        }

        claudeEntry.action();
        claudeCodeEntry.action();
        grokEntry.action();

        expect(createChatTab).toHaveBeenCalledWith(
            "project-1",
            "worktree-1",
            "claude",
        );
        expect(createChatTab).toHaveBeenCalledWith(
            "project-1",
            "worktree-1",
            "grok",
        );
        expect(createChatTab).toHaveBeenCalledTimes(2);
        expect(openClaudeCodeTerminal).toHaveBeenCalledTimes(1);
    });

    it("shows the missing CLI tooltip without disabling the action", () => {
        const entries = buildWorkspaceAgentsQuickCreateEntries({
            claudeCodeAvailable: false,
            defaultProjectId: "project-1",
            defaultWorktreeId: null,
            onCreateChatTab: vi.fn(),
            onOpenClaudeCodeTerminal: vi.fn(),
        });

        const claudeCodeEntry = entries.find(
            (entry) =>
                entry.type !== "separator" && entry.label === "Claude Code",
        );

        expect(claudeCodeEntry).not.toHaveProperty("disabled");
        expect(claudeCodeEntry).toMatchObject({
            title:
                "The claude command was not found in Comando's PATH. Your shell may still resolve it.",
        });
    });
});
