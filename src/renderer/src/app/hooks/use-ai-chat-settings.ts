import { useEffect } from "react";

import type { AppAiChatSettings } from "@shared/ipc";

import { useSettingsStore } from "../store/settings-store";

export function useAiChatSettings(): AppAiChatSettings {
    const hydrate = useSettingsStore((state) => state.hydrate);
    const settings = useSettingsStore((state) => state.aiChat);

    useEffect(() => {
        void hydrate();
    }, [hydrate]);

    return settings;
}
