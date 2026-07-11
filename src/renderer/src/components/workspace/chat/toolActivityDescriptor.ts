import type { AiToolActivity } from "@shared/ipc";

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
    const rawInput = parseRawInput(activity.rawInputJson);
    const rawTarget = readFirstString(rawInput, PATH_INPUT_KEYS);
    if (rawTarget) {
        return rawTarget;
    }

    return (
        activity.locations.find((location) => location.path.trim().length > 0)
            ?.path.trim() ?? null
    );
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
