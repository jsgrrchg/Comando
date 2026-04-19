import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
    ContentBlock,
    SessionConfigOption,
    SessionModeState,
    SessionModelState,
} from "@agentclientprotocol/sdk";
import type {
    AiImageAttachment,
    AiRuntimeId,
    AiSessionConfigOption,
    AiSessionMode,
    AiSessionModel,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiUserInputRequest,
    AiUserInputResponseInput,
    SendAiPromptInput,
} from "@shared/ipc";
import {
    inferChatTitleFromPrompt,
    isDefaultChatTitle,
} from "@shared/chatTitle";

import {
    CODEX_ACP_USER_INPUT_RESPONSE_PREFIX,
    type AcpSessionCatalogPayload,
} from "./contracts";

export function shouldFlushLiveSessionImmediately(
    snapshot: AiSessionSnapshot,
): boolean {
    return (
        snapshot.status !== "streaming" ||
        snapshot.pendingPermission !== null ||
        snapshot.pendingUserInput !== null ||
        snapshot.lastError !== null
    );
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
        "availableCommands",
        "configOptions",
        "lastError",
        "messages",
        "modeId",
        "modes",
        "modelId",
        "models",
        "pendingPermission",
        "pendingUserInput",
        "plan",
        "projectId",
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

    return changes as Partial<
        Omit<AiSessionSnapshot, "runtimeId" | "sessionId">
    >;
}

export function getRuntimeDisplayName(runtimeId: AiRuntimeId): string {
    switch (runtimeId) {
        case "claude":
            return "Claude";
        case "gemini":
            return "Gemini";
        case "kilo":
            return "Kilo";
        case "codex":
        default:
            return "Codex";
    }
}

export function applySessionCatalogToSnapshot(
    snapshot: AiSessionSnapshot,
    payload: AcpSessionCatalogPayload,
): AiSessionSnapshot {
    const configOptions =
        payload.configOptions !== undefined
            ? mapSessionConfigOptions(payload.configOptions)
            : snapshot.configOptions;
    const modes =
        payload.modes !== undefined
            ? mapSessionModes(payload.modes, configOptions)
            : snapshot.modes.length > 0
              ? snapshot.modes
              : buildModesFromConfigOptions(configOptions);
    const models =
        payload.models !== undefined
            ? mapSessionModels(payload.models, configOptions)
            : snapshot.models.length > 0
              ? snapshot.models
              : buildModelsFromConfigOptions(configOptions);
    const modeId =
        payload.modes !== undefined || payload.configOptions !== undefined
            ? deriveModeId(payload.modes, configOptions, snapshot.modeId)
            : snapshot.modeId;
    const modelId =
        payload.models !== undefined || payload.configOptions !== undefined
            ? deriveModelId(payload.models, configOptions, snapshot.modelId)
            : snapshot.modelId;

    return {
        ...snapshot,
        configOptions,
        modeId,
        modes,
        modelId,
        models,
    };
}

function mapSessionModes(
    state: SessionModeState | null | undefined,
    configOptions: readonly AiSessionConfigOption[],
): readonly AiSessionMode[] {
    if (state?.availableModes?.length) {
        return state.availableModes.map((mode) => ({
            description: mode.description ?? null,
            id: mode.id,
            name: mode.name,
        }));
    }

    return buildModesFromConfigOptions(configOptions);
}

function mapSessionModels(
    state: SessionModelState | null | undefined,
    configOptions: readonly AiSessionConfigOption[],
): readonly AiSessionModel[] {
    if (state?.availableModels?.length) {
        return state.availableModels.map((model) => ({
            description: model.description ?? null,
            id: model.modelId,
            name: model.name,
        }));
    }

    return buildModelsFromConfigOptions(configOptions);
}

function mapSessionConfigOptions(
    options: readonly SessionConfigOption[] | null | undefined,
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
    option: Extract<SessionConfigOption, { type: "select" }>,
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

    if (category === "thought_level") {
        return "reasoning";
    }

    return "other";
}

function deriveModeId(
    state: SessionModeState | null | undefined,
    configOptions: readonly AiSessionConfigOption[],
    fallback: string | null,
): string | null {
    const modeConfig = getModeConfigOption(configOptions);
    if (modeConfig?.type === "select" && modeConfig.value.trim()) {
        return modeConfig.value;
    }

    if (state?.currentModeId?.trim()) {
        return state.currentModeId;
    }

    return fallback;
}

