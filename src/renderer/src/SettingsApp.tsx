import { useCallback, useEffect, useMemo, useState } from "react";

import type {
    AiRuntimeId,
    AiRuntimeStatus,
    AppAiChatSettings,
    AppAppearanceSettings,
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
    DEFAULT_AI_DIFF_ZOOM,
    DEFAULT_PENDING_REVIEW_CARD_TEXT_ZOOM,
    PENDING_REVIEW_CARD_TEXT_ZOOM_MAX,
    PENDING_REVIEW_CARD_TEXT_ZOOM_MIN,
} from "./app/ai/sessionReviewContracts";
import {
    loadAiChatSettings,
    loadAppEditorSettings,
    loadAppAppearanceSettings,
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
    const availableFontFamilyIds = useAvailableFontFamilyIds();

    useResolvedAppearance();

    const loadAppAiChat = useCallback(async () => {
        const next = await loadAiChatSettings();
        setAiChat(next);
    }, []);

    const loadAppAppearance = useCallback(async () => {
        const nextAppearance = await loadAppAppearanceSettings();
        setAppAppearance(nextAppearance);
    }, []);

    const loadAppEditor = useCallback(async () => {
        const nextEditor = await loadAppEditorSettings();
        setAppEditor(nextEditor);
    }, []);

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

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            void Promise.all([
                loadAppAiChat(),
                loadAppAppearance(),
                loadAppEditor(),
                loadRuntimeStatuses(),
            ]);
        }, 0);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [loadAppAiChat, loadAppAppearance, loadAppEditor, loadRuntimeStatuses]);

    useEffect(() => {
        if (!window.comando) {
            return;
        }

        const unsubscribeSettings = window.comando.onSettingsUpdated(() => {
            void loadAppAiChat();
            void loadAppAppearance();
            void loadAppEditor();
            void loadRuntimeStatuses();
        });

        return () => {
            unsubscribeSettings();
        };
    }, [loadAppAiChat, loadAppAppearance, loadAppEditor, loadRuntimeStatuses]);

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

    const handleAppEditorFontFamilyChange = (fontFamilyId: string) => {
        const nextEditor: AppEditorSettings = {
            ...appEditor,
            fontFamily: fontFamilyId as AppEditorSettings["fontFamily"],
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

    return (
        <SettingsWindow
            aiChat={{
                chatFontFamily: aiChat.chatFontFamily,
                chatFontFamilies: chatFontFamilies,
                chatFontSize: aiChat.chatFontSize,
                composerFontFamily: aiChat.composerFontFamily,
                composerFontFamilies: composerFontFamilies,
                composerFontSize: aiChat.composerFontSize,
                pendingReviewCardTextZoomPercent: Math.round(
                    (aiChat.pendingReviewCardTextZoom ??
                        DEFAULT_PENDING_REVIEW_CARD_TEXT_ZOOM) * 100,
                ),
                requireCmdEnterToSend: aiChat.requireCmdEnterToSend,
                reviewDiffZoomPercent: Math.round(
                    (aiChat.reviewDiffZoom ?? DEFAULT_AI_DIFF_ZOOM) * 100,
                ),
                screenshotRetentionSeconds: aiChat.screenshotRetentionSeconds,
                historyRetentionDays: aiChat.historyRetentionDays,
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
                onPendingReviewCardTextZoomPercentChange: (percent) =>
                    updateAiChat({
                        pendingReviewCardTextZoom: Math.min(
                            PENDING_REVIEW_CARD_TEXT_ZOOM_MAX,
                            Math.max(
                                PENDING_REVIEW_CARD_TEXT_ZOOM_MIN,
                                percent / 100,
                            ),
                        ),
                    }),
                onRequireCmdEnterChange: (value) =>
                    updateAiChat({ requireCmdEnterToSend: value }),
                onReviewDiffZoomPercentChange: (percent) =>
                    updateAiChat({
                        reviewDiffZoom: Math.min(
                            0.96,
                            Math.max(0.64, percent / 100),
                        ),
                    }),
                onScreenshotRetentionChange: (seconds) =>
                    updateAiChat({ screenshotRetentionSeconds: seconds }),
                onHistoryRetentionChange: (days) =>
                    updateAiChat({ historyRetentionDays: days }),
            }}
            appAppearance={{
                fileTreeScale: appAppearance.fileTreeScale,
                mode: appAppearance.themeMode,
                onFileTreeScaleChange: handleAppFileTreeScaleChange,
                onModeChange: handleAppThemeModeChange,
                onPresetChange: handleAppThemePresetChange,
                onZoomFactorChange: handleAppZoomFactorChange,
                presetId: appAppearance.themePreset,
                presets: THEME_PRESET_OPTIONS.map((preset) => ({
                    description: preset.description,
                    id: preset.id,
                    label: preset.label,
                    swatches: preset.swatches,
                })),
                zoomFactor: appAppearance.zoomFactor,
            }}
            appEditor={{
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
                onFontFamilyChange: handleAppEditorFontFamilyChange,
                onFontSizeChange: handleAppEditorFontSizeChange,
                onLineHeightChange: handleAppEditorLineHeightChange,
                onMinimapEnabledChange: handleAppEditorMinimapEnabledChange,
                onSuggestionsEnabledChange:
                    handleAppEditorSuggestionsEnabledChange,
            }}
            onClose={() => window.close()}
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
