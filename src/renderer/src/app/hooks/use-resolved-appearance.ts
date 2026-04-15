import { useCallback, useEffect, useState } from "react";

import type { AppAppearanceSettings } from "@shared/ipc";

import { loadAppAppearanceSettings } from "../settings/client";
import {
    applyAppearance,
    getDefaultAppAppearance,
    resolveAppearance,
} from "../settings/theme";

export function useResolvedAppearance(): void {
    const [appAppearance, setAppAppearance] = useState<AppAppearanceSettings>(
        getDefaultAppAppearance(),
    );
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

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            void loadAppAppearance();
        }, 0);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [loadAppAppearance]);

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

        return () => {
            window.clearTimeout(timeout);
            unsubscribeTheme();
            unsubscribeSettings();
        };
    }, [loadAppAppearance, loadSystemTheme]);

    useEffect(() => {
        applyAppearance(resolveAppearance(appAppearance), systemIsDark);
    }, [appAppearance, systemIsDark]);
}
