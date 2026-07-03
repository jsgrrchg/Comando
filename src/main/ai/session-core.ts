import path from "node:path";

import {
    isSameOrInsidePath as isSameOrInsidePathIdentity,
    normalizePathKey,
    toDisplayRelativePath,
    type PathIdentityPlatform,
} from "@shared/path-identity";
import {
    applyModelIdToConfigOptions,
    applyReasoningEffortToConfigOptions,
    isReasoningEffortConfigOption,
} from "@shared/ai-config-options";
import type {
    AiAvailableCommand,
    AiRuntimeId,
    AiSessionConfigOption,
    AiSessionMode,
    AiSessionModel,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiToolActivity,
    SendAiPromptInput,
} from "@shared/ipc";

interface AcpSessionCatalogPayload {
    readonly configOptions?: readonly AiRuntimeCatalogConfigOption[] | null;
    readonly modes?: AiRuntimeModeState | null;
    readonly models?: AiRuntimeModelState | null;
}

type AiRuntimeCatalogConfigOption =
    | {
          readonly category?: string | null;
          readonly currentValue: boolean;
          readonly description?: string | null;
          readonly id: string;
          readonly name: string;
          readonly type: "boolean";
      }
    | {
          readonly category?: string | null;
          readonly currentValue: string;
          readonly description?: string | null;
          readonly id: string;
          readonly name: string;
          readonly options: readonly AiRuntimeCatalogSelectOptionEntry[];
          readonly type: "select";
      };

type AiRuntimeCatalogSelectOptionEntry =
    | AiRuntimeCatalogSelectOption
    | {
          readonly group: true;
          readonly name: string;
          readonly options: readonly AiRuntimeCatalogSelectOption[];
      };

interface AiRuntimeCatalogSelectOption {
    readonly description?: string | null;
    readonly name: string;
    readonly value: string;
}

interface AiRuntimeModeState {
    readonly availableModes?: readonly {
        readonly description?: string | null;
        readonly id: string;
        readonly name: string;
    }[];
    readonly currentModeId?: string | null;
}

interface AiRuntimeModelState {
    readonly availableModels?: readonly {
        readonly description?: string | null;
        readonly modelId: string;
        readonly name: string;
    }[];
    readonly currentModelId?: string | null;
}

export function normalizeRestoredAiSessionSnapshot(
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    const hadRestoredRuntimeState =
        isActiveAiSessionStatus(snapshot.status) ||
        (snapshot.activeTurnStartedAt ?? null) !== null ||
        (snapshot.pendingPermission ?? null) !== null ||
        (snapshot.pendingUserInput ?? null) !== null ||
        snapshot.messages.some((message) => message.status === "streaming") ||
        snapshot.toolActivity.some((activity) =>
            isActiveToolActivityStatus(activity.status),
        );

    if (!hadRestoredRuntimeState) {
        return snapshot;
    }

    return {
        ...snapshot,
        activeTurnStartedAt: null,
        messages: snapshot.messages.map((message) =>
            message.status === "streaming"
                ? { ...message, status: "completed" as const }
                : message,
        ),
        pendingPermission: null,
        pendingUserInput: null,
        status: isActiveAiSessionStatus(snapshot.status) ? "idle" : snapshot.status,
        toolActivity: snapshot.toolActivity.map((activity) =>
            isActiveToolActivityStatus(activity.status)
                ? { ...activity, status: "failed" as const }
                : activity,
        ),
    };
}

function isActiveAiSessionStatus(status: AiSessionSnapshot["status"]): boolean {
    return (
        status === "starting" ||
        status === "streaming" ||
        status === "waiting_permission" ||
        status === "waiting_user_input"
    );
}

function isActiveToolActivityStatus(status: AiToolActivity["status"]): boolean {
    return status === "pending" || status === "in_progress";
}

