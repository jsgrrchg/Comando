import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
    AiRuntimeId,
    AiRuntimeStatus,
    AppChangelogRelease,
    AppAiChatSettings,
    AppAppearanceSettings,
    AppPrivacyAccessState,
    ProjectSummary,
    AppUpdateState,
    AppEditorSettings,
    ChatFontFamily,
    ThemeMode,
    ThemePreset,
} from "@shared/ipc";

import {
    SettingsWindow,
    type RuntimeActionOption,
    type RuntimeCardOption,
} from "./components/settings";
import {
    saveAiChatSettings,
    saveAppEditorSettings,
    saveAppAppearanceSettings,
} from "./app/settings/client";
import {
    buildSelectableFontFamilyOptions,
    useAvailableFontFamilyIds,
} from "./app/hooks/use-available-font-family-options";
import {
    CHAT_FONT_FAMILY_OPTIONS,
    EDITOR_FONT_FAMILY_OPTIONS,
    getDefaultAiChatSettings,
    getDefaultAppAppearance,
    getDefaultAppEditorSettings,
    THEME_PRESET_OPTIONS,
} from "./app/settings/theme";
import { useResolvedAppearance } from "./app/hooks/use-resolved-appearance";
import { useSettingsStore } from "./app/store/settings-store";
import { shortcutDefinitions, formatShortcut } from "./app/shortcuts/registry";

