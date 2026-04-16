import { describe, expect, it } from "vitest";

import {
    getComposerSubmitKeyboardAction,
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
});