export function buildAiSessionUpdate(
    previousSnapshot: AiSessionSnapshot | null,
    nextSnapshot: AiSessionSnapshot,
): AiSessionUpdate {
    if (!previousSnapshot) {
        return {
            kind: "snapshot",
            snapshot: nextSnapshot,
        };
    }

    const changes = createAiSessionPatchChanges(previousSnapshot, nextSnapshot);

    if (Object.keys(changes).length === 0) {
        return {
            kind: "snapshot",
            snapshot: nextSnapshot,
        };
    }

    return {
        kind: "patch",
        patch: {
            changes,
            runtimeId: nextSnapshot.runtimeId,
            sessionId: nextSnapshot.sessionId,
        },
    };
}

function createAiSessionPatchChanges(
    previousSnapshot: AiSessionSnapshot,
    nextSnapshot: AiSessionSnapshot,
): Partial<Omit<AiSessionSnapshot, "runtimeId" | "sessionId">> {
    const changes: Record<string, unknown> = {};

    const patchableKeys = [
        "activeTurnStartedAt",
        "availableCommands",
        "closedAt",
        "configOptions",
        "lastError",
        "manualTitle",
        "messages",
        "modeId",
        "modes",
        "modelId",
        "models",
        "pendingPermission",
        "pendingUserInput",
        "plan",
        "parentSessionId",
        "projectId",
        "reasoningEffort",
        "reviewActionLog",
        "runtimeSessionId",
        "status",
        "title",
        "tokenUsage",
        "toolActivity",
        "trackedFiles",
        "updatedAt",
        "worktreeId",
    ] satisfies readonly (keyof Omit<
        AiSessionSnapshot,
        "runtimeId" | "sessionId"
    >)[];

    for (const key of patchableKeys) {
        if (previousSnapshot[key] !== nextSnapshot[key]) {
            changes[key] = nextSnapshot[key];
        }
    }

    return changes;
}

export function getRuntimeDisplayName(runtimeId: AiRuntimeId): string {
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
        default:
            return "Codex";
    }
}

export function applySessionCatalogToSnapshot(
    snapshot: AiSessionSnapshot,
    payload: AcpSessionCatalogPayload,
): AiSessionSnapshot {
    const baseConfigOptions =
        payload.configOptions !== undefined
            ? mapSessionConfigOptions(payload.configOptions)
            : snapshot.configOptions;
    const modes =
        payload.modes !== undefined
            ? mapSessionModes(payload.modes, baseConfigOptions)
            : snapshot.modes.length > 0
              ? snapshot.modes
              : buildModesFromConfigOptions(baseConfigOptions);
    const models =
        payload.models !== undefined
            ? mapSessionModels(payload.models, baseConfigOptions)
            : snapshot.models.length > 0
              ? snapshot.models
              : buildModelsFromConfigOptions(baseConfigOptions);
    const mergedConfigOptions = mergeMissingModelOptions(
        baseConfigOptions,
        models,
    );
    const hasModeCatalog =
        modes.length > 0 || getModeConfigOption(mergedConfigOptions) !== null;
    const hasModelCatalog =
        models.length > 0 || getModelConfigOption(mergedConfigOptions) !== null;
    const modeId =
        payload.modes !== undefined || payload.configOptions !== undefined
            ? hasModeCatalog
                ? deriveModeId(payload.modes, mergedConfigOptions, snapshot.modeId)
                : null
            : snapshot.modeId;
    const modelId =
        payload.models !== undefined || payload.configOptions !== undefined
            ? hasModelCatalog
                ? deriveModelId(
                      payload.models,
                      mergedConfigOptions,
                      snapshot.modelId,
                  )
                : snapshot.modelId
            : snapshot.modelId;
    const configOptions = syncSelectedModelOption(
        mergedConfigOptions,
        modelId,
    );

    return {
        ...snapshot,
        configOptions,
        modeId,
        modes,
        modelId,
        models,
    };
}

export interface NormalizedSessionCatalogPayload {
    readonly availableCommands?: readonly AiAvailableCommand[];
    readonly configOptions?: readonly AiSessionConfigOption[];
    readonly modeId?: string | null;
}

