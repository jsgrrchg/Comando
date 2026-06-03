import {
    createContext,
    useCallback,
    useContext,
    useState,
    type Dispatch,
    type ReactNode,
    type SetStateAction,
} from "react";

/**
 * Per-tab store of manual tool-card expansion, keyed by a caller-provided
 * string. The timeline virtualizes its history, so a row's `ToolActivityItem`
 * unmounts when it scrolls out of range and would lose any locally-held
 * expansion state. The store lives in the scroller (which does not unmount on
 * scroll), so the expansion survives the row remounting.
 *
 * The store is a plain Map held in a ref: identity is stable, so providing it
 * through context does not trigger re-renders. When absent (no provider), the
 * hook degrades to ordinary local state.
 */
type ToolExpansionStore = Map<string, boolean>;

const ToolExpansionStoreContext = createContext<ToolExpansionStore | null>(null);

export function ToolExpansionStoreProvider({
    children,
}: {
    readonly children: ReactNode;
}) {
    // Lazy-initialized once; the Map identity is stable across renders, so the
    // context value never changes and consumers don't re-render from it.
    const [store] = useState<ToolExpansionStore>(() => new Map());

    return (
        <ToolExpansionStoreContext.Provider value={store}>
            {children}
        </ToolExpansionStoreContext.Provider>
    );
}

/**
 * Like `useState<boolean>(defaultExpanded)`, but the value is persisted in the
 * surrounding `ToolExpansionStoreProvider` under `key` so it survives the
 * component unmounting (e.g. when its virtualized row scrolls out of view).
 *
 * When `key` changes without an unmount — the file card's reset key changes
 * with the expansion mode — the value re-hydrates from the store (or the
 * default), preserving the previous reset-on-mode-change behavior.
 */
export function usePersistentToolExpansion(
    key: string,
    defaultExpanded: boolean,
): readonly [boolean, Dispatch<SetStateAction<boolean>>] {
    const store = useContext(ToolExpansionStoreContext);
    const [state, setState] = useState(() => ({
        key,
        expanded: store?.get(key) ?? defaultExpanded,
    }));

    const expanded =
        state.key === key
            ? state.expanded
            : store?.get(key) ?? defaultExpanded;

    const setExpanded = useCallback<Dispatch<SetStateAction<boolean>>>(
        (next) => {
            setState((current) => {
                const previous =
                    current.key === key
                        ? current.expanded
                        : store?.get(key) ?? defaultExpanded;
                const value =
                    typeof next === "function" ? next(previous) : next;
                store?.set(key, value);
                return { key, expanded: value };
            });
        },
        [store, key, defaultExpanded],
    );

    return [expanded, setExpanded] as const;
}