function deriveModelId(
    state: SessionModelState | null | undefined,
    configOptions: readonly AiSessionConfigOption[],
    fallback: string | null,
): string | null {
    const modelConfig = getModelConfigOption(configOptions);
    if (modelConfig?.type === "select" && modelConfig.value.trim()) {
        return modelConfig.value;
    }

    if (state?.currentModelId?.trim()) {
        return state.currentModelId;
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
        configOptions: snapshot.configOptions.map((option) =>
            option.type === "select" &&
            (option.category === "model" ||
                option.id.toLowerCase() === "model") &&
            hasSelectConfigValue(option, modelId)
                ? {
                      ...option,
                      value: modelId,
                  }
                : option,
        ),
        modelId,
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

export function resolveSessionTitleOnPrompt(params: {
    readonly currentTitle: string;
    readonly fallbackTitle: string;
    readonly displayContent: string;
    readonly hasPriorUserMessage: boolean;
}): string {
    const { currentTitle, fallbackTitle, displayContent, hasPriorUserMessage } =
        params;
    if (currentTitle && !isDefaultChatTitle(currentTitle)) {
        return currentTitle;
    }
    if (!hasPriorUserMessage) {
        const inferred = inferChatTitleFromPrompt(displayContent);
        if (inferred) {
            return inferred;
        }
    }
    return fallbackTitle || currentTitle;
}

export function setConfigOptionOnSnapshot(
    snapshot: AiSessionSnapshot,
    optionId: string,
    value: boolean | string,
    updatedAt: string = new Date().toISOString(),
): AiSessionSnapshot {
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

    return {
        ...snapshot,
        configOptions: nextConfigOptions,
        modeId:
            updatedOption?.type === "select" &&
            updatedOption.category === "mode" &&
            typeof value === "string"
                ? value
                : snapshot.modeId,
        modelId:
            updatedOption?.type === "select" &&
            updatedOption.category === "model" &&
            typeof value === "string"
                ? value
                : snapshot.modelId,
        updatedAt,
    };
}

function appendChunkToSnapshot(
    snapshot: AiSessionSnapshot,
    kind: "assistant" | "thinking",
    content: string,
    messageId: string | null,
): AiSessionSnapshot {
    const messages = [...snapshot.messages];
    const lastMessage = messages.at(-1);

    if (
        lastMessage &&
        lastMessage.kind === kind &&
        lastMessage.status === "streaming" &&
        (!messageId || lastMessage.id === messageId)
    ) {
        messages[messages.length - 1] = {
            ...lastMessage,
            content: `${lastMessage.content}${content}`,
        };

        return {
            ...snapshot,
            messages,
        };
    }

    return {
        ...snapshot,
        messages: [
            ...finalizeStreamingMessages(snapshot).messages,
            {
                attachments: [],
                content,
                createdAt: new Date().toISOString(),
                id: messageId ?? randomUUID(),
                kind,
                status: "streaming",
            },
        ],
    };
}

export function appendContentBlockToSnapshot(
    snapshot: AiSessionSnapshot,
    kind: "assistant" | "thinking",
    content: ContentBlock,
    messageId: string | null,
): AiSessionSnapshot {
    if (content.type === "image") {
        return appendAttachmentToSnapshot(
            snapshot,
            kind,
            imageContentToAttachment(content, messageId),
            messageId,
        );
    }

    return appendChunkToSnapshot(
        snapshot,
        kind,
        formatContentBlock(content),
        messageId,
    );
}

function appendAttachmentToSnapshot(
    snapshot: AiSessionSnapshot,
    kind: "assistant" | "thinking",
    attachment: AiImageAttachment,
    messageId: string | null,
): AiSessionSnapshot {
    const messages = [...snapshot.messages];
    const lastMessage = messages.at(-1);

    if (
        lastMessage &&
        lastMessage.kind === kind &&
        lastMessage.status === "streaming" &&
        (!messageId || lastMessage.id === messageId)
    ) {
        messages[messages.length - 1] = {
            ...lastMessage,
            attachments: [...lastMessage.attachments, attachment],
        };

        return {
            ...snapshot,
            messages,
        };
    }

    return {
        ...snapshot,
        messages: [
            ...finalizeStreamingMessages(snapshot).messages,
            {
                attachments: [attachment],
                content: "",
                createdAt: new Date().toISOString(),
                id: messageId ?? randomUUID(),
                kind,
                status: "streaming",
            },
        ],
    };
}

export function finalizeStreamingMessages(
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    return {
        ...snapshot,
        messages: snapshot.messages.map((message) =>
            message.status === "streaming"
                ? {
                      ...message,
                      status: "completed",
                  }
                : message,
        ),
    };
}

export function buildUserInputResponsePrompt(
    turnId: string | null,
    answers: AiUserInputResponseInput["answers"],
): string {
    const payload = {
        response: {
            answers: Object.fromEntries(
                answers.map((answer) => [
                    answer.questionId,
                    {
                        answers: [...answer.answers],
                    },
                ]),
            ),
        },
        turn_id: turnId ?? "",
    };

    return `${CODEX_ACP_USER_INPUT_RESPONSE_PREFIX}${JSON.stringify(payload)}`;
}

export function summarizeUserInputAnswers(
    questions: readonly AiUserInputRequest["questions"][number][],
    answers: AiUserInputResponseInput["answers"],
): string {
    if (answers.length === 0) {
        return "Responded to guided input.";
    }

    return answers
        .map((answer) => {
            const question = questions.find(
                (candidate) => candidate.id === answer.questionId,
            );
            const label =
                question?.header || question?.question || answer.questionId;
            return `${label}: ${answer.answers.join(", ")}`;
        })
        .join("\n");
}

function formatContentBlock(content: ContentBlock): string {
    if (content.type === "text") {
        return content.text;
    }

    if (content.type === "image") {
        return content.uri ?? "";
    }

    if (content.type === "resource_link") {
        return content.uri;
    }

    return `[${content.type}]`;
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
                default:
                    return "";
            }
        })
        .join("")
        .trim();
}

