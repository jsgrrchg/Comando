import { useCallback, useEffect, useMemo, useState } from "react";

import type {
    AiRuntimeId,
    AiRuntimeStatus,
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    ChatFontFamily,
    ProjectAppearanceSettings,
    ProjectEditorSettings,
    ProjectSummary,
    ThemeMode,
    ThemePreset,
} from "@shared/ipc";

import {
    SettingsWindow,
    type RuntimeCardOption,
    type SettingsProjectOption,
} from "./components/settings";
import {
    loadAiChatSettings,
    loadAppEditorSettings,
    loadAppAppearanceSettings,
    loadProjectEditorSettings,
    loadProjectAppearanceSettings,
    saveAiChatSettings,
    saveAppEditorSettings,
    saveAppAppearanceSettings,
    saveProjectEditorSettings,
    saveProjectAppearanceSettings,
} from "./app/settings/client";
import {
    CHAT_FONT_FAMILY_OPTIONS,
    EDITOR_FONT_FAMILY_OPTIONS,
    getDefaultAiChatSettings,
    getDefaultAppEditorSettings,
    getDefaultProjectAppearance,
    getDefaultProjectEditorSettings,
    THEME_PRESET_OPTIONS,
} from "./app/settings/theme";
import { useResolvedAppearance } from "./app/hooks/use-resolved-appearance";
import { shortcutDefinitions, formatShortcut } from "./app/shortcuts/registry";