export function SettingsApp() {
    const runtimeProjectId = useMemo(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get("projectId");
    }, []);
    const [appAppearance, setAppAppearance] = useState<AppAppearanceSettings>(
        getDefaultAppAppearance(),
    );
    const [appEditor, setAppEditor] = useState<AppEditorSettings>(
        getDefaultAppEditorSettings(),
    );
    const [aiChat, setAiChat] = useState<AppAiChatSettings>(
        getDefaultAiChatSettings(),
    );
    const [runtimeStatuses, setRuntimeStatuses] = useState<
        Record<AiRuntimeId, AiRuntimeStatus | null>
    >({
        claude: null,
        codex: null,
        gemini: null,
        kilo: null,
    });
    const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>({
        autoUpdatesEnabled: false,
        availableVersion: null,
        canCheckForUpdates: false,
        canInstallUpdate: false,
        currentVersion: "",
        downloadedVersion: null,
        lastCheckedAt: null,
        message: "Loading update status...",
        progressPercent: null,
        status: "unsupported",
    });
    const [appChangelog, setAppChangelog] = useState<
        readonly AppChangelogRelease[]
    >([]);
    const [appPrivacyAccessState, setAppPrivacyAccessState] =
        useState<AppPrivacyAccessState>({
            canOpenFullDiskAccessSettings: false,
            lastDeniedPath: null,
            lastUpdatedAt: null,
            message: "Loading privacy access status...",
            status: "not-applicable",
        });
    const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
    const [projectsError, setProjectsError] = useState<string | null>(null);
    const [projectsLoading, setProjectsLoading] = useState(true);
    const availableFontFamilyIds = useAvailableFontFamilyIds();
    const hydrateSettings = useSettingsStore((state) => state.hydrate);
    const settingsRevision = useSettingsStore((state) => state.revision);
    const storeAiChat = useSettingsStore((state) => state.aiChat);
    const storeAppAppearance = useSettingsStore((state) => state.appearance);
    const storeAppEditor = useSettingsStore((state) => state.editor);
    const latestSettingsRevisionRef = useRef(0);

    useResolvedAppearance();

    const loadRuntimeStatuses = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        const [codex, claude, gemini, kilo] = await Promise.all([
            window.comando.getAiRuntimeStatus("codex"),
            window.comando.getAiRuntimeStatus("claude"),
            window.comando.getAiRuntimeStatus("gemini"),
            window.comando.getAiRuntimeStatus("kilo"),
        ]);

        setRuntimeStatuses({
            claude,
            codex,
            gemini,
            kilo,
        });
    }, []);

    const loadAppUpdateState = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        const nextState = await window.comando.getAppUpdateState();
        setAppUpdateState(nextState);
    }, []);

    const loadAppChangelog = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        const releases = await window.comando.getAppChangelog();
        setAppChangelog(releases);
    }, []);

    const loadAppPrivacyAccessState = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        const nextState = await window.comando.getAppPrivacyAccessState();
        setAppPrivacyAccessState(nextState);
    }, []);

    const loadProjects = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        setProjectsLoading(true);
        try {
            const nextProjects = await window.comando.listProjects();
            setProjects(nextProjects);
            setProjectsError(null);
        } catch (error) {
            setProjectsError(
                error instanceof Error
                    ? error.message
                    : "Could not load projects.",
            );
        } finally {
            setProjectsLoading(false);
        }
    }, []);

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            void Promise.all([
                hydrateSettings(),
                loadRuntimeStatuses(),
                loadAppUpdateState(),
                loadAppChangelog(),
                loadAppPrivacyAccessState(),
                loadProjects(),
            ]);
        }, 0);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [
        hydrateSettings,
        loadAppChangelog,
        loadAppPrivacyAccessState,
        loadAppUpdateState,
        loadRuntimeStatuses,
        loadProjects,
    ]);

    useEffect(() => {
        if (!window.comando) {
            return undefined;
        }

        return window.comando.onProjectsUpdated((nextProjects) => {
            setProjects(nextProjects);
            setProjectsError(null);
            setProjectsLoading(false);
        });
    }, []);

    useEffect(() => {
        if (!window.comando) {
            return undefined;
        }

        return window.comando.onAppUpdateState((nextState) => {
            setAppUpdateState(nextState);
        });
    }, []);

    useEffect(() => {
        if (!window.comando) {
            return undefined;
        }

        return window.comando.onAppPrivacyAccessState((nextState) => {
            setAppPrivacyAccessState(nextState);
        });
    }, []);

    useEffect(() => {
        setAiChat(storeAiChat);
    }, [storeAiChat]);

    useEffect(() => {
        setAppAppearance(storeAppAppearance);
    }, [storeAppAppearance]);

    useEffect(() => {
        setAppEditor(storeAppEditor);
    }, [storeAppEditor]);

    useEffect(() => {
        if (settingsRevision <= 0) {
            return;
        }

        if (latestSettingsRevisionRef.current === 0) {
            latestSettingsRevisionRef.current = settingsRevision;
            return;
        }

        if (latestSettingsRevisionRef.current === settingsRevision) {
            return;
        }

        latestSettingsRevisionRef.current = settingsRevision;
        void loadRuntimeStatuses();
    }, [loadRuntimeStatuses, settingsRevision]);

    const handleAppThemeModeChange = (themeMode: ThemeMode) => {
        const nextAppearance = {
            ...appAppearance,
            themeMode,
        };

        setAppAppearance(nextAppearance);
        void saveAppAppearanceSettings(nextAppearance);
    };

    const handleAppFileTreeScaleChange = (fileTreeScale: number) => {
        const nextAppearance = {
            ...appAppearance,
            fileTreeScale,
        };

        setAppAppearance(nextAppearance);
        void saveAppAppearanceSettings(nextAppearance);
    };

    const handleAppAgentsSidebarScaleChange = (
        agentsSidebarScale: number,
    ) => {
        const nextAppearance = {
            ...appAppearance,
            agentsSidebarScale,
        };

        setAppAppearance(nextAppearance);
        void saveAppAppearanceSettings(nextAppearance);
    };

    const handleAppStickyFoldersEnabledChange = (
        stickyFoldersEnabled: boolean,
    ) => {
        const nextAppearance = {
            ...appAppearance,
            stickyFoldersEnabled,
        };

        setAppAppearance(nextAppearance);
        void saveAppAppearanceSettings(nextAppearance);
    };

    const handleAppThemePresetChange = (themePresetId: string) => {
        const nextAppearance = {
            ...appAppearance,
            themePreset: themePresetId as ThemePreset,
        };

        setAppAppearance(nextAppearance);
        void saveAppAppearanceSettings(nextAppearance);
    };

    const handleAppZoomFactorChange = (zoomFactor: number) => {
        const nextAppearance = {
            ...appAppearance,
            zoomFactor,
        };

        setAppAppearance(nextAppearance);
        void saveAppAppearanceSettings(nextAppearance);
    };

    const handleAppBoostCodeContrastChange = (boostCodeContrast: boolean) => {
        const nextAppearance = {
            ...appAppearance,
            boostCodeContrast,
        };

        setAppAppearance(nextAppearance);
        void saveAppAppearanceSettings(nextAppearance);
    };

    const handleAppEditorFontFamilyChange = (fontFamilyId: string) => {
        const nextEditor: AppEditorSettings = {
            ...appEditor,
            fontFamily: fontFamilyId as AppEditorSettings["fontFamily"],
        };

        setAppEditor(nextEditor);
        void saveAppEditorSettings(nextEditor);
    };

    const handleAppEditorAutoSaveDelayMsChange = (autoSaveDelayMs: number) => {
        const nextEditor: AppEditorSettings = {
            ...appEditor,
            autoSaveDelayMs,
        };

        setAppEditor(nextEditor);
        void saveAppEditorSettings(nextEditor);
    };

    const handleAppEditorFontSizeChange = (fontSize: number) => {
        const nextEditor: AppEditorSettings = {
            ...appEditor,
            fontSize,
        };

        setAppEditor(nextEditor);
        void saveAppEditorSettings(nextEditor);
    };

    const handleAppEditorLineHeightChange = (lineHeight: number) => {
        const nextEditor: AppEditorSettings = {
            ...appEditor,
            lineHeight,
        };

        setAppEditor(nextEditor);
        void saveAppEditorSettings(nextEditor);
    };

    const handleAppEditorMinimapEnabledChange = (minimapEnabled: boolean) => {
        const nextEditor: AppEditorSettings = {
            ...appEditor,
            minimapEnabled,
        };

        setAppEditor(nextEditor);
        void saveAppEditorSettings(nextEditor);
    };

    const handleAppEditorSuggestionsEnabledChange = (
        suggestionsEnabled: boolean,
    ) => {
        const nextEditor: AppEditorSettings = {
            ...appEditor,
            suggestionsEnabled,
        };

        setAppEditor(nextEditor);
        void saveAppEditorSettings(nextEditor);
    };

    const updateAiChat = (patch: Partial<AppAiChatSettings>) => {
        const next: AppAiChatSettings = { ...aiChat, ...patch };
        setAiChat(next);
        void saveAiChatSettings(next);
    };

    const runtimes = useMemo<readonly RuntimeCardOption[]>(
        () =>
            (["codex", "claude", "gemini", "kilo"] as const).map((runtimeId) =>
                mapRuntimeCard(runtimeId, runtimeStatuses[runtimeId]),
            ),
        [runtimeStatuses],
    );
    const appEditorFontFamilies = useMemo(
        () =>
            buildSelectableFontFamilyOptions(
                EDITOR_FONT_FAMILY_OPTIONS,
                availableFontFamilyIds,
                appEditor.fontFamily,
            ),
        [availableFontFamilyIds, appEditor.fontFamily],
    );
    const chatFontFamilies = useMemo(
        () =>
            buildSelectableFontFamilyOptions(
                CHAT_FONT_FAMILY_OPTIONS,
                availableFontFamilyIds,
                aiChat.chatFontFamily,
            ),
        [aiChat.chatFontFamily, availableFontFamilyIds],
    );
    const composerFontFamilies = useMemo(
        () =>
            buildSelectableFontFamilyOptions(
                CHAT_FONT_FAMILY_OPTIONS,
                availableFontFamilyIds,
                aiChat.composerFontFamily,
            ),
        [aiChat.composerFontFamily, availableFontFamilyIds],
    );
    const shortcuts = useMemo(
        () =>
            shortcutDefinitions.map((shortcut) => ({
                description: shortcut.description,
                id: shortcut.id,
                keys: formatShortcut(shortcut.id),
                label: shortcut.label,
                section: shortcut.section,
            })),
        [],
    );

    const runProjectAction = useCallback(
        async (action: () => Promise<void>, fallbackMessage: string) => {
            if (!window.comando) {
                return;
            }

            setProjectsLoading(true);
            try {
                await action();
                await loadProjects();
            } catch (error) {
                setProjectsError(
                    error instanceof Error ? error.message : fallbackMessage,
                );
            } finally {
                setProjectsLoading(false);
            }
        },
        [loadProjects],
    );

    return (
        <SettingsWindow
            aiChat={{
                chatFontFamily: aiChat.chatFontFamily,
                chatFontFamilies: chatFontFamilies,
                chatFontSize: aiChat.chatFontSize,
                composerFontFamily: aiChat.composerFontFamily,
                composerFontFamilies: composerFontFamilies,
                composerFontSize: aiChat.composerFontSize,
                requireCmdEnterToSend: aiChat.requireCmdEnterToSend,
                screenshotRetentionSeconds: aiChat.screenshotRetentionSeconds,
                historyRetentionDays: aiChat.historyRetentionDays,
                contextUsageBarEnabled: aiChat.contextUsageBarEnabled,
                onChatFontFamilyChange: (id) =>
                    updateAiChat({
                        chatFontFamily: id as ChatFontFamily,
                    }),
                onChatFontSizeChange: (size) =>
                    updateAiChat({ chatFontSize: size }),
                onComposerFontFamilyChange: (id) =>
                    updateAiChat({
                        composerFontFamily: id as ChatFontFamily,
                    }),
                onComposerFontSizeChange: (size) =>
                    updateAiChat({ composerFontSize: size }),
                onRequireCmdEnterChange: (value) =>
                    updateAiChat({ requireCmdEnterToSend: value }),
                onScreenshotRetentionChange: (seconds) =>
                    updateAiChat({ screenshotRetentionSeconds: seconds }),
                onHistoryRetentionChange: (days) =>
                    updateAiChat({ historyRetentionDays: days }),
                onContextUsageBarEnabledChange: (value) =>
                    updateAiChat({ contextUsageBarEnabled: value }),
            }}
            appAppearance={{
                agentsSidebarScale: appAppearance.agentsSidebarScale,
                boostCodeContrast: appAppearance.boostCodeContrast,
                fileTreeScale: appAppearance.fileTreeScale,
                mode: appAppearance.themeMode,
                onAgentsSidebarScaleChange:
                    handleAppAgentsSidebarScaleChange,
                onBoostCodeContrastChange: handleAppBoostCodeContrastChange,
                onFileTreeScaleChange: handleAppFileTreeScaleChange,
                onModeChange: handleAppThemeModeChange,
                onPresetChange: handleAppThemePresetChange,
                onStickyFoldersEnabledChange:
                    handleAppStickyFoldersEnabledChange,
                onZoomFactorChange: handleAppZoomFactorChange,
                presetId: appAppearance.themePreset,
                presets: THEME_PRESET_OPTIONS.map((preset) => ({
                    description: preset.description,
                    id: preset.id,
                    label: preset.label,
                    swatches: preset.swatches,
                })),
                stickyFoldersEnabled: appAppearance.stickyFoldersEnabled,
                zoomFactor: appAppearance.zoomFactor,
            }}
            appEditor={{
                autoSaveDelayMs: appEditor.autoSaveDelayMs,
                fontFamilies: appEditorFontFamilies.map((fontFamily) => ({
                    description: fontFamily.description,
                    disabled: fontFamily.disabled,
                    group: fontFamily.group,
                    id: fontFamily.id,
                    label: fontFamily.label,
                    preview: fontFamily.preview,
                })),
                fontFamilyId: appEditor.fontFamily,
                fontSize: appEditor.fontSize,
                lineHeight: appEditor.lineHeight,
                minimapEnabled: appEditor.minimapEnabled,
                suggestionsEnabled: appEditor.suggestionsEnabled,
                onAutoSaveDelayMsChange: handleAppEditorAutoSaveDelayMsChange,
                onFontFamilyChange: handleAppEditorFontFamilyChange,
                onFontSizeChange: handleAppEditorFontSizeChange,
                onLineHeightChange: handleAppEditorLineHeightChange,
                onMinimapEnabledChange: handleAppEditorMinimapEnabledChange,
                onSuggestionsEnabledChange:
                    handleAppEditorSuggestionsEnabledChange,
            }}
            privacy={{
                onOpenFullDiskAccessSettings: () => {
                    if (!window.comando) {
                        return;
                    }

                    void window.comando.openMacOsFullDiskAccessSettings();
                },
                state: appPrivacyAccessState,
            }}
            projects={{
                error: projectsError,
                loading: projectsLoading,
                onAddProject: () => {
                    void runProjectAction(async () => {
                        await window.comando?.openProjects();
                    }, "Could not add projects.");
                },
                onClearAppData: (projectId) => {
                    void runProjectAction(async () => {
                        await window.comando?.clearProjectAppData({
                            projectId,
                        });
                    }, "Could not clear this project's app data.");
                },
                onGetAppDataSummary: async (projectId) => {
                    if (!window.comando) {
                        return {
                            chatSessionCount: 0,
                            projectSettingsCount: 0,
                            recentProjectCount: 0,
                            workspaceLayoutCount: 0,
                            workspaceSessionCount: 0,
                            workspaceTabCount: 0,
                        };
                    }

                    return await window.comando.getProjectAppDataSummary(
                        projectId,
                    );
                },
                onRelocateProject: (projectId) => {
                    void runProjectAction(async () => {
                        await window.comando?.relocateProject(projectId);
                    }, "Could not change this project's location.");
                },
                onRemoveProject: (projectId) => {
                    void runProjectAction(async () => {
                        await window.comando?.removeProject(projectId);
                    }, "Could not remove this project.");
                },
                onRevealProject: (projectId) => {
                    void runProjectAction(async () => {
                        await window.comando?.revealProjectEntry({
                            projectId,
                            relativePath: null,
                        });
                    }, "Could not reveal this project.");
                },
                projects: projects.map((project) => ({
                    id: project.id,
                    lastOpenedAt: project.lastOpenedAt,
                    name: project.name,
                    rootPath: project.rootPath,
                })),
            }}
            onRuntimeAction={(runtimeId, actionId) =>
                void handleRuntimeAction({
                    actionId,
                    loadRuntimeStatuses,
                    runtimeId: runtimeId as AiRuntimeId,
                    runtimeStatuses,
                    projectId: runtimeProjectId,
                })
            }
            shortcuts={shortcuts}
            runtimes={runtimes}
            updates={{
                changelog: appChangelog,
                onCheckForUpdates: () => {
                    if (!window.comando) {
                        return;
                    }

                    void window.comando.checkForAppUpdates();
                },
                onInstallUpdate: () => {
                    if (!window.comando) {
                        return;
                    }

                    void window.comando.installAppUpdateAndRestart();
                },
                state: appUpdateState,
            }}
        />
    );
}

