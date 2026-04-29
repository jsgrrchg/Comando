import { describe, expect, it } from "vitest";

import {
    buildCodexGeneratedImagePreviewUrl,
    isCodexGeneratedImagePath,
} from "./filePreviewUrl";

describe("filePreviewUrl", () => {
    it("builds comando-file URLs for Codex generated images", () => {
        const imagePath = "/Users/example/.codex/generated_images/image.png";
        const url = buildCodexGeneratedImagePreviewUrl(imagePath);

        expect(url).toMatch(
            /^comando-file:\/\/localhost\/codex-image\/[A-Za-z0-9_-]+$/,
        );
        expect(decodePathFromPreviewUrl(url ?? "")).toBe(imagePath);
    });

    it("preserves query and hash suffixes outside the encoded path", () => {
        const url = buildCodexGeneratedImagePreviewUrl(
            "/Users/example/.codex/generated_images/image.png?version=1#view",
        );

        expect(url?.endsWith("?version=1#view")).toBe(true);
        expect(decodePathFromPreviewUrl(url ?? "")).toBe(
            "/Users/example/.codex/generated_images/image.png",
        );
    });

    it("detects likely Codex generated image paths", () => {
        expect(
            isCodexGeneratedImagePath(
                "/Users/example/.codex/generated_images/image.webp",
            ),
        ).toBe(true);
        expect(isCodexGeneratedImagePath("/tmp/image.svg")).toBe(false);
    });
});

function decodePathFromPreviewUrl(url: string): string {
    const encodedPath = new URL(url).pathname.split("/").at(-1) ?? "";
    const base64 = encodedPath.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(`${base64}${padding}`);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}