export function applyNormalizedSessionCatalogToSnapshot(
    snapshot: AiSessionSnapshot,
    payload: NormalizedSessionCatalogPayload,
): AiSessionSnapshot {
    const configOptions =
        payload.configOptions !== undefined
            ? preserveConfigOptionSelections(
                  payload.configOptions,
                  snapshot.configOptions,
              )
            : snapshot.configOptions;
    const modes =
        payload.configOptions !== undefined
            ? buildModesFromConfigOptions(configOptions)
            : snapshot.modes;
    const models =
        payload.configOptions !== undefined
            ? buildModelsFromConfigOptions(configOptions)
            : snapshot.models;
    const hasModeCatalog =
        modes.length > 0 || getModeConfigOption(configOptions) !== null;
    const hasModelCatalog =
        models.length > 0 || getModelConfigOption(configOptions) !== null;
    const modeId =
        payload.modeId !== undefined
            ? payload.modeId
            : payload.configOptions !== undefined
              ? hasModeCatalog
                  ? deriveModeId(null, configOptions, snapshot.modeId)
                  : null
              : snapshot.modeId;
    const modelId =
        payload.configOptions !== undefined
            ? hasModelCatalog
                ? deriveModelId(null, configOptions, snapshot.modelId)
                : configOptions.length === 0
                  ? null
                  : snapshot.modelId
            : snapshot.modelId;

    return {
        ...snapshot,
        ...(payload.availableCommands !== undefined
            ? { availableCommands: payload.availableCommands }
            : {}),
        configOptions: applyReasoningEffortToConfigOptions(
            syncSelectedModelOption(
                syncSelectedModeOption(configOptions, modeId),
                modelId,
            ),
            snapshot.reasoningEffort ?? null,
        ),
        modeId,
        modes,
        modelId,
        models,
    };
}

function mapSessionModes(
    state: AiRuntimeModeState | null | undefined,
    configOptions: readonly AiSessionConfigOption[],
): readonly AiSessionMode[] {
    const availableModes = state?.availableModes ?? [];
    if (availableModes.length > 0) {
        return availableModes.map((mode) => ({
            description: mode.description ?? null,
            id: mode.id,
            name: mode.name,
        }));
    }

    return buildModesFromConfigOptions(configOptions);
}

function mapSessionModels(
    state: AiRuntimeModelState | null | undefined,
    configOptions: readonly AiSessionConfigOption[],
): readonly AiSessionModel[] {
    const availableModels = state?.availableModels ?? [];
    if (availableModels.length > 0) {
        return availableModels.map((model) => ({
            description: model.description ?? null,
            id: model.modelId,
            name: model.name,
        }));
    }

    return buildModelsFromConfigOptions(configOptions);
}

function mapSessionConfigOptions(
    options: readonly AiRuntimeCatalogConfigOption[] | null | undefined,
): readonly AiSessionConfigOption[] {
    if (!options?.length) {
        return [];
    }

    return options.map((option) =>
        option.type === "boolean"
            ? {
                  category: mapConfigOptionCategory(option.category),
                  description: option.description ?? null,
                  id: option.id,
                  label: option.name,
                  type: "boolean",
                  value: option.currentValue,
              }
            : {
                  category: mapConfigOptionCategory(option.category),
                  description: option.description ?? null,
                  id: option.id,
                  label: option.name,
                  options: mapSessionSelectOptions(option),
                  type: "select",
                  value: option.currentValue,
              },
    );
}

function mapSessionSelectOptions(
    option: Extract<AiRuntimeCatalogConfigOption, { type: "select" }>,
): readonly {
    description: string | null;
    groupLabel: string | null;
    label: string;
    value: string;
}[] {
    const items: {
        description: string | null;
        groupLabel: string | null;
        label: string;
        value: string;
    }[] = [];

    for (const entry of option.options) {
        if ("group" in entry) {
            for (const childOption of entry.options) {
                items.push({
                    description: childOption.description ?? null,
                    groupLabel: entry.name,
                    label: childOption.name,
                    value: childOption.value,
                });
            }
            continue;
        }

        items.push({
            description: entry.description ?? null,
            groupLabel: null,
            label: entry.name,
            value: entry.value,
        });
    }

    return items;
}

function mapConfigOptionCategory(
    category: string | null | undefined,
): AiSessionConfigOption["category"] {
    if (category === "mode" || category === "model") {
        return category;
    }

    if (category === "thought_level" || category === "effort") {
        return "reasoning";
    }

    return "other";
}