async function handleRuntimeAction(options: {
    readonly actionId: string;
    readonly loadRuntimeStatuses: () => Promise<void>;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly runtimeStatuses: Record<AiRuntimeId, AiRuntimeStatus | null>;
}): Promise<void> {
    if (!window.comando) {
        return;
    }

    if (options.actionId === "refresh") {
        await options.loadRuntimeStatuses();
        return;
    }

    if (options.actionId === "logout") {
        await window.comando.logoutAiRuntimeAuth({
            runtimeId: options.runtimeId,
        });
        await options.loadRuntimeStatuses();
        return;
    }

    if (options.actionId !== "connect") {
        return;
    }

    const runtimeStatus = options.runtimeStatuses[options.runtimeId];
    const methodId =
        options.runtimeId === "codex"
            ? getCodexLaunchAuthMethodId(runtimeStatus)
            : (runtimeStatus?.authMethods[0]?.id ??
              runtimeStatus?.authMethod ??
              null);

    if (!methodId) {
        return;
    }

    await window.comando.launchAiRuntimeAuth({
        methodId,
        projectId: options.projectId,
        runtimeId: options.runtimeId,
    });
    await options.loadRuntimeStatuses();
}

function mapRuntimeCard(
    runtimeId: AiRuntimeId,
    status: AiRuntimeStatus | null,
): RuntimeCardOption {
    if (!status) {
        return {
            actions: [
                {
                    id: "refresh",
                    label: "Refresh",
                },
            ],
            details: "Status not loaded yet.",
            id: runtimeId,
            name: getRuntimeName(runtimeId),
            status: "Unknown",
        };
    }

    const actions: RuntimeActionOption[] = [];
    if (status.runtimeId === "codex") {
        if (status.authReady) {
            actions.push({
                id: "logout",
                label: "Log out",
                tone: "danger",
            });
        } else {
            actions.push({
                id: "connect",
                label: "Connect",
                tone: "primary",
            });
        }
    } else if (!status.authReady) {
        actions.push({
            id: "connect",
            label: "Connect",
            tone: "primary",
        });
    }
    actions.push({
        id: "refresh",
        label: "Refresh",
    });

    return {
        actions,
        description: getRuntimeDescription(status.runtimeId),
        details:
            status.message ??
            status.command ??
            (status.source ? "Source: " + status.source : "No details yet."),
        id: status.runtimeId,
        name: getRuntimeName(status.runtimeId),
        source: status.source ?? "unknown",
        status: formatRuntimeStatus(status),
    };
}

