import DOMPurify from "dompurify";
import {
    memo,
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
} from "react";

export const MERMAID_SOURCE_MAX_LENGTH = 50000;

type MermaidRenderStatus = "error" | "loading" | "ready" | "too-large";
type MermaidThemeVariableValue = boolean | string;
type MermaidThemeVariables = Record<string, MermaidThemeVariableValue>;

interface MermaidRenderState {
    readonly errorMessage: string | null;
    readonly renderKey: string | null;
    readonly status: MermaidRenderStatus;
    readonly svg: string | null;
}

interface MermaidInitializeConfig {
    readonly deterministicIds: boolean;
    readonly flowchart: {
        readonly htmlLabels: boolean;
        readonly useMaxWidth: boolean;
    };
    readonly htmlLabels: boolean;
    readonly logLevel: "error";
    readonly maxTextSize: number;
    readonly secure: string[];
    readonly securityLevel: "strict";
    readonly startOnLoad: boolean;
    readonly theme: "base";
    readonly themeVariables: MermaidThemeVariables;
}

export interface MermaidRenderer {
    readonly initialize: (config: MermaidInitializeConfig) => void;
    readonly render: (
        id: string,
        source: string,
    ) => Promise<{ readonly svg: string }>;
}

type MermaidLoader = () => Promise<MermaidRenderer>;
type MermaidSvgSanitizer = (svg: string) => string;

interface MarkdownMermaidDiagramProps {
    readonly loadMermaid?: MermaidLoader;
    readonly sanitizeSvg?: MermaidSvgSanitizer;
    readonly source: string;
}

interface MermaidThemeSnapshot {
    readonly initializeConfig: MermaidInitializeConfig;
    readonly signature: string;
}

const initializedMermaidRendererThemeSignatures = new WeakMap<
    MermaidRenderer,
    string
>();

const initialRenderState: MermaidRenderState = {
    errorMessage: null,
    renderKey: null,
    status: "loading",
    svg: null,
};

const MERMAID_FONT_FAMILY_FALLBACK =
    '"SF Pro Text", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif';

function createMermaidElementId(reactId: string): string {
    const safeId = reactId.replace(/[^A-Za-z0-9_-]/g, "");
    return `markdown-mermaid-${safeId || "diagram"}`;
}

function readCssVariable(variableName: string, fallback: string): string {
    if (typeof window === "undefined") {
        return fallback;
    }

    const value = window
        .getComputedStyle(document.documentElement)
        .getPropertyValue(variableName)
        .trim();

    return value || fallback;
}