function deriveModeId(
    state: AiRuntimeModeState | null | undefined,
    configOptions: readonly AiSessionConfigOption[],
    fallback: string | null,
): string | null {
    const modeConfig = getModeConfigOption(configOptions);
    if (modeConfig?.type === "select" && modeConfig.value.trim()) {
        return modeConfig.value;
    }

    const currentModeId =
        state && typeof state.currentModeId === "string"
            ? state.currentModeId.trim()
            : "";
    if (currentModeId) {
        return currentModeId;
    }

    return fallback;
}

function deriveModelId(
    state: AiRuntimeModelState | null | undefined,
    configOptions: readonly AiSessionConfigOption[],
    fallback: string | null,
): string | null {
    if (
        state &&
        typeof state.currentModelId === "string" &&
        state.currentModelId.trim() &&
        !state.currentModelId.includes("/")
    ) {
        return state.currentModelId.trim();
    }

    const modelConfig = getModelConfigOption(configOptions);
    if (modelConfig?.type === "select" && modelConfig.value.trim()) {
        return modelConfig.value;
    }

    return fallback;
}

function buildModesFromConfigOptions(
    configOptions: readonly AiSessionConfigOption[],
): readonly AiSessionMode[] {
    const modeConfig = getModeConfigOption(configOptions);
    if (!modeConfig || modeConfig.type !== "select") {
        return [];
    }

    return modeConfig.options.map((option) => ({
        description: option.description,
        id: option.value,
        name: option.label,
    }));
}

function buildModelsFromConfigOptions(
    configOptions: readonly AiSessionConfigOption[],
): readonly AiSessionModel[] {
    const modelConfig = getModelConfigOption(configOptions);
    if (!modeConfigOrModelConfigExists(modelConfig)) {
        return [];
    }

    return modelConfig.options.map((option) => ({
        description: option.description,
        id: option.value,
        name: option.label,
    }));
}

function mergeMissingModelOptions(
    configOptions: readonly AiSessionConfigOption[],
    models: readonly AiSessionModel[],
): readonly AiSessionConfigOption[] {
    const modelConfig = getModelConfigOption(configOptions);
    if (!modeConfigOrModelConfigExists(modelConfig) || models.length === 0) {
        return configOptions;
    }

    const knownValues = new Set(modelConfig.options.map((option) => option.value));
    const missingOptions = models.flatMap((model) =>
        knownValues.has(model.id) || model.id.includes("/")
            ? []
            : [
                  {
                      description: model.description,
                      groupLabel: null,
                      label: model.name,
                      value: model.id,
                  },
              ],
    );

    if (missingOptions.length === 0) {
        return configOptions;
    }

    return configOptions.map((option) =>
        option === modelConfig
            ? {
                  ...option,
                  options: [...option.options, ...missingOptions],
              }
            : option,
    );
}

function syncSelectedModelOption(
    configOptions: readonly AiSessionConfigOption[],
    modelId: string | null,
): readonly AiSessionConfigOption[] {
    if (!modelId?.trim()) {
        return configOptions;
    }

    const modelConfig = getModelConfigOption(configOptions);
    if (
        !modeConfigOrModelConfigExists(modelConfig) ||
        !hasSelectConfigValue(modelConfig, modelId) ||
        modelConfig.value === modelId
    ) {
        return configOptions;
    }

    return configOptions.map((option) =>
        option === modelConfig
            ? {
                  ...option,
                  value: modelId,
              }
            : option,
    );
}

function preserveConfigOptionSelections(
    incomingOptions: readonly AiSessionConfigOption[],
    existingOptions: readonly AiSessionConfigOption[],
): readonly AiSessionConfigOption[] {
    if (incomingOptions.length === 0 || existingOptions.length === 0) {
        return incomingOptions;
    }

    const existingById = new Map(
        existingOptions.map((option) => [option.id, option]),
    );

    return incomingOptions.map((option) => {
        const existing = existingById.get(option.id);
        if (!existing || existing.type !== option.type) {
            return option;
        }

        if (option.type === "boolean" && existing.type === "boolean") {
            return {
                ...option,
                value: existing.value,
            };
        }

        if (
            option.type === "select" &&
            existing.type === "select" &&
            hasSelectConfigValue(option, existing.value)
        ) {
            return {
                ...option,
                value: existing.value,
            };
        }

        return option;
    });
}

