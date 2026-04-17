import { useEffect } from "react";

import {
    applyAppearance,
    resolveAppearance,
} from "../settings/theme";
import { useSettingsStore } from "../store/settings-store";

export function useResolvedAppearance(): void {
    const hydrate = useSettingsStore((state) => state.hydrate);
    const appAppearance = useSettingsStore((state) => state.appearance);
    const systemIsDark = useSettingsStore((state) => state.systemTheme.isDark);

    useEffect(() => {
        void hydrate();
    }, [hydrate]);

    useEffect(() => {
        applyAppearance(resolveAppearance(appAppearance), systemIsDark);
    }, [appAppearance, systemIsDark]);
}