export function SettingsApp() {
    const initialProjectId = useMemo(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get("projectId");
    }, []);
    const [appAppearance, setAppAppearance] = useState<AppAppearanceSettings>({
        themeMode: "system",
        themePreset: "default",
    });
    const [projectAppearance, setProjectAppearance] =
        useState<ProjectAppearanceSettings>(getDefaultProjectAppearance());
    const [appEditor, setAppEditor] = useState<AppEditorSettings>(
        getDefaultAppEditorSettings(),
    );
    const [projectEditor, setProjectEditor] = useState<ProjectEditorSettings>(
        getDefaultProjectEditorSettings(),
    );
    const [aiChat, setAiChat] = useState<AppAiChatSettings>(
        getDefaultAiChatSettings(),
    );
    const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
    const [runtimeStatuses, setRuntimeStatuses] = useState<
        Record<AiRuntimeId, AiRuntimeStatus | null>
    >({
        claude: null,
        codex: null,
        gemini: null,
        kilo: null,
    });
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
        initialProjectId,
    );

    useResolvedAppearance(selectedProjectId);

    const selectedProject =
        projects.find((project) => project.id === selectedProjectId) ?? null;
    const projectOverrideEnabled =
        projectAppearance.themeMode !== null ||
        projectAppearance.themePreset !== null;
    const projectEditorOverrideEnabled =
        projectEditor.fontFamily !== null ||
        projectEditor.fontSize !== null ||
        projectEditor.lineHeight !== null;

    const loadProjects = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        const nextProjects = await window.comando.listProjects();
        setProjects(nextProjects);
    }, []);

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

    const loadProjectAppearance = useCallback(
        async (projectId: string | null) => {
            if (!projectId) {
                setProjectAppearance(getDefaultProjectAppearance());
                return;
            }

            const nextAppearance =
                await loadProjectAppearanceSettings(projectId);
            setProjectAppearance(nextAppearance);
        },
        [],
    );

    const loadProjectEditor = useCallback(async (projectId: string | null) => {
        if (!projectId) {
            setProjectEditor(getDefaultProjectEditorSettings());
            return;
        }

        const nextEditor = await loadProjectEditorSettings(projectId);
        setProjectEditor(nextEditor);
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
                loadProjects(),
                loadAppAiChat(),
                loadAppAppearance(),
                loadAppEditor(),
                loadProjectAppearance(selectedProjectId),
                loadProjectEditor(selectedProjectId),
                loadRuntimeStatuses(),
            ]);
        }, 0);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [
        loadAppAiChat,
        loadAppAppearance,
        loadAppEditor,
        loadProjectEditor,
        loadProjectAppearance,
        loadProjects,
        loadRuntimeStatuses,
        selectedProjectId,
    ]);

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
        const unsubscribeProjectSettings =
            window.comando.onProjectSettingsUpdated((payload) => {
                if (payload.projectId !== selectedProjectId) {
                    return;
                }

                void loadProjectAppearance(selectedProjectId);
                void loadProjectEditor(selectedProjectId);
            });

        return () => {
            unsubscribeSettings();
            unsubscribeProjectSettings();
        };
    }, [
        loadAppAiChat,
        loadAppAppearance,
        loadAppEditor,
        loadProjectEditor,
        loadProjectAppearance,
        loadRuntimeStatuses,
        selectedProjectId,
    ]);

    const handleProjectSelect = (projectId: string | null) => {
        setSelectedProjectId(projectId);

        const params = new URLSearchParams(window.location.search);
        if (projectId) {
            params.set("projectId", projectId);
        } else {
            params.delete("projectId");
        }
        window.history.replaceState(
            {},
            "",
            params.size > 0
                ? `${window.location.pathname}?${params.toString()}`
                : window.location.pathname,
        );
    };

    const handleAppThemeModeChange = (themeMode: ThemeMode) => {
        const nextAppearance = {
            ...appAppearance,
            themeMode,
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

    const handleProjectOverrideChange = (enabled: boolean) => {
        if (!selectedProjectId) {
            return;
        }

        const nextAppearance = enabled
            ? {
                  themeMode:
                      projectAppearance.themeMode ?? appAppearance.themeMode,
                  themePreset:
                      projectAppearance.themePreset ??
                      appAppearance.themePreset,
              }
            : getDefaultProjectAppearance();

        setProjectAppearance(nextAppearance);
        void saveProjectAppearanceSettings(selectedProjectId, nextAppearance);
    };

    const handleProjectEditorOverrideChange = (enabled: boolean) => {
        if (!selectedProjectId) {
            return;
        }

        const nextEditor = enabled
            ? {
                  fontFamily: projectEditor.fontFamily ?? appEditor.fontFamily,
                  fontSize: projectEditor.fontSize ?? appEditor.fontSize,
                  lineHeight: projectEditor.lineHeight ?? appEditor.lineHeight,
              }
            : getDefaultProjectEditorSettings();

        setProjectEditor(nextEditor);
        void saveProjectEditorSettings(selectedProjectId, nextEditor);
    };

    const updateProjectAppearance = (patch: {
        readonly themeMode?: ThemeMode;
        readonly themePreset?: ThemePreset;
    }) => {
        if (!selectedProjectId) {
            return;
        }

        const nextAppearance: ProjectAppearanceSettings = {
            themeMode:
                patch.themeMode ??
                projectAppearance.themeMode ??
                appAppearance.themeMode,
            themePreset:
                patch.themePreset ??
                projectAppearance.themePreset ??
                appAppearance.themePreset,
        };

        setProjectAppearance(nextAppearance);
        void saveProjectAppearanceSettings(selectedProjectId, nextAppearance);
    };

    const updateProjectEditor = (patch: {
        readonly fontFamily?: AppEditorSettings["fontFamily"];
        readonly fontSize?: number;
        readonly lineHeight?: number;
    }) => {
        if (!selectedProjectId) {
            return;
        }

        const nextEditor: ProjectEditorSettings = {
            fontFamily:
                patch.fontFamily ??
                projectEditor.fontFamily ??
                appEditor.fontFamily,
            fontSize:
                patch.fontSize ?? projectEditor.fontSize ?? appEditor.fontSize,
            lineHeight:
                patch.lineHeight ??
                projectEditor.lineHeight ??
                appEditor.lineHeight,
        };

        setProjectEditor(nextEditor);
        void saveProjectEditorSettings(selectedProjectId, nextEditor);
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
                chatFontFamilies: CHAT_FONT_FAMILY_OPTIONS,
                chatFontSize: aiChat.chatFontSize,
                composerFontFamily: aiChat.composerFontFamily,
                composerFontFamilies: CHAT_FONT_FAMILY_OPTIONS,
                composerFontSize: aiChat.composerFontSize,
                requireCmdEnterToSend: aiChat.requireCmdEnterToSend,
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
                onRequireCmdEnterChange: (value) =>
                    updateAiChat({ requireCmdEnterToSend: value }),
                onScreenshotRetentionChange: (seconds) =>
                    updateAiChat({ screenshotRetentionSeconds: seconds }),
                onHistoryRetentionChange: (days) =>
                    updateAiChat({ historyRetentionDays: days }),
            }}
            appAppearance={{
                mode: appAppearance.themeMode,
                onModeChange: handleAppThemeModeChange,
                onPresetChange: handleAppThemePresetChange,
                presetId: appAppearance.themePreset,
                presets: THEME_PRESET_OPTIONS.map((preset) => ({
                    description: preset.description,
                    id: preset.id,
                    label: preset.label,
                    swatches: preset.swatches,
                })),
            }}
            appEditor={{
                fontFamilies: EDITOR_FONT_FAMILY_OPTIONS.map((fontFamily) => ({
                    description: fontFamily.description,
                    group: fontFamily.group,
                    id: fontFamily.id,
                    label: fontFamily.label,
                    preview: fontFamily.preview,
                })),
                fontFamilyId: appEditor.fontFamily,
                fontSize: appEditor.fontSize,
                lineHeight: appEditor.lineHeight,
                onFontFamilyChange: handleAppEditorFontFamilyChange,
                onFontSizeChange: handleAppEditorFontSizeChange,
                onLineHeightChange: handleAppEditorLineHeightChange,
            }}
            onClose={() => window.close()}
            onProjectSelect={handleProjectSelect}
            onRuntimeAction={(runtimeId, actionId) =>
                void handleRuntimeAction({
                    actionId,
                    loadRuntimeStatuses,
                    runtimeId: runtimeId as AiRuntimeId,
                    runtimeStatuses,
                    selectedProjectId,
                })
            }
            projectAppearance={
                selectedProjectId
                    ? {
                          enabled: projectOverrideEnabled,
                          mode:
                              projectAppearance.themeMode ??
                              appAppearance.themeMode,
                          onEnabledChange: handleProjectOverrideChange,
                          onModeChange: (themeMode) =>
                              updateProjectAppearance({ themeMode }),
                          onPresetChange: (themePreset) =>
                              updateProjectAppearance({
                                  themePreset: themePreset as ThemePreset,
                              }),
                          presetId:
                              projectAppearance.themePreset ??
                              appAppearance.themePreset,
                          presets: THEME_PRESET_OPTIONS.map((preset) => ({
                              description: preset.description,
                              id: preset.id,
                              label: preset.label,
                              swatches: preset.swatches,
                          })),
                      }
                    : null
            }
            projectEditor={
                selectedProjectId
                    ? {
                          enabled: projectEditorOverrideEnabled,
                          fontFamilies: EDITOR_FONT_FAMILY_OPTIONS.map(
                              (fontFamily) => ({
                                  description: fontFamily.description,
                                  group: fontFamily.group,
                                  id: fontFamily.id,
                                  label: fontFamily.label,
                                  preview: fontFamily.preview,
                              }),
                          ),
                          fontFamilyId:
                              projectEditor.fontFamily ?? appEditor.fontFamily,
                          fontSize:
                              projectEditor.fontSize ?? appEditor.fontSize,
                          lineHeight:
                              projectEditor.lineHeight ?? appEditor.lineHeight,
                          onEnabledChange: handleProjectEditorOverrideChange,
                          onFontFamilyChange: (fontFamilyId) =>
                              updateProjectEditor({
                                  fontFamily:
                                      fontFamilyId as AppEditorSettings["fontFamily"],
                              }),
                          onFontSizeChange: (fontSize) =>
                              updateProjectEditor({ fontSize }),
                          onLineHeightChange: (lineHeight) =>
                              updateProjectEditor({ lineHeight }),
                      }
                    : null
            }
            projectName={selectedProject?.name ?? null}
            projects={projects.map<SettingsProjectOption>((project) => ({
                id: project.id,
                name: project.name,
                path: project.rootPath,
            }))}
            shortcuts={shortcuts}
            runtimes={runtimes}
            selectedProjectId={selectedProjectId}
        />
    );
}

