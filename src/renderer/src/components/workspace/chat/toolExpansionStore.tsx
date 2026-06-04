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
 * Per-tab store of transient tool-card UI state, keyed by a caller-provided
 * string. The timeline virtualizes its history, so a row's `ToolActivityItem`
 * (and the `ChangeReviewPanel` it can render) unmounts when it scrolls out of
 * range and would lose any locally-held state — which card is expanded, how
 * tall the user dragged a diff preview. The store lives in the scroller (which
 * does not unmount on scroll), so that state survives the row remounting.
 *
 * The store is a plain Map held in a stable state slot: its identity never
 * changes, so providing it through context does not trigger re-renders. When
 * absent (no provider), the hooks degrade to ordinary local state.
 */
type ToolUiStateStore = Map<string, unknown>;

const ToolUiStateStoreContext = createContext<ToolUiStateStore | null>(null);

export function ToolExpansionStoreProvider({
    children,
}: {
    readonly children: ReactNode;
}) {
    // Lazy-initialized once; the Map identity is stable across renders, so the
    // context value never changes and consumers don't re-render from it.
    const [store] = useState<ToolUiStateStore>(() => new Map());

    return (
        <ToolUiStateStoreContext.Provider value={store}>
            {children}
        </ToolUiStateStoreContext.Provider>
    );
}

function readStoredValue<T>(
    store: ToolUiStateStore | null,
    key: string,
    defaultValue: T,
): T {
    const stored = store?.get(key);
    // Only an absent key falls back; a stored `false`/`0` is a real value.
    return stored === undefined ? defaultValue : (stored as T);
}

/**
 * Like `useState<T>(defaultValue)`, but the value is persisted in the
 * surrounding `ToolExpansionStoreProvider` under `key` so it survives the
 * component unmounting (e.g. when its virtualized row scrolls out of view).
 *
 * When `key` changes without an unmount — e.g. a card's reset key changes with
 * the expansion mode — the value re-hydrates from the store (or the default),
 * preserving the previous reset-on-key-change behavior.
 */
export function usePersistentToolState<T>(
    key: string,
    defaultValue: T,
): readonly [T, Dispatch<SetStateAction<T>>] {
    const store = useContext(ToolUiStateStoreContext);
    const [state, setState] = useState(() => ({
        key,
        value: readStoredValue(store, key, defaultValue),
    }));

    const value =
        state.key === key
            ? state.value
            : readStoredValue(store, key, defaultValue);

    const setValue = useCallback<Dispatch<SetStateAction<T>>>(
        (next) => {
            setState((current) => {
                const previous =
                    current.key === key
                        ? current.value
                        : readStoredValue(store, key, defaultValue);
                const resolved =
                    typeof next === "function"
                        ? (next as (prev: T) => T)(previous)
                        : next;
                store?.set(key, resolved);
                return { key, value: resolved };
            });
        },
        [store, key, defaultValue],
    );

    return [value, setValue] as const;
}

/**
 * Boolean specialization of {@link usePersistentToolState} for tool-card
 * expansion toggles.
 */
export function usePersistentToolExpansion(
    key: string,
    defaultExpanded: boolean,
): readonly [boolean, Dispatch<SetStateAction<boolean>>] {
    return usePersistentToolState<boolean>(key, defaultExpanded);
}