function syncSelectedModeOption(
    configOptions: readonly AiSessionConfigOption[],
    modeId: string | null,
): readonly AiSessionConfigOption[] {
    if (!modeId?.trim()) {
        return configOptions;
    }

    const modeConfig = getModeConfigOption(configOptions);
    if (
        !modeConfigOrModelConfigExists(modeConfig) ||
        !hasSelectConfigValue(modeConfig, modeId) ||
        modeConfig.value === modeId
    ) {
        return configOptions;
    }

    return configOptions.map((option) =>
        option === modeConfig
            ? {
                  ...option,
                  value: modeId,
              }
            : option,
    );
}

function modeConfigOrModelConfigExists(
    option: AiSessionConfigOption | null,
): option is Extract<AiSessionConfigOption, { type: "select" }> {
    return option !== null && option.type === "select";
}

export function getModeConfigOption(
    configOptions: readonly AiSessionConfigOption[],
): AiSessionConfigOption | null {
    return (
        configOptions.find(
            (option) =>
                option.category === "mode" ||
                option.id.toLowerCase() === "mode",
        ) ?? null
    );
}

export function getModelConfigOption(
    configOptions: readonly AiSessionConfigOption[],
): AiSessionConfigOption | null {
    return (
        configOptions.find(
            (option) =>
                option.category === "model" ||
                option.id.toLowerCase() === "model",
        ) ?? null
    );
}

export function hasSelectConfigValue(
    option: AiSessionConfigOption,
    value: string,
): boolean {
    return (
        option.type === "select" &&
        option.options.some((candidate) => candidate.value === value)
    );
}

export function setModeOnSnapshot(
    snapshot: AiSessionSnapshot,
    modeId: string,
    updatedAt: string = new Date().toISOString(),
): AiSessionSnapshot {
    return {
        ...snapshot,
        configOptions: snapshot.configOptions.map((option) =>
            option.type === "select" &&
            (option.category === "mode" ||
                option.id.toLowerCase() === "mode") &&
            hasSelectConfigValue(option, modeId)
                ? {
                      ...option,
                      value: modeId,
                  }
                : option,
        ),
        modeId,
        updatedAt,
    };
}

export function setModelOnSnapshot(
    snapshot: AiSessionSnapshot,
    modelId: string,
    updatedAt: string = new Date().toISOString(),
): AiSessionSnapshot {
    return {
        ...snapshot,
        configOptions: applyModelIdToConfigOptions(
            snapshot.configOptions,
            modelId,
        ),
        modelId,
        updatedAt,
    };
}

export function setReasoningEffortOnSnapshot(
    snapshot: AiSessionSnapshot,
    reasoningEffort: string,
    updatedAt: string = new Date().toISOString(),
): AiSessionSnapshot {
    return {
        ...snapshot,
        configOptions: applyReasoningEffortToConfigOptions(
            snapshot.configOptions,
            reasoningEffort,
        ),
        reasoningEffort,
        updatedAt,
    };
}

export function setTitleOnSnapshot(
    snapshot: AiSessionSnapshot,
    title: string,
    updatedAt: string = new Date().toISOString(),
): AiSessionSnapshot {
    return {
        ...snapshot,
        title,
        updatedAt,
    };
}

export function getSessionDisplayTitle(snapshot: AiSessionSnapshot): string {
    const manualTitle = snapshot.manualTitle?.trim();
    return manualTitle || snapshot.title;
}

export function setManualTitleOnSnapshot(
    snapshot: AiSessionSnapshot,
    title: string,
    updatedAt: string = new Date().toISOString(),
): AiSessionSnapshot {
    const manualTitle = title.trim();
    return {
        ...snapshot,
        manualTitle: manualTitle || null,
        title: manualTitle || snapshot.title,
        updatedAt,
    };
}

