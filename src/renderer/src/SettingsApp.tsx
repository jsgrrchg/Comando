import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
    AiEnvironmentDiagnostics,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSettingsSnapshot,
    AppChangelogRelease,
    AppAiChatSettings,
    AppAppearanceSettings,
    AppPrivacyAccessState,
    AppTerminalSettings,
    ClaudeRuntimeSettingsInput,
    CodexRuntimeSettingsInput,
    ProjectSummary,
    AppUpdateState,
    AppEditorSettings,
    ChatFontFamily,
    GeminiRuntimeSettingsInput,
    GrokRuntimeSettingsInput,
    GitHubAuthStatus,
    KiloRuntimeSettingsInput,
    OpenCodeRuntimeSettingsInput,
    ThemeMode,
    ThemePreset,
} from "@shared/ipc";

import {
    SettingsWindow,
    type AiProviderDiagnosticEntry,
    type AiProviderDiagnosticsState,
    type AiProviderId,
    type AiProviderRuntimeStatus,
    type AiProviderRuntimeSettingsInput,
} from "./components/settings";
import {
    saveAiChatSettings,
    saveAppEditorSettings,
    saveAppAppearanceSettings,
    saveAppTerminalSettings,
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
import {
    DEFAULT_APP_TERMINAL_SETTINGS,
    normalizeAppTerminalSettings,
} from "@shared/terminal-settings";
import { useResolvedAppearance } from "./app/hooks/use-resolved-appearance";
import { useSettingsStore } from "./app/store/settings-store";
import { shortcutDefinitions, formatShortcut } from "./app/shortcuts/registry";

const AI_PROVIDER_RUNTIME_IDS = [
    "codex",
    "claude",
    "gemini",
    "grok",
    "kilo",
    "opencode",
] as const satisfies readonly AiProviderId[];

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
    const [terminal, setTerminal] = useState<AppTerminalSettings>(
        DEFAULT_APP_TERMINAL_SETTINGS,
    );
    const [isWindows, setIsWindows] = useState(false);
    const [pwshAvailable, setPwshAvailable] = useState<boolean | null>(null);
    const [runtimeStatuses, setRuntimeStatuses] = useState<
        Record<AiRuntimeId, AiRuntimeStatus | null>
    >({
        claude: null,
        codex: null,
        gemini: null,
        grok: null,
        kilo: null,
        opencode: null,
    });
    const [runtimeSettings, setRuntimeSettings] =
        useState<AiSettingsSnapshot | null>(null);
    const [savingRuntimeId, setSavingRuntimeId] =
        useState<AiProviderId | null>(null);
    const [runtimeErrorById, setRuntimeErrorById] = useState<
        Partial<Record<AiProviderId, string | null>>
    >({});
    const [environmentDiagnostics, setEnvironmentDiagnostics] =
        useState<AiEnvironmentDiagnostics | null>(null);
    const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
    const [diagnosticsError, setDiagnosticsError] = useState<string | null>(
        null,
    );
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
    const [githubAuthStatus, setGitHubAuthStatus] =
        useState<GitHubAuthStatus>(() => createDefaultGitHubAuthStatus());
    const [githubTokenDraft, setGitHubTokenDraft] = useState("");
    const [githubLoading, setGitHubLoading] = useState(true);
    const [githubSaving, setGitHubSaving] = useState(false);
    const [githubError, setGitHubError] = useState<string | null>(null);
    const [githubNotice, setGitHubNotice] = useState<string | null>(null);
    const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
    const [projectsError, setProjectsError] = useState<string | null>(null);
    const [projectsLoading, setProjectsLoading] = useState(true);
    const availableFontFamilyIds = useAvailableFontFamilyIds();
    const hydrateSettings = useSettingsStore((state) => state.hydrate);
    const settingsRevision = useSettingsStore((state) => state.revision);
    const storeAiChat = useSettingsStore((state) => state.aiChat);
    const storeAppAppearance = useSettingsStore((state) => state.appearance);
    const storeAppEditor = useSettingsStore((state) => state.editor);
    const storeTerminal = useSettingsStore((state) => state.terminal);
    const latestSettingsRevisionRef = useRef(0);

    useResolvedAppearance();

    useEffect(() => {
        if (!window.comando) {
            return;
        }

        let cancelled = false;
        void window.comando.getBootstrapSnapshot().then((snapshot) => {
            if (!cancelled) {
                setIsWindows(snapshot.platform === "win32");
                if (snapshot.platform === "win32") {
                    void window.comando
                        .checkCommandAvailability({ name: "pwsh" })
                        .then((result) => {
                            if (!cancelled) {
                                setPwshAvailable(result.found);
                            }
                        })
                        .catch(() => {
                            if (!cancelled) {
                                setPwshAvailable(false);
                            }
                        });
                } else {
                    setPwshAvailable(null);
                }
                document.documentElement.setAttribute(
                    "data-platform",
                    snapshot.platform,
                );
                if (snapshot.platform === "win32") {
                    const windowsAcrylic =
                        snapshot.windowEffects?.windowsAcrylic ?? false;
                    document.documentElement.setAttribute(
                        "data-windows-acrylic",
                        windowsAcrylic ? "true" : "false",
                    );
                } else {
                    document.documentElement.removeAttribute(
                        "data-windows-acrylic",
                    );
                }
            }
        });

        return () => {
            cancelled = true;
            document.documentElement.removeAttribute("data-windows-acrylic");
        };
    }, []);

    const loadRuntimeStatuses = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        const [settingsSnapshot, codex, claude, gemini, grok, kilo, opencode] =
            await Promise.all([
                window.comando.getSettingsSnapshot(),
                window.comando.getAiRuntimeStatus("codex"),
                window.comando.getAiRuntimeStatus("claude"),
                window.comando.getAiRuntimeStatus("gemini"),
                window.comando.getAiRuntimeStatus("grok"),
                window.comando.getAiRuntimeStatus("kilo"),
                window.comando.getAiRuntimeStatus("opencode"),
            ]);

        setRuntimeSettings(settingsSnapshot.ai ?? null);
        setRuntimeStatuses({
            claude,
            codex,
            gemini,
            grok,
            kilo,
            opencode,
        });
    }, []);

    const loadEnvironmentDiagnostics = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        setDiagnosticsLoading(true);
        try {
            const diagnostics =
                await window.comando.getAiEnvironmentDiagnostics();
            setEnvironmentDiagnostics(diagnostics);
            setDiagnosticsError(null);
        } catch (error) {
            setDiagnosticsError(
                error instanceof Error
                    ? error.message
                    : "Could not load AI runtime diagnostics.",
            );
        } finally {
            setDiagnosticsLoading(false);
        }
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

    const loadGitHubAuthStatus = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        setGitHubLoading(true);
        try {
            const nextStatus = await window.comando.getGitHubAuthStatus({
                host: "github.com",
            });
            setGitHubAuthStatus(nextStatus);
            setGitHubError(null);
        } catch (error) {
            setGitHubError(
                error instanceof Error
                    ? error.message
                    : "Could not load GitHub auth status.",
            );
        } finally {
            setGitHubLoading(false);
        }
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
                loadEnvironmentDiagnostics(),
                loadAppUpdateState(),
                loadAppChangelog(),
                loadAppPrivacyAccessState(),
                loadGitHubAuthStatus(),
                loadProjects(),
            ]);
        }, 0);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [
        hydrateSettings,
        loadAppChangelog,
        loadEnvironmentDiagnostics,
        loadAppPrivacyAccessState,
        loadAppUpdateState,
        loadGitHubAuthStatus,
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
        setTerminal(storeTerminal);
    }, [storeTerminal]);

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
        void loadEnvironmentDiagnostics();
    }, [loadEnvironmentDiagnostics, loadRuntimeStatuses, settingsRevision]);

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

    const handleAppEditorRelativeLineNumbersEnabledChange = (
        relativeLineNumbersEnabled: boolean,
    ) => {
        const nextEditor: AppEditorSettings = {
            ...appEditor,
            relativeLineNumbersEnabled,
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

    const handleAppEditorVimModeEnabledChange = (vimModeEnabled: boolean) => {
        const nextEditor: AppEditorSettings = {
            ...appEditor,
            vimModeEnabled,
        };

        setAppEditor(nextEditor);
        void saveAppEditorSettings(nextEditor);
    };

    const updateAiChat = (patch: Partial<AppAiChatSettings>) => {
        const next: AppAiChatSettings = { ...aiChat, ...patch };
        setAiChat(next);
        void saveAiChatSettings(next);
    };

    const updateTerminal = (patch: Partial<AppTerminalSettings>) => {
        const next = normalizeAppTerminalSettings({
            ...terminal,
            ...patch,
        });
        setTerminal(next);
        void saveAppTerminalSettings(next);
    };

    const runProviderSettingsAction = useCallback(
        async (providerId: AiProviderId, action: () => Promise<void>) => {
            if (!window.comando) {
                throw new Error("Comando API is not available.");
            }

            setRuntimeErrorById((current) => ({
                ...current,
                [providerId]: null,
            }));
            setSavingRuntimeId(providerId);
            try {
                await action();
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : "Could not update AI provider settings.";
                setRuntimeErrorById((current) => ({
                    ...current,
                    [providerId]: message,
                }));
                throw error;
            } finally {
                setSavingRuntimeId(null);
            }
        },
        [],
    );

    const saveAiProviderSettings = useCallback(
        async (
            runtimeId: AiProviderId,
            settings: AiProviderRuntimeSettingsInput,
        ): Promise<AiRuntimeStatus> => {
            switch (runtimeId) {
                case "claude":
                    return await window.comando.saveClaudeRuntimeSettings(
                        settings as ClaudeRuntimeSettingsInput,
                    );
                case "codex":
                    return await window.comando.saveCodexRuntimeSettings(
                        settings as CodexRuntimeSettingsInput,
                    );
                case "gemini":
                    return await window.comando.saveGeminiRuntimeSettings(
                        settings as GeminiRuntimeSettingsInput,
                    );
                case "grok":
                    return await window.comando.saveGrokRuntimeSettings(
                        settings as GrokRuntimeSettingsInput,
                    );
                case "kilo":
                    return await window.comando.saveKiloRuntimeSettings(
                        settings as KiloRuntimeSettingsInput,
                    );
                case "opencode":
                    return await window.comando.saveOpenCodeRuntimeSettings(
                        settings as OpenCodeRuntimeSettingsInput,
                    );
            }
        },
        [],
    );

    const refreshProviderSettingsState = useCallback(
        async (runtimeId: AiProviderId, status: AiRuntimeStatus) => {
            const snapshot = await window.comando.getSettingsSnapshot();
            setRuntimeSettings(snapshot.ai ?? null);
            setRuntimeStatuses((current) => ({
                ...current,
                [runtimeId]: status,
            }));
            await loadEnvironmentDiagnostics();
        },
        [loadEnvironmentDiagnostics],
    );

    const aiProviderDiagnostics = useMemo<AiProviderDiagnosticsState>(
        () =>
            mapEnvironmentDiagnostics(
                environmentDiagnostics,
                diagnosticsLoading,
                diagnosticsError,
            ),
        [environmentDiagnostics, diagnosticsError, diagnosticsLoading],
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

    const handleGitHubSaveToken = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        const token = githubTokenDraft.trim();
        if (!token) {
            return;
        }

        setGitHubSaving(true);
        setGitHubError(null);
        setGitHubNotice(null);
        try {
            const nextStatus = await window.comando.saveGitHubToken({
                host: "github.com",
                token,
            });
            setGitHubAuthStatus(nextStatus);
            setGitHubTokenDraft("");
            setGitHubNotice("Token saved securely on this machine.");
        } catch (error) {
            setGitHubError(
                error instanceof Error
                    ? error.message
                    : "Could not save GitHub token. Secure storage may be unavailable on this machine.",
            );
        } finally {
            setGitHubSaving(false);
            setGitHubLoading(false);
        }
    }, [githubTokenDraft]);

    const handleGitHubDisconnect = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        if (githubAuthStatus.tokenSource === "gh_cli") {
            setGitHubNotice("Use gh auth logout to revoke gh CLI access.");
            return;
        }

        if (
            !window.confirm(
                "Disconnect GitHub?\n\nThis removes the saved token from this machine.",
            )
        ) {
            return;
        }

        setGitHubLoading(true);
        setGitHubError(null);
        setGitHubNotice(null);
        try {
            const nextStatus = await window.comando.clearGitHubToken({
                host: "github.com",
            });
            setGitHubAuthStatus(nextStatus);
            setGitHubTokenDraft("");
            setGitHubNotice(
                nextStatus.tokenSource === "gh_cli"
                    ? "Stored GitHub token removed. Using gh CLI fallback."
                    : "GitHub token removed from this machine.",
            );
        } catch (error) {
            setGitHubError(
                error instanceof Error
                    ? error.message
                    : "Could not disconnect GitHub.",
            );
        } finally {
            setGitHubLoading(false);
        }
    }, [githubAuthStatus.tokenSource]);

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
                toolCardExpansionMode: aiChat.toolCardExpansionMode,
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
                onToolCardExpansionModeChange: (value) =>
                    updateAiChat({ toolCardExpansionMode: value }),
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
                relativeLineNumbersEnabled:
                    appEditor.relativeLineNumbersEnabled,
                suggestionsEnabled: appEditor.suggestionsEnabled,
                vimModeEnabled: appEditor.vimModeEnabled,
                onAutoSaveDelayMsChange: handleAppEditorAutoSaveDelayMsChange,
                onFontFamilyChange: handleAppEditorFontFamilyChange,
                onFontSizeChange: handleAppEditorFontSizeChange,
                onLineHeightChange: handleAppEditorLineHeightChange,
                onMinimapEnabledChange: handleAppEditorMinimapEnabledChange,
                onRelativeLineNumbersEnabledChange:
                    handleAppEditorRelativeLineNumbersEnabledChange,
                onSuggestionsEnabledChange:
                    handleAppEditorSuggestionsEnabledChange,
                onVimModeEnabledChange: handleAppEditorVimModeEnabledChange,
            }}
            terminal={{
                claudeCodeAvailable: null,
                claudeCodeContinueSession: terminal.claudeCodeContinueSession,
                claudeCodeMaxTurns: terminal.claudeCodeMaxTurns,
                claudeCodeModel: terminal.claudeCodeModel,
                claudeCodeOptimized: terminal.claudeCodeOptimized,
                claudeCodeSkipPermissions: terminal.claudeCodeSkipPermissions,
                isWindows,
                onClaudeCodeContinueSessionChange: (value) =>
                    updateTerminal({ claudeCodeContinueSession: value }),
                onClaudeCodeMaxTurnsChange: (value) =>
                    updateTerminal({ claudeCodeMaxTurns: value }),
                onClaudeCodeModelChange: (value) =>
                    updateTerminal({ claudeCodeModel: value }),
                onClaudeCodeOptimizedChange: (value) =>
                    updateTerminal({ claudeCodeOptimized: value }),
                onClaudeCodeSkipPermissionsChange: (value) =>
                    updateTerminal({ claudeCodeSkipPermissions: value }),
                onTerminalFontFamilyChange: (value) =>
                    updateTerminal({ terminalFontFamily: value }),
                onTerminalFontSizeChange: (value) =>
                    updateTerminal({ terminalFontSize: value }),
                onWindowsShellChange: (value) =>
                    updateTerminal({ windowsShell: value }),
                pwshAvailable,
                terminalFontFamily: terminal.terminalFontFamily,
                terminalFontSize: terminal.terminalFontSize,
                windowsShell: terminal.windowsShell,
            }}
            aiProviders={{
                busyProviderId: savingRuntimeId,
                diagnostics: aiProviderDiagnostics,
                errorByProviderId: runtimeErrorById,
                onDisconnectAuth: async (runtimeId) => {
                    if (
                        !window.confirm(
                            "Disconnect from Comando? This removes Comando-managed credentials or marks external login as signed out. Active sessions may keep credentials loaded at launch.",
                        )
                    ) {
                        return;
                    }

                    await runProviderSettingsAction(runtimeId, async () => {
                        const status =
                            await window.comando.disconnectAiRuntimeAuth({
                                runtimeId,
                            });
                        await refreshProviderSettingsState(runtimeId, status);
                    });
                },
                onLaunchAuth: async (runtimeId, authMethod) => {
                    await runProviderSettingsAction(runtimeId, async () => {
                        await window.comando.launchAiRuntimeAuth({
                            methodId: authMethod,
                            projectId: runtimeProjectId,
                            runtimeId,
                        });
                        await loadRuntimeStatuses();
                        await loadEnvironmentDiagnostics();
                    });
                },
                onLogoutAuth: async (runtimeId) => {
                    if (
                        !window.confirm(
                            "Log out from the provider? If the remote logout fails, Comando will keep local credentials unchanged.",
                        )
                    ) {
                        return;
                    }

                    await runProviderSettingsAction(runtimeId, async () => {
                        const status = await window.comando.logoutAiRuntimeAuth({
                            runtimeId,
                        });
                        await refreshProviderSettingsState(runtimeId, status);
                    });
                },
                onRefreshDiagnostics: loadEnvironmentDiagnostics,
                onSaveProviderSettings: async (runtimeId, settings) => {
                    await runProviderSettingsAction(runtimeId, async () => {
                        const status = await saveAiProviderSettings(
                            runtimeId,
                            settings,
                        );
                        await refreshProviderSettingsState(runtimeId, status);
                    });
                },
                onVerifyRuntime: async (runtimeId) => {
                    await runProviderSettingsAction(runtimeId, async () => {
                        const status =
                            await window.comando.getAiRuntimeStatus(runtimeId);
                        setRuntimeStatuses((current) => ({
                            ...current,
                            [runtimeId]: status,
                        }));
                        await loadEnvironmentDiagnostics();
                    });
                },
                runtimeSettings: runtimeSettings ?? undefined,
                runtimeStatuses: mapProviderRuntimeStatuses(runtimeStatuses),
            }}
            github={{
                error: githubError,
                loading: githubLoading,
                notice: githubNotice,
                onDisconnect: () => {
                    void handleGitHubDisconnect();
                },
                onRefresh: () => {
                    void loadGitHubAuthStatus();
                },
                onSaveToken: () => {
                    void handleGitHubSaveToken();
                },
                onTokenDraftChange: (value) => {
                    setGitHubTokenDraft(value);
                    setGitHubError(null);
                    setGitHubNotice(null);
                },
                saving: githubSaving,
                status: githubAuthStatus,
                tokenDraft: githubTokenDraft,
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
            shortcuts={shortcuts}
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

function createDefaultGitHubAuthStatus(): GitHubAuthStatus {
    return {
        canReadActions: false,
        canWriteActions: false,
        canWriteIssues: false,
        canWritePullRequests: false,
        checkedAt: new Date().toISOString(),
        errorCode: "missing_auth",
        host: "github.com",
        readOnly: true,
        state: "missing",
        tokenSource: null,
        user: null,
    };
}

function getRuntimeName(runtimeId: AiRuntimeId): string {
    switch (runtimeId) {
        case "claude":
            return "Claude";
        case "gemini":
            return "Gemini";
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

function isAiProviderId(runtimeId: AiRuntimeId): runtimeId is AiProviderId {
    return AI_PROVIDER_RUNTIME_IDS.includes(runtimeId);
}

function mapProviderRuntimeStatuses(
    statuses: Record<AiRuntimeId, AiRuntimeStatus | null>,
): Partial<Record<AiProviderId, AiProviderRuntimeStatus | null>> {
    return Object.fromEntries(
        AI_PROVIDER_RUNTIME_IDS.map((providerId) => {
            const status = statuses[providerId];

            return [
                providerId,
                status ? { ...status, runtimeId: providerId } : null,
            ];
        }),
    );
}

function mapEnvironmentDiagnostics(
    diagnostics: AiEnvironmentDiagnostics | null,
    loading: boolean,
    error: string | null,
): AiProviderDiagnosticsState {
    if (!diagnostics) {
        return {
            entries: [],
            error,
            loading,
            updatedAt: null,
        };
    }

    return {
        entries: [
            {
                details: diagnostics.path.inheritedEntries.join("\n"),
                id: "path-inherited",
                label: "Inherited PATH",
                message:
                    diagnostics.path.inheritedEntries.length > 0
                        ? `${diagnostics.path.inheritedEntries.length} entries`
                        : "PATH is empty.",
                status:
                    diagnostics.path.inheritedEntries.length > 0
                        ? "ok"
                        : "warning",
            },
            {
                details: diagnostics.path.preferredEntries.join("\n"),
                id: "path-preferred",
                label: "Preferred runtime PATH",
                message:
                    diagnostics.path.preferredEntries.length > 0
                        ? `${diagnostics.path.preferredEntries.length} entries`
                        : "No preferred runtime PATH has been resolved yet.",
                status:
                    diagnostics.path.preferredEntries.length > 0
                        ? "ok"
                        : "pending",
            },
            ...diagnostics.runtimes.map((runtime): AiProviderDiagnosticEntry => ({
                details: [
                    runtime.command ? `Command: ${runtime.command}` : null,
                    runtime.executablePath
                        ? `Executable: ${runtime.executablePath}`
                        : null,
                    runtime.source ? `Source: ${runtime.source}` : null,
                    runtime.preferredPath
                        ? `Preferred PATH: ${runtime.preferredPath}`
                        : null,
                ]
                    .filter((part): part is string => Boolean(part))
                    .join("\n"),
                id: `runtime-${runtime.runtimeId}`,
                label: `${getRuntimeName(runtime.runtimeId)} runtime`,
                message:
                    runtime.message ??
                    (runtime.authReady
                        ? "Runtime authentication is ready."
                        : "Runtime needs authentication."),
                providerId: isAiProviderId(runtime.runtimeId)
                    ? runtime.runtimeId
                    : undefined,
                status:
                    runtime.state === "error"
                        ? "error"
                        : runtime.state === "missing" || !runtime.authReady
                          ? "warning"
                          : "ok",
            })),
            ...diagnostics.executables.map(
                (executable): AiProviderDiagnosticEntry => ({
                details: executable.path,
                id: `executable-${executable.command}`,
                label: `${executable.command} executable`,
                message: executable.message,
                status: executable.state === "ready" ? "ok" : "warning",
                }),
            ),
            ...diagnostics.runtimePathOverrides.map(
                (override): AiProviderDiagnosticEntry => ({
                details: override.pathOrCommand,
                id: `override-${override.name}`,
                label: override.name,
                message: override.present
                    ? "Runtime path override is set."
                    : "Runtime path override is not set.",
                providerId: isAiProviderId(override.runtimeId)
                    ? override.runtimeId
                    : undefined,
                status: override.present ? "ok" : "pending",
                }),
            ),
            ...diagnostics.credentialEnvironment.map(
                (credential): AiProviderDiagnosticEntry => ({
                id: `credential-${credential.runtimeId}-${credential.name}`,
                label: credential.name,
                message: credential.present
                    ? "Environment credential is present."
                    : "Environment credential is not set.",
                providerId: isAiProviderId(credential.runtimeId)
                    ? credential.runtimeId
                    : undefined,
                status: credential.present ? "ok" : "pending",
                }),
            ),
        ],
        error,
        loading,
        updatedAt: diagnostics.checkedAt,
    };
}