function createMermaidThemeSnapshot(): MermaidThemeSnapshot {
    const isDark =
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark");
    const appBackground = readCssVariable(
        "--color-bg-primary",
        "#1f2430",
    );
    const elevatedBackground = readCssVariable(
        "--color-bg-elevated",
        "#252b38",
    );
    const secondaryBackground = readCssVariable(
        "--color-bg-secondary",
        "#202633",
    );
    const tertiaryBackground = readCssVariable(
        "--color-bg-tertiary",
        "#171b24",
    );
    const borderColor = readCssVariable(
        "--color-border",
        "#515a6e",
    );
    const strongBorderColor = readCssVariable(
        "--color-border-strong",
        borderColor,
    );
    const textColor = readCssVariable(
        "--color-text-primary",
        "#f4f6fb",
    );
    const mutedTextColor = readCssVariable(
        "--color-text-secondary",
        "#8a93a5",
    );
    const accentColor = readCssVariable(
        "--color-accent",
        "#818cf8",
    );
    const strongAccentColor = readCssVariable(
        "--color-accent-strong",
        accentColor,
    );
    const successColor = readCssVariable("--diff-add", "#4ade80");
    const dangerColor = readCssVariable("--diff-remove", "#f87171");
    const warningColor = readCssVariable("--diff-warn", "#fbbf24");
    const infoColor = readCssVariable("--diff-update", "#60a5fa");
    const errorBackground = readCssVariable(
        "--color-danger-bg",
        isDark ? "#3b1d24" : "#fee2e2",
    );
    const errorTextColor = readCssVariable(
        "--color-danger",
        dangerColor,
    );
    const fontFamily = readCssVariable(
        "--font-sans",
        MERMAID_FONT_FAMILY_FALLBACK,
    );
    const labelBackground = appBackground;
    const nodeBackground = elevatedBackground;
    const nodeBackgroundAlt = secondaryBackground;
    const mutedBackground = tertiaryBackground;
    const lineColor = mutedTextColor;
    const themeVariables = {
        actorBkg: nodeBackground,
        actorBorder: strongBorderColor,
        actorLineColor: lineColor,
        actorTextColor: textColor,
        altBackground: mutedBackground,
        altSectionBkgColor: mutedBackground,
        arrowheadColor: lineColor,
        background: "transparent",
        branchLabelColor: textColor,
        classText: textColor,
        clusterBkg: secondaryBackground,
        clusterBorder: borderColor,
        clusterTextColor: textColor,
        cScale0: nodeBackground,
        cScale1: nodeBackgroundAlt,
        cScale10: warningColor,
        cScale11: infoColor,
        cScale2: mutedBackground,
        cScale3: accentColor,
        cScale4: strongAccentColor,
        cScale5: successColor,
        cScale6: warningColor,
        cScale7: dangerColor,
        cScale8: infoColor,
        cScale9: secondaryBackground,
        cScaleLabel0: textColor,
        cScaleLabel1: textColor,
        cScaleLabel10: textColor,
        cScaleLabel11: textColor,
        cScaleLabel2: textColor,
        cScaleLabel3: textColor,
        cScaleLabel4: textColor,
        cScaleLabel5: isDark ? appBackground : "#ffffff",
        cScaleLabel6: isDark ? appBackground : "#111827",
        cScaleLabel7: isDark ? appBackground : "#ffffff",
        cScaleLabel8: isDark ? appBackground : "#ffffff",
        cScaleLabel9: textColor,
        darkMode: isDark,
        defaultLinkColor: lineColor,
        edgeLabelBackground: labelBackground,
        errorBkgColor: errorBackground,
        errorTextColor,
        fillType0: nodeBackground,
        fillType1: nodeBackgroundAlt,
        fillType2: mutedBackground,
        fillType3: accentColor,
        fillType4: successColor,
        fillType5: warningColor,
        fillType6: dangerColor,
        fillType7: infoColor,
        fontFamily,
        git0: nodeBackground,
        git1: nodeBackgroundAlt,
        git2: mutedBackground,
        git3: accentColor,
        git4: successColor,
        git5: warningColor,
        git6: dangerColor,
        git7: infoColor,
        gitBranchLabel0: textColor,
        gitBranchLabel1: textColor,
        gitBranchLabel2: textColor,
        gitBranchLabel3: textColor,
        gitBranchLabel4: isDark ? appBackground : "#ffffff",
        gitBranchLabel5: isDark ? appBackground : "#111827",
        gitBranchLabel6: isDark ? appBackground : "#ffffff",
        gitBranchLabel7: isDark ? appBackground : "#ffffff",
        gitInv0: textColor,
        gitInv1: textColor,
        gitInv2: textColor,
        gitInv3: textColor,
        gitInv4: isDark ? appBackground : "#ffffff",
        gitInv5: isDark ? appBackground : "#111827",
        gitInv6: isDark ? appBackground : "#ffffff",
        gitInv7: isDark ? appBackground : "#ffffff",
        labelBackgroundColor: labelBackground,
        labelBoxBkgColor: nodeBackground,
        labelBoxBorderColor: strongBorderColor,
        labelTextColor: textColor,
        lineColor,
        loopTextColor: textColor,
        mainBkg: nodeBackground,
        nodeBorder: borderColor,
        nodeBkg: nodeBackground,
        nodeTextColor: textColor,
        noteBkgColor: mutedBackground,
        noteBorderColor: borderColor,
        noteTextColor: textColor,
        primaryBorderColor: borderColor,
        primaryColor: nodeBackground,
        primaryTextColor: textColor,
        rectBkgColor: nodeBackgroundAlt,
        relationLabelBackground: labelBackground,
        secondaryBorderColor: borderColor,
        secondaryColor: nodeBackgroundAlt,
        secondaryTextColor: textColor,
        signalColor: lineColor,
        signalTextColor: textColor,
        stateBkg: nodeBackground,
        stateLabelColor: textColor,
        tertiaryColor: tertiaryBackground,
        tertiaryTextColor: textColor,
        textColor,
        titleColor: textColor,
        transitionColor: lineColor,
        transitionLabelColor: textColor,
    };

    return {
        initializeConfig: {
            deterministicIds: true,
            flowchart: {
                htmlLabels: false,
                useMaxWidth: true,
            },
            htmlLabels: false,
            logLevel: "error",
            maxTextSize: MERMAID_SOURCE_MAX_LENGTH,
            secure: [
                "flowchart",
                "htmlLabels",
                "maxTextSize",
                "secure",
                "securityLevel",
                "startOnLoad",
                "theme",
                "themeVariables",
            ],
            securityLevel: "strict",
            startOnLoad: false,
            theme: "base",
            themeVariables,
        },
        signature: JSON.stringify(themeVariables),
    };
}

