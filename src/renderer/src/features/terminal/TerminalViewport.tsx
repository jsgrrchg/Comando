import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import {
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent,
} from "react";

import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "@renderer/components/context-menu/ContextMenu";
import { openExternalUrl } from "@renderer/app/utils/external-url";
import { useSettingsStore } from "@renderer/app/store/settings-store";

import { getTerminalTheme, type TerminalTheme } from "./terminalTheme";
import type {
    TerminalOutputCommand,
    TerminalSessionView,
} from "./terminalTypes";

const TERMINAL_RESIZE_SETTLE_MS = 80;
const SNAPSHOT_SAVE_DEBOUNCE_MS = 1_000;
const PERSISTED_SNAPSHOT_SCROLLBACK = 1_000;

function TerminalMessage({ message }: { readonly message: string }) {
    return (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-text-secondary">
            <span className="text-xs">{message}</span>
        </div>
    );
}

function createXtermTheme(theme: TerminalTheme) {
    return {
        background: theme.background,
        black: theme.black,
        blue: theme.blue,
        brightBlack: theme.brightBlack,
        brightBlue: theme.brightBlue,
        brightCyan: theme.brightCyan,
        brightGreen: theme.brightGreen,
        brightMagenta: theme.brightMagenta,
        brightRed: theme.brightRed,
        brightWhite: theme.brightWhite,
        brightYellow: theme.brightYellow,
        cyan: theme.cyan,
        cursor: theme.cursor,
        cursorAccent: theme.background,
        foreground: theme.text,
        green: theme.green,
        magenta: theme.magenta,
        red: theme.red,
        scrollbarSliderActiveBackground: theme.scrollbarSliderActiveBackground,
        scrollbarSliderBackground: theme.scrollbarSliderBackground,
        scrollbarSliderHoverBackground: theme.scrollbarSliderHoverBackground,
        selectionBackground: theme.selectionBackground,
        white: theme.white,
        yellow: theme.yellow,
    };
}

function buildSearchSummary(resultIndex: number, resultCount: number): string {
    if (resultCount <= 0) {
        return "No matches";
    }

    return `${Math.max(resultIndex + 1, 1)} / ${resultCount}`;
}

interface TerminalThemeOptions {
    readonly fontFamily: string;
    readonly fontSize: number;
}

function useTerminalTheme(options: TerminalThemeOptions): TerminalTheme {
    const { fontFamily, fontSize } = options;
    const [theme, setTheme] = useState<TerminalTheme>(() =>
        getTerminalTheme(null, { fontFamily, fontSize }),
    );

    useEffect(() => {
        let frameHandle = 0;

        const updateTheme = () => {
            frameHandle = 0;
            const nextTheme = getTerminalTheme(null, { fontFamily, fontSize });
            setTheme((currentTheme) =>
                JSON.stringify(currentTheme) === JSON.stringify(nextTheme)
                    ? currentTheme
                    : nextTheme,
            );
        };

        const scheduleThemeUpdate = () => {
            if (frameHandle !== 0) {
                return;
            }
            frameHandle = window.requestAnimationFrame(updateTheme);
        };

        scheduleThemeUpdate();
        const observer = new MutationObserver(scheduleThemeUpdate);
        observer.observe(document.documentElement, {
            attributeFilter: ["class", "style"],
            attributes: true,
        });

        return () => {
            observer.disconnect();
            if (frameHandle !== 0) {
                window.cancelAnimationFrame(frameHandle);
            }
        };
    }, [fontFamily, fontSize]);

    return theme;
}

async function loadTerminalFontForTheme(theme: TerminalTheme): Promise<void> {
    if (!document.fonts?.load) {
        return;
    }

    try {
        await document.fonts.load(`${theme.fontSize}px ${theme.fontFamily}`);
    } catch {
        // Font loading is best-effort; xterm can still refit with fallbacks.
    }
}

async function readClipboardText(): Promise<string> {
    if (window.comando?.readClipboardText) {
        try {
            return await window.comando.readClipboardText();
        } catch {
            // Fall back to the Web Clipboard API.
        }
    }

    try {
        return await navigator.clipboard.readText();
    } catch {
        return "";
    }
}

