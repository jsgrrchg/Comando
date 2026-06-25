import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiTrackedFile,
    OpenCodeRuntimeSettings,
} from "@shared/ipc";

import { AiService } from "./service";
import type { NativeAiGateway } from "./contracts";

const OPENCODE_ENV_CREDENTIAL_NAMES = [
    "ANTHROPIC_API_KEY",
    "CODEX_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
    "OPENCODE_API_KEY",
] as const;
const originalEnvCredentials = Object.fromEntries(
    OPENCODE_ENV_CREDENTIAL_NAMES.map((name) => [name, process.env[name]]),
) as Record<(typeof OPENCODE_ENV_CREDENTIAL_NAMES)[number], string | undefined>;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    for (const name of OPENCODE_ENV_CREDENTIAL_NAMES) {
        delete process.env[name];
    }
    delete process.env.XDG_DATA_HOME;
});

afterEach(() => {
    for (const name of OPENCODE_ENV_CREDENTIAL_NAMES) {
        restoreEnv(name, originalEnvCredentials[name]);
    }
    restoreEnv("XDG_DATA_HOME", originalXdgDataHome);
});

describe("AiService OpenCode branch", () => {
    it("stores OpenCode settings and emits runtime status", async () => {
        let savedSettings: OpenCodeRuntimeSettings | null = null;
        const runtimeStatusEvents: AiRuntimeStatus[] = [];
        const settingsService = createSettingsService({
            loadOpenCodeRuntimeSettings: vi.fn(() =>
                createOpenCodeSettings(),
            ),
            saveOpenCodeRuntimeSettings: (
                settings: OpenCodeRuntimeSettings,
            ) => {
                savedSettings = settings;
            },
        });
        const service = createService({
            onRuntimeStatus: (status) => runtimeStatusEvents.push(status),
            settingsService,
        });

        const status = await service.saveOpenCodeRuntimeSettings({
            authMethod: "opencode-login",
            binaryPath: "/opt/homebrew/bin/opencode",
        });

        expect(savedSettings).toEqual({
            authInvalidatedAtMs: null,
            authMethod: "opencode-login",
            binaryPath: "/opt/homebrew/bin/opencode",
        });
        expect(status.runtimeId).toBe("opencode");
        expect(runtimeStatusEvents.at(-1)?.runtimeId).toBe("opencode");
    });

    it("does not clear an invalidated OpenCode login on an unchanged save", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-unchanged-save-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.XDG_DATA_HOME = path.join(tempDir, "xdg");
            let savedSettings: OpenCodeRuntimeSettings | null = null;
            const currentSettings = createOpenCodeSettings({
                authInvalidatedAtMs: 12345,
                authMethod: "opencode-login",
                binaryPath,
            });
            const service = createService({
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() => currentSettings),
                    saveOpenCodeRuntimeSettings: (
                        settings: OpenCodeRuntimeSettings,
                    ) => {
                        savedSettings = settings;
                    },
                }),
            });

            const status = await service.saveOpenCodeRuntimeSettings({
                authMethod: "opencode-login",
                binaryPath,
            });

            expect(savedSettings).toEqual(currentSettings);
            expect(status.authReady).toBe(false);
            expect(status.onboardingRequired).toBe(true);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("clears OpenCode invalidation when settings change explicitly", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-changed-save-"),
        );

        try {
            const currentBinaryPath = writeExecutable(tempDir, "opencode");
            const nextBinaryPath = writeExecutable(tempDir, "next-opencode");
            process.env.XDG_DATA_HOME = path.join(tempDir, "xdg");
            let savedSettings: OpenCodeRuntimeSettings | null = null;
            const service = createService({
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authInvalidatedAtMs: 12345,
                            authMethod: "opencode-login",
                            binaryPath: currentBinaryPath,
                        }),
                    ),
                    saveOpenCodeRuntimeSettings: (
                        settings: OpenCodeRuntimeSettings,
                    ) => {
                        savedSettings = settings;
                    },
                }),
            });

            const status = await service.saveOpenCodeRuntimeSettings({
                authMethod: "opencode-login",
                binaryPath: nextBinaryPath,
            });

            expect(savedSettings).toMatchObject({
                authInvalidatedAtMs: null,
                authMethod: "opencode-login",
                binaryPath: nextBinaryPath,
            });
            expect(status.authReady).toBe(true);
            expect(status.onboardingRequired).toBe(false);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("disconnects OpenCode from Comando without deleting external credentials", async () => {
        let savedSettings: OpenCodeRuntimeSettings | null = null;
        const service = createService({
            settingsService: createSettingsService({
                loadOpenCodeRuntimeSettings: vi.fn(() =>
                    createOpenCodeSettings({
                        authMethod: "opencode-login",
                        binaryPath: "/opt/homebrew/bin/opencode",
                    }),
                ),
                saveOpenCodeRuntimeSettings: (
                    settings: OpenCodeRuntimeSettings,
                ) => {
                    savedSettings = settings;
                },
            }),
        });

        await service.disconnectRuntimeAuth({ runtimeId: "opencode" });

        expect(savedSettings).not.toBeNull();
        const nextSettings =
            savedSettings as unknown as OpenCodeRuntimeSettings;
        expect(nextSettings.binaryPath).toBe("/opt/homebrew/bin/opencode");
        expect(nextSettings.authMethod).toBeNull();
        expect(nextSettings.authInvalidatedAtMs).toEqual(expect.any(Number));
    });

    it("waits for pending review mutations before sending the next prompt", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-send-race-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.XDG_DATA_HOME = path.join(tempDir, "xdg");
            const trackedFile = createTrackedFile();
            let resolveKeep: () => void = () => {
                throw new Error("keepTrackedFile was not started.");
            };
            const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
                ({ launch }) =>
                    Promise.resolve({
                        ...launch.persistedSnapshot,
                        runtimeSessionId: "runtime-opencode",
                        status: "idle",
                        trackedFiles: [trackedFile],
                        updatedAt: "2026-06-20T00:00:00.000Z",
                    }),
            );
            const keepTrackedFile = vi.fn<
                NonNullable<NativeAiGateway["keepTrackedFile"]>
            >(
                ({ context }) =>
                    new Promise((resolve) => {
                        resolveKeep = () =>
                            resolve({
                                ownerWindowId: context.ownerWindowId,
                                snapshot: {
                                    ...context.snapshot,
                                    trackedFiles: [],
                                    updatedAt:
                                        "2026-06-20T00:00:01.000Z",
                                },
                            });
                    }),
            );
            const sendPrompt = vi.fn<NativeAiGateway["sendPrompt"]>(() =>
                Promise.resolve({
                    sessionId: "session-opencode",
                    stopReason: "accepted",
                }),
            );
            const nativeAi = createNativeAi({
                keepTrackedFile,
                prepareSession,
                sendPrompt,
            });
            const service = createService({
                nativeAi,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.prepareSession(
                {
                    projectId: null,
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );

            const keepPromise = service.keepTrackedFile({
                path: trackedFile.path,
                sessionId: "session-opencode",
            });
            await vi.waitFor(() => expect(keepTrackedFile).toHaveBeenCalled());

            const sendPromise = service.sendPrompt(
                {
                    additionalRoots: [],
                    attachments: [],
                    messageId: "user-message-2",
                    projectId: null,
                    prompt: "Continue.",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            await Promise.resolve();
            expect(sendPrompt).not.toHaveBeenCalled();

            resolveKeep();
            await keepPromise;
            await sendPromise;

            expect(sendPrompt).toHaveBeenCalledTimes(1);
            expect(
                sendPrompt.mock.calls[0]?.[0].launch.persistedSnapshot
                    .trackedFiles,
            ).toEqual([]);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("rebases cumulative tool diffs on the last accepted review text", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-accepted-base-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.XDG_DATA_HOME = path.join(tempDir, "xdg");
            const originalText = "A\nfirst accepted\nsecond pending\nZ\n";
            const acceptedText = "A\nsecond pending\nZ\n";
            const nextText = "A\nZ\n";
            const trackedFile = createTrackedFile({
                currentText: acceptedText,
                diffBase: originalText,
                newText: acceptedText,
                oldText: originalText,
                path: "cuento.md",
            });
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
                ({ launch }) =>
                    Promise.resolve({
                        ...launch.persistedSnapshot,
                        runtimeSessionId: "runtime-opencode",
                        status: "idle",
                        trackedFiles: [trackedFile],
                        updatedAt: "2026-06-20T00:00:00.000Z",
                    }),
            );
            const keepTrackedFile = vi.fn<
                NonNullable<NativeAiGateway["keepTrackedFile"]>
            >(({ context }) =>
                Promise.resolve({
                    ownerWindowId: context.ownerWindowId,
                    snapshot: {
                        ...context.snapshot,
                        trackedFiles: [],
                        updatedAt: "2026-06-20T00:00:01.000Z",
                    },
                }),
            );
            const recordReviewDiffs = vi.fn<
                NonNullable<NativeAiGateway["recordReviewDiffs"]>
            >(() => Promise.resolve([]));
            const nativeAi = createNativeAi({
                keepTrackedFile,
                prepareSession,
                recordReviewDiffs,
                sendPrompt: vi.fn<NativeAiGateway["sendPrompt"]>(({ input }) =>
                    Promise.resolve({
                        sessionId: input.sessionId,
                        stopReason: "accepted",
                    }),
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                projectRootPath: tempDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.prepareSession(
                {
                    projectId: "project-1",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            await service.keepTrackedFile({
                path: "cuento.md",
                sessionId: "session-opencode",
            });
            await service.sendPrompt(
                {
                    additionalRoots: [],
                    attachments: [],
                    messageId: "user-message-2",
                    projectId: "project-1",
                    prompt: "Remove the next line.",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );

            service.handleNativeSessionEvent("window-1", {
                activity: {
                    createdAt: "2026-06-20T00:00:02.000Z",
                    diffs: [
                        {
                            hunks: [],
                            isText: true,
                            kind: "update",
                            newText: nextText,
                            oldText: originalText,
                            path: path.join(tempDir, "cuento.md"),
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                    exitCode: 0,
                    id: "tool-write-2",
                    kind: "edit",
                    locations: [],
                    rawInputJson: null,
                    rawOutputJson: null,
                    sessionId: "session-opencode",
                    status: "completed",
                    summary: "Edited cuento.md",
                    terminalOutput: null,
                    title: "Edited cuento.md",
                    updatedAt: "2026-06-20T00:00:02.000Z",
                },
                kind: "tool-activity",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });

            expect(recordReviewDiffs).toHaveBeenCalledWith({
                diffs: [
                    expect.objectContaining({
                        isText: true,
                        newText: nextText,
                        oldText: acceptedText,
                        path: "cuento.md",
                    }),
                ],
                reviewRoot: tempDir,
                sessionId: "session-opencode",
                toolCallId: "tool-write-2",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });
            const latestTrackedFiles = onSessionSnapshot.mock.calls
                .map(([, update]) =>
                    update.kind === "snapshot"
                        ? update.snapshot.trackedFiles
                        : update.patch.changes.trackedFiles,
                )
                .findLast((trackedFiles) => trackedFiles !== undefined);
            expect(latestTrackedFiles).toEqual([
                expect.objectContaining({
                    newText: nextText,
                    oldText: acceptedText,
                    path: "cuento.md",
                    reviewState: "pending",
                }),
            ]);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("prepares OpenCode sessions with opencode acp launch details", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-service-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.XDG_DATA_HOME = path.join(tempDir, "xdg");
            const preparedSnapshot = createSessionSnapshot();
            const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
                () => Promise.resolve(preparedSnapshot),
            );
            const nativeAi = createNativeAi({ prepareSession });
            const service = createService({
                nativeAi,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.prepareSession(
                {
                    projectId: null,
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );

            const launch = prepareSession.mock.calls[0][0].launch;
            expect(launch.resolvedRuntime.executable).toBe(binaryPath);
            expect(launch.resolvedRuntime.args).toEqual(["acp"]);
            expect(launch.resolvedRuntime.command).toBe(`${binaryPath} acp`);
            expect(launch.resolvedRuntime.status.runtimeId).toBe("opencode");
            expect(launch.resolvedRuntime.status.onboardingRequired).toBe(
                false,
            );
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("persists native session events through the service snapshot cache", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-native-events-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const saveSessionSnapshot = vi.fn();
            const onSessionSnapshot = vi.fn<
                (ownerWindowId: string, update: AiSessionUpdate) => void
            >();
            const nativeAi = createNativeAi({
                cancelSession: vi.fn(),
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession: vi.fn(),
                deleteSession: vi.fn(),
                listSessionHistory: vi.fn(() => Promise.resolve([])),
                loadSessionSnapshot: vi.fn(() => Promise.resolve(null)),
                loadSessionTranscriptPage: vi.fn(() => Promise.resolve(null)),
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-native-1",
                            status: "idle",
                            updatedAt: "2026-06-20T00:00:00.000Z",
                        }),
                ),
                respondPermission: vi.fn(),
                respondUserInput: vi.fn(),
                sendPrompt: vi.fn(),
                renameSession: vi.fn(),
                setSessionConfigOption: vi.fn(),
                setSessionMode: vi.fn(),
                setSessionModel: vi.fn(),
                setSessionPinned: vi.fn(),
                shouldHandleHistory: vi.fn(() => false),
                shouldHandleRuntime: vi.fn((runtimeId) => runtimeId === "opencode"),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                persistence: {
                    saveSessionSnapshot,
                },
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.prepareSession(
                {
                    projectId: null,
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            service.handleNativeSessionEvent("window-1", {
                kind: "message-started",
                message: {
                    attachments: [],
                    content: "",
                    createdAt: "2026-06-20T00:00:01.000Z",
                    id: "assistant-1",
                    kind: "assistant",
                    status: "streaming",
                },
                messageKind: "assistant",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-native-1",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:01.000Z",
            });
            service.handleNativeSessionEvent("window-1", {
                content: "Hello",
                delta: "Hello",
                kind: "message-delta",
                messageId: "assistant-1",
                messageKind: "assistant",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-native-1",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });

            expect(saveSessionSnapshot).not.toHaveBeenCalled();
            const snapshotCall = onSessionSnapshot.mock.calls.at(-1);
            expect(snapshotCall?.[0]).toBe("window-1");
            const update = snapshotCall?.[1];
            expect(update?.kind).toBe("patch");
            if (update?.kind !== "patch") {
                throw new Error("Expected a patch update.");
            }
            const message = update.patch.changes.messages?.[0];
            expect(message).toMatchObject({
                content: "Hello",
                id: "assistant-1",
                status: "streaming",
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("marks native sessions closed from session-closed events", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-native-closed-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot = vi.fn<
                (ownerWindowId: string, update: AiSessionUpdate) => void
            >();
            const nativeAi = createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-native-1",
                            status: "streaming",
                            updatedAt: "2026-06-20T00:00:00.000Z",
                        }),
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.prepareSession(
                {
                    projectId: null,
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            service.handleNativeSessionEvent("window-1", {
                closedAt: "2026-06-20T00:00:03.000Z",
                kind: "session-closed",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-native-1",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:03.000Z",
            });

            const update = onSessionSnapshot.mock.calls.at(-1)?.[1];
            expect(update?.kind).toBe("patch");
            if (update?.kind !== "patch") {
                throw new Error("Expected a patch update.");
            }
            expect(update.patch.changes).toMatchObject({
                closedAt: "2026-06-20T00:00:03.000Z",
                status: "idle",
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("tracks native working tree edits after a turn for review", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-native-review-"),
        );

        try {
            createGitRepository(tempDir);
            const sourceDir = path.join(tempDir, "src");
            fs.mkdirSync(sourceDir, { recursive: true });
            fs.writeFileSync(
                path.join(sourceDir, "app.ts"),
                "export const value = 1;\n",
                "utf8",
            );
            fs.writeFileSync(
                path.join(sourceDir, "dirty.ts"),
                "export const dirty = false;\n",
                "utf8",
            );
            fs.writeFileSync(
                path.join(sourceDir, "restored.ts"),
                "export const restored = false;\n",
                "utf8",
            );
            execGitSync(tempDir, ["add", "."]);
            execGitSync(tempDir, ["commit", "-m", "initial"]);
            fs.writeFileSync(
                path.join(sourceDir, "dirty.ts"),
                "export const dirty = true;\n",
                "utf8",
            );
            fs.writeFileSync(
                path.join(sourceDir, "restored.ts"),
                "export const restored = true;\n",
                "utf8",
            );
            fs.writeFileSync(
                path.join(tempDir, "scratch.txt"),
                "temporary local note\n",
                "utf8",
            );

            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const saveSessionSnapshot = vi.fn();
            const onSessionSnapshot = vi.fn<
                (ownerWindowId: string, update: AiSessionUpdate) => void
            >();
            let promptCallCount = 0;
            const serviceRef: { current: AiService | null } = {
                current: null,
            };
            const trackedReviewFiles: readonly AiTrackedFile[] = [
                {
                    currentText: "export const value = 2;\n",
                    diffBase: "export const value = 1;\n",
                    hunks: [],
                    identityKey: "native:session-opencode:src/app.ts",
                    isText: true,
                    kind: "update",
                    newText: "export const value = 2;\n",
                    oldText: "export const value = 1;\n",
                    path: "src/app.ts",
                    previousPath: null,
                    reviewState: "pending",
                    reversible: true,
                    sessionId: "session-opencode",
                    toolCallId: null,
                    updatedAt: "2026-06-20T00:00:02.000Z",
                    version: 1,
                },
                {
                    currentText: "export const restored = false;\n",
                    diffBase: "export const restored = true;\n",
                    hunks: [],
                    identityKey: "native:session-opencode:src/restored.ts",
                    isText: true,
                    kind: "update",
                    newText: "export const restored = false;\n",
                    oldText: "export const restored = true;\n",
                    path: "src/restored.ts",
                    previousPath: null,
                    reviewState: "pending",
                    reversible: true,
                    sessionId: "session-opencode",
                    toolCallId: null,
                    updatedAt: "2026-06-20T00:00:02.000Z",
                    version: 1,
                },
                {
                    currentText: "",
                    diffBase: "temporary local note\n",
                    hunks: [],
                    identityKey: "native:session-opencode:scratch.txt",
                    isText: true,
                    kind: "delete",
                    newText: null,
                    oldText: "temporary local note\n",
                    path: "scratch.txt",
                    previousPath: null,
                    reviewState: "pending",
                    reversible: true,
                    sessionId: "session-opencode",
                    toolCallId: null,
                    updatedAt: "2026-06-20T00:00:02.000Z",
                    version: 1,
                },
            ];
            const nativeAi = createNativeAi({
                cancelSession: vi.fn(),
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession: vi.fn(),
                deleteSession: vi.fn(),
                listSessionHistory: vi.fn(() => Promise.resolve([])),
                loadSessionSnapshot: vi.fn(() => Promise.resolve(null)),
                loadSessionTranscriptPage: vi.fn(() => Promise.resolve(null)),
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-native-review",
                            status: "idle",
                            updatedAt: "2026-06-20T00:00:00.000Z",
                        }),
                ),
                respondPermission: vi.fn(),
                respondUserInput: vi.fn(),
                sendPrompt: vi.fn<NativeAiGateway["sendPrompt"]>(() => {
                    promptCallCount += 1;
                    if (promptCallCount > 1) {
                        return Promise.reject(new Error("Session busy"));
                    }
                    if (!serviceRef.current) {
                        throw new Error("The AI service was not initialized.");
                    }
                    serviceRef.current.handleNativeSessionEvent("window-1", {
                        activeTurnStartedAt: null,
                        kind: "status",
                        lastError: null,
                        origin: "live",
                        parentSessionId: null,
                        runtimeId: "opencode",
                        runtimeSessionId: "runtime-native-review",
                        sessionId: "session-opencode",
                        status: "idle",
                        updatedAt: "2026-06-20T00:00:01.000Z",
                    });
                    fs.writeFileSync(
                        path.join(sourceDir, "app.ts"),
                        "export const value = 2;\n",
                        "utf8",
                    );
                    fs.writeFileSync(
                        path.join(sourceDir, "restored.ts"),
                        "export const restored = false;\n",
                        "utf8",
                    );
                    fs.unlinkSync(path.join(tempDir, "scratch.txt"));
                    return Promise.resolve({
                        sessionId: "session-opencode",
                        stopReason: "accepted",
                    });
                }),
                reconcileTrackedFiles: vi.fn(() =>
                    Promise.resolve(trackedReviewFiles),
                ),
                renameSession: vi.fn(),
                setSessionConfigOption: vi.fn(),
                setSessionMode: vi.fn(),
                setSessionModel: vi.fn(),
                setSessionPinned: vi.fn(),
                shouldHandleHistory: vi.fn(() => false),
                shouldHandleRuntime: vi.fn(
                    (runtimeId) => runtimeId === "opencode",
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                persistence: {
                    saveSessionSnapshot,
                },
                projectRootPath: tempDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });
            serviceRef.current = service;

            await service.sendPrompt(
                {
                    additionalRoots: [],
                    attachments: [],
                    messageId: "user-message-1",
                    projectId: "project-1",
                    prompt: "Update the value.",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            await expect(
                service.sendPrompt(
                    {
                        additionalRoots: [],
                        attachments: [],
                        messageId: "user-message-2",
                        projectId: "project-1",
                        prompt: "Try again immediately.",
                        runtimeId: "opencode",
                        sessionId: "session-opencode",
                        title: "OpenCode 1",
                        worktreeId: null,
                    },
                    "window-1",
                ),
            ).rejects.toThrow("Session busy");
            service.handleNativeSessionEvent("window-1", {
                activeTurnStartedAt: "2026-06-20T00:00:02.000Z",
                kind: "status",
                lastError: null,
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-native-review",
                sessionId: "session-opencode",
                status: "streaming",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });
            service.handleNativeSessionEvent("window-1", {
                activeTurnStartedAt: null,
                kind: "status",
                lastError: null,
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-native-review",
                sessionId: "session-opencode",
                status: "idle",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });

            await waitForAssertion(() => {
                const snapshots = onSessionSnapshot.mock.calls.map(
                    ([, update]) => update,
                );
                const latestSnapshot = snapshots
                    .map((update) =>
                        update.kind === "snapshot"
                            ? update.snapshot
                            : update.patch.changes,
                    )
                    .findLast(
                        (snapshot) => snapshot.trackedFiles !== undefined,
                    );
                const trackedFiles = latestSnapshot?.trackedFiles ?? [];
                expect(
                    trackedFiles.map((trackedFile) => trackedFile.path).sort(),
                ).toEqual(["scratch.txt", "src/app.ts", "src/restored.ts"]);
                expect(
                    trackedFiles.find(
                        (trackedFile) => trackedFile.path === "src/app.ts",
                    ),
                ).toMatchObject({
                    kind: "update",
                    newText: "export const value = 2;\n",
                    oldText: "export const value = 1;\n",
                    path: "src/app.ts",
                    reviewState: "pending",
                });
                expect(
                    trackedFiles.find(
                        (trackedFile) =>
                            trackedFile.path === "src/restored.ts",
                    ),
                ).toMatchObject({
                    kind: "update",
                    newText: "export const restored = false;\n",
                    oldText: "export const restored = true;\n",
                    path: "src/restored.ts",
                    reviewState: "pending",
                });
                expect(
                    trackedFiles.find(
                        (trackedFile) => trackedFile.path === "scratch.txt",
                    ),
                ).toMatchObject({
                    kind: "delete",
                    newText: null,
                    oldText: "temporary local note\n",
                    path: "scratch.txt",
                    reviewState: "pending",
                });
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("prepares the native parent before sending to a persisted child", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-native-child-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const parentSnapshot: AiSessionSnapshot = {
                ...createSessionSnapshot(),
                runtimeSessionId: "runtime-parent",
                sessionId: "session-parent",
                title: "Parent",
            };
            const childSnapshot: AiSessionSnapshot = {
                ...createSessionSnapshot(),
                parentSessionId: "session-parent",
                runtimeSessionId: "runtime-child",
                sessionId: "session-child",
                title: "Child",
            };
            const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
                ({ launch }) =>
                    Promise.resolve({
                        ...launch.persistedSnapshot,
                        runtimeSessionId: "runtime-parent",
                        status: "idle",
                        updatedAt: "2026-06-20T00:00:00.000Z",
                    }),
            );
            const sendPrompt = vi.fn<NativeAiGateway["sendPrompt"]>(() =>
                Promise.resolve({
                    sessionId: "session-child",
                    stopReason: "accepted",
                }),
            );
            const cancelSession = vi.fn<NativeAiGateway["cancelSession"]>();
            const saveSessionSnapshot = vi.fn();
            const onSessionSnapshot = vi.fn<
                (ownerWindowId: string, update: AiSessionUpdate) => void
            >();
            const nativeAi = createNativeAi({
                cancelSession,
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession: vi.fn(),
                deleteSession: vi.fn(),
                listSessionHistory: vi.fn(() => Promise.resolve([])),
                loadSessionSnapshot: vi.fn(() => Promise.resolve(null)),
                loadSessionTranscriptPage: vi.fn(() => Promise.resolve(null)),
                prepareSession,
                respondPermission: vi.fn(),
                respondUserInput: vi.fn(),
                sendPrompt,
                renameSession: vi.fn(),
                setSessionConfigOption: vi.fn(),
                setSessionMode: vi.fn(),
                setSessionModel: vi.fn(),
                setSessionPinned: vi.fn(),
                shouldHandleHistory: vi.fn(() => false),
                shouldHandleRuntime: vi.fn((runtimeId) => runtimeId === "opencode"),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                persistence: {
                    listSessionRuntimeMappingsForParent: vi.fn((sessionId) =>
                        sessionId === "session-parent"
                            ? [
                                  {
                                      appSessionId: "session-child",
                                      parentAppSessionId: "session-parent",
                                      parentRuntimeSessionId: "runtime-parent",
                                      runtimeSessionId: "runtime-child",
                                  },
                              ]
                            : [],
                    ),
                    loadSessionSnapshot: vi.fn((sessionId) => {
                        if (sessionId === "session-parent") {
                            return parentSnapshot;
                        }
                        if (sessionId === "session-child") {
                            return childSnapshot;
                        }
                        return null;
                    }),
                    saveSessionSnapshot,
                },
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.sendPrompt(
                {
                    additionalRoots: [],
                    attachments: [],
                    messageId: "user-message-1",
                    projectId: null,
                    prompt: "Continue the child task.",
                    runtimeId: "opencode",
                    sessionId: "session-child",
                    title: "Child",
                    worktreeId: null,
                },
                "window-1",
            );

            expect(prepareSession).toHaveBeenCalledTimes(1);
            expect(prepareSession.mock.calls[0]?.[0].input.sessionId).toBe(
                "session-parent",
            );
            expect(sendPrompt).toHaveBeenCalledTimes(1);
            expect(sendPrompt.mock.calls[0]?.[0].input.sessionId).toBe(
                "session-child",
            );
            expect(
                sendPrompt.mock.calls[0]?.[0].launch.persistedSnapshot
                    .parentSessionId,
            ).toBe("session-parent");

            service.handleNativeSessionEvent("window-1", {
                activeTurnStartedAt: "2026-06-20T00:00:01.000Z",
                kind: "status",
                lastError: null,
                origin: "live",
                parentSessionId: "session-parent",
                runtimeId: "opencode",
                runtimeSessionId: "runtime-child",
                sessionId: "session-child",
                status: "streaming",
                updatedAt: "2026-06-20T00:00:01.000Z",
            });
            expect(saveSessionSnapshot).not.toHaveBeenCalledWith(
                expect.objectContaining({ sessionId: "session-child" }),
            );
            const snapshotCall = onSessionSnapshot.mock.calls.at(-1);
            expect(snapshotCall?.[0]).toBe("window-1");
            const update = snapshotCall?.[1];
            expect(update?.kind).toBe("patch");
            if (update?.kind !== "patch") {
                throw new Error("Expected a patch update.");
            }
            expect(update.patch.sessionId).toBe("session-child");
            expect(update.patch.changes.status).toBe("streaming");

            await service.cancelSession("session-child");
            expect(cancelSession).toHaveBeenCalledWith("session-child");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("prepares the native parent when opening a persisted child", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-native-child-open-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const parentSnapshot: AiSessionSnapshot = {
                ...createSessionSnapshot(),
                runtimeSessionId: "runtime-parent",
                sessionId: "session-parent",
                title: "Parent",
            };
            const childSnapshot: AiSessionSnapshot = {
                ...createSessionSnapshot(),
                parentSessionId: "session-parent",
                runtimeSessionId: "runtime-child",
                sessionId: "session-child",
                title: "Child",
            };
            const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
                ({ launch }) =>
                    Promise.resolve({
                        ...launch.persistedSnapshot,
                        runtimeSessionId: "runtime-parent",
                        status: "idle",
                        updatedAt: "2026-06-20T00:00:00.000Z",
                    }),
            );
            const closeSession = vi.fn<NativeAiGateway["closeSession"]>();
            const nativeAi = createNativeAi({
                cancelSession: vi.fn(),
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession,
                deleteSession: vi.fn(),
                listSessionHistory: vi.fn(() => Promise.resolve([])),
                loadSessionSnapshot: vi.fn(() => Promise.resolve(null)),
                loadSessionTranscriptPage: vi.fn(() => Promise.resolve(null)),
                prepareSession,
                respondPermission: vi.fn(),
                respondUserInput: vi.fn(),
                sendPrompt: vi.fn(),
                renameSession: vi.fn(),
                setSessionConfigOption: vi.fn(),
                setSessionMode: vi.fn(),
                setSessionModel: vi.fn(),
                setSessionPinned: vi.fn(),
                shouldHandleHistory: vi.fn(() => false),
                shouldHandleRuntime: vi.fn((runtimeId) => runtimeId === "opencode"),
            });
            const service = createService({
                nativeAi,
                persistence: {
                    listSessionRuntimeMappingsForParent: vi.fn((sessionId) =>
                        sessionId === "session-parent"
                            ? [
                                  {
                                      appSessionId: "session-child",
                                      parentAppSessionId: "session-parent",
                                      parentRuntimeSessionId: "runtime-parent",
                                      runtimeSessionId: "runtime-child",
                                  },
                              ]
                            : [],
                    ),
                    loadSessionSnapshot: vi.fn((sessionId) => {
                        if (sessionId === "session-parent") {
                            return parentSnapshot;
                        }
                        if (sessionId === "session-child") {
                            return childSnapshot;
                        }
                        return null;
                    }),
                },
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await expect(
                service.prepareSession(
                    {
                        projectId: null,
                        runtimeId: "opencode",
                        sessionId: "session-child",
                        title: "Child",
                        worktreeId: null,
                    },
                    "window-1",
                ),
            ).resolves.toMatchObject({
                parentSessionId: "session-parent",
                sessionId: "session-child",
            });

            expect(prepareSession).toHaveBeenCalledTimes(1);
            expect(prepareSession.mock.calls[0]?.[0].input.sessionId).toBe(
                "session-parent",
            );

            await service.closeSession("session-child");
            expect(closeSession).toHaveBeenCalledWith("session-child");
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("rehydrates native launches from native history before sending", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-native-history-resume-"),
        );

        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const previousMessage = {
                attachments: [],
                content: "Earlier answer",
                createdAt: "2026-06-20T00:00:00.000Z",
                id: "message-previous",
                kind: "assistant" as const,
                status: "completed" as const,
            };
            const nativeSnapshot: AiSessionSnapshot = {
                ...createSessionSnapshot(),
                messages: [previousMessage],
                runtimeSessionId: "runtime-native",
                sessionId: "session-native",
                title: "Native history",
            };
            const loadSessionSnapshot = vi.fn<NativeAiGateway["loadSessionSnapshot"]>(
                (sessionId) =>
                    Promise.resolve(
                        sessionId === "session-native" ? nativeSnapshot : null,
                    ),
            );
            const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
                ({ launch }) => Promise.resolve(launch.persistedSnapshot),
            );
            const sendPrompt = vi.fn<NativeAiGateway["sendPrompt"]>(() =>
                Promise.resolve({
                    sessionId: "session-native",
                    stopReason: "accepted",
                }),
            );
            const nativeAi = createNativeAi({
                cancelSession: vi.fn(),
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession: vi.fn(),
                deleteSession: vi.fn(),
                listSessionHistory: vi.fn(() => Promise.resolve([])),
                listSessionRuntimeMappingsForParent: vi.fn(() =>
                    Promise.resolve([]),
                ),
                loadSessionSnapshot,
                loadSessionTranscriptPage: vi.fn(() => Promise.resolve(null)),
                prepareSession,
                respondPermission: vi.fn(),
                respondUserInput: vi.fn(),
                sendPrompt,
                renameSession: vi.fn(),
                setSessionConfigOption: vi.fn(),
                setSessionMode: vi.fn(),
                setSessionModel: vi.fn(),
                setSessionPinned: vi.fn(),
                shouldHandleHistory: vi.fn(() => true),
                shouldHandleRuntime: vi.fn((runtimeId) => runtimeId === "opencode"),
            });
            const persistenceLoadSnapshot = vi.fn(() => null);
            const service = createService({
                nativeAi,
                persistence: {
                    loadSessionSnapshot: persistenceLoadSnapshot,
                },
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.sendPrompt(
                {
                    additionalRoots: [],
                    attachments: [],
                    messageId: "user-message-1",
                    projectId: null,
                    prompt: "Continue.",
                    runtimeId: "opencode",
                    sessionId: "session-native",
                    title: "Native history",
                    worktreeId: null,
                },
                "window-1",
            );

            expect(loadSessionSnapshot).toHaveBeenCalledWith("session-native");
            expect(persistenceLoadSnapshot).not.toHaveBeenCalled();
            expect(
                prepareSession.mock.calls[0]?.[0].launch.persistedSnapshot
                    .messages,
            ).toEqual([previousMessage]);
            expect(
                sendPrompt.mock.calls[0]?.[0].launch.persistedSnapshot.messages,
            ).toEqual([previousMessage]);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("clears pending review when native reconciliation returns no files without streaming status", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-clear-"),
        );
        const pendingFile = createTrackedFile({
            path: "src/app.ts",
            sessionId: "session-opencode",
        });
        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            const reconcileTrackedFiles = vi.fn(() => Promise.resolve([]));
            const nativeAi = createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-opencode",
                            status: "idle",
                            trackedFiles: [pendingFile],
                            updatedAt: "2026-06-20T00:00:00.000Z",
                        }),
                ),
                reconcileTrackedFiles,
                sendPrompt: vi.fn<NativeAiGateway["sendPrompt"]>(({ input }) =>
                    Promise.resolve({
                        sessionId: input.sessionId,
                        stopReason: "accepted",
                    }),
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.sendPrompt(
                {
                    additionalRoots: [],
                    attachments: [],
                    messageId: "user-message-1",
                    projectId: "project-1",
                    prompt: "Undo the edit.",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            service.handleNativeSessionEvent("window-1", {
                activeTurnStartedAt: null,
                kind: "status",
                lastError: null,
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                status: "idle",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });

            await waitForAssertion(() => {
                expect(reconcileTrackedFiles).toHaveBeenCalledWith(
                    "session-opencode",
                );
                const updates = onSessionSnapshot.mock.calls.map(
                    ([, update]) => update,
                );
                expect(
                    updates.some(
                        (update) =>
                            update.kind === "patch" &&
                            Array.isArray(update.patch.changes.trackedFiles) &&
                            update.patch.changes.trackedFiles.length === 0,
                    ),
                ).toBe(true);
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("preserves pending review when preparing a live session again", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-reprepare-"),
        );
        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            let prepareCount = 0;
            const prepareSession = vi.fn<NativeAiGateway["prepareSession"]>(
                ({ launch }) => {
                    prepareCount += 1;
                    return Promise.resolve({
                        ...launch.persistedSnapshot,
                        runtimeSessionId: "runtime-opencode",
                        status: "idle",
                        trackedFiles: [],
                        updatedAt: `2026-06-20T00:00:0${prepareCount}.000Z`,
                    });
                },
            );
            const nativeAi = createNativeAi({ prepareSession });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                projectRootPath: tempDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });
            const input = {
                projectId: "project-1",
                runtimeId: "opencode" as const,
                sessionId: "session-opencode",
                title: "OpenCode 1",
                worktreeId: null,
            };
            const pendingFile = createTrackedFile({
                path: "cuento.md",
                sessionId: "session-opencode",
            });

            await service.prepareSession(input, "window-1");
            service.handleNativeSessionEvent("window-1", {
                conflicts: [],
                kind: "review",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                trackedFiles: [pendingFile],
                updatedAt: "2026-06-20T00:00:03.000Z",
            });

            const reopenedSnapshot = await service.prepareSession(
                input,
                "window-1",
            );

            expect(prepareSession).toHaveBeenCalledTimes(2);
            expect(reopenedSnapshot.trackedFiles).toEqual([pendingFile]);
            const latestTrackedFiles = onSessionSnapshot.mock.calls
                .map(([, update]) =>
                    update.kind === "snapshot"
                        ? update.snapshot.trackedFiles
                        : update.patch.changes.trackedFiles,
                )
                .findLast((trackedFiles) => trackedFiles !== undefined);
            expect(latestTrackedFiles).toEqual([
                expect.objectContaining({
                    path: "cuento.md",
                    reviewState: "pending",
                }),
            ]);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("preserves pending review when a passive native snapshot is empty", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-passive-snapshot-"),
        );
        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            const nativeAi = createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-opencode",
                            status: "idle",
                            trackedFiles: [],
                            updatedAt: "2026-06-20T00:00:01.000Z",
                        }),
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                projectRootPath: tempDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });
            const pendingFile = createTrackedFile({
                path: "cuento.md",
                sessionId: "session-opencode",
            });

            await service.prepareSession(
                {
                    projectId: "project-1",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            service.handleNativeSessionEvent("window-1", {
                conflicts: [],
                kind: "review",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                trackedFiles: [pendingFile],
                updatedAt: "2026-06-20T00:00:02.000Z",
            });

            service.handleNativeSessionSnapshot("window-1", {
                kind: "snapshot",
                snapshot: {
                    ...createSessionSnapshot(),
                    runtimeSessionId: "runtime-opencode",
                    sessionId: "session-opencode",
                    trackedFiles: [],
                    updatedAt: "2026-06-20T00:00:03.000Z",
                },
            });

            const latestTrackedFiles = onSessionSnapshot.mock.calls
                .map(([, update]) =>
                    update.kind === "snapshot"
                        ? update.snapshot.trackedFiles
                        : update.patch.changes.trackedFiles,
                )
                .findLast((trackedFiles) => trackedFiles !== undefined);
            expect(latestTrackedFiles).toEqual([
                expect.objectContaining({
                    path: "cuento.md",
                    reviewState: "pending",
                }),
            ]);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("blocks fallback reject when the file drifted after review", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-fallback-drift-"),
        );
        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            const editedPath = path.join(tempDir, "cuento.md");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            const rejectTrackedFile = vi.fn();
            const nativeAi = createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-opencode",
                            status: "idle",
                            updatedAt: "2026-06-20T00:00:01.000Z",
                        }),
                ),
                rejectTrackedFile,
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                projectRootPath: tempDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });
            const pendingFile = createTrackedFile({
                currentText: "agent\n",
                diffBase: "base\n",
                identityKey: "tool:session-opencode:tool-write-1::cuento.md",
                newText: "agent\n",
                oldText: "base\n",
                path: "cuento.md",
                sessionId: "session-opencode",
                toolCallId: "tool-write-1",
            });

            await service.prepareSession(
                {
                    projectId: "project-1",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            service.handleNativeSessionEvent("window-1", {
                conflicts: [],
                kind: "review",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                trackedFiles: [pendingFile],
                updatedAt: "2026-06-20T00:00:02.000Z",
            });
            fs.writeFileSync(editedPath, "agent + user\n", "utf8");

            await expect(
                service.rejectTrackedFile({
                    path: "cuento.md",
                    sessionId: "session-opencode",
                }),
            ).rejects.toThrow("no longer matches");

            expect(fs.readFileSync(editedPath, "utf8")).toBe(
                "agent + user\n",
            );
            expect(rejectTrackedFile).not.toHaveBeenCalled();
            const latestTrackedFiles = onSessionSnapshot.mock.calls
                .map(([, update]) =>
                    update.kind === "snapshot"
                        ? update.snapshot.trackedFiles
                        : update.patch.changes.trackedFiles,
                )
                .findLast((trackedFiles) => trackedFiles !== undefined);
            expect(latestTrackedFiles).toEqual([
                expect.objectContaining({
                    path: "cuento.md",
                    reviewState: "pending",
                }),
            ]);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("keeps fallback review with drift without writing the file", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-fallback-keep-drift-"),
        );
        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            const editedPath = path.join(tempDir, "cuento.md");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            const keepTrackedFile = vi.fn();
            const nativeAi = createNativeAi({
                keepTrackedFile,
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-opencode",
                            status: "idle",
                            updatedAt: "2026-06-20T00:00:01.000Z",
                        }),
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                projectRootPath: tempDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });
            const pendingFile = createTrackedFile({
                currentText: "agent\n",
                diffBase: "base\n",
                identityKey: "tool:session-opencode:tool-write-1::cuento.md",
                newText: "agent\n",
                oldText: "base\n",
                path: "cuento.md",
                sessionId: "session-opencode",
                toolCallId: "tool-write-1",
            });

            await service.prepareSession(
                {
                    projectId: "project-1",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            service.handleNativeSessionEvent("window-1", {
                conflicts: [],
                kind: "review",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                trackedFiles: [pendingFile],
                updatedAt: "2026-06-20T00:00:02.000Z",
            });
            fs.writeFileSync(editedPath, "agent + user\n", "utf8");

            await service.keepTrackedFile({
                path: "cuento.md",
                sessionId: "session-opencode",
            });

            expect(fs.readFileSync(editedPath, "utf8")).toBe(
                "agent + user\n",
            );
            expect(keepTrackedFile).not.toHaveBeenCalled();
            const latestTrackedFiles = onSessionSnapshot.mock.calls
                .map(([, update]) =>
                    update.kind === "snapshot"
                        ? update.snapshot.trackedFiles
                        : update.patch.changes.trackedFiles,
                )
                .findLast((trackedFiles) => trackedFiles !== undefined);
            expect(latestTrackedFiles).toEqual([]);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("rolls back fallback reject all when a later write fails", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-fallback-rollback-"),
        );
        const originalWriteFileSync = fs.writeFileSync.bind(fs);
        const writeFileSyncSpy = vi.spyOn(fs, "writeFileSync");
        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            const firstPath = path.join(tempDir, "a.txt");
            const secondPath = path.join(tempDir, "b.txt");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            const nativeAi = createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-opencode",
                            status: "idle",
                            updatedAt: "2026-06-20T00:00:01.000Z",
                        }),
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                projectRootPath: tempDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });
            const firstFile = createTrackedFile({
                currentText: "agent a\n",
                diffBase: "base a\n",
                identityKey: "tool:session-opencode:tool-write-1::a.txt",
                newText: "agent a\n",
                oldText: "base a\n",
                path: "a.txt",
                sessionId: "session-opencode",
                toolCallId: "tool-write-1",
            });
            const secondFile = createTrackedFile({
                currentText: "agent b\n",
                diffBase: "base b\n",
                identityKey: "tool:session-opencode:tool-write-2::b.txt",
                newText: "agent b\n",
                oldText: "base b\n",
                path: "b.txt",
                sessionId: "session-opencode",
                toolCallId: "tool-write-2",
            });
            writeFileSyncSpy.mockImplementation((file, data, options) => {
                if (
                    String(file) === secondPath &&
                    typeof data === "string" &&
                    data === "base b\n"
                ) {
                    throw new Error("simulated write failure");
                }
                return originalWriteFileSync(file, data, options);
            });

            await service.prepareSession(
                {
                    projectId: "project-1",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            service.handleNativeSessionEvent("window-1", {
                conflicts: [],
                kind: "review",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                trackedFiles: [firstFile, secondFile],
                updatedAt: "2026-06-20T00:00:02.000Z",
            });
            originalWriteFileSync(firstPath, "agent a\n", "utf8");
            originalWriteFileSync(secondPath, "agent b\n", "utf8");

            await expect(
                service.rejectAllTrackedFiles("session-opencode"),
            ).rejects.toThrow("simulated write failure");

            expect(fs.readFileSync(firstPath, "utf8")).toBe("agent a\n");
            expect(fs.readFileSync(secondPath, "utf8")).toBe("agent b\n");
            const latestTrackedFiles = onSessionSnapshot.mock.calls
                .map(([, update]) =>
                    update.kind === "snapshot"
                        ? update.snapshot.trackedFiles
                        : update.patch.changes.trackedFiles,
                )
                .findLast((trackedFiles) => trackedFiles !== undefined);
            expect(latestTrackedFiles).toEqual([
                expect.objectContaining({ path: "a.txt" }),
                expect.objectContaining({ path: "b.txt" }),
            ]);
        } finally {
            writeFileSyncSpy.mockRestore();
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("creates pending review from scoped tool diffs when native baseline capture is unavailable", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-diff-fallback-"),
        );
        try {
            const editedPath = path.join(tempDir, "Fliege font.md");
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            const reconcileTrackedFiles = vi.fn(() => Promise.resolve([]));
            const recordReviewDiffs = vi.fn<
                NonNullable<NativeAiGateway["recordReviewDiffs"]>
            >(() => Promise.resolve([]));
            const rejectTrackedFile = vi.fn();
            const nativeAi = createNativeAi({
                captureReviewBaseline: vi.fn(() => Promise.resolve(false)),
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-opencode",
                            status: "idle",
                            updatedAt: "2026-06-20T00:00:00.000Z",
                        }),
                ),
                reconcileTrackedFiles,
                recordReviewDiffs,
                rejectTrackedFile,
                sendPrompt: vi.fn<NativeAiGateway["sendPrompt"]>(({ input }) =>
                    Promise.resolve({
                        sessionId: input.sessionId,
                        stopReason: "accepted",
                    }),
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                projectRootPath: tempDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.sendPrompt(
                {
                    additionalRoots: [],
                    attachments: [],
                    messageId: "user-message-1",
                    projectId: "project-1",
                    prompt: "Edit the file.",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            fs.writeFileSync(editedPath, "new text\n", "utf8");
            service.handleNativeSessionEvent("window-1", {
                activity: {
                    createdAt: "2026-06-20T00:00:01.000Z",
                    diffs: [
                        {
                            hunks: [],
                            isText: true,
                            kind: "update",
                            newText: "new text\n",
                            oldText: "old text\n",
                            path: editedPath,
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                    exitCode: 0,
                    id: "tool-write-1",
                    kind: "edit",
                    locations: [],
                    rawInputJson: null,
                    rawOutputJson: null,
                    sessionId: "session-opencode",
                    status: "completed",
                    summary: "Edited Fliege font.md",
                    terminalOutput: null,
                    title: "Edited Fliege font.md",
                    updatedAt: "2026-06-20T00:00:01.000Z",
                },
                kind: "tool-activity",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:01.000Z",
            });

            const updates = onSessionSnapshot.mock.calls.map(
                ([, update]) => update,
            );
            const pendingReviewUpdates = updates
                .map((update) =>
                    update.kind === "snapshot"
                        ? update.snapshot
                        : update.patch.changes,
                )
                .filter((snapshot) =>
                    snapshot.trackedFiles?.some(
                        (file) => file.reviewState === "pending",
                    ),
                );
            expect(pendingReviewUpdates).toEqual([
                expect.objectContaining({
                    trackedFiles: [
                        expect.objectContaining({
                            newText: "new text\n",
                            oldText: "old text\n",
                            path: "Fliege font.md",
                            reviewState: "pending",
                            toolCallId: "tool-write-1",
                        }),
                    ],
                }),
            ]);
            expect(recordReviewDiffs).toHaveBeenCalledWith({
                diffs: [
                    expect.objectContaining({
                        isText: true,
                        newText: "new text\n",
                        oldText: "old text\n",
                        path: "Fliege font.md",
                        previousPath: null,
                    }),
                ],
                reviewRoot: tempDir,
                sessionId: "session-opencode",
                toolCallId: "tool-write-1",
                updatedAt: "2026-06-20T00:00:01.000Z",
            });
            expect(reconcileTrackedFiles).not.toHaveBeenCalled();

            service.handleNativeSessionEvent("window-1", {
                conflicts: [],
                kind: "review",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                trackedFiles: [],
                updatedAt: "2026-06-20T00:00:02.000Z",
            });

            const reviewEventUpdates = onSessionSnapshot.mock.calls.map(
                ([, update]) => update,
            );
            const latestTrackedFilesAfterReviewEvent = reviewEventUpdates
                .map((update) =>
                    update.kind === "snapshot"
                        ? update.snapshot
                        : update.patch.changes,
                )
                .findLast(
                    (snapshot) => snapshot.trackedFiles !== undefined,
                )?.trackedFiles;
            expect(latestTrackedFilesAfterReviewEvent).toEqual([
                expect.objectContaining({
                    path: "Fliege font.md",
                    reviewState: "pending",
                    toolCallId: "tool-write-1",
                }),
            ]);

            await service.rejectTrackedFile({
                path: "Fliege font.md",
                sessionId: "session-opencode",
            });

            expect(fs.readFileSync(editedPath, "utf8")).toBe("old text\n");
            expect(rejectTrackedFile).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("records flushed subagent tool diffs with inherited native review context", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-subagent-diff-"),
        );
        try {
            const editedPath = path.join(tempDir, "child.ts");
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const recordReviewDiffs = vi.fn<
                NonNullable<NativeAiGateway["recordReviewDiffs"]>
            >(() => Promise.resolve([]));
            const nativeAi = createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-parent",
                            status: "idle",
                            updatedAt: "2026-06-20T00:00:00.000Z",
                        }),
                ),
                recordReviewDiffs,
                sendPrompt: vi.fn<NativeAiGateway["sendPrompt"]>(({ input }) =>
                    Promise.resolve({
                        sessionId: input.sessionId,
                        stopReason: "accepted",
                    }),
                ),
            });
            const service = createService({
                nativeAi,
                projectRootPath: tempDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.sendPrompt(
                {
                    additionalRoots: [],
                    attachments: [],
                    messageId: "user-message-1",
                    projectId: "project-1",
                    prompt: "Delegate the edit.",
                    runtimeId: "opencode",
                    sessionId: "session-parent",
                    title: "Parent",
                    worktreeId: null,
                },
                "window-1",
            );
            service.handleNativeSessionEvent("window-1", {
                childRuntimeSessionId: "runtime-child",
                childSessionId: "session-parent:subagent:runtime-child",
                kind: "subagent-created",
                modelId: null,
                origin: "live",
                parentSessionId: "session-parent",
                runtimeId: "opencode",
                runtimeSessionId: "runtime-child",
                sessionId: "session-parent:subagent:runtime-child",
                title: "Child",
                updatedAt: "2026-06-20T00:00:01.000Z",
            });
            service.handleNativeSessionEvent("window-1", {
                activity: {
                    createdAt: "2026-06-20T00:00:02.000Z",
                    diffs: [
                        {
                            hunks: [],
                            isText: true,
                            kind: "update",
                            newText: "child agent\n",
                            oldText: "child base\n",
                            path: editedPath,
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                    exitCode: 0,
                    id: "tool-child-write-1",
                    kind: "edit",
                    locations: [],
                    rawInputJson: null,
                    rawOutputJson: null,
                    sessionId: "session-parent:subagent:runtime-child",
                    status: "completed",
                    summary: "Edited child.ts",
                    terminalOutput: null,
                    title: "Edited child.ts",
                    updatedAt: "2026-06-20T00:00:02.000Z",
                },
                kind: "tool-activity",
                origin: "live",
                parentSessionId: "session-parent",
                runtimeId: "opencode",
                runtimeSessionId: "runtime-child",
                sessionId: "session-parent:subagent:runtime-child",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });

            expect(recordReviewDiffs).toHaveBeenCalledWith({
                diffs: [
                    expect.objectContaining({
                        newText: "child agent\n",
                        oldText: "child base\n",
                        path: "child.ts",
                        previousPath: null,
                    }),
                ],
                reviewRoot: tempDir,
                sessionId: "session-parent:subagent:runtime-child",
                toolCallId: "tool-child-write-1",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("waits for terminal status before native review reconciliation", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-native-review-idle-"),
        );
        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            const trackedFile = createTrackedFile({
                path: "Fliege font.md",
                sessionId: "session-opencode",
            });
            const reconcileTrackedFiles = vi.fn(() =>
                Promise.resolve([trackedFile]),
            );
            const nativeAi = createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-opencode",
                            status: "idle",
                            updatedAt: "2026-06-20T00:00:00.000Z",
                        }),
                ),
                reconcileTrackedFiles,
                sendPrompt: vi.fn<NativeAiGateway["sendPrompt"]>(({ input }) =>
                    Promise.resolve({
                        sessionId: input.sessionId,
                        stopReason: "accepted",
                    }),
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                projectRootPath: tempDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.sendPrompt(
                {
                    additionalRoots: [],
                    attachments: [],
                    messageId: "user-message-1",
                    projectId: "project-1",
                    prompt: "Edit the file.",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            service.handleNativeSessionEvent("window-1", {
                activity: {
                    createdAt: "2026-06-20T00:00:01.000Z",
                    diffs: [
                        {
                            hunks: [],
                            isText: true,
                            kind: "update",
                            newText: "new text\n",
                            oldText: "old text\n",
                            path: path.join(tempDir, "Fliege font.md"),
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                    exitCode: 0,
                    id: "tool-write-1",
                    kind: "edit",
                    locations: [],
                    rawInputJson: null,
                    rawOutputJson: null,
                    sessionId: "session-opencode",
                    status: "completed",
                    summary: "Edited Fliege font.md",
                    terminalOutput: null,
                    title: "Edited Fliege font.md",
                    updatedAt: "2026-06-20T00:00:01.000Z",
                },
                kind: "tool-activity",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:01.000Z",
            });
            service.handleNativeSessionEvent("window-1", {
                activity: {
                    createdAt: "2026-06-20T00:00:01.000Z",
                    diffs: [],
                    exitCode: 0,
                    id: "acp:turn:user-message-1",
                    kind: "shell",
                    locations: [],
                    rawInputJson: null,
                    rawOutputJson: null,
                    sessionId: "session-opencode",
                    status: "completed",
                    summary: "Done",
                    terminalOutput: null,
                    title: "Done",
                    updatedAt: "2026-06-20T00:00:01.000Z",
                },
                kind: "tool-activity",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:01.000Z",
            });

            expect(reconcileTrackedFiles).not.toHaveBeenCalled();
            expect(
                onSessionSnapshot.mock.calls
                    .map(([, update]) =>
                        update.kind === "snapshot"
                            ? update.snapshot
                            : update.patch.changes,
                    )
                    .some((snapshot) =>
                        snapshot.trackedFiles?.some(
                            (file) =>
                                file.path === "Fliege font.md" &&
                                file.reviewState === "pending" &&
                                file.toolCallId === "tool-write-1",
                        ),
                    ),
            ).toBe(true);

            service.handleNativeSessionEvent("window-1", {
                activeTurnStartedAt: null,
                kind: "status",
                lastError: null,
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                status: "idle",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });

            await waitForAssertion(() => {
                expect(reconcileTrackedFiles).toHaveBeenCalledTimes(1);
                expect(
                    onSessionSnapshot.mock.calls.some(([, update]) =>
                        update.kind === "patch" &&
                        update.patch.changes.trackedFiles?.some(
                            (file) => file.path === "Fliege font.md",
                        ),
                    ),
                ).toBe(true);
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("keeps fallback review when native reconciliation finds no files", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-empty-reconcile-"),
        );
        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            const reconcileTrackedFiles = vi.fn(() => Promise.resolve([]));
            const nativeAi = createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-opencode",
                            status: "idle",
                            updatedAt: "2026-06-20T00:00:00.000Z",
                        }),
                ),
                reconcileTrackedFiles,
                sendPrompt: vi.fn<NativeAiGateway["sendPrompt"]>(({ input }) =>
                    Promise.resolve({
                        sessionId: input.sessionId,
                        stopReason: "accepted",
                    }),
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                projectRootPath: tempDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.sendPrompt(
                {
                    additionalRoots: [],
                    attachments: [],
                    messageId: "user-message-1",
                    projectId: "project-1",
                    prompt: "Edit the file.",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            service.handleNativeSessionEvent("window-1", {
                activity: {
                    createdAt: "2026-06-20T00:00:01.000Z",
                    diffs: [
                        {
                            hunks: [],
                            isText: true,
                            kind: "update",
                            newText: "new text\n",
                            oldText: "old text\n",
                            path: path.join(tempDir, "Fliege font.md"),
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                    exitCode: 0,
                    id: "tool-write-1",
                    kind: "edit",
                    locations: [],
                    rawInputJson: null,
                    rawOutputJson: null,
                    sessionId: "session-opencode",
                    status: "completed",
                    summary: "Edited Fliege font.md",
                    terminalOutput: null,
                    title: "Edited Fliege font.md",
                    updatedAt: "2026-06-20T00:00:01.000Z",
                },
                kind: "tool-activity",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:01.000Z",
            });
            service.handleNativeSessionEvent("window-1", {
                activeTurnStartedAt: null,
                kind: "status",
                lastError: null,
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                status: "idle",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });

            await waitForAssertion(() => {
                expect(reconcileTrackedFiles).toHaveBeenCalledTimes(1);
                const latestTrackedFiles = onSessionSnapshot.mock.calls
                    .map(([, update]) =>
                        update.kind === "snapshot"
                            ? update.snapshot.trackedFiles
                            : update.patch.changes.trackedFiles,
                    )
                    .findLast((trackedFiles) => trackedFiles !== undefined);
                expect(latestTrackedFiles).toEqual([
                    expect.objectContaining({
                        path: "Fliege font.md",
                        reviewState: "pending",
                        toolCallId: "tool-write-1",
                    }),
                ]);
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("records fallback review from a tool diff that arrives after native reconciliation", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-late-tool-diff-"),
        );
        try {
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            const reconcileTrackedFiles = vi.fn(() => Promise.resolve([]));
            const nativeAi = createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-opencode",
                            status: "idle",
                            updatedAt: "2026-06-20T00:00:00.000Z",
                        }),
                ),
                reconcileTrackedFiles,
                sendPrompt: vi.fn<NativeAiGateway["sendPrompt"]>(({ input }) =>
                    Promise.resolve({
                        sessionId: input.sessionId,
                        stopReason: "accepted",
                    }),
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                projectRootPath: tempDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.sendPrompt(
                {
                    additionalRoots: [],
                    attachments: [],
                    messageId: "user-message-1",
                    projectId: "project-1",
                    prompt: "Restore the file.",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            service.handleNativeSessionEvent("window-1", {
                activeTurnStartedAt: null,
                kind: "status",
                lastError: null,
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                status: "idle",
                updatedAt: "2026-06-20T00:00:01.000Z",
            });

            await waitForAssertion(() => {
                expect(reconcileTrackedFiles).toHaveBeenCalledTimes(1);
            });

            service.handleNativeSessionEvent("window-1", {
                activity: {
                    createdAt: "2026-06-20T00:00:02.000Z",
                    diffs: [
                        {
                            hunks: [],
                            isText: true,
                            kind: "update",
                            newText: "restored text\n",
                            oldText: "",
                            path: path.join(tempDir, "cuento.md"),
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                    exitCode: 0,
                    id: "tool-restore-1",
                    kind: "edit",
                    locations: [],
                    rawInputJson: null,
                    rawOutputJson: null,
                    sessionId: "session-opencode",
                    status: "completed",
                    summary: "Edited cuento.md",
                    terminalOutput: null,
                    title: "Edited cuento.md",
                    updatedAt: "2026-06-20T00:00:02.000Z",
                },
                kind: "tool-activity",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });

            const latestTrackedFiles = onSessionSnapshot.mock.calls
                .map(([, update]) =>
                    update.kind === "snapshot"
                        ? update.snapshot.trackedFiles
                        : update.patch.changes.trackedFiles,
                )
                .findLast((trackedFiles) => trackedFiles !== undefined);
            expect(latestTrackedFiles).toEqual([
                expect.objectContaining({
                    path: "cuento.md",
                    reviewState: "pending",
                    toolCallId: "tool-restore-1",
                }),
            ]);
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("keeps pending review from terminal tool diffs inside additional roots", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-additional-root-"),
        );
        try {
            const projectDir = path.join(tempDir, "project");
            const additionalRoot = path.join(tempDir, "external");
            fs.mkdirSync(projectDir, { recursive: true });
            fs.mkdirSync(additionalRoot, { recursive: true });
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            const reconcileTrackedFiles = vi.fn(() => Promise.resolve([]));
            const nativeAi = createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-opencode",
                            status: "idle",
                            updatedAt: "2026-06-20T00:00:00.000Z",
                        }),
                ),
                reconcileTrackedFiles,
                sendPrompt: vi.fn<NativeAiGateway["sendPrompt"]>(({ input }) =>
                    Promise.resolve({
                        sessionId: input.sessionId,
                        stopReason: "accepted",
                    }),
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                projectRootPath: projectDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.sendPrompt(
                {
                    additionalRoots: [additionalRoot],
                    attachments: [],
                    messageId: "user-message-1",
                    projectId: "project-1",
                    prompt: "Edit the external file.",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            const externalPath = path.join(additionalRoot, "External.md");
            service.handleNativeSessionEvent("window-1", {
                activity: {
                    createdAt: "2026-06-20T00:00:01.000Z",
                    diffs: [
                        {
                            hunks: [],
                            isText: true,
                            kind: "update",
                            newText: "new text\n",
                            oldText: "old text\n",
                            path: externalPath,
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                    exitCode: 0,
                    id: "tool-write-external",
                    kind: "edit",
                    locations: [],
                    rawInputJson: null,
                    rawOutputJson: null,
                    sessionId: "session-opencode",
                    status: "completed",
                    summary: "Edited External.md",
                    terminalOutput: null,
                    title: "Edited External.md",
                    updatedAt: "2026-06-20T00:00:01.000Z",
                },
                kind: "tool-activity",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:01.000Z",
            });

            await waitForAssertion(() => {
                const updates = onSessionSnapshot.mock.calls.map(
                    ([, update]) => update,
                );
                const latestSnapshot = updates
                    .map((update) =>
                        update.kind === "snapshot"
                            ? update.snapshot
                            : update.patch.changes,
                    )
                    .findLast(
                        (snapshot) => snapshot.trackedFiles !== undefined,
                    );
                expect(latestSnapshot?.trackedFiles).toEqual([
                    expect.objectContaining({
                        path: externalPath,
                        reviewState: "pending",
                    }),
                ]);
                expect(reconcileTrackedFiles).not.toHaveBeenCalled();
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });

    it("preserves additional-root fallback that arrives during native reconciliation", async () => {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-opencode-review-reconcile-race-"),
        );
        try {
            const projectDir = path.join(tempDir, "project");
            const additionalRoot = path.join(tempDir, "external");
            fs.mkdirSync(projectDir, { recursive: true });
            fs.mkdirSync(additionalRoot, { recursive: true });
            const binaryPath = writeExecutable(tempDir, "opencode");
            process.env.OPENCODE_API_KEY = "test-opencode-key";
            const onSessionSnapshot =
                vi.fn<(ownerWindowId: string, update: AiSessionUpdate) => void>();
            let resolveReconcile!: (
                trackedFiles: readonly AiTrackedFile[],
            ) => void;
            const reconcilePromise = new Promise<readonly AiTrackedFile[]>(
                (resolve) => {
                    resolveReconcile = resolve;
                },
            );
            const reconcileTrackedFiles = vi.fn(() => reconcilePromise);
            const nativeAi = createNativeAi({
                prepareSession: vi.fn<NativeAiGateway["prepareSession"]>(
                    ({ launch }) =>
                        Promise.resolve({
                            ...launch.persistedSnapshot,
                            runtimeSessionId: "runtime-opencode",
                            status: "idle",
                            updatedAt: "2026-06-20T00:00:00.000Z",
                        }),
                ),
                reconcileTrackedFiles,
                sendPrompt: vi.fn<NativeAiGateway["sendPrompt"]>(({ input }) =>
                    Promise.resolve({
                        sessionId: input.sessionId,
                        stopReason: "accepted",
                    }),
                ),
            });
            const service = createService({
                nativeAi,
                onSessionSnapshot,
                projectRootPath: projectDir,
                settingsService: createSettingsService({
                    loadOpenCodeRuntimeSettings: vi.fn(() =>
                        createOpenCodeSettings({
                            authMethod: "opencode-login",
                            binaryPath,
                        }),
                    ),
                }),
            });

            await service.sendPrompt(
                {
                    additionalRoots: [additionalRoot],
                    attachments: [],
                    messageId: "user-message-1",
                    projectId: "project-1",
                    prompt: "Edit the external file.",
                    runtimeId: "opencode",
                    sessionId: "session-opencode",
                    title: "OpenCode 1",
                    worktreeId: null,
                },
                "window-1",
            );
            service.handleNativeSessionEvent("window-1", {
                activeTurnStartedAt: null,
                kind: "status",
                lastError: null,
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                status: "idle",
                updatedAt: "2026-06-20T00:00:01.000Z",
            });
            await waitForAssertion(() => {
                expect(reconcileTrackedFiles).toHaveBeenCalledTimes(1);
            });

            const externalPath = path.join(additionalRoot, "External.md");
            service.handleNativeSessionEvent("window-1", {
                activity: {
                    createdAt: "2026-06-20T00:00:02.000Z",
                    diffs: [
                        {
                            hunks: [],
                            isText: true,
                            kind: "update",
                            newText: "new text\n",
                            oldText: "old text\n",
                            path: externalPath,
                            previousPath: null,
                            reversible: true,
                        },
                    ],
                    exitCode: 0,
                    id: "tool-write-external",
                    kind: "edit",
                    locations: [],
                    rawInputJson: null,
                    rawOutputJson: null,
                    sessionId: "session-opencode",
                    status: "completed",
                    summary: "Edited External.md",
                    terminalOutput: null,
                    title: "Edited External.md",
                    updatedAt: "2026-06-20T00:00:02.000Z",
                },
                kind: "tool-activity",
                origin: "live",
                parentSessionId: null,
                runtimeId: "opencode",
                runtimeSessionId: "runtime-opencode",
                sessionId: "session-opencode",
                updatedAt: "2026-06-20T00:00:02.000Z",
            });
            resolveReconcile([]);

            await waitForAssertion(() => {
                const updates = onSessionSnapshot.mock.calls.map(
                    ([, update]) => update,
                );
                const latestSnapshot = updates
                    .map((update) =>
                        update.kind === "snapshot"
                            ? update.snapshot
                            : update.patch.changes,
                    )
                    .findLast(
                        (snapshot) => snapshot.trackedFiles !== undefined,
                    );
                expect(latestSnapshot?.trackedFiles).toEqual([
                    expect.objectContaining({
                        path: externalPath,
                        reviewState: "pending",
                    }),
                ]);
            });
        } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
        }
    });
});

function createService(overrides: {
    readonly nativeAi?: NativeAiGateway;
    readonly onRuntimeStatus?: (status: AiRuntimeStatus) => void;
    readonly onSessionSnapshot?: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly persistence?: Partial<ConstructorParameters<typeof AiService>[0]["persistence"]>;
    readonly projectRootPath?: string;
    readonly settingsService?: unknown;
}): AiService {
    const persistence = {
        loadLatestRuntimeCatalog: vi.fn(() => null),
        loadRuntimeSelectionPreferences: vi.fn(() => ({
            configOptions: {},
            modeId: null,
            modelId: null,
        })),
        loadSessionSnapshot: vi.fn(() => null),
        saveRuntimeModePreference: vi.fn(),
        saveRuntimeModelPreference: vi.fn(),
        saveRuntimeSelectionPreferenceOption: vi.fn(),
        saveSessionSnapshot: vi.fn(),
        ...overrides.persistence,
    };

    return new AiService({
        nativeAi: overrides.nativeAi ?? null,
        onRuntimeStatus: overrides.onRuntimeStatus ?? vi.fn(),
        onSessionSnapshot: overrides.onSessionSnapshot ?? vi.fn(),
        persistence: persistence as never,
        projectService: {
            getProjectRootPath: vi.fn(
                () => overrides.projectRootPath ?? process.cwd(),
            ),
            listProjectWorktrees: vi.fn(() => []),
        } as never,
        secretStore: {
            cacheSecretPatches: vi.fn(),
            getStorageStatus: vi.fn(() => ({
                encryptionAvailable: true,
                isWeakBackend: false,
                message: null,
                platform: process.platform,
                selectedBackend: null,
            })),
            loadSecret: vi.fn(() => null),
            saveSecret: vi.fn(),
        },
        settingsService: (overrides.settingsService ??
            createSettingsService({})) as never,
    });
}

function createSettingsService(overrides: Record<string, unknown>) {
    return {
        loadClaudeRuntimeSettings: vi.fn(() => ({
            authInvalidatedAtMs: null,
            authMethod: null,
            bedrockGatewayBaseUrl: null,
            binaryPath: null,
            gatewayBaseUrl: null,
            hasAnthropicApiKey: false,
            hasGatewayAuthToken: false,
            hasGatewayCustomHeaders: false,
        })),
        loadCodexRuntimeSettings: vi.fn(() => ({
            authMethod: null,
            binaryPath: null,
            hasCodexApiKey: false,
            hasOpenAiApiKey: false,
        })),
        loadKiloRuntimeSettings: vi.fn(() => ({
            authInvalidatedAtMs: null,
            authMethod: null,
            binaryPath: null,
            hasKiloApiKey: false,
        })),
        loadOpenCodeRuntimeSettings: vi.fn(() => createOpenCodeSettings()),
        saveClaudeRuntimeSettings: vi.fn(),
        saveCodexRuntimeSettings: vi.fn(),
        saveKiloRuntimeSettings: vi.fn(),
        saveOpenCodeRuntimeSettings: vi.fn(),
        ...overrides,
    } as never;
}

function createNativeAi(
    overrides: Partial<NativeAiGateway> = {},
): NativeAiGateway {
    return {
        cancelSession: vi.fn(),
        captureReviewBaseline: vi.fn(() => Promise.resolve(true)),
        close: vi.fn(),
        closeOwnedByWindow: vi.fn(),
        closeSession: vi.fn(),
        deleteSession: vi.fn(),
        listSessionHistory: vi.fn(() => Promise.resolve([])),
        loadSessionSnapshot: vi.fn(() => Promise.resolve(null)),
        loadSessionTranscriptPage: vi.fn(() => Promise.resolve(null)),
        prepareSession: vi.fn(),
        recordReviewDiffs: vi.fn(() => Promise.resolve([])),
        reconcileTrackedFiles: vi.fn(() => Promise.resolve([])),
        renameSession: vi.fn(),
        respondPermission: vi.fn(),
        respondUserInput: vi.fn(),
        sendPrompt: vi.fn(),
        setSessionConfigOption: vi.fn(),
        setSessionMode: vi.fn(),
        setSessionModel: vi.fn(),
        setSessionPinned: vi.fn(),
        shouldHandleHistory: vi.fn(() => false),
        shouldHandleReview: vi.fn(() => true),
        shouldHandleRuntime: vi.fn((runtimeId) => runtimeId === "opencode"),
        ...overrides,
    };
}

function createOpenCodeSettings(
    overrides: Partial<OpenCodeRuntimeSettings> = {},
): OpenCodeRuntimeSettings {
    return {
        authInvalidatedAtMs: null,
        authMethod: null,
        binaryPath: null,
        ...overrides,
    };
}

function createSessionSnapshot(): AiSessionSnapshot {
    return {
        activeTurnStartedAt: null,
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        parentSessionId: null,
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: null,
        runtimeId: "opencode",
        runtimeSessionId: "runtime-opencode",
        sessionId: "session-opencode",
        status: "idle",
        title: "OpenCode 1",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-05-22T00:00:00.000Z",
        worktreeId: null,
    };
}

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    const path = overrides.path ?? "src/app.ts";
    return {
        currentText: "export const value = 2;\n",
        diffBase: "export const value = 1;\n",
        hunks: [],
        identityKey: `native:session-opencode::${path}`,
        isText: true,
        kind: "update",
        newText: "export const value = 2;\n",
        oldText: "export const value = 1;\n",
        path,
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-opencode",
        toolCallId: null,
        updatedAt: "2026-06-20T00:00:00.000Z",
        version: 1,
        ...overrides,
    };
}

function writeExecutable(dir: string, name: string): string {
    const binaryPath = path.join(dir, name);
    fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(binaryPath, 0o755);
    return binaryPath;
}

function createGitRepository(dir: string): void {
    execGitSync(dir, ["init"]);
    execGitSync(dir, ["config", "user.email", "test@example.com"]);
    execGitSync(dir, ["config", "user.name", "Test User"]);
}

function execGitSync(dir: string, args: readonly string[]): void {
    execFileSync("git", args, {
        cwd: dir,
        stdio: "ignore",
    });
}

async function waitForAssertion(
    assertion: () => void,
    timeoutMs = 1_000,
): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        try {
            assertion();
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    assertion();
}

function restoreEnv(name: string, value: string | undefined): void {
    if (typeof value === "string") {
        process.env[name] = value;
    } else {
        delete process.env[name];
    }
}
