import type { ProjectTreeNode } from "@shared/ipc";
import {
    nativeIndexedProjectEntriesToIpc,
    nativeProjectTreeEntriesToIpc,
    type NativeContentSearchInput,
    type NativeContentSearchResult,
    type NativeIndexDropProjectResult,
    type NativeIndexRebuildProjectResult,
    type NativeIndexStatusResult,
    type NativeIndexUpdateEntriesResult,
    type NativeIndexUpdateKind,
    type NativeProjectEntrySearchResult,
    type NativeProjectListEntriesResult,
    type NativeSearchCancelled,
} from "@shared/native-backend";

import type {
    ProjectRuntimeListEntriesInput,
    ProjectRuntimeSearchInput,
} from "../projects/runtime";
import type { NativeBackendRequester } from "./persistence";

export const NATIVE_INDEX_ENABLED_ENV = "COMANDO_NATIVE_INDEX";
export const NATIVE_SEARCH_ENABLED_ENV = "COMANDO_NATIVE_SEARCH";
export const NATIVE_SEARCH_MODE_ENV = "COMANDO_NATIVE_SEARCH_MODE";
export const NATIVE_SEARCH_FALLBACK_ENV = "COMANDO_NATIVE_SEARCH_FALLBACK";

export type NativeSearchMode = "read" | "shadow";

export class NativeSearchGateway {
    readonly #client: NativeBackendRequester;

    constructor(client: NativeBackendRequester) {
        this.#client = client;
    }

    async rebuildProjectIndex(input: {
        readonly projectId: string;
        readonly worktreeId: string | null;
    }): Promise<NativeIndexRebuildProjectResult> {
        return parseNativeIndexRebuildProjectResult(
            await this.#client.request("index_rebuild_project", {
                projectId: input.projectId,
                worktreeId: input.worktreeId,
            }),
        );
    }

    async updateProjectIndexEntries(input: {
        readonly kind: NativeIndexUpdateKind;
        readonly projectId: string;
        readonly relativePaths: readonly string[] | null;
        readonly worktreeId: string | null;
    }): Promise<NativeIndexUpdateEntriesResult> {
        return parseNativeIndexUpdateEntriesResult(
            await this.#client.request("index_update_entries", {
                kind: input.kind,
                projectId: input.projectId,
                relativePaths:
                    input.relativePaths === null ? null : [...input.relativePaths],
                worktreeId: input.worktreeId,
            }),
        );
    }

    async getProjectIndexStatus(input: {
        readonly projectId: string;
        readonly worktreeId: string | null;
    }): Promise<NativeIndexStatusResult> {
        return parseNativeIndexStatusResult(
            await this.#client.request("index_get_status", {
                projectId: input.projectId,
                worktreeId: input.worktreeId,
            }),
        );
    }

    async dropProjectIndex(input: {
        readonly projectId: string;
        readonly worktreeId: string | null;
    }): Promise<NativeIndexDropProjectResult> {
        return parseNativeIndexDropProjectResult(
            await this.#client.request("index_drop_project", {
                projectId: input.projectId,
                worktreeId: input.worktreeId,
            }),
        );
    }

    async listProjectEntries(
        input: ProjectRuntimeListEntriesInput,
    ): Promise<ProjectTreeNode[]> {
        const result = parseNativeProjectListEntriesResult(
            await this.#client.request("project_list_entries", {
                projectId: input.projectId,
                worktreeId: input.worktreeId ?? null,
            }),
        );
        if (result.truncated) {
            throw new Error(
                "Native project index listing was truncated; falling back requires an explicit native search fallback flag.",
            );
        }
        return nativeProjectTreeEntriesToIpc(result.entries);
    }

    async searchProjectEntries(
        input: ProjectRuntimeSearchInput,
    ): Promise<ProjectTreeNode[]> {
        const result = parseNativeProjectEntrySearchResult(
            await this.#client.request("project_search_entries", {
                contextKey: nativeSearchContextKey(input),
                includeAncestorDirectories:
                    input.includeAncestorDirectories === true,
                limit: input.limit ?? 20,
                projectId: input.projectId,
                query: input.query,
                worktreeId: input.worktreeId ?? null,
            }),
        );
        return nativeIndexedProjectEntriesToIpc(result.entries);
    }

    async searchProjectContent(
        input: NativeContentSearchInput,
    ): Promise<NativeContentSearchResult> {
        return parseNativeContentSearchResult(
            await this.#client.request("search_project_content", {
                limit: input.limit,
                projectId: input.projectId,
                query: input.query,
                worktreeId: input.worktreeId,
            }),
        );
    }

    async cancelSearch(operationId: string): Promise<NativeSearchCancelled> {
        return parseNativeSearchCancelled(
            await this.#client.request("search_cancel", {
                operationId,
            }),
        );
    }
}

