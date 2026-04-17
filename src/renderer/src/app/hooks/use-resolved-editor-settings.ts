import { useEffect } from "react";

import type { AppEditorSettings } from "@shared/ipc";

import {
    resolveEditorSettings,
} from "../settings/theme";
import { useSettingsStore } from "../store/settings-store";

export function useResolvedEditorSettings(): AppEditorSettings {
    const hydrate = useSettingsStore((state) => state.hydrate);
    const appEditor = useSettingsStore((state) => state.editor);

    useEffect(() => {
        void hydrate();
    }, [hydrate]);

    return resolveEditorSettings(appEditor);
}
