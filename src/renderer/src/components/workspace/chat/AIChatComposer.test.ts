import { describe, expect, it } from "vitest";

import { getComposerAnchoredPickerWidth } from "@renderer/app/utils/menu-position";

import {
    appendComposerProjectEntries,
    getComposerPillLayoutStyle,
    getComposerShellLayoutStyle,
    getComposerShellSizingStyle,
    getComposerInputSlotSizingStyle,
    getComposerInputSizingStyle,
    getComposerPrimaryAction,
    getComposerSubmitKeyboardAction,
    shouldAutoFocusComposerForKeyChange,
    shouldResetComposerForNonceChange,
} from "./AIChatComposer";
import { getChatPillMetrics } from "./chatPillMetrics";
import {
    appendWorkspaceTabComposerItem,
    appendWorkspaceTabComposerItems,
} from "./composerParts";

describe("AIChatComposer", () => {
    it("does not reset on the initial mount nonce", () => {
        expect(shouldResetComposerForNonceChange(null, 0)).toBe(false);
        expect(shouldResetComposerForNonceChange(null, 3)).toBe(false);
    });

    it("resets only when the nonce actually changes", () => {
        expect(shouldResetComposerForNonceChange(0, 0)).toBe(false);
        expect(shouldResetComposerForNonceChange(0, 1)).toBe(true);
    });

    it("auto-focuses only when switching to a different chat tab after initialization", () => {
        expect(
            shouldAutoFocusComposerForKeyChange(null, "chat-tab-1"),
        ).toBe(false);
        expect(
            shouldAutoFocusComposerForKeyChange("chat-tab-1", "chat-tab-1"),
        ).toBe(false);
        expect(
            shouldAutoFocusComposerForKeyChange("chat-tab-1", "chat-tab-2"),
        ).toBe(true);
    });

    it.each([
        {
            expected: "send",
            hasDraft: false,
            isSessionBusy: false,
        },
        {
            expected: "send",
            hasDraft: true,
            isSessionBusy: false,
        },
        {
            expected: "stop",
            hasDraft: false,
            isSessionBusy: true,
        },
        {
            expected: "queue",
            hasDraft: true,
            isSessionBusy: true,
        },
    ] as const)(
        "uses $expected as the primary action when busy=$isSessionBusy and draft=$hasDraft",
        ({ expected, hasDraft, isSessionBusy }) => {
            expect(
                getComposerPrimaryAction({ hasDraft, isSessionBusy }),
            ).toBe(expected);
        },
    );

    it("submits with plain Enter when modifier is not required", () => {
        expect(
            getComposerSubmitKeyboardAction({
                key: "Enter",
                shiftKey: false,
                metaKey: false,
                ctrlKey: false,
                altKey: false,
                canSubmit: true,
                isSessionBusy: false,
                requireCmdEnterToSend: false,
            }),
        ).toBe("submit");
    });

    it("does not submit with plain Enter when modifier is required", () => {
        expect(
            getComposerSubmitKeyboardAction({
                key: "Enter",
                shiftKey: false,
                metaKey: false,
                ctrlKey: false,
                altKey: false,
                canSubmit: true,
                isSessionBusy: false,
                requireCmdEnterToSend: true,
            }),
        ).toBeNull();
    });

    it("submits with Cmd or Ctrl plus Enter when modifier is required", () => {
        expect(
            getComposerSubmitKeyboardAction({
                key: "Enter",
                shiftKey: false,
                metaKey: true,
                ctrlKey: false,
                altKey: false,
                canSubmit: true,
                isSessionBusy: false,
                requireCmdEnterToSend: true,
            }),
        ).toBe("submit");

        expect(
            getComposerSubmitKeyboardAction({
                key: "Enter",
                shiftKey: false,
                metaKey: false,
                ctrlKey: true,
                altKey: false,
                canSubmit: true,
                isSessionBusy: false,
                requireCmdEnterToSend: true,
            }),
        ).toBe("submit");
    });

    it("keeps modifier Enter inert when the setting is disabled", () => {
        expect(
            getComposerSubmitKeyboardAction({
                key: "Enter",
                shiftKey: false,
                metaKey: true,
                ctrlKey: false,
                altKey: false,
                canSubmit: true,
                isSessionBusy: false,
                requireCmdEnterToSend: false,
            }),
        ).toBeNull();
    });

    it("uses the same gated shortcut to stop a busy session", () => {
        expect(
            getComposerSubmitKeyboardAction({
                key: "Enter",
                shiftKey: false,
                metaKey: true,
                ctrlKey: false,
                altKey: false,
                canSubmit: false,
                isSessionBusy: true,
                requireCmdEnterToSend: true,
            }),
        ).toBe("stop");

        expect(
            getComposerSubmitKeyboardAction({
                key: "Enter",
                shiftKey: false,
                metaKey: false,
                ctrlKey: false,
                altKey: false,
                canSubmit: false,
                isSessionBusy: true,
                requireCmdEnterToSend: true,
            }),
        ).toBeNull();
    });

    it("appends multiple dropped project entries as composer pills", () => {
        expect(
            appendComposerProjectEntries([{ text: "", type: "text" }], [
                {
                    kind: "file",
                    name: "app.ts",
                    relativePath: "src/app.ts",
                },
                {
                    kind: "directory",
                    name: "docs",
                    relativePath: "docs",
                },
            ]),
        ).toEqual([
            { text: "", type: "text" },
            {
                label: "app.ts",
                languageId: "typescript",
                path: "src/app.ts",
                relativePath: "src/app.ts",
                type: "file_mention",
            },
            { text: " ", type: "text" },
            {
                folderPath: "docs",
                label: "docs",
                type: "folder_mention",
            },
            { text: " ", type: "text" },
        ]);
    });

    it("appends dropped git commit tabs as inline commit pills", () => {
        expect(
            appendWorkspaceTabComposerItem(
                [{ text: "", type: "text" }],
                {
                    commitSha: "abcdef1234567890",
                    kind: "git_commit_mention",
                    label: "abcdef1",
                },
            ),
        ).toEqual([
            { text: "", type: "text" },
            {
                commitSha: "abcdef1234567890",
                label: "abcdef1",
                type: "git_commit_mention",
            },
            { text: " ", type: "text" },
        ]);
    });

    it("appends dropped GitHub issue tabs as inline issue pills", () => {
        expect(
            appendWorkspaceTabComposerItem(
                [{ text: "", type: "text" }],
                {
                    host: "github.com",
                    kind: "github_issue_mention",
                    label: "#123",
                    number: 123,
                    owner: "comando",
                    repo: "app",
                    title: "Crash on launch",
                    url: "https://github.com/comando/app/issues/123",
                },
            ),
        ).toEqual([
            { text: "", type: "text" },
            {
                host: "github.com",
                label: "#123",
                number: 123,
                owner: "comando",
                repo: "app",
                title: "Crash on launch",
                type: "github_issue_mention",
                url: "https://github.com/comando/app/issues/123",
            },
            { text: " ", type: "text" },
        ]);
    });

    it("appends dropped GitHub PR tabs as inline PR pills", () => {
        expect(
            appendWorkspaceTabComposerItem(
                [{ text: "", type: "text" }],
                {
                    host: "github.com",
                    kind: "github_pull_request_mention",
                    label: "PR #456",
                    number: 456,
                    owner: "comando",
                    repo: "app",
                    title: "Add GitHub API integration",
                    url: "https://github.com/comando/app/pull/456",
                },
            ),
        ).toEqual([
            { text: "", type: "text" },
            {
                host: "github.com",
                label: "PR #456",
                number: 456,
                owner: "comando",
                repo: "app",
                title: "Add GitHub API integration",
                type: "github_pull_request_mention",
                url: "https://github.com/comando/app/pull/456",
            },
            { text: " ", type: "text" },
        ]);
    });

    it("appends every item from a multi-item GitHub drop", () => {
        expect(
            appendWorkspaceTabComposerItems([{ text: "", type: "text" }], [
                {
                    host: "github.com",
                    kind: "github_issue_mention",
                    label: "#123",
                    number: 123,
                    owner: "comando",
                    repo: "app",
                    title: "Crash on launch",
                    url: "https://github.com/comando/app/issues/123",
                },
                {
                    host: "github.com",
                    kind: "github_issue_mention",
                    label: "#124",
                    number: 124,
                    owner: "comando",
                    repo: "app",
                    title: "Broken drag preview",
                    url: "https://github.com/comando/app/issues/124",
                },
            ]),
        ).toEqual([
            { text: "", type: "text" },
            {
                host: "github.com",
                label: "#123",
                number: 123,
                owner: "comando",
                repo: "app",
                title: "Crash on launch",
                type: "github_issue_mention",
                url: "https://github.com/comando/app/issues/123",
            },
            { text: " ", type: "text" },
            {
                host: "github.com",
                label: "#124",
                number: 124,
                owner: "comando",
                repo: "app",
                title: "Broken drag preview",
                type: "github_issue_mention",
                url: "https://github.com/comando/app/issues/124",
            },
            { text: " ", type: "text" },
        ]);
    });

    it("lets regular composer pills show their full label", () => {
        expect(getComposerPillLayoutStyle(getChatPillMetrics(14))).toMatchObject({
            maxWidth: "100%",
            overflow: "visible",
            overflowWrap: "anywhere",
            textOverflow: "clip",
            whiteSpace: "normal",
            wordBreak: "break-word",
        });
    });

    it("keeps selection composer pills compact", () => {
        expect(
            getComposerPillLayoutStyle(getChatPillMetrics(14), { compact: true }),
        ).toMatchObject({
            maxWidth: "161px",
            overflow: "hidden",
            overflowWrap: "normal",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            wordBreak: "normal",
        });
    });

    it("caps the default composer shell height so large pastes stay scrollable", () => {
        expect(getComposerShellSizingStyle(null)).toEqual({
            maxHeight: 600,
            minHeight: 112,
        });
    });

    it("keeps editor overflow isolated from the bottom toolbar", () => {
        expect(
            getComposerShellLayoutStyle({ hasAttachments: false }),
        ).toEqual({
            display: "grid",
            gridTemplateRows: "minmax(0, 1fr) auto",
        });
        expect(getComposerInputSlotSizingStyle()).toEqual({
            minHeight: 76,
            overflow: "hidden",
        });
        expect(getComposerInputSizingStyle()).toEqual({
            minHeight: 0,
        });
    });

    it("keeps attachments in their own row above long composer text", () => {
        expect(getComposerShellLayoutStyle({ hasAttachments: true })).toEqual({
            display: "grid",
            gridTemplateRows: "auto minmax(0, 1fr) auto",
        });
    });

    it("preserves the manual resize height while keeping the same bounds", () => {
        expect(getComposerShellSizingStyle(320)).toEqual({
            height: 320,
            maxHeight: 600,
            minHeight: 112,
        });
    });

    it("ignores manual resize height while the composer is expanded", () => {
        expect(getComposerShellSizingStyle(320, { expanded: true })).toEqual({
            minHeight: 112,
        });
    });

    it("sizes the slash command menu to the composer width within the viewport", () => {
        expect(getComposerAnchoredPickerWidth(640, 900)).toBe(640);
        expect(getComposerAnchoredPickerWidth(900, 640)).toBe(624);
    });
});
