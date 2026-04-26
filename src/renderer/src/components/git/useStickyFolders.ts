import { useLayoutEffect, useMemo, useRef, useState } from "react";

import {
    computeFolderLastDescendant,
    flattenVisibleTree,
    type FlatRowEntry,
} from "./flattenTree";
import type { GitTreeNode, GitViewLayout } from "./types";

const ROW_HEIGHT = 28;

export interface StickyFolder {
    readonly node: GitTreeNode;
    readonly depth: number;
    readonly top: number;
    readonly path: string;
}

export interface UseStickyFoldersResult {
    readonly stickyFolders: readonly StickyFolder[];
    readonly stickyFolderPaths: ReadonlySet<string>;
    readonly scrollLeft: number;
}

export function useStickyFolders({
    scrollContainer,
    nodes,
    expandedPaths,
    layout,
    enabled = true,
}: {
    readonly scrollContainer: HTMLElement | null;
    readonly nodes: readonly GitTreeNode[];
    readonly expandedPaths: readonly string[] | undefined;
    readonly layout: GitViewLayout;
    readonly enabled?: boolean;
}): UseStickyFoldersResult {
    const [scrollTop, setScrollTop] = useState(0);
    const [scrollLeft, setScrollLeft] = useState(0);
    const [scale, setScale] = useState(1);
    const [paddingTop, setPaddingTop] = useState(0);
    const rafRef = useRef(0);

    useLayoutEffect(() => {
        if (!scrollContainer) {
            setScrollTop(0);
            setScrollLeft(0);
            setScale(1);
            setPaddingTop(0);
            return;
        }

        const container = scrollContainer;

        const readMetrics = (): void => {
            const styles = getComputedStyle(container);
            const raw = styles.getPropertyValue("--file-tree-scale");
            const parsed = parseFloat(raw);
            if (!Number.isNaN(parsed) && parsed > 0) {
                setScale(parsed);
            } else {
                setScale(1);
            }
            setPaddingTop(parseFloat(styles.paddingTop) || 0);
            setScrollTop(container.scrollTop);
            setScrollLeft(container.scrollLeft);
        };

        // Read immediately so remounts/restored scroll positions do not leave
        // hidden row placeholders ahead of the overlay.
        readMetrics();

        const onScroll = () => {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(() => {
                setScrollTop(container.scrollTop);
                setScrollLeft(container.scrollLeft);
            });
        };

        const resizeObserver = new ResizeObserver(() => {
            readMetrics();
        });

        container.addEventListener("scroll", onScroll, { passive: true });
        resizeObserver.observe(container);

        return () => {
            cancelAnimationFrame(rafRef.current);
            container.removeEventListener("scroll", onScroll);
            resizeObserver.disconnect();
        };
    }, [scrollContainer]);

    const flatRows = useMemo(
        () => flattenVisibleTree(nodes, expandedPaths, layout),
        [nodes, expandedPaths, layout],
    );

    const folderLastDescendant = useMemo(
        () => computeFolderLastDescendant(flatRows),
        [flatRows],
    );

    const stickyFolders = useMemo(() => {
        if (!enabled) {
            return [];
        }

        const effectiveRowHeight = ROW_HEIGHT * scale;
        const result: StickyFolder[] = [];

        for (let depth = 0; depth < 50; depth++) {
            const stickyY = depth * effectiveRowHeight;
            let bestFolder: FlatRowEntry | null = null;
            let bestIndex = -1;

            for (let i = 0; i < flatRows.length; i++) {
                const row = flatRows[i];
                // Defensive: future `noUncheckedIndexedAccess` would widen
                // `row` to `FlatRowEntry | undefined`; bail early in any case.
                if (!row || row.kind !== "directory" || row.depth !== depth) {
                    continue;
                }

                const rowTop = paddingTop + i * effectiveRowHeight;
                const lastDescIdx = folderLastDescendant.get(i) ?? i;
                const sectionBottom =
                    paddingTop + (lastDescIdx + 1) * effectiveRowHeight;

                if (
                    rowTop < scrollTop + stickyY &&
                    sectionBottom > scrollTop + stickyY + effectiveRowHeight
                ) {
                    bestFolder = row;
                    bestIndex = i;
                }
            }

            if (!bestFolder || bestIndex < 0) {
                break;
            }

            const lastDescIdx =
                folderLastDescendant.get(bestIndex) ?? bestIndex;
            const sectionBottom =
                paddingTop + (lastDescIdx + 1) * effectiveRowHeight;
            const maxTop = sectionBottom - scrollTop - effectiveRowHeight;
            const top = Math.min(stickyY, maxTop);

            result.push({
                node: bestFolder.node,
                depth: bestFolder.depth,
                top,
                path: bestFolder.path,
            });
        }

        return result;
    }, [
        enabled,
        flatRows,
        folderLastDescendant,
        scrollTop,
        scale,
        paddingTop,
    ]);

    const stickyFolderPaths = useMemo(
        () => new Set(stickyFolders.map((f) => f.path)),
        [stickyFolders],
    );

    return { stickyFolders, stickyFolderPaths, scrollLeft };
}
