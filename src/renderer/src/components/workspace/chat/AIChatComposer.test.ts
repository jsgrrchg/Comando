import { describe, expect, it } from "vitest";

import {
    appendComposerProjectEntries,
    getComposerSubmitKeyboardAction,
    shouldAutoFocusComposerForKeyChange,
    shouldResetComposerForNonceChange,
} from "./AIChatComposer";

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
});
