import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
    ReadClaudeCodeTranscriptInput,
    ReadClaudeCodeTranscriptResult,
} from "@shared/ipc";

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 80;
const MAX_PREVIEW_LENGTH = 160;

export async function readClaudeCodeTranscript(
    input: ReadClaudeCodeTranscriptInput,
): Promise<ReadClaudeCodeTranscriptResult> {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
    if (!UUID_PATTERN.test(sessionId)) {
        throw new Error("Expected a Claude Code transcript session UUID.");
    }

    const cwd = typeof input.cwd === "string" ? input.cwd : "";
    if (cwd.trim().length === 0) {
        return createMissingTranscriptResult();
    }

    const transcriptPath = path.join(
        os.homedir(),
        ".claude",
        "projects",
        encodeClaudeCodeProjectPath(cwd),
        `${sessionId}.jsonl`,
    );

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
        stat = await fs.stat(transcriptPath);
    } catch (error) {
        if (isNodeErrorCode(error, "ENOENT")) {
            return createMissingTranscriptResult();
        }
        throw error;
    }

    const mtimeMs = stat.mtimeMs;
    if (
        typeof input.sinceMtimeMs === "number" &&
        Number.isFinite(input.sinceMtimeMs) &&
        input.sinceMtimeMs === mtimeMs
    ) {
        return {
            changed: false,
            found: true,
            mtimeMs,
            preview: null,
            title: null,
        };
    }

    const content = await fs.readFile(transcriptPath, "utf8");
    const parsed = parseClaudeCodeTranscriptJsonl(content);
    return {
        changed: true,
        found: true,
        mtimeMs,
        preview: parsed.preview,
        title: parsed.title,
    };
}

export function encodeClaudeCodeProjectPath(cwd: string): string {
    return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function parseClaudeCodeTranscriptJsonl(content: string): {
    readonly preview: string | null;
    readonly title: string | null;
} {
    let title: string | null = null;
    let preview: string | null = null;

    for (const line of content.split(/\r?\n/)) {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
            continue;
        }

        let entry: unknown;
        try {
            entry = JSON.parse(trimmedLine);
        } catch {
            continue;
        }

        if (!isRecord(entry) || entry.isSidechain === true || entry.isMeta === true) {
            continue;
        }

        const role = getTranscriptEntryRole(entry);
        const text = extractClaudeCodeMessageText(entry.message);
        if (!text) {
            continue;
        }

        if (role === "user" && !title) {
            title = truncateCleanText(text, MAX_TITLE_LENGTH);
        } else if (role === "assistant") {
            preview = truncateCleanText(text, MAX_PREVIEW_LENGTH);
        }
    }

    return { preview, title };
}

function getTranscriptEntryRole(entry: Record<string, unknown>): string | null {
    if (typeof entry.type === "string") {
        return entry.type;
    }
    if (isRecord(entry.message) && typeof entry.message.role === "string") {
        return entry.message.role;
    }
    return null;
}

function extractClaudeCodeMessageText(value: unknown): string | null {
    if (typeof value === "string") {
        return collapseWhitespace(value);
    }
    if (!isRecord(value)) {
        return null;
    }

    const content = value.content;
    if (typeof content === "string") {
        return collapseWhitespace(content);
    }
    if (!Array.isArray(content)) {
        return null;
    }

    const text = content
        .map((block) => {
            if (typeof block === "string") {
                return block;
            }
            if (isRecord(block) && typeof block.text === "string") {
                return block.text;
            }
            return "";
        })
        .filter((part) => part.trim().length > 0)
        .join(" ");
    return collapseWhitespace(text);
}

function truncateCleanText(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function collapseWhitespace(value: string): string | null {
    const collapsed = value.replace(/\s+/g, " ").trim();
    return collapsed.length > 0 ? collapsed : null;
}

function createMissingTranscriptResult(): ReadClaudeCodeTranscriptResult {
    return {
        changed: false,
        found: false,
        mtimeMs: null,
        preview: null,
        title: null,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as { readonly code?: unknown }).code === code
    );
}