async function loadMermaidRenderer(): Promise<MermaidRenderer> {
    const mermaidModule = await import("mermaid");
    return mermaidModule.default;
}

function initializeMermaidRenderer(
    mermaid: MermaidRenderer,
    themeSnapshot: MermaidThemeSnapshot,
): void {
    if (
        initializedMermaidRendererThemeSignatures.get(mermaid) ===
        themeSnapshot.signature
    ) {
        return;
    }

    mermaid.initialize(themeSnapshot.initializeConfig);
    initializedMermaidRendererThemeSignatures.set(
        mermaid,
        themeSnapshot.signature,
    );
}

export function sanitizeMermaidSvg(svg: string): string {
    return DOMPurify.sanitize(svg, {
        USE_PROFILES: {
            svg: true,
            svgFilters: true,
        },
    });
}

async function writeMermaidSourceClipboardText(text: string): Promise<void> {
    if (window.comando?.writeClipboardText) {
        try {
            await window.comando.writeClipboardText(text);
            return;
        } catch {
            // Fall through to the Web Clipboard API when the native bridge is unavailable.
        }
    }

    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Copy actions should stay quiet if clipboard access is denied.
        }
    }
}

function useMermaidThemeSnapshot(): MermaidThemeSnapshot {
    const [themeSnapshot, setThemeSnapshot] = useState<MermaidThemeSnapshot>(
        createMermaidThemeSnapshot,
    );

    useEffect(() => {
        if (typeof window === "undefined" || typeof MutationObserver === "undefined") {
            return undefined;
        }

        let frameHandle = 0;

        const updateThemeSnapshot = () => {
            frameHandle = 0;
            const nextThemeSnapshot = createMermaidThemeSnapshot();
            setThemeSnapshot((currentThemeSnapshot) =>
                currentThemeSnapshot.signature === nextThemeSnapshot.signature
                    ? currentThemeSnapshot
                    : nextThemeSnapshot,
            );
        };

        const scheduleThemeSnapshotUpdate = () => {
            if (frameHandle !== 0) {
                return;
            }

            if (window.requestAnimationFrame) {
                frameHandle = window.requestAnimationFrame(updateThemeSnapshot);
                return;
            }

            frameHandle = window.setTimeout(updateThemeSnapshot, 0);
        };

        scheduleThemeSnapshotUpdate();

        const observer = new MutationObserver(scheduleThemeSnapshotUpdate);
        observer.observe(document.documentElement, {
            attributeFilter: ["class", "style"],
            attributes: true,
        });

        return () => {
            observer.disconnect();
            if (frameHandle !== 0) {
                if (window.cancelAnimationFrame) {
                    window.cancelAnimationFrame(frameHandle);
                } else {
                    window.clearTimeout(frameHandle);
                }
            }
        };
    }, []);

    return themeSnapshot;
}

