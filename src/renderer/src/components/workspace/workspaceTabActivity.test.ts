import { describe, expect, it } from "vitest";

import { resolveWorkspaceChatTabActivityIndicator } from "./workspaceTabActivity";

describe("resolveWorkspaceChatTabActivityIndicator", () => {
    it("returns a working indicator while the agent is active", () => {
        expect(
            resolveWorkspaceChatTabActivityIndicator({
                localError: null,
                snapshot: { status: "starting" },
            }),
        ).toEqual({
            title: "Agent busy",
            tone: "working",
        });

        expect(
            resolveWorkspaceChatTabActivityIndicator({
                localError: null,
                snapshot: { status: "streaming" },
            }),
        ).toEqual({
            title: "Agent busy",
            tone: "working",
        });
    });

    it("keeps the indicator while the agent waits for user action", () => {
        expect(
            resolveWorkspaceChatTabActivityIndicator({
                localError: null,
                snapshot: { status: "waiting_permission" },
            }),
        ).toEqual({
            title: "Agent busy",
            tone: "working",
        });

        expect(
            resolveWorkspaceChatTabActivityIndicator({
                localError: null,
                snapshot: { status: "waiting_user_input" },
            }),
        ).toEqual({
            title: "Agent busy",
            tone: "working",
        });
    });

    it("returns an error indicator when the session fails", () => {
        expect(
            resolveWorkspaceChatTabActivityIndicator({
                localError: null,
                snapshot: { status: "error" },
            }),
        ).toEqual({
            title: "Agent error",
            tone: "danger",
        });
    });

    it("prioritizes local renderer errors", () => {
        expect(
            resolveWorkspaceChatTabActivityIndicator({
                localError: "Could not hydrate the session.",
                snapshot: { status: "idle" },
            }),
        ).toEqual({
            title: "Agent error",
            tone: "danger",
        });
    });

    it("clears the indicator when the session is idle", () => {
        expect(
            resolveWorkspaceChatTabActivityIndicator({
                localError: null,
                snapshot: { status: "idle" },
            }),
        ).toBeNull();
    });

    it("returns stable references for identical activity states", () => {
        expect(
            resolveWorkspaceChatTabActivityIndicator({
                localError: null,
                snapshot: { status: "streaming" },
            }),
        ).toBe(
            resolveWorkspaceChatTabActivityIndicator({
                localError: null,
                snapshot: { status: "waiting_permission" },
            }),
        );

        expect(
            resolveWorkspaceChatTabActivityIndicator({
                localError: "Renderer failure",
                snapshot: { status: "idle" },
            }),
        ).toBe(
            resolveWorkspaceChatTabActivityIndicator({
                localError: null,
                snapshot: { status: "error" },
            }),
        );
    });
});