async function handleRuntimeAction(options: {
    readonly actionId: string;
    readonly loadRuntimeStatuses: () => Promise<void>;
    readonly runtimeId: AiRuntimeId;
    readonly runtimeStatuses: Record<AiRuntimeId, AiRuntimeStatus | null>;
    readonly selectedProjectId: string | null;
}): Promise<void> {
    if (!window.comando) {
        return;
    }

    if (options.actionId === "refresh") {
        await options.loadRuntimeStatuses();
        return;
    }

    if (options.actionId !== "connect") {
        return;
    }

    const runtimeStatus = options.runtimeStatuses[options.runtimeId];
    const methodId =
        runtimeStatus?.authMethods[0]?.id ?? runtimeStatus?.authMethod ?? null;

    if (!methodId) {
        return;
    }

    await window.comando.launchAiRuntimeAuth({
        methodId,
        projectId: options.selectedProjectId,
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

    return {
        actions: [
            ...(status.runtimeId !== "codex" && !status.authReady
                ? [
                      {
                          id: "connect",
                          label: "Connect",
                          tone: "primary" as const,
                      },
                  ]
                : []),
            {
                id: "refresh",
                label: "Refresh",
            },
        ],
        description: getRuntimeDescription(status.runtimeId),
        details:
            status.message ??
            status.command ??
            (status.source ? `Source: ${status.source}` : "No details yet."),
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
