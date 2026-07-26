import type { AiToolActivity } from "@shared/ipc";

import { isLikelyProjectFileReference } from "../projectFileReferences";
import {
    FILE_TOOL_KINDS,
    isStatusToolActivity,
    isTerminalToolActivity,
} from "./toolActivityKinds";

const SEARCH_TOOL_KINDS = new Set([
    "fetch",
    "find",
    "glob",
    "grep",
    "list",
    "search",
]);

const PATH_INPUT_KEYS = ["file_path", "filePath", "path", "target"] as const;
const QUERY_INPUT_KEYS = ["query", "pattern", "search", "url"] as const;

export type ToolActivityDescriptorCategory =
    | "command"
    | "file"
    | "search"
    | "status"
    | "unknown";

export interface ToolActivityDescriptor {
    readonly category: ToolActivityDescriptorCategory;
    readonly command: string | null;
    readonly target: string | null;
}

export interface ToolActivityHeaderPresentation {
    readonly displayTarget: string;
    readonly prefix: string;
    readonly target: string;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRawInput(
    rawInputJson: string | null,
): Record<string, unknown> | null {
    if (!rawInputJson) {
        return null;
    }

    try {
        let parsed: unknown = JSON.parse(rawInputJson);
        if (typeof parsed === "string") {
            parsed = JSON.parse(parsed) as unknown;
        }
        return isRecordValue(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function readFirstString(
    record: Record<string, unknown> | null,
    keys: readonly string[],
): string | null {
    if (!record) {
        return null;
    }

    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim().length > 0) {
            return value.trim();
        }
    }

    return null;
}

export function getStructuredToolTarget(
    activity: AiToolActivity,
): string | null {
    const locationTarget =
        activity.locations.find(
            (location) => location.path.trim().length > 0,
        )?.path.trim() ?? null;
    if (locationTarget) {
        return locationTarget;
    }

    const rawInput = parseRawInput(activity.rawInputJson);
    return readFirstString(rawInput, PATH_INPUT_KEYS);
}

export function getStructuredToolCommand(
    activity: AiToolActivity,
): string | null {
    return readFirstString(parseRawInput(activity.rawInputJson), [
        "command",
        "cmd",
    ]);
}

function getStructuredToolQuery(activity: AiToolActivity): string | null {
    return readFirstString(parseRawInput(activity.rawInputJson), QUERY_INPUT_KEYS);
}

function getDescriptorCategory(
    activity: AiToolActivity,
): ToolActivityDescriptorCategory {
    const kind = activity.kind.toLowerCase();
    if (isStatusToolActivity(activity)) {
        return "status";
    }
    if (isTerminalToolActivity(activity)) {
        return "command";
    }
    if (SEARCH_TOOL_KINDS.has(kind)) {
        return "search";
    }
    if (FILE_TOOL_KINDS.has(kind)) {
        return "file";
    }
    return "unknown";
}

function parseToolTitleReference(
    title: string,
): ToolActivityHeaderPresentation | null {
    const match =
        /^(Read|Edit|Write|Create|Delete|Move|Search)\s+(.+)$/i.exec(
            title.trim(),
        );
    const target = match?.[2]?.trim() ?? "";
    if (
        !target ||
        /^\.{2,}$/.test(target) ||
        !isLikelyProjectFileReference(target)
    ) {
        return null;
    }

    return {
        displayTarget: target,
        prefix: `${match?.[1] ?? ""} `,
        target,
    };
}

function getToolActionPrefix(kind: string): string {
    const normalizedKind = kind.toLowerCase();
    if (normalizedKind === "read" || normalizedKind === "read_file") {
        return "Read ";
    }
    if (normalizedKind === "search" || normalizedKind === "grep") {
        return "Search ";
    }
    if (normalizedKind === "edit" || normalizedKind === "update") {
        return "Edit ";
    }
    if (normalizedKind === "write") return "Write ";
    if (normalizedKind === "create") return "Create ";
    if (normalizedKind === "delete" || normalizedKind === "remove") {
        return "Delete ";
    }
    if (normalizedKind === "move" || normalizedKind === "rename") {
        return "Move ";
    }
    return "";
}

function shouldUseStructuredHeaderTarget(kind: string): boolean {
    const normalizedKind = kind.toLowerCase();
    return (
        normalizedKind === "read" ||
        normalizedKind === "read_file" ||
        normalizedKind === "search" ||
        normalizedKind === "grep"
    );
}

export function getToolActivityHeaderPresentation(
    activity: AiToolActivity,
): ToolActivityHeaderPresentation | null {
    const titleReference = parseToolTitleReference(activity.title);
    if (!shouldUseStructuredHeaderTarget(activity.kind)) {
        return titleReference;
    }

    const structuredTarget = getStructuredToolTarget(activity);
    if (structuredTarget && isLikelyProjectFileReference(structuredTarget)) {
        return {
            // Keep a useful provider title for display, but never use it as the
            // navigation target when structured protocol metadata exists.
            displayTarget: titleReference?.displayTarget ?? structuredTarget,
            prefix:
                titleReference?.prefix ??
                getToolActionPrefix(activity.kind),
            target: structuredTarget,
        };
    }

    return titleReference;
}

export function getToolActivityDescriptor(
    activity: AiToolActivity,
): ToolActivityDescriptor {
    const category = getDescriptorCategory(activity);
    const command = getStructuredToolCommand(activity);
    const fileTarget = getStructuredToolTarget(activity);

    return {
        category,
        command,
        target:
            category === "command"
                ? command
                : category === "search"
                  ? (fileTarget ?? getStructuredToolQuery(activity))
                  : fileTarget,
    };
}
