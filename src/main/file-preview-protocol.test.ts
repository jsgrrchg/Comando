import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveCodexGeneratedImagePreviewPath } from "./file-preview-protocol";

describe("resolveCodexGeneratedImagePreviewPath", () => {
    let tempDir: string;
    let generatedImagesRoot: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-preview-protocol-"),
        );
        generatedImagesRoot = path.join(tempDir, "generated_images");
        fs.mkdirSync(generatedImagesRoot, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tempDir, { force: true, recursive: true });
    });

    it("allows image files inside an authorized generated_images root", async () => {
        const imagePath = path.join(generatedImagesRoot, "image.png");
        fs.writeFileSync(imagePath, "png");

        await expect(resolvePath(imagePath)).resolves.toMatchObject({
            filePath: fs.realpathSync(imagePath),
            mimeType: "image/png",
            status: 200,
        });
    });

    it("blocks files outside authorized roots", async () => {
        const imagePath = path.join(tempDir, "outside.png");
        fs.writeFileSync(imagePath, "png");

        await expect(resolvePath(imagePath)).resolves.toMatchObject({
            filePath: null,
            mimeType: null,
            status: 404,
        });
    });

    it("blocks symlinks that escape the authorized root", async () => {
        const outsidePath = path.join(tempDir, "outside.png");
        const symlinkPath = path.join(generatedImagesRoot, "linked.png");
        fs.writeFileSync(outsidePath, "png");
        fs.symlinkSync(outsidePath, symlinkPath);

        await expect(resolvePath(symlinkPath)).resolves.toMatchObject({
            filePath: null,
            mimeType: null,
            status: 404,
        });
    });

    it("returns 415 for non-image files inside an authorized root", async () => {
        const textPath = path.join(generatedImagesRoot, "notes.txt");
        fs.writeFileSync(textPath, "hello");

        await expect(resolvePath(textPath)).resolves.toMatchObject({
            filePath: null,
            mimeType: null,
            status: 415,
        });
    });

    function resolvePath(candidatePath: string) {
        return resolveCodexGeneratedImagePreviewPath(
            encodeBase64Url(candidatePath),
            {
                allowedRoots: [generatedImagesRoot],
            },
        );
    }
});

function encodeBase64Url(value: string): string {
    return Buffer.from(value, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}
