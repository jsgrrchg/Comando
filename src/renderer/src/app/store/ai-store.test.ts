import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiFileContextAttachment,
    AiImageAttachment,
    AiSessionSnapshot,
    WorkspaceChatTab,
} from "@shared/ipc";

import { DEFAULT_AI_DIFF_ZOOM } from "@renderer/app/ai/sessionReviewContracts";
import { useAiStore } from "./ai-store";

const TAB: WorkspaceChatTab = {
    createdAt: "2026-04-14T00:00:00.000Z",
    draft: "",
    id: "tab-1",
    kind: "chat",
    projectId: "project-1",
    runtimeId: "codex",
    sessionId: "session-1",
    title: "Chat",
    worktreeId: null,
};

function createSnapshot(
    overrides: Partial<AiSessionSnapshot> = {},
): AiSessionSnapshot {
    return {
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: TAB.projectId,
        runtimeId: TAB.runtimeId,
        runtimeSessionId: "runtime-session-1",
        sessionId: TAB.sessionId,
        status: "idle",
        title: TAB.title,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-14T00:00:00.000Z",
        worktreeId: TAB.worktreeId ?? null,
        ...overrides,
    };
}

function createImageAttachment(
    overrides: Partial<AiImageAttachment> = {},
): AiImageAttachment {
    return {
        dataBase64: "ZmFrZQ==",
        id: "img-1",
        mimeType: "image/png",
        name: "mock.png",
        sizeBytes: 128,
        ...overrides,
    };
}

function createFileContext(
    overrides: Partial<AiFileContextAttachment> = {},
): AiFileContextAttachment {
    return {
        extension: "ts",
        id: "ctx-1",
        languageId: "typescript",
        name: "app.ts",
        projectId: TAB.projectId ?? "project-1",
        relativePath: "src/app.ts",
        ...overrides,
    };
}

describe("ai-store queue", () => {
    beforeEach(() => {
        useAiStore.setState((state) => ({
            ...state,
            runtimeStatusById: {},
            sessions: {},
        }));
        vi.restoreAllMocks();
    });

    it("reencola el prompt cuando el main todavía reporta la sesión como ocupada", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(new Error("La sesión todavía está ocupada."))
            .mockResolvedValueOnce(undefined);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        await useAiStore.getState().sendPrompt(TAB, "hola");

        const deferredSession = useAiStore.getState().sessions[TAB.sessionId];
        expect(sendAiPrompt).toHaveBeenCalledTimes(1);
        expect(deferredSession?.localError).toBeNull();
        expect(deferredSession?.queue).toHaveLength(1);
        expect(deferredSession?.queue[0]?.prompt).toBe("hola");
        expect(deferredSession?.queue[0]?.status).toBe("queued");
        expect(deferredSession?.snapshot?.status).toBe("starting");

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        await vi.waitFor(() => {
            const drainedSession =
                useAiStore.getState().sessions[TAB.sessionId];
            expect(drainedSession?.queue).toHaveLength(0);
            expect(drainedSession?.localError).toBeNull();
        });
    });

    it("guarda snapshots completos del composer en la cola y permite restaurarlos", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(
                new Error("La sesión todavía está ocupada."),
            );

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        const attachment = createImageAttachment();
        const fileContext = createFileContext();

        await useAiStore.getState().sendPrompt(TAB, "hola", {
            attachments: [attachment],
            composerPartsSnapshot: [
                { text: "hola ", type: "text" },
                {
                    label: "app.ts",
                    languageId: "typescript",
                    path: "/tmp/project/src/app.ts",
                    relativePath: "src/app.ts",
                    type: "file_mention",
                },
            ],
            fileContextsSnapshot: [fileContext],
        });

        const queuedPrompt =
            useAiStore.getState().sessions[TAB.sessionId]?.queue[0];
        expect(queuedPrompt?.attachments).toEqual([attachment]);
        expect(queuedPrompt?.composerPartsSnapshot).toHaveLength(2);
        expect(queuedPrompt?.fileContextsSnapshot).toEqual([fileContext]);

        const restoredParts = useAiStore
            .getState()
            .editQueuedPrompt(TAB.sessionId, queuedPrompt?.id ?? "");

        const restoredSession = useAiStore.getState().sessions[TAB.sessionId];
        expect(restoredParts).toEqual(queuedPrompt?.composerPartsSnapshot);
        expect(restoredSession?.draftAttachments).toEqual([attachment]);
        expect(restoredSession?.draftFileContexts).toEqual([fileContext]);
        expect(restoredSession?.queue).toHaveLength(0);
    });

    it("marca queued prompts como failed cuando el dispatch automático falla", async () => {
        const sendAiPrompt = vi
            .fn()
            .mockRejectedValueOnce(new Error("La sesión todavía está ocupada."))
            .mockRejectedValueOnce(new Error("Boom"));

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        await useAiStore.getState().sendPrompt(TAB, "hola");

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await vi.waitFor(() => {
            expect(sendAiPrompt).toHaveBeenCalledTimes(2);
        });
        await vi.waitFor(() => {
            const failedQueuedPrompt =
                useAiStore.getState().sessions[TAB.sessionId]?.queue[0];
            expect(failedQueuedPrompt?.status).toBe("failed");
        });
    });

    it("guarda diff zoom compartido por sesión en el store", () => {
        useAiStore.getState().registerSessionTab(TAB);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.diffZoom).toBe(
            DEFAULT_AI_DIFF_ZOOM,
        );

        useAiStore.getState().setSessionDiffZoom(TAB.sessionId, 0.823);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.diffZoom).toBe(
            0.82,
        );
    });
});
