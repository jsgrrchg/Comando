/* ─── Part types ─── */

export type AIComposerPart =
    | { readonly type: "text"; readonly text: string }
    | {
          readonly type: "file_mention";
          readonly label: string;
          readonly path: string;
          readonly relativePath: string;
          readonly languageId: string;
      }
    | {
          readonly type: "folder_mention";
          readonly folderPath: string;
          readonly label: string;
      }
    | { readonly type: "fetch_mention" }
    | { readonly type: "plan_mention" }
    | {
          readonly type: "file_attachment";
          readonly filePath: string;
          readonly mimeType: string;
          readonly label: string;
      };

/* ─── Normalization ─── */

export function normalizeComposerParts(
    parts: readonly AIComposerPart[],
): AIComposerPart[] {
    const result: AIComposerPart[] = [];

    for (const part of parts) {
        if (part.type === "text") {
            const last = result[result.length - 1];
            if (last?.type === "text") {
                result[result.length - 1] = {
                    type: "text",
                    text: last.text + part.text,
                };
                continue;
            }
        }
        result.push(part);
    }

    return result;
}

/* ─── Serialization ─── */

const PILL_OPEN = "\u200B\u00AB";
const PILL_CLOSE = "\u00BB\u200B";

export function serializeComposerParts(
    parts: readonly AIComposerPart[],
): string {
    return parts
        .map((p) => {
            switch (p.type) {
                case "text":
                    return p.text;
                case "file_mention":
                    return `${PILL_OPEN}@${p.label}${PILL_CLOSE}`;
                case "folder_mention":
                    return `${PILL_OPEN}@${p.label}${PILL_CLOSE}`;
                case "fetch_mention":
                    return `${PILL_OPEN}@fetch${PILL_CLOSE}`;
                case "plan_mention":
                    return `${PILL_OPEN}/plan${PILL_CLOSE}`;
                case "file_attachment":
                    return `${PILL_OPEN}📎${p.label}${PILL_CLOSE}`;
            }
        })
        .join("");
}

export function cleanPillMarkers(text: string): string {
    return text.replaceAll(PILL_OPEN, "").replaceAll(PILL_CLOSE, "");
}

export function createEmptyComposerParts(): AIComposerPart[] {
    return [{ type: "text", text: "" }];
}

/* ─── Plain text extraction ─── */

export function composerPartsToPlainText(
    parts: readonly AIComposerPart[],
): string {
    return parts
        .map((p) => {
            switch (p.type) {
                case "text":
                    return p.text;
                case "file_mention":
                    return `@${p.relativePath}`;
                case "folder_mention":
                    return `@${p.folderPath}`;
                case "fetch_mention":
                    return "@fetch";
                case "plan_mention":
                    return "/plan";
                case "file_attachment":
                    return `[${p.label}]`;
            }
        })
        .join("");
}

/* ─── Append helpers ─── */

function ensureTrailingSpace(
    parts: readonly AIComposerPart[],
): AIComposerPart[] {
    const result = [...parts];
    const last = result[result.length - 1];
    if (!last) {
        return result;
    }

    if (
        last.type === "text" &&
        (last.text.length === 0 || last.text.endsWith(" "))
    ) {
        return result;
    }

    if (last.type !== "text" || !last.text.endsWith(" ")) {
        result.push({ type: "text", text: " " });
    }
    return result;
}

export function appendFileMentionPart(
    parts: readonly AIComposerPart[],
    file: {
        label: string;
        path: string;
        relativePath: string;
        languageId: string;
    },
): AIComposerPart[] {
    const withSpace = ensureTrailingSpace(parts);
    withSpace.push({
        type: "file_mention",
        label: file.label,
        path: file.path,
        relativePath: file.relativePath,
        languageId: file.languageId,
    });
    withSpace.push({ type: "text", text: " " });
    return normalizeComposerParts(withSpace);
}

export function appendFolderMentionPart(
    parts: readonly AIComposerPart[],
    folderPath: string,
    label: string,
): AIComposerPart[] {
    const withSpace = ensureTrailingSpace(parts);
    withSpace.push({
        type: "folder_mention",
        folderPath,
        label,
    });
    withSpace.push({ type: "text", text: " " });
    return normalizeComposerParts(withSpace);
}

export function appendFetchMentionPart(
    parts: readonly AIComposerPart[],
): AIComposerPart[] {
    const withSpace = ensureTrailingSpace(parts);
    withSpace.push({ type: "fetch_mention" });
    withSpace.push({ type: "text", text: " " });
    return normalizeComposerParts(withSpace);
}

export function appendPlanMentionPart(
    parts: readonly AIComposerPart[],
): AIComposerPart[] {
    const withSpace = ensureTrailingSpace(parts);
    withSpace.push({ type: "plan_mention" });
    withSpace.push({ type: "text", text: " " });
    return normalizeComposerParts(withSpace);
}

/* ─── Emptiness check ─── */

export function isComposerEmpty(parts: readonly AIComposerPart[]): boolean {
    return parts.every((p) => p.type === "text" && p.text.trim().length === 0);
}
