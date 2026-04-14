import { type LanguageSupport } from "@codemirror/language";
import { useEffect, useMemo, useState } from "react";

import {
    loadCodeLanguageSupportByPath,
    loadMarkdownCodeLanguageSupport,
} from "./codeLanguage";

function useLoadedLanguageSupport(
    loader: (() => Promise<LanguageSupport | null>) | null,
) {
    const [{ resolvedLoader, languageSupport }, setResolvedSupport] = useState<{
        readonly resolvedLoader: (() => Promise<LanguageSupport | null>) | null;
        readonly languageSupport: LanguageSupport | null;
    }>({
        resolvedLoader: null,
        languageSupport: null,
    });

    useEffect(() => {
        if (!loader) {
            return;
        }

        let cancelled = false;
        void loader().then((support) => {
            if (!cancelled) {
                setResolvedSupport({
                    resolvedLoader: loader,
                    languageSupport: support,
                });
            }
        });

        return () => {
            cancelled = true;
        };
    }, [loader]);

    return loader && resolvedLoader === loader ? languageSupport : null;
}

export function useMarkdownCodeLanguageSupport(
    info: string | null | undefined,
) {
    return useCodeLanguageSupport(null, info);
}

export function useCodePathLanguageSupport(
    filePath: string | null | undefined,
    probeContent?: string | null,
) {
    return useCodeLanguageSupport(filePath, null, probeContent);
}

export function useCodeLanguageSupport(
    filePath: string | null | undefined,
    markdownInfo: string | null | undefined,
    probeContent?: string | null,
) {
    const loader = useMemo(() => {
        const trimmedPath = filePath?.trim();
        if (trimmedPath) {
            return () =>
                loadCodeLanguageSupportByPath(
                    trimmedPath,
                    null,
                    probeContent ?? undefined,
                );
        }

        const trimmedInfo = markdownInfo?.trim();
        if (!trimmedInfo) {
            return null;
        }

        return () => loadMarkdownCodeLanguageSupport(trimmedInfo);
    }, [filePath, markdownInfo, probeContent]);

    return useLoadedLanguageSupport(loader);
}
