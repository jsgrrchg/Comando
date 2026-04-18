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
        const resolved = resolveAppearance(appAppearance);
        applyAppearance(resolved, systemIsDark);
        // Sync the OS appearance so DWM tints the Windows acrylic to match
        // the in-app light/dark mode. The main process no-ops on macOS.
        void window.comando?.setNativeAppearance(resolved.themeMode);
    }, [appAppearance, systemIsDark]);
}
