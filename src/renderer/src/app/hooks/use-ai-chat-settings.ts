import { useCallback, useEffect, useState } from "react";

import type { AppAiChatSettings } from "@shared/ipc";

import { loadAiChatSettings } from "../settings/client";
import { getDefaultAiChatSettings } from "../settings/theme";

export function useAiChatSettings(): AppAiChatSettings {
    const [settings, setSettings] = useState<AppAiChatSettings>(
        getDefaultAiChatSettings(),
    );

    const load = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        const next = await loadAiChatSettings();
        setSettings(next);
    }, []);

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            void load();
        }, 0);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [load]);

    useEffect(() => {
        if (!window.comando) {
            return;
        }

        const unsubscribe = window.comando.onSettingsUpdated(() => {
            void load();
        });

        return () => {
            unsubscribe();
        };
    }, [load]);

    return settings;
}