function imageContentToAttachment(
    content: Extract<ContentBlock, { type: "image" }>,
    messageId: string | null,
): AiImageAttachment {
    return {
        dataBase64: content.data,
        id: messageId ? `${messageId}:image:${randomUUID()}` : randomUUID(),
        mimeType: content.mimeType,
        name: null,
        sizeBytes: estimateBase64Size(content.data),
    };
}

export function buildPromptContentBlocks(
    promptText: string,
    attachments: readonly AiImageAttachment[],
): ContentBlock[] {
    const prompt: ContentBlock[] = [];

    if (promptText) {
        prompt.push({
            text: promptText,
            type: "text",
        });
    }

    for (const attachment of attachments) {
        prompt.push({
            data: attachment.dataBase64,
            mimeType: attachment.mimeType,
            type: "image",
        });
    }

    return prompt;
}

function estimateBase64Size(dataBase64: string): number {
    const padding = dataBase64.endsWith("==")
        ? 2
        : dataBase64.endsWith("=")
          ? 1
          : 0;

    return Math.max(0, Math.floor((dataBase64.length * 3) / 4) - padding);
}

export function getPreparedSessionStatus(
    snapshot: Pick<
        AiSessionSnapshot,
        "lastError" | "pendingPermission" | "pendingUserInput"
    >,
): AiSessionSnapshot["status"] {
    if (snapshot.pendingPermission) {
        return "waiting_permission";
    }
    if (snapshot.pendingUserInput) {
        return "waiting_user_input";
    }
    if (snapshot.lastError) {
        return "error";
    }
    return "idle";
}

export function getRecentStderrText(stderrChunks: readonly string[]): string {
    const normalized = stripAnsiControlSequences(stderrChunks.join(""))
        .trim()
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);

    if (normalized.length === 0) {
        return "";
    }

    return normalized.slice(-4).join("\n");
}

const ANSI_ESCAPE_RE = new RegExp(
    `${String.fromCharCode(27)}\\[[0-9;]*m`,
    "g",
);

function stripAnsiControlSequences(value: string): string {
    return value.replace(ANSI_ESCAPE_RE, "");
}

export function isBusyAiSessionStatus(
    status: AiSessionSnapshot["status"],
): boolean {
    return (
        status === "starting" ||
        status === "streaming" ||
        status === "waiting_permission" ||
        status === "waiting_user_input"
    );
}

export function normalizeAdditionalRoots(
    roots: readonly string[] | undefined,
): string[] {
    if (!roots || roots.length === 0) {
        return [];
    }

    const seen = new Set<string>();
    const normalizedRoots: string[] = [];

    for (const rootPath of roots) {
        if (!rootPath?.trim()) {
            continue;
        }

        const normalized = path.resolve(rootPath);
        if (seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        normalizedRoots.push(normalized);
    }

    normalizedRoots.sort((left, right) => left.localeCompare(right));
    return normalizedRoots;
}

export function sameAdditionalRoots(
    left: readonly string[],
    right: readonly string[],
): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((entry, index) => entry === right[index]);
}

export function isPathInsideRoot(
    candidatePath: string,
    rootPath: string,
): boolean {
    const resolvedCandidate = path.resolve(candidatePath);
    const resolvedRoot = path.resolve(rootPath);

    return (
        resolvedCandidate === resolvedRoot ||
        resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
    );
}

export function toPosixPath(candidatePath: string): string {
    return candidatePath.split(path.sep).join("/");
}
