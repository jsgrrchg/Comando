import DOMPurify from "dompurify";
import {
    memo,
    type PointerEvent as ReactPointerEvent,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

export const MERMAID_SOURCE_MAX_LENGTH = 50000;
export const MERMAID_VIEWPORT_FIT_MAX_ZOOM = 2;
export const MERMAID_VIEWPORT_MAX_ZOOM = 10;
export const MERMAID_VIEWPORT_MIN_ZOOM = 0.25;
const MERMAID_MAX_EDGES = 500;
const MERMAID_VIEWPORT_ZOOM_STEP = 0.2;

type MermaidRenderStatus = "error" | "loading" | "ready" | "too-large";
type MermaidThemeVariableValue = boolean | string;
type MermaidThemeVariables = Record<string, MermaidThemeVariableValue>;

interface MermaidRenderState {
    readonly errorMessage: string | null;
    readonly renderKey: string | null;
    readonly status: MermaidRenderStatus;
    readonly svg: string | null;
}

interface MermaidViewportState {
    readonly fitScale: number;
    readonly isDragging: boolean;
    readonly offsetX: number;
    readonly offsetY: number;
    readonly scale: number;
}

export interface MermaidViewportStateSnapshot {
    readonly isCustom: boolean;
    readonly offsetX: number;
    readonly offsetY: number;
    readonly scale: number;
}

interface MermaidViewportSize {
    readonly height: number;
    readonly width: number;
}

interface MermaidViewportMetrics {
    readonly diagram: MermaidViewportSize;
    readonly viewport: MermaidViewportSize;
}

interface MermaidPanOffset {
    readonly x: number;
    readonly y: number;
}

interface MermaidDragState {
    readonly offsetX: number;
    readonly offsetY: number;
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
}

interface MermaidInitializeConfig {
    readonly deterministicIds: boolean;
    readonly flowchart: {
        readonly htmlLabels: boolean;
        readonly useMaxWidth: boolean;
    };
    readonly htmlLabels: boolean;
    readonly logLevel: "error";
    readonly maxEdges: number;
    readonly maxTextSize: number;
    readonly secure: string[];
    readonly securityLevel: "strict";
    readonly startOnLoad: boolean;
    readonly suppressErrorRendering: boolean;
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
    readonly onViewportStateChange?: (
        state: MermaidViewportStateSnapshot,
    ) => void;
    readonly sanitizeSvg?: MermaidSvgSanitizer;
    readonly source: string;
    readonly viewportState?: MermaidViewportStateSnapshot;
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

const initialViewportState: MermaidViewportState = {
    fitScale: 1,
    isDragging: false,
    offsetX: 0,
    offsetY: 0,
    scale: 1,
};

const initialViewportMetrics: MermaidViewportMetrics = {
    diagram: {
        height: 0,
        width: 0,
    },
    viewport: {
        height: 0,
        width: 0,
    },
};

const MERMAID_FONT_FAMILY_FALLBACK =
    '"SF Pro Text", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif';

function createMermaidElementId(reactId: string): string {
    const safeId = reactId.replace(/[^A-Za-z0-9_-]/g, "");
    return `markdown-mermaid-${safeId || "diagram"}`;
}

function parseSvgLength(value: string | null): number | null {
    if (!value) {
        return null;
    }

    const parsedValue = Number.parseFloat(value);
    return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : null;
}

function readSvgIntrinsicSize(svgElement: SVGSVGElement): MermaidViewportSize {
    const bounds = svgElement.getBoundingClientRect();

    if (bounds.width > 0 && bounds.height > 0) {
        return {
            height: bounds.height,
            width: bounds.width,
        };
    }

    const viewBox = svgElement.getAttribute("viewBox")?.trim();

    if (viewBox) {
        const viewBoxParts = viewBox
            .split(/[\s,]+/)
            .map((part) => Number.parseFloat(part));
        const [, , viewBoxWidth, viewBoxHeight] = viewBoxParts;

        if (
            Number.isFinite(viewBoxWidth) &&
            Number.isFinite(viewBoxHeight) &&
            viewBoxWidth > 0 &&
            viewBoxHeight > 0
        ) {
            return {
                height: viewBoxHeight,
                width: viewBoxWidth,
            };
        }
    }

    const width = parseSvgLength(svgElement.getAttribute("width"));
    const height = parseSvgLength(svgElement.getAttribute("height"));

    if (width && height) {
        return { height, width };
    }

    return {
        height: bounds.height,
        width: bounds.width,
    };
}

export function clampMermaidZoom(zoom: number): number {
    if (!Number.isFinite(zoom)) {
        return 1;
    }

    return Math.min(
        MERMAID_VIEWPORT_MAX_ZOOM,
        Math.max(MERMAID_VIEWPORT_MIN_ZOOM, zoom),
    );
}

export function calculateNextMermaidZoom({
    direction,
    scale,
}: {
    readonly direction: -1 | 1;
    readonly scale: number;
}): number {
    const nextScale = scale + MERMAID_VIEWPORT_ZOOM_STEP * direction;
    const roundedScale = Math.round(nextScale * 100) / 100;

    return clampMermaidZoom(roundedScale);
}

export function calculateMermaidFitScale({
    diagram,
    viewport,
}: {
    readonly diagram: MermaidViewportSize;
    readonly viewport: MermaidViewportSize;
}): number {
    const widthScale =
        diagram.width > 0 && viewport.width > 0
            ? viewport.width / diagram.width
            : 1;
    const heightScale =
        diagram.height > 0 && viewport.height > 0
            ? viewport.height / diagram.height
            : 1;

    // Fit both dimensions (never overflow either axis), but still allow small
    // diagrams to scale up so they don't render tiny inside a large viewport.
    const containScale = Math.min(widthScale, heightScale);

    return clampMermaidZoom(Math.min(MERMAID_VIEWPORT_FIT_MAX_ZOOM, containScale));
}

export function createMermaidFitViewportState({
    diagram,
    viewport,
}: {
    readonly diagram: MermaidViewportSize;
    readonly viewport: MermaidViewportSize;
}): MermaidViewportState {
    const fitScale = calculateMermaidFitScale({ diagram, viewport });

    return {
        fitScale,
        isDragging: false,
        offsetX: 0,
        offsetY: 0,
        scale: fitScale,
    };
}

export function calculateMermaidPanBounds({
    diagram,
    scale,
    viewport,
}: MermaidViewportMetrics & {
    readonly scale: number;
}): MermaidPanOffset {
    const scaledWidth = diagram.width * scale;
    const scaledHeight = diagram.height * scale;
    const minVisibleWidth = Math.min(96, viewport.width / 2, scaledWidth / 2);
    const minVisibleHeight = Math.min(96, viewport.height / 2, scaledHeight / 2);

    if (
        scaledWidth <= 0 ||
        scaledHeight <= 0 ||
        viewport.width <= 0 ||
        viewport.height <= 0
    ) {
        return { x: 0, y: 0 };
    }

    return {
        x: Math.max(0, (scaledWidth + viewport.width) / 2 - minVisibleWidth),
        y: Math.max(0, (scaledHeight + viewport.height) / 2 - minVisibleHeight),
    };
}

export function clampMermaidPanOffset({
    metrics,
    offset,
    scale,
}: {
    readonly metrics: MermaidViewportMetrics;
    readonly offset: MermaidPanOffset;
    readonly scale: number;
}): MermaidPanOffset {
    const bounds = calculateMermaidPanBounds({
        ...metrics,
        scale,
    });

    return {
        x: Math.min(bounds.x, Math.max(-bounds.x, offset.x)),
        y: Math.min(bounds.y, Math.max(-bounds.y, offset.y)),
    };
}

function formatMermaidZoomLevel(scale: number): string {
    return `${Math.round(scale * 100)}%`;
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
            maxEdges: MERMAID_MAX_EDGES,
            maxTextSize: MERMAID_SOURCE_MAX_LENGTH,
            secure: [
                "flowchart",
                "htmlLabels",
                "maxEdges",
                "maxTextSize",
                "secure",
                "securityLevel",
                "startOnLoad",
                "suppressErrorRendering",
                "theme",
                "themeCSS",
                "themeVariables",
            ],
            securityLevel: "strict",
            startOnLoad: false,
            suppressErrorRendering: false,
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
    onViewportStateChange,
    sanitizeSvg = sanitizeMermaidSvg,
    source,
    viewportState: savedViewportState,
}: MarkdownMermaidDiagramProps) {
    const reactId = useId();
    const dragStateRef = useRef<MermaidDragState | null>(null);
    const elementIdRef = useRef(createMermaidElementId(reactId));
    const hasCustomViewportRef = useRef(false);
    const mermaidSvgRef = useRef<HTMLDivElement>(null);
    const mermaidViewportMetricsRef =
        useRef<MermaidViewportMetrics>(initialViewportMetrics);
    const mermaidViewportRef = useRef<HTMLDivElement>(null);
    const hasMeasuredViewportRef = useRef(false);
    const restoredViewportRenderKeyRef = useRef<string | null>(null);
    const themeSnapshot = useMermaidThemeSnapshot();
    const trimmedSource = source.trim();
    const currentRenderKey = `${themeSnapshot.signature}\n${trimmedSource}`;
    const [renderState, setRenderState] =
        useState<MermaidRenderState>(initialRenderState);
    const [viewportState, setViewportState] =
        useState<MermaidViewportState>(initialViewportState);
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

    const handleZoomOut = useCallback(() => {
        hasCustomViewportRef.current = true;
        setViewportState((currentViewportState) => {
            const scale = calculateNextMermaidZoom({
                direction: -1,
                scale: currentViewportState.scale,
            });
            const offset = clampMermaidPanOffset({
                metrics: mermaidViewportMetricsRef.current,
                offset: {
                    x: currentViewportState.offsetX,
                    y: currentViewportState.offsetY,
                },
                scale,
            });

            return {
                ...currentViewportState,
                offsetX: offset.x,
                offsetY: offset.y,
                scale,
            };
        });
    }, []);

    const handleZoomIn = useCallback(() => {
        hasCustomViewportRef.current = true;
        setViewportState((currentViewportState) => {
            const scale = calculateNextMermaidZoom({
                direction: 1,
                scale: currentViewportState.scale,
            });
            const offset = clampMermaidPanOffset({
                metrics: mermaidViewportMetricsRef.current,
                offset: {
                    x: currentViewportState.offsetX,
                    y: currentViewportState.offsetY,
                },
                scale,
            });

            return {
                ...currentViewportState,
                offsetX: offset.x,
                offsetY: offset.y,
                scale,
            };
        });
    }, []);

    const handleFitDiagram = useCallback(() => {
        hasCustomViewportRef.current = false;
        dragStateRef.current = null;
        setViewportState((currentViewportState) => ({
            ...currentViewportState,
            isDragging: false,
            offsetX: 0,
            offsetY: 0,
            scale: currentViewportState.fitScale,
        }));
    }, []);

    useEffect(() => {
        if (!hasMeasuredViewportRef.current) {
            return;
        }

        onViewportStateChange?.({
            isCustom: hasCustomViewportRef.current,
            offsetX: viewportState.offsetX,
            offsetY: viewportState.offsetY,
            scale: viewportState.scale,
        });
    }, [onViewportStateChange, viewportState]);

    useLayoutEffect(() => {
        if (
            visibleRenderState.status !== "ready" ||
            !visibleRenderState.svg
        ) {
            return undefined;
        }

        hasMeasuredViewportRef.current = false;
        hasCustomViewportRef.current = savedViewportState?.isCustom ?? false;
        restoredViewportRenderKeyRef.current = null;

        const updateViewportFit = () => {
            const viewportElement = mermaidViewportRef.current;
            const svgElement =
                mermaidSvgRef.current?.querySelector<SVGSVGElement>("svg");

            if (!viewportElement || !svgElement) {
                return;
            }

            const viewportBounds = viewportElement.getBoundingClientRect();
            const diagramSize = readSvgIntrinsicSize(svgElement);
            const viewportSize = {
                height: viewportBounds.height,
                width: viewportBounds.width,
            };
            const metrics: MermaidViewportMetrics = {
                diagram: diagramSize,
                viewport: viewportSize,
            };

            mermaidViewportMetricsRef.current = metrics;

            if (!hasCustomViewportRef.current) {
                setViewportState(createMermaidFitViewportState(metrics));
                hasMeasuredViewportRef.current = true;
                return;
            }

            if (
                savedViewportState?.isCustom &&
                restoredViewportRenderKeyRef.current !== currentRenderKey
            ) {
                const scale = clampMermaidZoom(savedViewportState?.scale ?? 1);
                const offset = clampMermaidPanOffset({
                    metrics,
                    offset: {
                        x: savedViewportState?.offsetX ?? 0,
                        y: savedViewportState?.offsetY ?? 0,
                    },
                    scale,
                });

                restoredViewportRenderKeyRef.current = currentRenderKey;
                hasMeasuredViewportRef.current = true;
                setViewportState({
                    fitScale: calculateMermaidFitScale(metrics),
                    isDragging: false,
                    offsetX: offset.x,
                    offsetY: offset.y,
                    scale,
                });
                return;
            }

            // The user already zoomed or panned this diagram. Re-measuring
            // happens on every resize, including a hidden tab regaining a
            // real layout size, so only refresh the fit reference and clamp
            // the pan offset instead of discarding their adjustment.
            const fitScale = calculateMermaidFitScale(metrics);
            setViewportState((currentViewportState) => {
                const offset = clampMermaidPanOffset({
                    metrics,
                    offset: {
                        x: currentViewportState.offsetX,
                        y: currentViewportState.offsetY,
                    },
                    scale: currentViewportState.scale,
                });

                return {
                    ...currentViewportState,
                    fitScale,
                    offsetX: offset.x,
                    offsetY: offset.y,
                };
            });
            hasMeasuredViewportRef.current = true;
        };

        updateViewportFit();

        if (typeof ResizeObserver !== "undefined" && mermaidViewportRef.current) {
            const resizeObserver = new ResizeObserver(updateViewportFit);
            resizeObserver.observe(mermaidViewportRef.current);

            return () => {
                resizeObserver.disconnect();
            };
        }

        window.addEventListener("resize", updateViewportFit);

        return () => {
            window.removeEventListener("resize", updateViewportFit);
        };
    }, [
        currentRenderKey,
        visibleRenderState.renderKey,
        visibleRenderState.status,
        visibleRenderState.svg,
        savedViewportState,
    ]);

    const handleViewportPointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            if (!event.isPrimary || event.button !== 0) {
                return;
            }

            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            dragStateRef.current = {
                offsetX: viewportState.offsetX,
                offsetY: viewportState.offsetY,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
            };
            setViewportState((currentViewportState) => ({
                ...currentViewportState,
                isDragging: true,
            }));
        },
        [viewportState.offsetX, viewportState.offsetY],
    );

    const handleViewportPointerMove = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const dragState = dragStateRef.current;

            if (!dragState || dragState.pointerId !== event.pointerId) {
                return;
            }

            event.preventDefault();
            hasCustomViewportRef.current = true;
            const offset = clampMermaidPanOffset({
                metrics: mermaidViewportMetricsRef.current,
                offset: {
                    x: dragState.offsetX + event.clientX - dragState.startX,
                    y: dragState.offsetY + event.clientY - dragState.startY,
                },
                scale: viewportState.scale,
            });

            setViewportState((currentViewportState) => ({
                ...currentViewportState,
                offsetX: offset.x,
                offsetY: offset.y,
            }));
        },
        [viewportState.scale],
    );

    const stopViewportDrag = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const dragState = dragStateRef.current;

            if (!dragState || dragState.pointerId !== event.pointerId) {
                return;
            }

            event.currentTarget.releasePointerCapture?.(event.pointerId);
            dragStateRef.current = null;
            setViewportState((currentViewportState) => ({
                ...currentViewportState,
                isDragging: false,
            }));
        },
        [],
    );

    const isDiagramReady =
        visibleRenderState.status === "ready" && Boolean(visibleRenderState.svg);
    const isZoomOutDisabled =
        viewportState.scale <= MERMAID_VIEWPORT_MIN_ZOOM;
    const isZoomInDisabled =
        viewportState.scale >= MERMAID_VIEWPORT_MAX_ZOOM;
    const zoomLevel = formatMermaidZoomLevel(viewportState.scale);
    const viewportClassName = viewportState.isDragging
        ? "markdown-file-preview__mermaid-viewport markdown-file-preview__mermaid-viewport--dragging"
        : "markdown-file-preview__mermaid-viewport";

    return (
        <div className="markdown-file-preview__mermaid-frame">
            <div className="markdown-file-preview__mermaid-header">
                <span>Mermaid</span>
                <div className="markdown-file-preview__mermaid-actions">
                    {isDiagramReady ? (
                        <div
                            aria-label="Mermaid zoom controls"
                            className="markdown-file-preview__mermaid-zoom-controls"
                            role="group"
                        >
                            <button
                                aria-label="Zoom out"
                                className="markdown-file-preview__mermaid-tool-button"
                                disabled={isZoomOutDisabled}
                                onClick={handleZoomOut}
                                title="Zoom out"
                                type="button"
                            >
                                -
                            </button>
                            <span
                                aria-label="Zoom level"
                                className="markdown-file-preview__mermaid-zoom-level"
                            >
                                {zoomLevel}
                            </span>
                            <button
                                aria-label="Zoom in"
                                className="markdown-file-preview__mermaid-tool-button"
                                disabled={isZoomInDisabled}
                                onClick={handleZoomIn}
                                title="Zoom in"
                                type="button"
                            >
                                +
                            </button>
                            <button
                                aria-label="Fit diagram"
                                className="markdown-file-preview__mermaid-tool-button markdown-file-preview__mermaid-fit-button"
                                onClick={handleFitDiagram}
                                title="Fit diagram"
                                type="button"
                            >
                                Fit
                            </button>
                        </div>
                    ) : null}
                    <button
                        className="markdown-file-preview__mermaid-copy-button"
                        onClick={handleCopySource}
                        type="button"
                    >
                        Copy source
                    </button>
                </div>
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
                        className={viewportClassName}
                        onPointerCancel={stopViewportDrag}
                        onPointerDown={handleViewportPointerDown}
                        onPointerMove={handleViewportPointerMove}
                        onPointerUp={stopViewportDrag}
                        ref={mermaidViewportRef}
                    >
                        <div
                            className="markdown-file-preview__mermaid-svg"
                            ref={mermaidSvgRef}
                            style={{
                                transform: `translate(${viewportState.offsetX}px, ${viewportState.offsetY}px) scale(${viewportState.scale})`,
                            }}
                            // Mermaid only returns SVG strings; sanitize before inserting.
                            dangerouslySetInnerHTML={{
                                __html: visibleRenderState.svg,
                            }}
                        />
                    </div>
                ) : null}
            </div>
        </div>
    );
});
