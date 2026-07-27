import { Virtualizer as PierreVirtualizer } from "@pierre/diffs";
import { VirtualizerContext } from "@pierre/diffs/react";
import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode,
    type RefObject,
} from "react";

const useIsomorphicLayoutEffect =
    typeof window === "undefined" ? useEffect : useLayoutEffect;

function canUsePierreVirtualizer(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof ResizeObserver !== "undefined" &&
        typeof IntersectionObserver !== "undefined"
    );
}

export function PierreGitDiffVirtualizerProvider({
    children,
    scrollContainerRef,
}: {
    readonly children: ReactNode;
    readonly scrollContainerRef: RefObject<HTMLElement | null>;
}) {
    const contentRef = useRef<HTMLDivElement | null>(null);
    const [virtualizer] = useState(() =>
        canUsePierreVirtualizer() ? new PierreVirtualizer() : null,
    );

    useIsomorphicLayoutEffect(() => {
        const scrollContainer = scrollContainerRef.current;
        const content = contentRef.current;
        if (!virtualizer || !scrollContainer || !content) {
            return;
        }

        // Pierre must observe Comando's scroller so its height reconciliation keeps the current scroll anchor stable.
        virtualizer.setup(scrollContainer, content);
        return () => virtualizer.cleanUp();
    }, [scrollContainerRef, virtualizer]);

    if (!virtualizer) {
        return children;
    }

    return (
        <VirtualizerContext.Provider value={virtualizer}>
            <div ref={contentRef}>{children}</div>
        </VirtualizerContext.Provider>
    );
}
