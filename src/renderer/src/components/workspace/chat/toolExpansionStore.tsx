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

// The hook's persistence logic, factored out as pure functions so it can be
// unit-tested without a DOM (the renderer test env is node-only). The hook
// below is a thin wrapper that wires these to React state and the store.
interface PersistentToolStateSlot<T> {
    readonly key: string;
    readonly value: T;
}

/**
 * Reads a value from the store, treating only an absent key as a miss — a
 * stored `false`/`0` is a real value. A null store (no provider) always misses.
 */
export function readStoredToolState<T>(
    store: ToolUiStateStore | null,
    key: string,
    defaultValue: T,
): T {
    const stored = store?.get(key);
    return stored === undefined ? defaultValue : (stored as T);
}

/**
 * Resolves the value to show for `key`. While the slot's key still matches we
 * trust its in-memory value; once the key changes (e.g. a card's reset key
 * flips with the expansion mode) we re-hydrate from the store — which is what
 * lets persisted state survive a key change without an unmount.
 */
export function resolvePersistentToolState<T>(
    slot: PersistentToolStateSlot<T>,
    store: ToolUiStateStore | null,
    key: string,
    defaultValue: T,
): T {
    return slot.key === key
        ? slot.value
        : readStoredToolState(store, key, defaultValue);
}

/**
 * Applies a state update for `key`: resolves the previous value (re-hydrating
 * across a key change), runs the functional updater if given, writes the result
 * back into the store so it survives the component unmounting, and returns the
 * next slot.
 */
export function applyPersistentToolStateUpdate<T>(
    slot: PersistentToolStateSlot<T>,
    store: ToolUiStateStore | null,
    key: string,
    defaultValue: T,
    next: SetStateAction<T>,
): PersistentToolStateSlot<T> {
    const previous = resolvePersistentToolState(slot, store, key, defaultValue);
    const resolved =
        typeof next === "function" ? (next as (prev: T) => T)(previous) : next;
    store?.set(key, resolved);
    return { key, value: resolved };
}

/**
 * Like `useState<T>(defaultValue)`, but the value is persisted in the
 * surrounding `ToolExpansionStoreProvider` under `key` so it survives the
 * component unmounting (e.g. when its virtualized row scrolls out of view).
 *
 * When `key` changes without an unmount — e.g. a card's reset key changes with
 * the expansion mode — the value re-hydrates from the store under the new key,
 * so it restores whatever was last seen for that key (or the default the first
 * time the key is encountered).
 */
export function usePersistentToolState<T>(
    key: string,
    defaultValue: T,
): readonly [T, Dispatch<SetStateAction<T>>] {
    const store = useContext(ToolUiStateStoreContext);
    const [slot, setSlot] = useState<PersistentToolStateSlot<T>>(() => ({
        key,
        value: readStoredToolState(store, key, defaultValue),
    }));

    const value = resolvePersistentToolState(slot, store, key, defaultValue);

    const setValue = useCallback<Dispatch<SetStateAction<T>>>(
        (next) => {
            setSlot((current) =>
                applyPersistentToolStateUpdate(
                    current,
                    store,
                    key,
                    defaultValue,
                    next,
                ),
            );
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
