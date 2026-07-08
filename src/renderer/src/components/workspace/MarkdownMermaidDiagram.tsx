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

interface MermaidRenderState {
    readonly errorMessage: string | null;
    readonly renderKey: string | null;
    readonly status: MermaidRenderStatus;
    readonly svg: string | null;
}

interface MermaidInitializeConfig {
    readonly deterministicIds: boolean;
    readonly logLevel: "error";
    readonly maxTextSize: number;
    readonly secure: string[];
    readonly securityLevel: "strict";
    readonly startOnLoad: boolean;
    readonly theme: "base";
    readonly themeVariables: {
        readonly background: string;
        readonly errorBkgColor: string;
        readonly errorTextColor: string;
        readonly lineColor: string;
        readonly mainBkg: string;
        readonly nodeBorder: string;
        readonly primaryBorderColor: string;
        readonly primaryColor: string;
        readonly primaryTextColor: string;
        readonly secondaryBorderColor: string;
        readonly secondaryColor: string;
        readonly tertiaryColor: string;
    };
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

const fallbackMermaidThemeVariables: MermaidInitializeConfig["themeVariables"] = {
    background: "transparent",
    errorBkgColor: "#3b1d24",
    errorTextColor: "#f8d7da",
    lineColor: "#8a93a5",
    mainBkg: "#1f2430",
    nodeBorder: "#515a6e",
    primaryBorderColor: "#515a6e",
    primaryColor: "#252b38",
    primaryTextColor: "#f4f6fb",
    secondaryBorderColor: "#515a6e",
    secondaryColor: "#202633",
    tertiaryColor: "#171b24",
};

function createMermaidElementId(reactId: string): string {
    const safeId = reactId.replace(/[^A-Za-z0-9_-]/g, "");
    return `markdown-mermaid-${safeId || "diagram"}`;
}

function readCssColorVariable(variableName: string, fallback: string): string {
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
    const background = readCssColorVariable(
        "--color-bg-tertiary",
        fallbackMermaidThemeVariables.primaryColor,
    );
    const borderColor = readCssColorVariable(
        "--color-border",
        fallbackMermaidThemeVariables.primaryBorderColor,
    );
    const textColor = readCssColorVariable(
        "--color-text-primary",
        fallbackMermaidThemeVariables.primaryTextColor,
    );
    const secondaryBackground = readCssColorVariable(
        "--color-bg-secondary",
        fallbackMermaidThemeVariables.secondaryColor,
    );
    const tertiaryBackground = readCssColorVariable(
        "--color-bg-primary",
        fallbackMermaidThemeVariables.tertiaryColor,
    );
    const lineColor = readCssColorVariable(
        "--color-text-secondary",
        fallbackMermaidThemeVariables.lineColor,
    );
    const errorBackground = readCssColorVariable(
        "--color-danger-bg",
        fallbackMermaidThemeVariables.errorBkgColor,
    );
    const errorTextColor = readCssColorVariable(
        "--color-danger",
        fallbackMermaidThemeVariables.errorTextColor,
    );
    const themeVariables = {
        background: "transparent",
        errorBkgColor: errorBackground,
        errorTextColor,
        lineColor,
        mainBkg: background,
        nodeBorder: borderColor,
        primaryBorderColor: borderColor,
        primaryColor: background,
        primaryTextColor: textColor,
        secondaryBorderColor: borderColor,
        secondaryColor: secondaryBackground,
        tertiaryColor: tertiaryBackground,
    };

    return {
        initializeConfig: {
            deterministicIds: true,
            logLevel: "error",
            maxTextSize: MERMAID_SOURCE_MAX_LENGTH,
            secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize"],
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
