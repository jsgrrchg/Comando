import { useCallback, useEffect, useState } from "react";

import type {
    AppEditorSettings,
    ProjectEditorSettings,
} from "@shared/ipc";

import {
    loadAppEditorSettings,
    loadProjectEditorSettings,
} from "../settings/client";
import {
    getDefaultAppEditorSettings,
    resolveEditorSettings,
} from "../settings/theme";

export function useResolvedEditorSettings(
    projectId: string | null,
): AppEditorSettings {
    const [appEditor, setAppEditor] = useState<AppEditorSettings>(
        getDefaultAppEditorSettings(),
    );
    const [projectEditor, setProjectEditor] =
        useState<ProjectEditorSettings | null>(null);

    const loadAppEditor = useCallback(async () => {
        if (!window.comando) {
            return;
        }

        const nextEditor = await loadAppEditorSettings();
        setAppEditor(nextEditor);
    }, []);

    const loadProjectEditor = useCallback(async (nextProjectId: string | null) => {
        if (!window.comando || !nextProjectId) {
            setProjectEditor(null);
            return;
        }

        const nextEditor = await loadProjectEditorSettings(nextProjectId);
        setProjectEditor(nextEditor);
    }, []);

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            void loadAppEditor();
            void loadProjectEditor(projectId);
        }, 0);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [loadAppEditor, loadProjectEditor, projectId]);

    useEffect(() => {
        if (!window.comando) {
            return;
        }

        const unsubscribeSettings = window.comando.onSettingsUpdated(() => {
            void loadAppEditor();
        });
        const unsubscribeProjectSettings =
            window.comando.onProjectSettingsUpdated((payload) => {
                if (!projectId || payload.projectId !== projectId) {
                    return;
                }

                void loadProjectEditor(projectId);
            });

        return () => {
            unsubscribeSettings();
            unsubscribeProjectSettings();
        };
    }, [loadAppEditor, loadProjectEditor, projectId]);

    return resolveEditorSettings(appEditor, projectEditor);
}
