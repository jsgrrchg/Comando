import { type CodeViewDiffItem } from "@pierre/diffs";
import {
    CodeView,
    type CodeViewHandle,
} from "@pierre/diffs/react";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    type MouseEvent as ReactMouseEvent,
    type RefCallback,
} from "react";

import {
    buildPierreDiffHostStyle,
    getComandoPierreThemes,
} from "@renderer/app/editor/pierreShikiTheme";
import {
    resolveComandoThemeTokens,
    resolveIsDark,
} from "@renderer/app/settings/theme";
import { useSettingsStore } from "@renderer/app/store/settings-store";

import { GitBadge } from "./GitUi";
import {
    getPierreDiffVirtualMetrics,
} from "./PierreGitDiffModel";
import { PIERRE_GIT_DIFF_UNSAFE_CSS } from "./PierreGitDiffFile";
import type { GitDiffFile, GitDiffStyle } from "./types";

export interface PierreGitCodeViewProps {
    readonly activeFileId: string | null;
    readonly className?: string;
    readonly codeFontFamily: string | null;
    readonly codeFontSize: number | null;
    readonly codeLineHeight: number | null;
    readonly collapsedFileIds: ReadonlySet<string>;
    readonly diffStyle: GitDiffStyle;
    readonly files: readonly GitDiffFile[];
    readonly items: readonly CodeViewDiffItem[];
    readonly lineWrapping: boolean;
    readonly onScrollTop?: (scrollTop: number) => void;
    readonly onToggleFileCollapse: (fileId: string) => void;
    readonly scrollRef?: RefCallback<HTMLDivElement>;
}

