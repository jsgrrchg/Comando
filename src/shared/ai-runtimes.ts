import type {
    AiRuntimeDescriptor,
    AiRuntimeId,
    BuiltInAiRuntimeId,
    CustomAcpRuntimeId,
} from "./ipc";

export type ActiveAiRuntimeId = BuiltInAiRuntimeId;

export const ACTIVE_AI_RUNTIME_IDS = [
    "codex",
    "claude",
    "grok",
    "kilo",
    "opencode",
] as const satisfies readonly BuiltInAiRuntimeId[];

export const LEGACY_AI_RUNTIME_IDS = [
    ...ACTIVE_AI_RUNTIME_IDS,
] as const satisfies readonly BuiltInAiRuntimeId[];

const ACTIVE_AI_RUNTIME_ID_SET = new Set<BuiltInAiRuntimeId>(
    ACTIVE_AI_RUNTIME_IDS,
);
export function isActiveAiRuntimeId(value: unknown): value is ActiveAiRuntimeId {
    return (
        typeof value === "string" &&
        ACTIVE_AI_RUNTIME_ID_SET.has(value as BuiltInAiRuntimeId)
    );
}

export const isBuiltInAiRuntimeId = isActiveAiRuntimeId;

const CUSTOM_ACP_RUNTIME_ID_PATTERN =
    /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCustomAcpRuntimeId(
    value: unknown,
): value is CustomAcpRuntimeId {
    return (
        typeof value === "string" &&
        CUSTOM_ACP_RUNTIME_ID_PATTERN.test(value)
    );
}

export function isKnownAiRuntimeId(value: unknown): value is AiRuntimeId {
    return isBuiltInAiRuntimeId(value) || isCustomAcpRuntimeId(value);
}

export function createCustomAcpRuntimeId(): CustomAcpRuntimeId {
    const value = `custom:${globalThis.crypto.randomUUID()}`;
    if (!isCustomAcpRuntimeId(value)) {
        throw new Error("The platform generated an invalid custom runtime ID.");
    }
    return value;
}

export interface CustomAcpRuntimeCatalogEntry {
    readonly available?: boolean;
    readonly displayName: string;
    readonly id: CustomAcpRuntimeId;
}

const BUILT_IN_RUNTIME_CAPABILITIES: Readonly<
    Record<BuiltInAiRuntimeId, AiRuntimeDescriptor["capabilities"]>
> = {
    claude: {
        internalAuthentication: true,
        proprietaryActions: true,
        subagents: false,
    },
    codex: {
        internalAuthentication: true,
        proprietaryActions: true,
        subagents: true,
    },
    grok: {
        internalAuthentication: true,
        proprietaryActions: true,
        subagents: false,
    },
    kilo: {
        internalAuthentication: true,
        proprietaryActions: true,
        subagents: false,
    },
    opencode: {
        internalAuthentication: true,
        proprietaryActions: true,
        subagents: false,
    },
};

export const BUILT_IN_AI_RUNTIME_CATALOG: readonly AiRuntimeDescriptor[] =
    ACTIVE_AI_RUNTIME_IDS.map((id) => ({
        available: true,
        capabilities: BUILT_IN_RUNTIME_CAPABILITIES[id],
        displayName: getAiRuntimeDisplayName(id),
        id,
        kind: "built-in",
    }));

export function buildAiRuntimeCatalog(
    customRuntimes: readonly CustomAcpRuntimeCatalogEntry[] = [],
): readonly AiRuntimeDescriptor[] {
    const seenIds = new Set<AiRuntimeId>(ACTIVE_AI_RUNTIME_IDS);
    const customDescriptors: AiRuntimeDescriptor[] = [];
    for (const runtime of customRuntimes) {
        if (!isCustomAcpRuntimeId(runtime.id) || seenIds.has(runtime.id)) {
            continue;
        }
        const displayName = runtime.displayName.trim();
        if (!displayName) {
            continue;
        }
        seenIds.add(runtime.id);
        customDescriptors.push({
            available: runtime.available ?? true,
            capabilities: {
                internalAuthentication: false,
                proprietaryActions: false,
                subagents: false,
            },
            displayName,
            id: runtime.id,
            kind: "custom-acp",
        });
    }

    return [...BUILT_IN_AI_RUNTIME_CATALOG, ...customDescriptors];
}

export function findAiRuntimeDescriptor(
    runtimeId: AiRuntimeId,
    catalog: readonly AiRuntimeDescriptor[],
): AiRuntimeDescriptor | null {
    return catalog.find((runtime) => runtime.id === runtimeId) ?? null;
}

export function resolveAvailableAiRuntimeId(
    runtimeId: AiRuntimeId,
    catalog: readonly AiRuntimeDescriptor[],
): AiRuntimeId {
    const descriptor = findAiRuntimeDescriptor(runtimeId, catalog);
    return descriptor?.available ? descriptor.id : "codex";
}

export function getAiRuntimeDisplayName(
    runtimeId: AiRuntimeId,
    catalog?: readonly AiRuntimeDescriptor[],
): string {
    if (isCustomAcpRuntimeId(runtimeId)) {
        return (
            (catalog
                ? findAiRuntimeDescriptor(runtimeId, catalog)?.displayName
                : null) ??
            "Custom ACP runtime"
        );
    }
    switch (runtimeId) {
        case "claude":
            return "Claude";
        case "grok":
            return "Grok";
        case "kilo":
            return "Kilo";
        case "opencode":
            return "OpenCode";
        case "codex":
            return "Codex";
    }
}
