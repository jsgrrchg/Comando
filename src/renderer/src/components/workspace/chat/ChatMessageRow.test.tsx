import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AiMessage } from "@shared/ipc";

import { ChatMessageRow } from "./ChatMessageRow";

describe("ChatMessageRow generated images", () => {
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
