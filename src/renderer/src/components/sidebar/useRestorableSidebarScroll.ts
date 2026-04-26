import {
    useCallback,
    useLayoutEffect,
    useRef,
    type RefCallback,
    type UIEventHandler,
} from "react";

export type SidebarScrollPositionStore = Map<string, number>;

export interface SidebarScrollPositionStoreRef {
    current: SidebarScrollPositionStore;
}

interface RestorableSidebarScrollOptions {
    readonly enabled?: boolean;
    readonly externalRef?: {
        current: HTMLDivElement | null;
    };
    readonly restoreToken?: unknown;
    readonly scrollKey: string;
    readonly scrollPositionsRef: SidebarScrollPositionStoreRef;
}

const MAX_RESTORE_ATTEMPTS = 12;

function getMaxScrollTop(element: HTMLDivElement): number {
    return Math.max(0, element.scrollHeight - element.clientHeight);
}

function clampScrollTop(element: HTMLDivElement, scrollTop: number): number {
    return Math.min(Math.max(0, scrollTop), getMaxScrollTop(element));
}

export function useRestorableSidebarScroll({
    enabled = true,
    externalRef,
    restoreToken,
    scrollKey,
    scrollPositionsRef,
}: RestorableSidebarScrollOptions) {
    const elementRef = useRef<HTMLDivElement | null>(null);
    const restoreFrameRef = useRef<number | null>(null);

    const cancelRestore = useCallback(() => {
        if (restoreFrameRef.current !== null) {
            window.cancelAnimationFrame(restoreFrameRef.current);
            restoreFrameRef.current = null;
        }
    }, []);

    const saveElementPosition = useCallback(
        (element: HTMLDivElement | null, key: string) => {
            if (!element) {
                return;
            }

            scrollPositionsRef.current.set(key, element.scrollTop);
        },
        [scrollPositionsRef],
    );

    const saveScrollPosition = useCallback(() => {
        saveElementPosition(elementRef.current, scrollKey);
    }, [saveElementPosition, scrollKey]);

    const restoreScrollPosition = useCallback(() => {
        cancelRestore();

        if (!enabled) {
            return;
        }

        const savedScrollTop = scrollPositionsRef.current.get(scrollKey);
        if (savedScrollTop === undefined) {
            return;
        }

        let attempt = 0;

        const applySavedScrollTop = () => {
            const element = elementRef.current;
            if (!element) {
                return false;
            }

            const maxScrollTop = getMaxScrollTop(element);
            element.scrollTop = clampScrollTop(element, savedScrollTop);

            return savedScrollTop <= maxScrollTop || savedScrollTop === 0;
        };

        if (applySavedScrollTop()) {
            return;
        }

        const retry = () => {
            restoreFrameRef.current = null;

            if (applySavedScrollTop() || attempt >= MAX_RESTORE_ATTEMPTS) {
                return;
            }

            attempt += 1;
            restoreFrameRef.current = window.requestAnimationFrame(retry);
        };

        attempt += 1;
        restoreFrameRef.current = window.requestAnimationFrame(retry);
    }, [cancelRestore, enabled, scrollKey, scrollPositionsRef]);

    const setScrollElement = useCallback<RefCallback<HTMLDivElement>>(
        (node) => {
            const previousElement = elementRef.current;
            if (previousElement && previousElement !== node) {
                saveElementPosition(previousElement, scrollKey);
            }

            elementRef.current = node;
            if (externalRef) {
                externalRef.current = node;
            }

            if (node) {
                restoreScrollPosition();
            }
        },
        [externalRef, restoreScrollPosition, saveElementPosition, scrollKey],
    );

    const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>(
        (event) => {
            scrollPositionsRef.current.set(
                scrollKey,
                event.currentTarget.scrollTop,
            );
        },
        [scrollKey, scrollPositionsRef],
    );

    useLayoutEffect(() => {
        restoreScrollPosition();

        return () => {
            cancelRestore();
        };
    }, [cancelRestore, restoreScrollPosition, restoreToken]);

    useLayoutEffect(() => {
        return () => {
            saveScrollPosition();
            cancelRestore();
        };
    }, [cancelRestore, saveScrollPosition]);

    return {
        handleScroll,
        restoreScrollPosition,
        saveScrollPosition,
        setScrollElement,
    };
}
