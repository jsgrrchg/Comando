import { useCallback, useEffect, useState } from "react";

import type {
    AppAppearanceSettings,
    ProjectAppearanceSettings,
} from "@shared/ipc";

import {
    loadAppAppearanceSettings,
    loadProjectAppearanceSettings,
} from "../settings/client";
import {
    applyAppearance,
    getDefaultAppAppearance,
    resolveAppearance,
} from "../settings/theme";

export function useResolvedAppearance(projectId: string | null): void {
    const [appAppearance, setAppAppearance] = useState<AppAppearanceSettings>(
        getDefaultAppAppearance(),
    );
    const [projectAppearance, setProjectAppearance] =
        useState<ProjectAppearanceSettings | null>(null);
    const [systemIsDark, setSystemIsDark] = useState(false);

    const loadSystemTheme = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        const theme = await window.comando.getSystemTheme();
        setSystemIsDark(theme.isDark);
    }, []);

    const loadAppAppearance = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        const nextAppearance = await loadAppAppearanceSettings();
        setAppAppearance(nextAppearance);
    }, []);

    const loadProjectAppearance = useCallback(
        async (nextProjectId: string | null) => {
            if (!window.comando || !nextProjectId) {
                setProjectAppearance(null);
                return;
            }

            const nextAppearance =
                await loadProjectAppearanceSettings(nextProjectId);
            setProjectAppearance(nextAppearance);
        },
        [],
    );

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            void loadAppAppearance();
            void loadProjectAppearance(projectId);
        }, 0);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [loadAppAppearance, loadProjectAppearance, projectId]);

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            void loadSystemTheme();
        }, 0);

        if (!window.comando) {
            return () => {
                window.clearTimeout(timeout);
            };
        }

        const unsubscribeTheme = window.comando.onThemeUpdated((theme) => {
            setSystemIsDark(theme.isDark);
        });
        const unsubscribeSettings = window.comando.onSettingsUpdated(() => {
            void loadAppAppearance();
        });
        const unsubscribeProjectSettings =
            window.comando.onProjectSettingsUpdated((payload) => {
                if (!projectId || payload.projectId !== projectId) {
                    return;
                }

                void loadProjectAppearance(projectId);
            });

        return () => {
            window.clearTimeout(timeout);
            unsubscribeTheme();
            unsubscribeSettings();
            unsubscribeProjectSettings();
        };
    }, [loadAppAppearance, loadProjectAppearance, loadSystemTheme, projectId]);

    useEffect(() => {
        applyAppearance(
            resolveAppearance(appAppearance, projectAppearance),
            systemIsDark,
        );
    }, [appAppearance, projectAppearance, systemIsDark]);
}
