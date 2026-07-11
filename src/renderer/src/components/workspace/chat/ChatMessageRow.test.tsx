import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AiMessage } from "@shared/ipc";

import { ChatMessageRow, formatChatMessageTime } from "./ChatMessageRow";

describe("ChatMessageRow generated images", () => {
    it("renders indented user messages with time and copy metadata", () => {
        const markup = renderMessage({
            content: "Please update the activity rail.",
            createdAt: "2026-04-20T12:00:00",
            kind: "user",
        });

        expect(markup).toContain('data-user-message="true"');
        expect(markup).toContain("user-message-layout min-w-0 w-full");
        expect(markup).toContain("user-message-bubble ml-auto");
        expect(markup).toContain("w-[70%] max-w-full");
        expect(markup).toContain('data-user-message-metadata="true"');
        expect(markup).toContain("items-center justify-end gap-1.5");
        expect(markup).toContain('dateTime="2026-04-20T12:00:00"');
        expect(markup).toContain("12:00 PM");
        expect(markup).toContain('aria-label="Copy message"');
        expect(markup).toContain("var(--color-accent) 5%");
    });

    it("formats message times in the requested locale and ignores invalid dates", () => {
        expect(
            formatChatMessageTime("2026-04-20T12:00:00", "en-US"),
        ).toBe("12:00 PM");
        expect(formatChatMessageTime("invalid", "en-US")).toBeNull();
    });

    it("renders assistant text in a full-width container", () => {
        const markup = renderMessage({
            content: "A normal assistant paragraph should use the available width.",
            kind: "assistant",
            status: "streaming",
        });

        expect(markup).toContain("w-full");
        expect(markup).toContain("chat-assistant-content");
    });

    it("renders an in-progress generated image placeholder", () => {
        const markup = renderMessage({
            content: "Generating image...",
            generatedImage: {
                error: null,
                mimeType: null,
                path: null,
                result: null,
                revisedPrompt: null,
                status: "in_progress",
                title: "Generating image",
            },
            status: "streaming",
        });

        expect(markup).toContain("Generating image");
        expect(markup).toContain("Generating image...");
    });

    it("renders a generated image preview from the secure preview URL", () => {
        const markup = renderMessage({
            content: "Generated image",
            generatedImage: {
                error: null,
                mimeType: "image/png",
                path: "/Users/example/.codex/generated_images/image.png",
                result: "created image",
                revisedPrompt: "A tiny brass robot",
                status: "completed",
                title: "Generated image",
            },
            status: "completed",
        });

        expect(markup).toContain("Generated image");
        expect(markup).toContain("A tiny brass robot");
        expect(markup).toContain("comando-file://localhost/codex-image/");
        expect(markup).toContain("Open Externally");
        expect(markup).toContain("Copy Path");
    });

    it("renders an error fallback for failed generated images", () => {
        const markup = renderMessage({
            content: "Image generation failed",
            generatedImage: {
                error: "policy denied",
                mimeType: null,
                path: null,
                result: "policy denied",
                revisedPrompt: null,
                status: "failed",
                title: "Image generation failed",
            },
            status: "completed",
        });

        expect(markup).toContain("Image generation failed");
        expect(markup).toContain("policy denied");
    });
});

function renderMessage(overrides: Partial<AiMessage>): string {
    const message: AiMessage = {
        attachments: [],
        content: "",
        createdAt: "2026-04-20T12:00:00.000Z",
        id: "image:codex-acp:image:image-1",
        kind: "image",
        status: "completed",
        ...overrides,
    };

    return renderToStaticMarkup(
        createElement(ChatMessageRow, {
            message,
            onOpenFile: () => {},
            onOpenImage: async () => {},
            resolveFileReference: () => null,
        }),
    );
}
