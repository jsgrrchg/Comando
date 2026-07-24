import { describe, expect, it, vi } from "vitest";
import { buildAiRuntimeCatalog } from "@shared/ai-runtimes";

import {
    buildWorkspaceAgentsQuickCreateEntries,
    getQuickCreateButtonTitle,
    shouldActivateWorkspacePaneOnMouseDown,
} from "./WorkspaceView";

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

        const labels = entries.map((entry) =>
            entry.type === "separator" ? "" : entry.label,
        );
        expect(labels).toEqual([
            "Codex",
            "Claude",
            "Claude Code",
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

    it("creates custom runtimes from the unified catalog", () => {
        const createChatTab = vi.fn();
        const id = "custom:550e8400-e29b-41d4-a716-446655440000";
        const entries = buildWorkspaceAgentsQuickCreateEntries({
            claudeCodeAvailable: true,
            defaultProjectId: "project-1",
            defaultWorktreeId: null,
            onCreateChatTab: createChatTab,
            onOpenClaudeCodeTerminal: vi.fn(),
            runtimeCatalog: buildAiRuntimeCatalog([
                { displayName: "Pi development", id },
            ]),
        });
        const entry = entries.find(
            (candidate) =>
                candidate.type !== "separator" &&
                candidate.label === "Pi development",
        );

        if (entry?.type === "separator" || !entry?.action) {
            throw new Error("Expected custom runtime entry.");
        }
        entry.action();

        expect(createChatTab).toHaveBeenCalledWith("project-1", null, id);
    });

    it("labels Grok as the last quick-create action", () => {
        expect(getQuickCreateButtonTitle("grok", true)).toBe(
            "Open last item: Grok chat",
        );
    });
});

describe("Workspace pane focus", () => {
    it("does not focus a background pane from a secondary mouse button", () => {
        expect(shouldActivateWorkspacePaneOnMouseDown(0)).toBe(true);
        expect(shouldActivateWorkspacePaneOnMouseDown(2)).toBe(false);
    });
});
