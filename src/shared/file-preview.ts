export const COMANDO_FILE_PREVIEW_SCHEME = "comando-file";
export const CODEX_GENERATED_IMAGE_PREVIEW_HOST = "localhost";
export const CODEX_GENERATED_IMAGE_PREVIEW_SCOPE = "codex-image";

const CODEX_GENERATED_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    jpe: "image/jpeg",
    jpeg: "image/jpeg",
    jfif: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
};

export function inferCodexGeneratedImageMimeType(
    candidatePath: string,
): string | null {
    const extension = candidatePath
        .split(/[?#]/, 1)[0]
        ?.split(".")
        .at(-1)
        ?.toLowerCase();

    if (!extension || extension === candidatePath.toLowerCase()) {
        return null;
    }

    return CODEX_GENERATED_IMAGE_MIME_TYPES[extension] ?? null;
}

export function isLikelyCodexGeneratedImagePath(
    candidatePath: string,
): boolean {
    const normalized = candidatePath.replace(/\\/g, "/");
    return (
        normalized.includes("/.codex/generated_images/") ||
        normalized.includes("/generated_images/")
    );
}
