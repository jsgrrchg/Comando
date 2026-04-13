import { useEffect } from "react";

export function useSystemTheme(): void {
    useEffect(() => {
        if (!window.comando) {
            return;
        }

        void window.comando.getSystemTheme().then((theme) => {
            applyTheme(theme.isDark);
        });

        const unsubscribe = window.comando.onThemeUpdated((theme) => {
            applyTheme(theme.isDark);
        });

        return unsubscribe;
    }, []);
}

function applyTheme(isDark: boolean): void {
    document.documentElement.classList.toggle("dark", isDark);
}