function getRuntimeName(runtimeId: AiRuntimeId): string {
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

function getRuntimeDescription(runtimeId: AiRuntimeId): string {
    switch (runtimeId) {
        case "claude":
            return "Claude authentication and binary setup.";
        case "gemini":
            return "Gemini CLI auth and Google-backed runtime setup.";
        case "kilo":
            return "Kilo CLI discovery and sign-in status from the local runtime.";
        case "codex":
        default:
            return "Codex runtime discovery and binary path.";
    }
}

function formatRuntimeStatus(status: AiRuntimeStatus): string {
    if (status.state === "ready") {
        return status.authReady ? "Ready" : "Needs auth";
    }

    if (status.state === "missing") {
        return "Missing";
    }

    return "Needs attention";
}

function getCodexLaunchAuthMethodId(
    status: AiRuntimeStatus | null,
): string | null {
    if (!status) {
        return null;
    }

    if (
        status.authMethod === "chatgpt" ||
        status.authMethod === "codex-api-key" ||
        status.authMethod === "openai-api-key"
    ) {
        return status.authMethod;
    }

    const nextMethod = status.authMethods.find(
        (method) =>
            method.id === "chatgpt" ||
            method.id === "codex-api-key" ||
            method.id === "openai-api-key",
    );

    return nextMethod?.id ?? "chatgpt";
}
