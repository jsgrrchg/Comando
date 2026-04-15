import {
    useCallback,
    useMemo,
    useState,
    type MouseEventHandler,
    type ReactNode,
    type RefObject,
} from "react";

import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "./ContextMenu";

interface TextContextMenuPayload {
    readonly container: HTMLElement;
    readonly range: Range | null;
    readonly selectedText: string;
}

interface UseTextContextMenuOptions {
    readonly containerRef: RefObject<HTMLElement | null>;
    readonly editable?: boolean;
    readonly getFallbackCopyText?: () => string;
    readonly onContentChanged?: () => void;
    readonly onPasteText?: (text: string) => void | Promise<void>;
}

interface UseTextContextMenuResult<T extends HTMLElement> {
    readonly contextMenu: ReactNode;
    readonly handleContextMenu: MouseEventHandler<T>;
}

type DocumentWithCaretRange = Document & {
    caretPositionFromPoint?: (
        x: number,
        y: number,
    ) => { offset: number; offsetNode: Node } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function cloneScopedSelectionRange(container: HTMLElement): Range | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return null;
    }

    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
        return null;
    }

    return range.cloneRange();
}

function restoreSelectionRange(range: Range | null): void {
    if (!range) {
        return;
    }

    const selection = window.getSelection();
    if (!selection) {
        return;
    }

    selection.removeAllRanges();
    selection.addRange(range);
}

function selectAllContent(container: HTMLElement): void {
    const selection = window.getSelection();
    if (!selection) {
        return;
    }

    const range = document.createRange();
    range.selectNodeContents(container);
    selection.removeAllRanges();
    selection.addRange(range);
}

function moveCaretToPoint(
    container: HTMLElement,
    clientX: number,
    clientY: number,
): void {
    const doc = container.ownerDocument as DocumentWithCaretRange;

    const caretPosition = doc.caretPositionFromPoint?.(clientX, clientY);
    if (caretPosition && container.contains(caretPosition.offsetNode)) {
        const range = doc.createRange();
        range.setStart(caretPosition.offsetNode, caretPosition.offset);
        range.collapse(true);
        restoreSelectionRange(range);
        return;
    }

    const caretRange = doc.caretRangeFromPoint?.(clientX, clientY);
    if (caretRange && container.contains(caretRange.startContainer)) {
        caretRange.collapse(true);
        restoreSelectionRange(caretRange);
    }
}

async function readClipboardText(): Promise<string> {
    if (window.comando?.readClipboardText) {
        return window.comando.readClipboardText();
    }

    if (navigator.clipboard?.readText) {
        return navigator.clipboard.readText();
    }

    return "";
}

async function writeClipboardText(text: string): Promise<void> {
    if (window.comando?.writeClipboardText) {
        await window.comando.writeClipboardText(text);
        return;
    }

    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
    }
}

function deleteScopedSelection(
    container: HTMLElement,
    range: Range | null,
): boolean {
    restoreSelectionRange(range);

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return false;
    }

    const activeRange = selection.getRangeAt(0);
    if (
        activeRange.collapsed ||
        !container.contains(activeRange.commonAncestorContainer)
    ) {
        return false;
    }

    activeRange.deleteContents();
    activeRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(activeRange);
    return true;
}

export function useTextContextMenu<T extends HTMLElement>({
    containerRef,
    editable = false,
    getFallbackCopyText,
    onContentChanged,
    onPasteText,
}: UseTextContextMenuOptions): UseTextContextMenuResult<T> {
    const [menu, setMenu] =
        useState<ContextMenuState<TextContextMenuPayload> | null>(null);

    const closeContextMenu = useCallback(() => {
        setMenu(null);
    }, []);

    const handleContextMenu = useCallback<MouseEventHandler<T>>(
        (event) => {
            const container = containerRef.current;
            if (!container) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            if (editable) {
                container.focus();

                const existingRange = cloneScopedSelectionRange(container);
                if (!existingRange || existingRange.toString().length === 0) {
                    moveCaretToPoint(container, event.clientX, event.clientY);
                }
            }

            const range = cloneScopedSelectionRange(container);
            setMenu({
                x: event.clientX,
                y: event.clientY,
                payload: {
                    container,
                    range,
                    selectedText: range?.toString() ?? "",
                },
            });
        },
        [containerRef, editable],
    );

    const handleCutSelection = useCallback(() => {
        if (!menu) {
            return;
        }

        void (async () => {
            const selectedText = menu.payload.selectedText;
            if (selectedText.length === 0) {
                return;
            }

            await writeClipboardText(selectedText);
            if (
                deleteScopedSelection(
                    menu.payload.container,
                    menu.payload.range,
                )
            ) {
                onContentChanged?.();
            }
        })();
    }, [menu, onContentChanged]);

    const handleCopyText = useCallback(() => {
        if (!menu) {
            return;
        }

        void (async () => {
            const selectedText = menu.payload.selectedText;
            const fallbackCopyText = getFallbackCopyText?.() ?? "";
            const copyText = selectedText || fallbackCopyText;
            if (copyText.length === 0) {
                return;
            }

            await writeClipboardText(copyText);
        })();
    }, [getFallbackCopyText, menu]);

    const handlePasteFromClipboard = useCallback(() => {
        if (!menu || !onPasteText) {
            return;
        }

        void (async () => {
            const text = await readClipboardText();
            if (text.length === 0) {
                return;
            }

            restoreSelectionRange(menu.payload.range);
            await onPasteText(text);
        })();
    }, [menu, onPasteText]);

    const handleSelectAll = useCallback(() => {
        if (!menu) {
            return;
        }

        const container = menu.payload.container;
        if (editable) {
            container.focus();
        }

        selectAllContent(container);
    }, [editable, menu]);

    const contextMenuEntries = useMemo((): readonly ContextMenuEntry[] => {
        if (!menu) {
            return [];
        }

        const selectedText = menu.payload.selectedText;
        const fallbackCopyText = getFallbackCopyText?.() ?? "";
        const copyText = selectedText || fallbackCopyText;
        const copyLabel =
            selectedText.length > 0
                ? "Copy selection"
                : editable
                  ? "Copy draft"
                  : "Copy message";
        const entries: ContextMenuEntry[] = [];

        if (editable) {
            entries.push({
                label: "Cut selection",
                action: handleCutSelection,
                disabled: selectedText.length === 0,
            });
        }

        entries.push({
            label: copyLabel,
            action: handleCopyText,
            disabled: copyText.length === 0,
        });

        if (editable) {
            entries.push({
                label: "Paste",
                action: handlePasteFromClipboard,
                disabled: !onPasteText,
            });
        }

        entries.push({ type: "separator" });
        entries.push({
            label: "Select all",
            action: handleSelectAll,
        });

        return entries;
    }, [
        editable,
        getFallbackCopyText,
        handleCopyText,
        handleCutSelection,
        handlePasteFromClipboard,
        handleSelectAll,
        menu,
        onPasteText,
    ]);

    return {
        contextMenu:
            menu && contextMenuEntries.length > 0 ? (
                <ContextMenu
                    entries={contextMenuEntries}
                    menu={menu}
                    onClose={closeContextMenu}
                />
            ) : null,
        handleContextMenu,
    };
}