export const MarkdownMermaidDiagram = memo(function MarkdownMermaidDiagram({
    loadMermaid = loadMermaidRenderer,
    sanitizeSvg = sanitizeMermaidSvg,
    source,
}: MarkdownMermaidDiagramProps) {
    const reactId = useId();
    const elementIdRef = useRef(createMermaidElementId(reactId));
    const themeSnapshot = useMermaidThemeSnapshot();
    const trimmedSource = source.trim();
    const currentRenderKey = `${themeSnapshot.signature}\n${trimmedSource}`;
    const [renderState, setRenderState] =
        useState<MermaidRenderState>(initialRenderState);
    const visibleRenderState =
        trimmedSource.length > MERMAID_SOURCE_MAX_LENGTH
            ? {
                  errorMessage: null,
                  renderKey: currentRenderKey,
                  status: "too-large" as const,
                  svg: null,
              }
            : renderState.renderKey === currentRenderKey
              ? renderState
              : initialRenderState;

    useEffect(() => {
        let cancelled = false;

        if (trimmedSource.length > MERMAID_SOURCE_MAX_LENGTH) {
            return () => {
                cancelled = true;
            };
        }

        const renderDiagram = async () => {
            try {
                const mermaid = await loadMermaid();
                initializeMermaidRenderer(mermaid, themeSnapshot);
                const result = await mermaid.render(
                    elementIdRef.current,
                    trimmedSource,
                );
                const sanitizedSvg = sanitizeSvg(result.svg);

                if (!cancelled) {
                    setRenderState({
                        errorMessage: null,
                        renderKey: currentRenderKey,
                        status: "ready",
                        svg: sanitizedSvg,
                    });
                }
            } catch {
                if (!cancelled) {
                    setRenderState({
                        errorMessage: "Could not render Mermaid diagram",
                        renderKey: currentRenderKey,
                        status: "error",
                        svg: null,
                    });
                }
            }
        };

        void renderDiagram();

        return () => {
            cancelled = true;
        };
    }, [
        currentRenderKey,
        loadMermaid,
        sanitizeSvg,
        themeSnapshot,
        trimmedSource,
    ]);

    const handleCopySource = useCallback(() => {
        void writeMermaidSourceClipboardText(source);
    }, [source]);

    return (
        <div className="markdown-file-preview__mermaid-frame">
            <div className="markdown-file-preview__mermaid-header">
                <span>Mermaid</span>
                <button
                    className="markdown-file-preview__mermaid-copy-button"
                    onClick={handleCopySource}
                    type="button"
                >
                    Copy source
                </button>
            </div>
            <div
                aria-label="Mermaid diagram"
                className="markdown-file-preview__mermaid-body"
            >
                {visibleRenderState.status === "loading" ? (
                    <div
                        className="markdown-file-preview__mermaid-status"
                        role="status"
                    >
                        Rendering diagram...
                    </div>
                ) : null}
                {visibleRenderState.status === "too-large" ? (
                    <div
                        className="markdown-file-preview__mermaid-status"
                        role="status"
                    >
                        Diagram source is too large to preview
                    </div>
                ) : null}
                {visibleRenderState.status === "error" ? (
                    <div
                        className="markdown-file-preview__mermaid-error"
                        role="alert"
                    >
                        {visibleRenderState.errorMessage}
                    </div>
                ) : null}
                {visibleRenderState.status === "ready" && visibleRenderState.svg ? (
                    <div
                        className="markdown-file-preview__mermaid-svg"
                        // Mermaid only returns SVG strings; sanitize before inserting.
                        dangerouslySetInnerHTML={{ __html: visibleRenderState.svg }}
                    />
                ) : null}
            </div>
        </div>
    );
});
