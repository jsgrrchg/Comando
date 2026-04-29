import {
    CODEX_GENERATED_IMAGE_PREVIEW_HOST,
    CODEX_GENERATED_IMAGE_PREVIEW_SCOPE,
    COMANDO_FILE_PREVIEW_SCHEME,
    inferCodexGeneratedImageMimeType,
    isLikelyCodexGeneratedImagePath,
} from "@shared/file-preview";

export function buildCodexGeneratedImagePreviewUrl(
    absolutePath: string,
): string | null {
    const { pathname, suffix } = splitPathSuffix(absolutePath);
    if (pathname.trim().length === 0) {
        return null;
    }

    return `${COMANDO_FILE_PREVIEW_SCHEME}://${CODEX_GENERATED_IMAGE_PREVIEW_HOST}/${CODEX_GENERATED_IMAGE_PREVIEW_SCOPE}/${encodeBase64Url(pathname)}${suffix}`;
}

export function isCodexGeneratedImagePath(candidatePath: string): boolean {
    return (
        isLikelyCodexGeneratedImagePath(candidatePath) &&
        inferCodexGeneratedImageMimeType(candidatePath) !== null
    );
}

function encodeBase64Url(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function splitPathSuffix(value: string): {
    readonly pathname: string;
    readonly suffix: string;
} {
    const marker = value.search(/[?#]/);
    return marker === -1
        ? { pathname: value, suffix: "" }
        : {
              pathname: value.slice(0, marker),
              suffix: value.slice(marker),
          };
}
