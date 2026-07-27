import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type RefObject,
} from "react";

import {
    MeasuredVirtualList,
    type MeasuredVirtualListHandle,
} from "@renderer/components/virtual/MeasuredVirtualList";

import { GitDiffFileContent } from "./GitDiffFileContent";
import { GitBadge, GitEmptyState } from "./GitUi";
import { canRenderGitDiffWithPierre } from "./PierreGitDiffFile";
import type {
    GitDiffFile,
    GitDiffsViewProps,
} from "./types";

export const GIT_DIFF_FILE_VIRTUALIZATION_THRESHOLD = 25;
export const GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD = 1_000;

const DIFF_FILE_STACK_OVERSCAN = 4;
const DIFF_FILE_STACK_GAP_PX = 12;
const DIFF_FILE_HEADER_HEIGHT_PX = 52;
const DIFF_FILE_EMPTY_STATE_HEIGHT_PX = 76;
const DIFF_HUNK_HEADER_HEIGHT_PX = 26;
const DIFF_HUNK_VERTICAL_PADDING_PX = 24;
const DIFF_HUNK_GAP_PX = 12;
const DEFAULT_DIFF_LINE_HEIGHT_PX = 20;
const MAX_ESTIMATED_DIFF_FILE_HEIGHT_PX = 1_600;

function resolveDiffLineHeightPx(codeLineHeight: number | null): number {
    if (typeof codeLineHeight !== "number" || !Number.isFinite(codeLineHeight)) {
        return DEFAULT_DIFF_LINE_HEIGHT_PX;
    }

    return codeLineHeight > 4
        ? Math.max(1, codeLineHeight)
        : Math.max(1, Math.round(DEFAULT_DIFF_LINE_HEIGHT_PX * codeLineHeight));
}

export function estimateDiffFileSurfaceHeight(
    file: GitDiffFile,
    collapsed: boolean,
    codeLineHeight: number | null,
): number {
    if (collapsed) {
        return DIFF_FILE_HEADER_HEIGHT_PX;
    }

    if (!file.isText || file.hunks.length === 0) {
        return DIFF_FILE_HEADER_HEIGHT_PX + DIFF_FILE_EMPTY_STATE_HEIGHT_PX;
    }

    const lineHeight = resolveDiffLineHeightPx(codeLineHeight);
    const hunksHeight = file.hunks.reduce((total, hunk, index) => {
        const gap = index === 0 ? 0 : DIFF_HUNK_GAP_PX;
        return (
            total +
            gap +
            DIFF_HUNK_HEADER_HEIGHT_PX +
            hunk.lines.length * lineHeight
        );
    }, 0);
    const estimatedHeight =
        DIFF_FILE_HEADER_HEIGHT_PX +
        DIFF_HUNK_VERTICAL_PADDING_PX +
        hunksHeight;

    return Math.min(estimatedHeight, MAX_ESTIMATED_DIFF_FILE_HEIGHT_PX);
}

function countDiffLines(file: GitDiffFile): number {
    return file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
}

function shouldVirtualizeDiffLines({
    allowLineVirtualization,
    file,
    lineWrapping,
}: {
    readonly allowLineVirtualization: boolean;
    readonly file: GitDiffFile;
    readonly lineWrapping: boolean;
}): boolean {
    return (
        allowLineVirtualization &&
        !lineWrapping &&
        file.isText &&
        countDiffLines(file) >= GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD
    );
}

