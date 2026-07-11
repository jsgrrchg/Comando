import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
    type Dispatch,
    type ReactNode,
    type SetStateAction,
} from "react";

/**
 * Store of transient tool-card UI state, keyed by a caller-provided string.
 * A scoped provider reuses the same store after its chat tab remounts; an
 * unscoped provider keeps the previous local-only behavior. This lets virtual
 * rows and inactive chat tabs unmount without losing expansion or diff sizing.
 *
 * The store is a plain Map whose identity remains stable for its scope, so
 * providing it through context does not trigger unrelated re-renders. When
 * absent (no provider), the hooks degrade to ordinary local state.
 */
type ToolUiStateStore = Map<string, unknown>;

const ToolUiStateStoreContext = createContext<ToolUiStateStore | null>(null);
const toolUiStateStoreByScope = new Map<string, ToolUiStateStore>();

export function getScopedToolUiStateStore(
    scopeKey: string,
): ToolUiStateStore {
    const existing = toolUiStateStoreByScope.get(scopeKey);
    if (existing) {
        return existing;
    }

    const store = new Map<string, unknown>();
    toolUiStateStoreByScope.set(scopeKey, store);
    return store;
}

export function resetScopedToolUiStateStoresForTests(): void {
    toolUiStateStoreByScope.clear();
}

export function ToolExpansionStoreProvider({
    children,
    scopeKey,
}: {
    readonly children: ReactNode;
    readonly scopeKey?: string;
}) {
    const store = useMemo(
        () =>
            scopeKey
                ? getScopedToolUiStateStore(scopeKey)
                : new Map<string, unknown>(),
        [scopeKey],
    );

    return (
        <ToolUiStateStoreContext.Provider key={scopeKey} value={store}>
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