export function resolveNativeSearchMode(
    env: NodeJS.ProcessEnv = process.env,
): NativeSearchMode | null {
    if (
        env[NATIVE_INDEX_ENABLED_ENV] !== "1" ||
        env[NATIVE_SEARCH_ENABLED_ENV] !== "1"
    ) {
        return null;
    }

    return env[NATIVE_SEARCH_MODE_ENV] === "read" ? "read" : "shadow";
}

export function shouldUseNativeSearchReads(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return resolveNativeSearchMode(env) === "read";
}

export function shouldUseNativeSearchShadow(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return resolveNativeSearchMode(env) === "shadow";
}

export function shouldFallbackFromNativeSearch(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return env[NATIVE_SEARCH_FALLBACK_ENV] === "1";
}

function parseNativeIndexRebuildProjectResult(
    value: unknown,
): NativeIndexRebuildProjectResult {
    const record = requireRecord(value, "Native index rebuild result");
    parseNativeIndexStatusResult(record.status);
    requireArray(record.entries, "entries");
    return record as unknown as NativeIndexRebuildProjectResult;
}

function parseNativeIndexUpdateEntriesResult(
    value: unknown,
): NativeIndexUpdateEntriesResult {
    const record = requireRecord(value, "Native index update result");
    parseNativeIndexStatusResult(record.status);
    return record as unknown as NativeIndexUpdateEntriesResult;
}

function parseNativeIndexStatusResult(value: unknown): NativeIndexStatusResult {
    const record = requireRecord(value, "Native index status");
    requireString(record.projectId, "projectId");
    requireString(record.status, "status");
    requireNumber(record.generation, "generation");
    requireRecord(record.stats, "stats");
    requireString(record.occurredAt, "occurredAt");
    return record as unknown as NativeIndexStatusResult;
}

function parseNativeIndexDropProjectResult(
    value: unknown,
): NativeIndexDropProjectResult {
    const record = requireRecord(value, "Native index drop result");
    requireBoolean(record.dropped, "dropped");
    return record as unknown as NativeIndexDropProjectResult;
}

function parseNativeProjectListEntriesResult(
    value: unknown,
): NativeProjectListEntriesResult {
    const record = requireRecord(value, "Native project entries result");
    requireArray(record.entries, "entries");
    requireBoolean(record.truncated, "truncated");
    return record as unknown as NativeProjectListEntriesResult;
}

function parseNativeProjectEntrySearchResult(
    value: unknown,
): NativeProjectEntrySearchResult {
    const record = requireRecord(value, "Native project entry search result");
    requireString(record.operationId, "operationId");
    requireArray(record.entries, "entries");
    requireArray(record.matches, "matches");
    requireRecord(record.stats, "stats");
    return record as unknown as NativeProjectEntrySearchResult;
}

function parseNativeContentSearchResult(
    value: unknown,
): NativeContentSearchResult {
    const record = requireRecord(value, "Native content search result");
    requireString(record.operationId, "operationId");
    requireArray(record.matches, "matches");
    requireBoolean(record.truncated, "truncated");
    return record as unknown as NativeContentSearchResult;
}

function parseNativeSearchCancelled(value: unknown): NativeSearchCancelled {
    const record = requireRecord(value, "Native search cancelled result");
    requireString(record.operationId, "operationId");
    requireBoolean(record.cancelled, "cancelled");
    requireString(record.cancelledAt, "cancelledAt");
    return record as unknown as NativeSearchCancelled;
}

function requireRecord(
    value: unknown,
    label: string,
): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function requireArray(value: unknown, fieldName: string): readonly unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`Native search field ${fieldName} must be an array.`);
    }
    return value;
}

function requireBoolean(value: unknown, fieldName: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`Native search field ${fieldName} must be a boolean.`);
    }
    return value;
}

function requireNumber(value: unknown, fieldName: string): number {
    if (typeof value !== "number") {
        throw new Error(`Native search field ${fieldName} must be a number.`);
    }
    return value;
}

function requireString(value: unknown, fieldName: string): string {
    if (typeof value !== "string") {
        throw new Error(`Native search field ${fieldName} must be a string.`);
    }
    return value;
}

function nativeSearchContextKey(input: ProjectRuntimeSearchInput): string {
    const searchContext = input.searchContext?.trim() || "project-search";
    return `${input.projectId}:${input.worktreeId ?? "primary"}:${searchContext}`;
}