export function setRuntimeTitleOnSnapshot(
    snapshot: AiSessionSnapshot,
    title: string,
    updatedAt: string = new Date().toISOString(),
): AiSessionSnapshot {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
        return snapshot;
    }
    if (snapshot.manualTitle?.trim()) {
        return {
            ...snapshot,
            updatedAt,
        };
    }
    return {
        ...snapshot,
        title: trimmedTitle,
        updatedAt,
    };
}

export function setConfigOptionOnSnapshot(
    snapshot: AiSessionSnapshot,
    optionId: string,
    value: boolean | string,
    updatedAt: string = new Date().toISOString(),
): AiSessionSnapshot {
    const previousOption =
        snapshot.configOptions.find((option) => option.id === optionId) ?? null;
    const nextConfigOptions = snapshot.configOptions.map((option) =>
        option.id !== optionId
            ? option
            : option.type === "boolean" && typeof value === "boolean"
              ? {
                    ...option,
                    value,
                }
              : option.type === "select" &&
                  typeof value === "string" &&
                  hasSelectConfigValue(option, value)
                ? {
                      ...option,
                      value,
                  }
                : option,
    );
    const updatedOption =
        nextConfigOptions.find((option) => option.id === optionId) ?? null;
    const hasUpdatedOptionValue =
        updatedOption !== null &&
        previousOption !== null &&
        updatedOption.value !== previousOption.value;

    return {
        ...snapshot,
        configOptions: nextConfigOptions,
        modeId:
            updatedOption?.type === "select" &&
            (updatedOption.category === "mode" ||
                updatedOption.id.toLowerCase() === "mode") &&
            typeof value === "string"
                ? value
                : snapshot.modeId,
        modelId:
            updatedOption?.type === "select" &&
            (updatedOption.category === "model" ||
                updatedOption.id.toLowerCase() === "model") &&
            typeof value === "string"
                ? value
                : snapshot.modelId,
        reasoningEffort:
            hasUpdatedOptionValue &&
            updatedOption.type === "select" &&
            isReasoningEffortConfigOption(updatedOption) &&
            typeof value === "string"
                ? value
                : snapshot.reasoningEffort,
        updatedAt,
    };
}

const PILL_OPEN = "\u200B\u00AB";
const PILL_CLOSE = "\u00BB\u200B";

export function serializeComposerPartsForDisplay(
    parts: SendAiPromptInput["composerParts"] | undefined,
    fallback: string,
): string {
    if (!parts || parts.length === 0) {
        return fallback;
    }

    return parts
        .map((part) => {
            switch (part.type) {
                case "text":
                    return part.text;
                case "file_mention":
                    return `${PILL_OPEN}@${part.label}${PILL_CLOSE}`;
                case "folder_mention":
                    return `${PILL_OPEN}@${part.label}${PILL_CLOSE}`;
                case "fetch_mention":
                    return `${PILL_OPEN}@fetch${PILL_CLOSE}`;
                case "plan_mention":
                    return `${PILL_OPEN}/plan${PILL_CLOSE}`;
                case "selection_mention":
                    return `${PILL_OPEN}${part.label}${PILL_CLOSE}`;
                case "file_attachment":
                    return `${PILL_OPEN}📎${part.label}${PILL_CLOSE}`;
                case "git_commit_mention":
                    return `${PILL_OPEN}commit: ${part.label}${PILL_CLOSE}`;
                case "github_issue_mention":
                    return `${PILL_OPEN}${part.label}${PILL_CLOSE}`;
                case "github_pull_request_mention":
                    return `${PILL_OPEN}${part.label}${PILL_CLOSE}`;
                default:
                    return "";
            }
        })
        .join("")
        .trim();
}

