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

const initializedMermaidRenderers = new WeakSet<MermaidRenderer>();

const initialRenderState: MermaidRenderState = {
    errorMessage: null,
    status: "loading",
    svg: null,
};

const mermaidInitializeConfig: MermaidInitializeConfig = {
    deterministicIds: true,
    logLevel: "error",
    maxTextSize: MERMAID_SOURCE_MAX_LENGTH,
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize"],
    securityLevel: "strict",
    startOnLoad: false,
    theme: "base",
};

function createMermaidElementId(reactId: string): string {
    const safeId = reactId.replace(/[^A-Za-z0-9_-]/g, "");
    return `markdown-mermaid-${safeId || "diagram"}`;
}

async function loadMermaidRenderer(): Promise<MermaidRenderer> {
    const mermaidModule = await import("mermaid");
    return mermaidModule.default;
}

function initializeMermaidRenderer(mermaid: MermaidRenderer): void {
    if (initializedMermaidRenderers.has(mermaid)) {
        return;
    }

    mermaid.initialize(mermaidInitializeConfig);
    initializedMermaidRenderers.add(mermaid);
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

export const MarkdownMermaidDiagram = memo(function MarkdownMermaidDiagram({
    loadMermaid = loadMermaidRenderer,
    sanitizeSvg = sanitizeMermaidSvg,
    source,
}: MarkdownMermaidDiagramProps) {
    const reactId = useId();
    const elementIdRef = useRef(createMermaidElementId(reactId));
    const [renderState, setRenderState] =
        useState<MermaidRenderState>(initialRenderState);

    useEffect(() => {
        const trimmedSource = source.trim();
        let cancelled = false;

        if (trimmedSource.length > MERMAID_SOURCE_MAX_LENGTH) {
            setRenderState({
                errorMessage: null,
                status: "too-large",
                svg: null,
            });
            return () => {
                cancelled = true;
            };
        }

        setRenderState(initialRenderState);

        const renderDiagram = async () => {
            try {
                const mermaid = await loadMermaid();
                initializeMermaidRenderer(mermaid);
                const result = await mermaid.render(
                    elementIdRef.current,
                    trimmedSource,
                );
                const sanitizedSvg = sanitizeSvg(result.svg);

                if (!cancelled) {
                    setRenderState({
                        errorMessage: null,
                        status: "ready",
                        svg: sanitizedSvg,
                    });
                }
            } catch {
                if (!cancelled) {
                    setRenderState({
                        errorMessage: "Could not render Mermaid diagram",
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
    }, [loadMermaid, sanitizeSvg, source]);

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
                {renderState.status === "loading" ? (
                    <div
                        className="markdown-file-preview__mermaid-status"
                        role="status"
                    >
                        Rendering diagram...
                    </div>
                ) : null}
                {renderState.status === "too-large" ? (
                    <div
                        className="markdown-file-preview__mermaid-status"
                        role="status"
                    >
                        Diagram source is too large to preview
                    </div>
                ) : null}
                {renderState.status === "error" ? (
                    <div
                        className="markdown-file-preview__mermaid-error"
                        role="alert"
                    >
                        {renderState.errorMessage}
                    </div>
                ) : null}
                {renderState.status === "ready" && renderState.svg ? (
                    <div
                        className="markdown-file-preview__mermaid-svg"
                        // Mermaid only returns SVG strings; sanitize before inserting.
                        dangerouslySetInnerHTML={{ __html: renderState.svg }}
                    />
                ) : null}
            </div>
        </div>
    );
});