async function writeClipboardText(text: string): Promise<void> {
    if (window.comando?.writeClipboardText) {
        try {
            await window.comando.writeClipboardText(text);
            return;
        } catch {
            // Fall back to the Web Clipboard API.
        }
    }

    try {
        await navigator.clipboard.writeText(text);
    } catch {
        // Context menu actions should fail silently.
    }
}

export function TerminalViewport({
    active = true,
    autoFocus = false,
    initialScrollPosition = "bottom",
    session,
}: {
    readonly active?: boolean;
    readonly autoFocus?: boolean;
    readonly initialScrollPosition?: "top" | "bottom";
    readonly session: TerminalSessionView;
}) {
    const { hasOutput, resize, snapshot, writeInput } = session;
    const hostRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const serializeAddonRef = useRef<SerializeAddon | null>(null);
    const webglAddonRef = useRef<WebglAddon | null>(null);
    const writeInputRef = useRef(writeInput);
    const resizeRef = useRef(resize);
    const snapshotRef = useRef(snapshot);
    const sessionRef = useRef(session);
    const syncSizeRef = useRef<() => void>(() => undefined);
    const restoreReplaySnapshotRef = useRef<() => void>(() => undefined);
    const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const snapshotSaveTimerRef = useRef<ReturnType<
        typeof setTimeout
    > | null>(null);
    const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(
        null,
    );
    const lastRequestedSizeRef = useRef<{ cols: number; rows: number } | null>(
        null,
    );
    const lastSessionIdRef = useRef<string | null>(null);
    const restoredReplayKeyRef = useRef<string | null>(null);
    const shouldApplyInitialScrollRef = useRef(false);
    const shouldRestoreFocusRef = useRef(false);
    const searchPanelRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const searchOpenRef = useRef(false);
    const suppressNextNewlineRef = useRef(false);
    const searchInputId = useId();
    const [focused, setFocused] = useState(false);
    const [hasSelection, setHasSelection] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
    const [searchResultIndex, setSearchResultIndex] = useState(-1);
    const [searchResultCount, setSearchResultCount] = useState(0);
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<void> | null>(null);
    const terminalFontFamily = useSettingsStore(
        (state) => state.terminal.terminalFontFamily,
    );
    const terminalFontSize = useSettingsStore(
        (state) => state.terminal.terminalFontSize,
    );
    const theme = useTerminalTheme({
        fontFamily: terminalFontFamily,
        fontSize: terminalFontSize,
    });

    const focusTerminal = useCallback(() => {
        shouldRestoreFocusRef.current = true;
        terminalRef.current?.focus();
    }, []);

    const closeSearch = useCallback(() => {
        setSearchOpen(false);
        searchAddonRef.current?.clearDecorations();
        requestAnimationFrame(() => {
            focusTerminal();
        });
    }, [focusTerminal]);

    const runSearch = useCallback(
        (direction: "next" | "previous", queryOverride?: string) => {
            const searchAddon = searchAddonRef.current;
            if (!searchAddon) {
                return false;
            }

            const query = queryOverride ?? searchQuery;
            if (!query) {
                searchAddon.clearDecorations();
                setSearchResultCount(0);
                setSearchResultIndex(-1);
                return false;
            }

            const options = {
                caseSensitive: searchCaseSensitive,
                incremental: direction === "next",
            };

            return direction === "previous"
                ? searchAddon.findPrevious(query, options)
                : searchAddon.findNext(query, options);
        },
        [searchCaseSensitive, searchQuery],
    );

    const openSearch = useCallback(() => {
        setSearchOpen(true);
        requestAnimationFrame(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
        });
    }, []);

    useEffect(() => {
        writeInputRef.current = writeInput;
        resizeRef.current = resize;
        snapshotRef.current = snapshot;
        sessionRef.current = session;
    }, [resize, session, snapshot, writeInput]);

    useEffect(() => {
        const lastRequestedSize = lastRequestedSizeRef.current;
        if (
            lastRequestedSize &&
            lastRequestedSize.cols === snapshot.cols &&
            lastRequestedSize.rows === snapshot.rows
        ) {
            lastRequestedSizeRef.current = null;
        }
    }, [snapshot.cols, snapshot.rows]);

    useEffect(() => {
        searchOpenRef.current = searchOpen;
    }, [searchOpen]);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) {
            return;
        }

        const terminal = new Terminal({
            allowTransparency: false,
            convertEol: false,
            cursorBlink: true,
            cursorStyle: "block",
            fontFamily: theme.fontFamily,
            fontSize: theme.fontSize,
            lineHeight: theme.lineHeight,
            macOptionIsMeta: true,
            rightClickSelectsWord: true,
            scrollback: 20_000,
            theme: createXtermTheme(theme),
        });
        const fitAddon = new FitAddon();
        const searchAddon = new SearchAddon();
        const webLinksAddon = new WebLinksAddon((event, uri) => {
            event.preventDefault();
            openExternalUrl(uri);
        });
        const syncSelection = () =>
            setHasSelection(terminal.getSelection().length > 0);
        const requestResize = (cols: number, rows: number) => {
            lastRequestedSizeRef.current = { cols, rows };
            void resizeRef.current(cols, rows).catch(() => {
                const lastRequestedSize = lastRequestedSizeRef.current;
                if (
                    lastRequestedSize?.cols === cols &&
                    lastRequestedSize.rows === rows
                ) {
                    lastRequestedSizeRef.current = null;
                }
            });
        };
        const syncSize = () => {
            fitAddon.fit();
            const nextCols = terminal.cols;
            const nextRows = terminal.rows;
            const currentSnapshot = snapshotRef.current;

            if (nextCols < 1 || nextRows < 1) {
                return;
            }

            if (
                nextCols === currentSnapshot.cols &&
                nextRows === currentSnapshot.rows
            ) {
                pendingResizeRef.current = null;
                return;
            }

            if (!currentSnapshot.sessionId) {
                pendingResizeRef.current = { cols: nextCols, rows: nextRows };
                lastRequestedSizeRef.current = null;
                return;
            }

            const lastRequestedSize = lastRequestedSizeRef.current;
            if (
                lastRequestedSize?.cols === nextCols &&
                lastRequestedSize.rows === nextRows
            ) {
                return;
            }

            if (!lastRequestedSize) {
                if (resizeTimerRef.current) {
                    clearTimeout(resizeTimerRef.current);
                    resizeTimerRef.current = null;
                }
                pendingResizeRef.current = null;
                requestResize(nextCols, nextRows);
                return;
            }

            const pendingSize = pendingResizeRef.current;
            if (
                pendingSize?.cols === nextCols &&
                pendingSize.rows === nextRows
            ) {
                return;
            }

            pendingResizeRef.current = { cols: nextCols, rows: nextRows };
            if (resizeTimerRef.current) {
                clearTimeout(resizeTimerRef.current);
            }
            resizeTimerRef.current = setTimeout(() => {
                const pendingResize = pendingResizeRef.current;
                resizeTimerRef.current = null;
                if (!pendingResize) {
                    return;
                }

                if (!snapshotRef.current.sessionId) {
                    return;
                }

                pendingResizeRef.current = null;
                requestResize(pendingResize.cols, pendingResize.rows);
            }, TERMINAL_RESIZE_SETTLE_MS);
        };
        syncSizeRef.current = syncSize;

        terminal.loadAddon(fitAddon);
        terminal.loadAddon(searchAddon);
        terminal.loadAddon(webLinksAddon);
        terminal.attachCustomKeyEventHandler((event) => {
            const key = event.key.toLowerCase();
            if ((event.metaKey || event.ctrlKey) && key === "f") {
                event.preventDefault();
                openSearch();
                return false;
            }
            if (searchOpenRef.current && event.key === "Escape") {
                event.preventDefault();
                closeSearch();
                return false;
            }
            if (
                event.type === "keydown" &&
                event.key === "Enter" &&
                event.shiftKey
            ) {
                event.preventDefault();
                suppressNextNewlineRef.current = true;
                void writeInputRef.current("\n").catch(() => undefined);
                return false;
            }
            return true;
        });

        let cancelled = false;
        let onDataDisposable: ReturnType<typeof terminal.onData> | null = null;
        let onSelectionDisposable: ReturnType<
            typeof terminal.onSelectionChange
        > | null = null;
        let onSearchResultsDisposable: ReturnType<
            typeof searchAddon.onDidChangeResults
        > | null = null;
        let textarea: HTMLTextAreaElement | null = null;
        let handleFocus: (() => void) | null = null;
        let handleBlur: ((event: FocusEvent) => void) | null = null;
        let observer: ResizeObserver | null = null;
        let unsubscribeOutput: (() => void) | null = null;

        const saveSnapshot = () => {
            snapshotSaveTimerRef.current = null;
            const addon = serializeAddonRef.current;
            if (!addon) {
                return;
            }
            try {
                sessionRef.current.saveReplaySnapshot(
                    addon.serialize({
                        scrollback: PERSISTED_SNAPSHOT_SCROLLBACK,
                    }),
                );
            } catch {
                // Serialization is best-effort.
            }
        };

        const scheduleSnapshotSave = () => {
            if (snapshotSaveTimerRef.current) {
                clearTimeout(snapshotSaveTimerRef.current);
            }
            snapshotSaveTimerRef.current = setTimeout(
                saveSnapshot,
                SNAPSHOT_SAVE_DEBOUNCE_MS,
            );
        };

        const restoreReplaySnapshot = () => {
            const replaySnapshot = sessionRef.current.getReplaySnapshot();
            if (
                !replaySnapshot ||
                restoredReplayKeyRef.current === replaySnapshot.sessionId
            ) {
                return;
            }

            restoredReplayKeyRef.current = replaySnapshot.sessionId;
            terminal.write(replaySnapshot.serialized);
        };
        const handleOutputCommand = (command: TerminalOutputCommand) => {
            const t = terminalRef.current;
            if (!t) {
                return;
            }
            if (command.type === "clear") {
                t.reset();
                return;
            }
            restoreReplaySnapshot();
            t.write(command.data, () => {
                if (shouldApplyInitialScrollRef.current) {
                    shouldApplyInitialScrollRef.current = false;
                    t.scrollToTop();
                }
            });
            scheduleSnapshotSave();
        };

        const finishOpen = () => {
            if (cancelled) {
                return;
            }

            terminal.open(host);

            try {
                const webglAddon = new WebglAddon();
                webglAddon.onContextLoss(() => {
                    webglAddon.dispose();
                    webglAddonRef.current = null;
                });
                terminal.loadAddon(webglAddon);
                webglAddonRef.current = webglAddon;
            } catch (error) {
                console.warn("[terminal] WebGL renderer unavailable", error);
            }

            const serializeAddon = new SerializeAddon();
            terminal.loadAddon(serializeAddon);

            terminalRef.current = terminal;
            fitAddonRef.current = fitAddon;
            searchAddonRef.current = searchAddon;
            serializeAddonRef.current = serializeAddon;
            shouldApplyInitialScrollRef.current =
                initialScrollPosition === "top";

            restoreReplaySnapshotRef.current = restoreReplaySnapshot;
            restoreReplaySnapshot();
            unsubscribeOutput =
                sessionRef.current.subscribeOutput(handleOutputCommand);

            onDataDisposable = terminal.onData((data) => {
                if (data === "\n" && suppressNextNewlineRef.current) {
                    suppressNextNewlineRef.current = false;
                    return;
                }
                suppressNextNewlineRef.current = false;
                void writeInputRef.current(data).catch((error) => {
                    console.error("[terminal] writeInput error:", error);
                });
            });
            onSelectionDisposable =
                terminal.onSelectionChange(syncSelection);
            onSearchResultsDisposable = searchAddon.onDidChangeResults(
                (event) => {
                    setSearchResultIndex(event.resultIndex);
                    setSearchResultCount(event.resultCount);
                },
            );

            textarea = terminal.textarea ?? null;
            handleFocus = () => {
                shouldRestoreFocusRef.current = true;
                setFocused(true);
            };
            handleBlur = (event: FocusEvent) => {
                const nextTarget = event.relatedTarget;
                const nextInsideSearch =
                    nextTarget instanceof Node &&
                    searchPanelRef.current?.contains(nextTarget);
                if (!nextInsideSearch) {
                    shouldRestoreFocusRef.current = false;
                }
                setFocused(false);
                searchAddon.clearActiveDecoration();
            };
            textarea?.addEventListener("focus", handleFocus);
            textarea?.addEventListener("blur", handleBlur);

            syncSize();
            observer = new ResizeObserver(syncSize);
            observer.observe(host);
        };

        finishOpen();

        return () => {
            cancelled = true;
            unsubscribeOutput?.();
            unsubscribeOutput = null;
            if (snapshotSaveTimerRef.current) {
                clearTimeout(snapshotSaveTimerRef.current);
                snapshotSaveTimerRef.current = null;
            }
            saveSnapshot();
            observer?.disconnect();
            onSearchResultsDisposable?.dispose();
            onSelectionDisposable?.dispose();
            if (textarea && handleBlur) {
                textarea.removeEventListener("blur", handleBlur);
            }
            if (textarea && handleFocus) {
                textarea.removeEventListener("focus", handleFocus);
            }
            onDataDisposable?.dispose();
            webglAddonRef.current?.dispose();
            webglAddonRef.current = null;
            terminal.dispose();
            syncSizeRef.current = () => undefined;
            restoreReplaySnapshotRef.current = () => undefined;
            terminalRef.current = null;
            fitAddonRef.current = null;
            searchAddonRef.current = null;
            serializeAddonRef.current = null;
            if (resizeTimerRef.current) {
                clearTimeout(resizeTimerRef.current);
                resizeTimerRef.current = null;
            }
            pendingResizeRef.current = null;
            lastRequestedSizeRef.current = null;
            lastSessionIdRef.current = null;
            restoredReplayKeyRef.current = null;
            shouldApplyInitialScrollRef.current = false;
            shouldRestoreFocusRef.current = false;
            setHasSelection(false);
            setFocused(false);
            setSearchOpen(false);
            setSearchQuery("");
            setSearchResultIndex(-1);
            setSearchResultCount(0);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [closeSearch, openSearch]);

    useEffect(() => {
        if (!active) {
            return;
        }

        const frame = requestAnimationFrame(() => {
            syncSizeRef.current();
            if (autoFocus) {
                focusTerminal();
            }
        });

        return () => cancelAnimationFrame(frame);
    }, [active, autoFocus, focusTerminal, snapshot.sessionId]);

    useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) {
            return;
        }

        terminal.options.fontFamily = theme.fontFamily;
        terminal.options.fontSize = theme.fontSize;
        terminal.options.lineHeight = theme.lineHeight;
        terminal.options.theme = createXtermTheme(theme);

        let cancelled = false;
        void loadTerminalFontForTheme(theme).finally(() => {
            if (cancelled) {
                return;
            }
            syncSizeRef.current();
        });

        return () => {
            cancelled = true;
        };
    }, [theme]);

    useEffect(() => {
        const sessionId = snapshot.sessionId || "__pending-terminal__";
        if (lastSessionIdRef.current === sessionId) {
            return;
        }
        const isFirstSession = lastSessionIdRef.current === null;
        lastSessionIdRef.current = sessionId;
        if (isFirstSession) {
            restoreReplaySnapshotRef.current();
            return;
        }
        restoreReplaySnapshotRef.current();
        shouldApplyInitialScrollRef.current = initialScrollPosition === "top";
        setHasSelection(false);
        setSearchResultCount(0);
        setSearchResultIndex(-1);
    }, [initialScrollPosition, snapshot.sessionId]);

    useEffect(() => {
        if (
            snapshot.status !== "running" ||
            !snapshot.sessionId ||
            !shouldRestoreFocusRef.current
        ) {
            return;
        }

        requestAnimationFrame(() => {
            terminalRef.current?.focus();
        });
    }, [snapshot.sessionId, snapshot.status]);

    useEffect(() => {
        if (!searchOpen) {
            return;
        }
        requestAnimationFrame(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
        });
    }, [searchOpen]);

    useEffect(() => {
        if (!searchOpen || !searchQuery) {
            return;
        }

        queueMicrotask(() => runSearch("next"));
    }, [runSearch, searchCaseSensitive, searchOpen, searchQuery]);

    const handleContextMenu = useCallback(
        (event: MouseEvent<HTMLDivElement>) => {
            event.preventDefault();
            focusTerminal();
            setContextMenu({
                payload: undefined,
                x: event.clientX,
                y: event.clientY,
            });
        },
        [focusTerminal],
    );

    const handleMouseDown = useCallback(
        (event: MouseEvent<HTMLDivElement>) => {
            if (
                searchPanelRef.current &&
                searchPanelRef.current.contains(event.target as Node)
            ) {
                return;
            }
            focusTerminal();
        },
        [focusTerminal],
    );

    const handleSearchInputKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
                return;
            }

            if (event.key === "Enter") {
                event.preventDefault();
                runSearch(event.shiftKey ? "previous" : "next");
            }
        },
        [closeSearch, runSearch],
    );

    const contextMenuEntries: ContextMenuEntry[] = [
        {
            action: () => {
                const text = terminalRef.current?.getSelection();
                if (text) {
                    void writeClipboardText(text);
                }
            },
            disabled: !hasSelection,
            label: "Copy",
        },
        {
            action: () => {
                void readClipboardText().then((text) => {
                    if (!text) {
                        return;
                    }
                    void writeInputRef.current(text).catch(() => undefined);
                });
            },
            disabled: snapshot.status !== "running",
            label: "Paste",
        },
        { type: "separator" },
        {
            action: () => {
                terminalRef.current?.selectAll();
                setHasSelection(true);
            },
            label: "Select All",
        },
        { type: "separator" },
        {
            action: () => openSearch(),
            label: "Find",
        },
        {
            action: () => session.clearViewport(),
            disabled: !hasOutput,
            label: "Clear",
        },
        {
            action: () => {
                void session.restart();
            },
            label: "Restart",
        },
    ];

    const noOutput = !hasOutput;

    return (
        <div
            className="relative h-full min-h-0 overflow-hidden outline-none"
            onContextMenu={handleContextMenu}
            onMouseDown={handleMouseDown}
            style={{
                backgroundColor: theme.background,
                color: theme.text,
            }}
        >
            <div ref={hostRef} className="terminal-surface h-full min-h-0" />

            {searchOpen && (
                <div
                    ref={searchPanelRef}
                    className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-border bg-bg-panel px-2 py-2 text-text-primary shadow-lg"
                >
                    <label htmlFor={searchInputId} className="sr-only">
                        Find in terminal
                    </label>
                    <input
                        id={searchInputId}
                        ref={searchInputRef}
                        type="text"
                        value={searchQuery}
                        onBlur={() => {
                            searchAddonRef.current?.clearActiveDecoration();
                        }}
                        onChange={(event) => {
                            const nextQuery = event.target.value;
                            setSearchQuery(nextQuery);
                            void runSearch("next", nextQuery);
                        }}
                        onKeyDown={handleSearchInputKeyDown}
                        placeholder="Find in terminal"
                        className="h-8 w-52 rounded border border-border bg-bg-primary px-2 text-xs text-text-primary outline-none"
                    />
                    <button
                        type="button"
                        onClick={() =>
                            setSearchCaseSensitive((current) => !current)
                        }
                        className={[
                            "h-8 rounded border border-border px-2 text-[11px]",
                            searchCaseSensitive
                                ? "bg-accent text-white"
                                : "bg-bg-primary text-text-secondary",
                        ].join(" ")}
                        title="Match case"
                    >
                        Aa
                    </button>
                    <button
                        type="button"
                        onClick={() => runSearch("previous")}
                        className="h-8 rounded border border-border bg-bg-primary px-2 text-xs text-text-primary"
                    >
                        Prev
                    </button>
                    <button
                        type="button"
                        onClick={() => runSearch("next")}
                        className="h-8 rounded border border-border bg-bg-primary px-2 text-xs text-text-primary"
                    >
                        Next
                    </button>
                    <span className="min-w-16 text-right text-[11px] text-text-secondary">
                        {buildSearchSummary(
                            searchResultIndex,
                            searchResultCount,
                        )}
                    </span>
                    <button
                        type="button"
                        onClick={closeSearch}
                        className="h-8 rounded border border-border bg-bg-primary px-2 text-xs text-text-primary"
                    >
                        Close
                    </button>
                </div>
            )}

            {snapshot.status === "starting" && noOutput && (
                <TerminalMessage message="Starting shell..." />
            )}
            {snapshot.status === "idle" && noOutput && (
                <TerminalMessage message="Shell not started" />
            )}
            {snapshot.status === "error" && noOutput && (
                <TerminalMessage
                    message={snapshot.errorMessage ?? "Shell unavailable"}
                />
            )}
            {snapshot.status === "exited" && noOutput && (
                <TerminalMessage message="Shell exited - restart to continue" />
            )}

            {!focused && snapshot.status === "running" && noOutput && (
                <div className="pointer-events-none absolute bottom-3 right-3 rounded border border-border bg-bg-panel px-2 py-1 text-[11px] text-text-secondary">
                    Click to focus terminal
                </div>
            )}

            {contextMenu && (
                <ContextMenu
                    entries={contextMenuEntries}
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </div>
    );
}