export function normalizeAdditionalRoots(
    roots: readonly string[] | undefined,
    options: ResolveSessionPathOptions = {},
): string[] {
    if (!roots || roots.length === 0) {
        return [];
    }

    const seen = new Set<string>();
    const normalizedRoots: string[] = [];
    const platform = options.platform ?? getNativePathIdentityPlatform();

    for (const rootPath of roots) {
        if (!rootPath.trim()) {
            continue;
        }

        const normalized = resolvePathForPlatform(rootPath, platform);
        const normalizedKey = normalizePathKey(normalized, { platform });
        if (seen.has(normalizedKey)) {
            continue;
        }

        seen.add(normalizedKey);
        normalizedRoots.push(normalized);
    }

    normalizedRoots.sort((left, right) => left.localeCompare(right));
    return normalizedRoots;
}

export function isPathInsideRoot(
    candidatePath: string,
    rootPath: string,
    options: ResolveSessionPathOptions = {},
): boolean {
    const platform = getPathIdentityPlatform(rootPath, candidatePath, options);
    const resolvedCandidate = resolvePathForPlatform(candidatePath, platform);
    const resolvedRoot = resolvePathForPlatform(rootPath, platform);

    return isSameOrInsidePathIdentity(resolvedCandidate, resolvedRoot, {
        platform,
    });
}

export function isSamePath(
    leftPath: string,
    rightPath: string,
    options: ResolveSessionPathOptions = {},
): boolean {
    const platform = getPathIdentityPlatform(leftPath, rightPath, options);
    return (
        normalizePathKey(resolvePathForPlatform(leftPath, platform), {
            platform,
        }) ===
        normalizePathKey(resolvePathForPlatform(rightPath, platform), {
            platform,
        })
    );
}

export interface ResolveSessionPathOptions {
    readonly platform?: PathIdentityPlatform;
}

export interface ResolvedSessionScopedPath {
    readonly absolutePath: string;
    readonly insideRoot: boolean;
    readonly isAbsoluteInput: boolean;
    readonly platform: PathIdentityPlatform;
    readonly relativePath: string | null;
}

export function resolveSessionScopedPath(
    scopeRoot: string,
    candidatePath: string,
    options: ResolveSessionPathOptions = {},
): ResolvedSessionScopedPath {
    const platform = getPathIdentityPlatform(scopeRoot, candidatePath, options);
    const absolutePath = resolvePathForPlatform(
        candidatePath,
        platform,
        scopeRoot,
    );
    const resolvedScopeRoot = resolvePathForPlatform(scopeRoot, platform);
    const insideRoot = isSameOrInsidePathIdentity(
        absolutePath,
        resolvedScopeRoot,
        { platform },
    );

    return {
        absolutePath,
        insideRoot,
        isAbsoluteInput: getPathApi(platform).isAbsolute(candidatePath),
        platform,
        relativePath: insideRoot
            ? toDisplayRelativePath(absolutePath, resolvedScopeRoot, {
                  platform,
              })
            : null,
    };
}

export function basenameForPathIdentity(
    candidatePath: string,
    options: ResolveSessionPathOptions = {},
): string {
    return getPathApi(options.platform ?? getNativePathIdentityPlatform()).basename(
        candidatePath,
    );
}

export function toPosixPath(candidatePath: string): string {
    return candidatePath.split(path.sep).join("/");
}

function resolvePathForPlatform(
    candidatePath: string,
    platform: PathIdentityPlatform,
    basePath?: string,
): string {
    const pathApi = getPathApi(platform);
    return basePath && !pathApi.isAbsolute(candidatePath)
        ? pathApi.resolve(basePath, candidatePath)
        : pathApi.resolve(candidatePath);
}

function getPathApi(platform: PathIdentityPlatform): typeof path.posix {
    return platform === "win32" ? path.win32 : path.posix;
}

function getPathIdentityPlatform(
    leftPath: string,
    rightPath: string,
    options: ResolveSessionPathOptions,
): PathIdentityPlatform {
    if (options.platform) {
        return options.platform;
    }

    if (isPosixAbsolutePath(leftPath) && isPosixAbsolutePath(rightPath)) {
        return "posix";
    }

    return getNativePathIdentityPlatform();
}

function getNativePathIdentityPlatform(): PathIdentityPlatform {
    return process.platform === "win32" ? "win32" : "posix";
}

function isPosixAbsolutePath(candidatePath: string): boolean {
    return candidatePath.startsWith("/") && !candidatePath.startsWith("//");
}
