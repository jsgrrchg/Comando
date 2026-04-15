import { useCallback, useEffect, useState } from "react";

import type { AppEditorSettings } from "@shared/ipc";

import { loadAppEditorSettings } from "../settings/client";
import {
    getDefaultAppEditorSettings,
    resolveEditorSettings,
} from "../settings/theme";

export function useResolvedEditorSettings(): AppEditorSettings {
    const [appEditor, setAppEditor] = useState<AppEditorSettings>(
        getDefaultAppEditorSettings(),
    );

    const loadAppEditor = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        const nextEditor = await loadAppEditorSettings();
        setAppEditor(nextEditor);
    }, []);

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            void loadAppEditor();
        }, 0);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [loadAppEditor]);

    useEffect(() => {
        if (!window.comando) {
            return;
        }

        const unsubscribeSettings = window.comando.onSettingsUpdated(() => {
            void loadAppEditor();
        });

        return () => {
            unsubscribeSettings();
        };
    }, [loadAppEditor]);

    return resolveEditorSettings(appEditor);
}
