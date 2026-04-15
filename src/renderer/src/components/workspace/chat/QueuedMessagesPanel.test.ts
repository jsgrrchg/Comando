import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { QueuedPrompt } from "@renderer/app/ai/sessionReviewContracts";

import { QueuedMessagesPanel } from "./QueuedMessagesPanel";

function createQueuedPrompt(
    overrides: Partial<QueuedPrompt> = {},
): QueuedPrompt {
    return {
        attachments: [],
        composerPartsSnapshot: [{ text: "Review src/app.ts", type: "text" }],
        createdAt: "2026-04-14T00:00:00.000Z",
        fileContextsSnapshot: [],
        id: "queued-1",
        prompt: "Review src/app.ts",
        status: "queued",
        ...overrides,
    };
}

describe("QueuedMessagesPanel", () => {
    it("renders header, editing message, and queue actions", () => {
        const markup = renderToStaticMarkup(
            createElement(QueuedMessagesPanel, {
                editingItem: createQueuedPrompt({
                    id: "editing-1",
                    prompt: "Refine the previous message",
                }),
                items: [
                    createQueuedPrompt(),
                    createQueuedPrompt({
                        id: "queued-2",
                        prompt: "Retry failing message",
                        status: "failed",
                    }),
                ],
                onCancelEdit: () => {},
                onClearAll: () => {},
                onDelete: () => {},
                onEdit: () => {},
                onSendNow: () => {},
            }),
        );

        expect(markup).toContain("queue (2)");
        expect(markup).toContain("editing:");
        expect(markup).toContain("cancel");
        expect(markup).toContain("[clear]");
        expect(markup).toContain("Delete");
        expect(markup).toContain("Edit");
        expect(markup).toContain("send");
        expect(markup).toContain("Retry failing message");
    });

    it("starts collapsed without rendering the list", () => {
        const markup = renderToStaticMarkup(
            createElement(QueuedMessagesPanel, {
                defaultCollapsed: true,
                items: [createQueuedPrompt()],
                onCancelEdit: () => {},
                onClearAll: () => {},
                onDelete: () => {},
                onEdit: () => {},
                onSendNow: () => {},
            }),
        );

        expect(markup).toContain("queue (1)");
        expect(markup).not.toContain("queued-messages-list");
        expect(markup).not.toContain("Review src/app.ts");
    });

    it("renders nothing when there are no queued messages or edit message", () => {
        const markup = renderToStaticMarkup(
            createElement(QueuedMessagesPanel, {
                items: [],
                onCancelEdit: () => {},
                onClearAll: () => {},
                onDelete: () => {},
                onEdit: () => {},
                onSendNow: () => {},
            }),
        );

        expect(markup).toBe("");
    });
});