export function PierreGitCodeView({
    activeFileId,
    className,
    codeFontFamily,
    codeFontSize,
    codeLineHeight,
    collapsedFileIds,
    diffStyle,
    files,
    items: baseItems,
    lineWrapping,
    onScrollTop,
    onToggleFileCollapse,
    scrollRef,
}: PierreGitCodeViewProps) {
    const appearance = useSettingsStore((state) => state.appearance);
    const systemIsDark = useSettingsStore((state) => state.systemTheme.isDark);
    const codeViewRef = useRef<CodeViewHandle<undefined> | null>(null);
    const itemRevisionRef = useRef(
        new Map<
            string,
            {
                readonly collapsed: boolean;
                readonly source: CodeViewDiffItem;
                readonly version: number;
            }
        >(),
    );
    const isDark = resolveIsDark(appearance.themeMode, systemIsDark);
    const filesById = useMemo(
        () => new Map(files.map((file) => [file.id, file])),
        [files],
    );
    const items = useMemo<readonly CodeViewDiffItem[]>(
        () => {
            const activeItemIds = new Set<string>();

            const nextItems = baseItems.map((item) => {
                const collapsed = collapsedFileIds.has(item.id);
                const previous = itemRevisionRef.current.get(item.id);
                const version =
                    previous?.source === item && previous.collapsed === collapsed
                        ? previous.version
                        : (previous?.version ?? -1) + 1;

                activeItemIds.add(item.id);
                itemRevisionRef.current.set(item.id, {
                    collapsed,
                    source: item,
                    version,
                });

                return {
                    ...item,
                    collapsed,
                    // CodeView only reconciles controlled item updates when their version changes.
                    version,
                };
            });

            for (const itemId of itemRevisionRef.current.keys()) {
                if (!activeItemIds.has(itemId)) {
                    itemRevisionRef.current.delete(itemId);
                }
            }

            return nextItems;
        },
        [baseItems, collapsedFileIds],
    );
    const options = useMemo(
        () => ({
            diffStyle,
            disableErrorHandling: true,
            disableFileHeader: false,
            itemMetrics: getPierreDiffVirtualMetrics(
                codeFontSize,
                codeLineHeight,
            ),
            layout: {
                gap: 0,
                paddingBottom: 8,
                paddingTop: 8,
            },
            overflow: lineWrapping ? ("wrap" as const) : ("scroll" as const),
            stickyHeaders: true,
            theme: getComandoPierreThemes(
                appearance.themePreset,
                appearance.boostCodeContrast,
            ),
            themeType: isDark ? ("dark" as const) : ("light" as const),
            unsafeCSS: PIERRE_GIT_DIFF_UNSAFE_CSS,
        }),
        [
            appearance.boostCodeContrast,
            appearance.themePreset,
            codeFontSize,
            codeLineHeight,
            diffStyle,
            isDark,
            lineWrapping,
        ],
    );
    const style = useMemo(
        () =>
            buildPierreDiffHostStyle(
                resolveComandoThemeTokens(
                    appearance.themePreset,
                    isDark,
                    appearance.boostCodeContrast,
                ),
                {
                    fontFamily: codeFontFamily,
                    fontSize: codeFontSize,
                    lineHeight: codeLineHeight,
                },
            ),
        [
            appearance.boostCodeContrast,
            appearance.themePreset,
            codeFontFamily,
            codeFontSize,
            codeLineHeight,
            isDark,
        ],
    );
    const setContainer = useCallback<RefCallback<HTMLDivElement>>(
        (node) => {
            scrollRef?.(node);
        },
        [scrollRef],
    );

    useEffect(() => {
        if (!activeFileId || !filesById.has(activeFileId)) {
            return;
        }

        codeViewRef.current?.scrollTo({
            align: "start",
            behavior: "instant",
            id: activeFileId,
            offset: -8,
            type: "item",
        });
    }, [activeFileId, filesById]);

    return (
        <CodeView
            className={[
                "pierre-git-code-view shell-scrollbar min-h-0 flex-1 overflow-y-auto select-text",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
            containerRef={setContainer}
            items={items}
            onScroll={onScrollTop}
            options={options}
            ref={codeViewRef}
            renderHeaderFilenameSuffix={(item) => {
                const file = filesById.get(item.id);
                if (!file) {
                    return null;
                }

                return (
                    <>
                        {file.sectionLabel ? (
                            <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-text-secondary">
                                {file.sectionLabel}
                            </span>
                        ) : null}
                        {file.reversible ? (
                            <GitBadge className="shrink-0" tone="neutral">
                                reversible
                            </GitBadge>
                        ) : null}
                    </>
                );
            }}
            renderHeaderMetadata={(item) => {
                const file = filesById.get(item.id);
                if (!file) {
                    return null;
                }

                return (
                    <div className="flex shrink-0 items-center gap-2">
                        {file.summary ? (
                            <p className="flex items-center gap-1.5 text-[12px]">
                                <DiffSummaryColored summary={file.summary} />
                            </p>
                        ) : null}
                        <DiffFileActionGroup actions={file.actions} />
                    </div>
                );
            }}
            renderHeaderPrefix={(item) => (
                <PierreCollapseButton
                    collapsed={item.collapsed === true}
                    onToggle={() => onToggleFileCollapse(item.id)}
                />
            )}
            style={style}
        />
    );
}

function PierreCollapseButton({
    collapsed,
    onToggle,
}: {
    readonly collapsed: boolean;
    readonly onToggle: () => void;
}) {
    const handleClick = useCallback(
        (event: ReactMouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            onToggle();
        },
        [onToggle],
    );

    return (
        <button
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand file" : "Collapse file"}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            onClick={handleClick}
            title={collapsed ? "Expand file" : "Collapse file"}
            type="button"
        >
            <CollapseChevron collapsed={collapsed} />
        </button>
    );
}

function DiffFileActionGroup({
    actions,
}: {
    readonly actions: readonly NonNullable<GitDiffFile["actions"]>[number][] | undefined;
}) {
    if (!actions || actions.length === 0) {
        return null;
    }

    return (
        <div className="flex shrink-0 items-center gap-1.5">
            {actions.map((action) => (
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
                    key={action.id}
                    onClick={(event) => {
                        event.stopPropagation();
                        action.onClick();
                    }}
                    title={action.ariaLabel ?? action.label}
                    type="button"
                >
                    {action.busy ? "..." : action.label}
                </button>
            ))}
        </div>
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
    return (
        <>
            {summary.split(/\s+/).map((part, index) => (
                <span
                    className={
                        part.startsWith("+") || part.startsWith("-")
                            ? undefined
                            : "text-text-secondary"
                    }
                    key={`${part}:${index}`}
                    style={
                        part.startsWith("+")
                            ? { color: "var(--diff-add)" }
                            : part.startsWith("-")
                              ? { color: "var(--diff-remove)" }
                              : undefined
                    }
                >
                    {part}
                </span>
            ))}
        </>
    );
}