export function GitDiffsView({
    activeFileId = null,
    className,
    codeFontFamily = null,
    codeFontSize = null,
    codeLineHeight = null,
    collapsedFileIds: controlledCollapsedFileIds,
    displayMode = "single",
    emptyState,
    files,
    lineWrapping = true,
    onScroll,
    onSelectFile,
    onToggleFileCollapse,
    scrollContainerRef,
    showFileSelector = true,
    surfaceVariant = "panel",
}: GitDiffsViewProps) {
    const ownsScrollContainer = scrollContainerRef === undefined;
    const ownScrollContainerRef = useRef<HTMLElement | null>(null);
    const setOwnScrollContainer = useCallback((node: HTMLDivElement | null) => {
        ownScrollContainerRef.current = node;
    }, []);
    const resolvedScrollContainerRef =
        scrollContainerRef ?? ownScrollContainerRef;
    const isControlled = controlledCollapsedFileIds !== undefined;
    const [localCollapsedFileIds, setLocalCollapsedFileIds] = useState<
        readonly string[]
    >([]);
    const collapsedFileIds = isControlled
        ? controlledCollapsedFileIds
        : localCollapsedFileIds;
    const fileIdSet = useMemo(
        () => new Set(files.map((file) => file.id)),
        [files],
    );

    const collapsedFileIdSet = useMemo(
        () =>
            new Set(collapsedFileIds.filter((fileId) => fileIdSet.has(fileId))),
        [collapsedFileIds, fileIdSet],
    );

    const toggleFileCollapse = useCallback(
        (fileId: string) => {
            if (onToggleFileCollapse) {
                onToggleFileCollapse(fileId);
                return;
            }
            setLocalCollapsedFileIds((currentIds) =>
                currentIds.includes(fileId)
                    ? currentIds.filter((id) => id !== fileId)
                    : [...currentIds, fileId],
            );
        },
        [onToggleFileCollapse],
    );
    const activeFile =
        files.find((file) => file.id === activeFileId) ?? files[0] ?? null;

    if (files.length === 0) {
        return (
            <GitEmptyState className={className}>
                {emptyState ?? "Pick a change to inspect its diff."}
            </GitEmptyState>
        );
    }

    if (!activeFile) {
        return (
            <GitEmptyState className={className}>
                {emptyState ?? "No diff selected."}
            </GitEmptyState>
        );
    }

    return (
        <div
            className={[
                ownsScrollContainer
                    ? "shell-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2"
                    : "min-h-0 flex-1 px-2 py-2",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
            onScroll={ownsScrollContainer ? onScroll : undefined}
            ref={ownsScrollContainer ? setOwnScrollContainer : undefined}
        >
            {showFileSelector ? (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    {files.map((file) => (
                        <FileSelectorButton
                            file={file}
                            isActive={file.id === activeFile.id}
                            key={file.id}
                            onSelect={onSelectFile}
                        />
                    ))}
                </div>
            ) : null}

            {displayMode === "stack" ? (
                <VirtualizedGitDiffStack
                    activeFileId={activeFileId}
                    codeFontFamily={codeFontFamily}
                    codeFontSize={codeFontSize}
                    codeLineHeight={codeLineHeight}
                    collapsedFileIdSet={collapsedFileIdSet}
                    files={files}
                    lineWrapping={lineWrapping}
                    onToggleFileCollapse={toggleFileCollapse}
                    scrollContainerRef={resolvedScrollContainerRef}
                    surfaceVariant={surfaceVariant}
                />
            ) : (
                <DiffFileSurface
                    allowLineVirtualization
                    codeFontFamily={codeFontFamily}
                    codeFontSize={codeFontSize}
                    codeLineHeight={codeLineHeight}
                    file={activeFile}
                    lineWrapping={lineWrapping}
                    scrollContainerRef={resolvedScrollContainerRef}
                    surfaceVariant={surfaceVariant}
                />
            )}
        </div>
    );
}

const FileSelectorButton = memo(function FileSelectorButton({
    file,
    isActive,
    onSelect,
}: {
    readonly file: GitDiffFile;
    readonly isActive: boolean;
    readonly onSelect?: ((file: GitDiffFile) => void) | undefined;
}) {
    const handleClick = useCallback(() => {
        onSelect?.(file);
    }, [file, onSelect]);
    return (
        <button
            aria-pressed={isActive}
            className={[
                "inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1 text-left text-[11px] transition-colors",
                isActive
                    ? "border-[color-mix(in_srgb,var(--color-accent)_34%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-bg-secondary))] text-text-primary"
                    : "border-border bg-bg-secondary text-text-secondary hover:text-text-primary",
            ].join(" ")}
            onClick={handleClick}
            type="button"
        >
            <span
                className="truncate font-mono"
                style={{ color: diffKindColor(file.kind) }}
                title={file.statusLabel ?? file.kind}
            >
                {file.path}
            </span>
        </button>
    );
});

function calculateScrollMarginTop(
    element: HTMLElement | null,
    scrollContainer: HTMLElement | null,
): number {
    if (!element || !scrollContainer || element === scrollContainer) {
        return 0;
    }

    const elementRect = element.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    return Math.max(
        0,
        elementRect.top - containerRect.top + scrollContainer.scrollTop,
    );
}

function VirtualizedGitDiffStack({
    activeFileId,
    codeFontFamily,
    codeFontSize,
    codeLineHeight,
    collapsedFileIdSet,
    files,
    lineWrapping,
    onToggleFileCollapse,
    scrollContainerRef,
    surfaceVariant,
}: {
    readonly activeFileId: string | null | undefined;
    readonly codeFontFamily: string | null;
    readonly codeFontSize: number | null;
    readonly codeLineHeight: number | null;
    readonly collapsedFileIdSet: ReadonlySet<string>;
    readonly files: readonly GitDiffFile[];
    readonly lineWrapping: boolean;
    readonly onToggleFileCollapse: (fileId: string) => void;
    readonly scrollContainerRef: RefObject<HTMLElement | null>;
    readonly surfaceVariant: "flat" | "panel";
}) {
    const stackRef = useRef<HTMLDivElement | null>(null);
    const virtualListHandleRef = useRef<MeasuredVirtualListHandle | null>(null);
    const [scrollMarginTop, setScrollMarginTop] = useState(0);
    const shouldVirtualize = files.length >= GIT_DIFF_FILE_VIRTUALIZATION_THRESHOLD;
    const activeFileIndex = useMemo(
        () =>
            activeFileId
                ? files.findIndex((file) => file.id === activeFileId)
                : -1,
        [activeFileId, files],
    );

    useEffect(() => {
        if (!shouldVirtualize || typeof window === "undefined") {
            return;
        }

        const syncScrollMarginTop = () => {
            setScrollMarginTop(
                calculateScrollMarginTop(
                    stackRef.current,
                    scrollContainerRef.current,
                ),
            );
        };

        syncScrollMarginTop();

        const scrollContainer = scrollContainerRef.current;
        let observer: ResizeObserver | null = null;

        if (typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(syncScrollMarginTop);
            if (stackRef.current) {
                observer.observe(stackRef.current);
            }
            if (scrollContainer) {
                observer.observe(scrollContainer);
            }
        }

        window.addEventListener("resize", syncScrollMarginTop);

        return () => {
            observer?.disconnect();
            window.removeEventListener("resize", syncScrollMarginTop);
        };
    }, [scrollContainerRef, shouldVirtualize]);

    useEffect(() => {
        if (!shouldVirtualize || activeFileIndex < 0) {
            return;
        }

        virtualListHandleRef.current?.scrollToIndex(activeFileIndex, {
            align: "start",
            offset: -8,
        });
    }, [activeFileIndex, shouldVirtualize]);

    const renderDiffFile = useCallback(
        (file: GitDiffFile) => (
            <DiffFileSurface
                allowLineVirtualization
                codeFontFamily={codeFontFamily}
                codeFontSize={codeFontSize}
                codeLineHeight={codeLineHeight}
                collapsed={collapsedFileIdSet.has(file.id)}
                file={file}
                fileId={file.id}
                lineWrapping={lineWrapping}
                onToggleCollapse={onToggleFileCollapse}
                scrollContainerRef={scrollContainerRef}
                surfaceVariant={surfaceVariant}
            />
        ),
        [
            codeFontFamily,
            codeFontSize,
            codeLineHeight,
            collapsedFileIdSet,
            lineWrapping,
            onToggleFileCollapse,
            scrollContainerRef,
            surfaceVariant,
        ],
    );

    const estimateFileSize = useCallback(
        (file: GitDiffFile, index: number) =>
            estimateDiffFileSurfaceHeight(
                file,
                collapsedFileIdSet.has(file.id),
                codeLineHeight,
            ) + (index === files.length - 1 ? 0 : DIFF_FILE_STACK_GAP_PX),
        [codeLineHeight, collapsedFileIdSet, files.length],
    );

    const handleVirtualListReady = useCallback(
        (handle: MeasuredVirtualListHandle | null) => {
            virtualListHandleRef.current = handle;
        },
        [],
    );

    if (!shouldVirtualize) {
        return (
            <div className="space-y-3" ref={stackRef}>
                {files.map((file) => (
                    <div key={file.id}>{renderDiffFile(file)}</div>
                ))}
            </div>
        );
    }

    return (
        <div ref={stackRef}>
            <MeasuredVirtualList
                enabled
                estimateSize={estimateFileSize}
                getItemKey={(file) => file.id}
                items={files}
                onReady={handleVirtualListReady}
                overscan={DIFF_FILE_STACK_OVERSCAN}
                renderItem={({ index, item }) => (
                    <div
                        className={
                            index === files.length - 1 ? undefined : "pb-3"
                        }
                    >
                        {renderDiffFile(item)}
                    </div>
                )}
                scrollContainerRef={scrollContainerRef}
                scrollMarginTop={scrollMarginTop}
            />
        </div>
    );
}

const DiffFileSurface = memo(function DiffFileSurface({
    allowLineVirtualization = false,
    codeFontFamily = null,
    codeFontSize = null,
    codeLineHeight = null,
    collapsed = false,
    file,
    fileId,
    lineWrapping = true,
    onToggleCollapse,
    scrollContainerRef,
    surfaceVariant,
}: {
    readonly allowLineVirtualization?: boolean;
    readonly codeFontFamily?: string | null;
    readonly codeFontSize?: number | null;
    readonly codeLineHeight?: number | null;
    readonly collapsed?: boolean;
    readonly file: GitDiffFile;
    readonly fileId?: string;
    readonly lineWrapping?: boolean;
    readonly onToggleCollapse?: ((fileId: string) => void) | undefined;
    readonly scrollContainerRef?: RefObject<HTMLElement | null>;
    readonly surfaceVariant: "flat" | "panel";
}) {
    const isCollapsible = typeof onToggleCollapse === "function";
    const handleToggle = useCallback(() => {
        if (onToggleCollapse && fileId !== undefined) {
            onToggleCollapse(fileId);
        }
    }, [onToggleCollapse, fileId]);
    const headerContent = (
        <>
            <div className="min-w-0 flex-1">
                {/* Single non-wrapping row: the path truncates instead of
                    pushing the chevron or badge onto their own line. */}
                <div className="flex items-center gap-2">
                    {isCollapsible ? (
                        <CollapseChevron collapsed={collapsed} />
                    ) : null}
                    <span
                        className="min-w-0 flex-1 truncate font-mono text-[14px] font-medium"
                        title={file.statusLabel ?? file.kind}
                    >
                        <span className="text-text-secondary">
                            {file.path.substring(
                                0,
                                file.path.lastIndexOf("/") + 1,
                            )}
                        </span>
                        <span style={{ color: diffKindColor(file.kind) }}>
                            {file.path.substring(
                                file.path.lastIndexOf("/") + 1,
                            )}
                        </span>
                    </span>
                    {file.reversible ? (
                        <GitBadge className="shrink-0" tone="neutral">
                            reversible
                        </GitBadge>
                    ) : null}
                </div>
                {file.previousPath ? (
                    <p className="mt-1 truncate text-[11px] text-text-secondary">
                        Previous path: {file.previousPath}
                    </p>
                ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-2">
                {file.summary ? (
                    <p className="flex items-center gap-1.5 text-[13px]">
                        <DiffSummaryColored summary={file.summary} />
                    </p>
                ) : null}
            </div>
        </>
    );
    const actionButtons =
        file.actions && file.actions.length > 0 ? (
            <div className="flex shrink-0 items-center gap-1.5">
                {file.actions.map((action) => (
                    <DiffFileActionButton action={action} key={action.id} />
                ))}
            </div>
        ) : null;
    const canRenderWithPierre = canRenderGitDiffWithPierre(file);
    const virtualizeLines =
        !canRenderWithPierre &&
        scrollContainerRef !== undefined &&
        shouldVirtualizeDiffLines({
            allowLineVirtualization,
            file,
            lineWrapping,
        });

    return (
        <section
            className={[
                "overflow-hidden",
                surfaceVariant === "panel"
                    ? "rounded-xl border border-border bg-bg-secondary"
                    : "bg-bg-primary",
            ].join(" ")}
        >
            {isCollapsible ? (
                <div
                    className={[
                        "flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-secondary/55",
                        surfaceVariant === "panel" && !collapsed
                            ? "border-b border-border"
                            : "",
                    ].join(" ")}
                >
                    <button
                        aria-expanded={!collapsed}
                        className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2 text-left"
                        onClick={handleToggle}
                        type="button"
                    >
                        {headerContent}
                    </button>
                    {actionButtons}
                </div>
            ) : (
                <div
                    className={[
                        "flex flex-wrap items-center justify-between gap-2 px-3 py-2",
                        surfaceVariant === "panel"
                            ? "border-b border-border"
                            : "",
                    ].join(" ")}
                >
                    {headerContent}
                    {actionButtons}
                </div>
            )}

            {collapsed ? null : (
                <GitDiffFileContent
                    codeFontFamily={codeFontFamily}
                    codeFontSize={codeFontSize}
                    codeLineHeight={codeLineHeight}
                    canRenderWithPierre={canRenderWithPierre}
                    file={file}
                    lineWrapping={lineWrapping}
                    scrollContainerRef={scrollContainerRef}
                    virtualizeLines={virtualizeLines}
                />
            )}
        </section>
    );
});

function DiffFileActionButton({
    action,
}: {
    readonly action: NonNullable<GitDiffFile["actions"]>[number];
}) {
    const handleClick = useCallback(
        (event: ReactMouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            action.onClick();
        },
        [action],
    );

    return (
        <button
            aria-label={action.ariaLabel}
            className={[
                "review-text-btn rounded border px-2 py-1 text-[10px] font-medium",
                action.tone === "danger"
                    ? "border-red-500/30 text-red-400 hover:bg-red-500/10"
                    : "border-border text-text-secondary hover:bg-bg-tertiary hover:text-text-primary",
                action.disabled ? "cursor-not-allowed opacity-50" : "",
            ].join(" ")}
            disabled={action.disabled || action.busy}
            onClick={handleClick}
            title={action.ariaLabel ?? action.label}
            type="button"
        >
            {action.busy ? "..." : action.label}
        </button>
    );
}

function CollapseChevron({ collapsed }: { readonly collapsed: boolean }) {
    return (
        <svg
            aria-hidden="true"
            className={[
                "shrink-0 text-text-secondary transition-transform",
                collapsed ? "" : "rotate-90",
            ].join(" ")}
            fill="none"
            height="12"
            viewBox="0 0 16 16"
            width="12"
        >
            <path
                d="M6 4.5 9.5 8 6 11.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.4"
            />
        </svg>
    );
}

function DiffSummaryColored({ summary }: { readonly summary: string }) {
    const parts = summary.split(/\s+/);
    return (
        <>
            {parts.map((part, i) => {
                if (part.startsWith("+")) {
                    return (
                        <span key={i} style={{ color: "var(--diff-add)" }}>
                            {part}
                        </span>
                    );
                }
                if (part.startsWith("-")) {
                    return (
                        <span key={i} style={{ color: "var(--diff-remove)" }}>
                            {part}
                        </span>
                    );
                }
                return (
                    <span key={i} className="text-text-secondary">
                        {part}
                    </span>
                );
            })}
        </>
    );
}

function diffKindColor(kind: GitDiffFile["kind"]): string {
    switch (kind) {
        case "create":
            return "var(--diff-add)";
        case "delete":
            return "var(--diff-remove)";
        case "move":
            return "var(--color-accent)";
        case "update":
        default:
            return "var(--diff-warn)";
    }
}
