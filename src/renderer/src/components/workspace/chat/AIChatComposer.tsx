import {
    Fragment,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
    type RefObject,
} from "react";

import type {
    AiAvailableCommand,
    AiFileContextAttachment,
    AiImageAttachment,
    AiSessionSnapshot,
    ProjectTreeNode,
} from "@shared/ipc";

import {
    COMPOSER_PROJECT_ENTRY_MIME,
    parseComposerProjectEntryDragData,
} from "@renderer/app/drag-and-drop";
import { getChatPillMetrics, type ChatPillMetrics } from "./chatPillMetrics";
import { CHAT_PILL_VARIANTS } from "./chatPillPalette";
import type { AIComposerPart } from "./composerParts";
import {
    appendFileMentionPart,
    appendFolderMentionPart,
    normalizeComposerParts,
} from "./composerParts";
import {
    AIChatMentionPicker,
    getMentionSuggestions,
    type MentionSuggestion,
} from "./AIChatMentionPicker";
import {
    AIChatCommandPicker,
    getCommandSuggestions,
} from "./AIChatCommandPicker";

/* ─── Constants ─── */

const MIN_COMPOSER_HEIGHT = 64;
const MAX_COMPOSER_HEIGHT = 480;

/* ─── DOM pill helpers ─── */

function applyComposerPillStyles(
    element: HTMLElement,
    metrics: ChatPillMetrics,
    palette: { background: string; color: string },
) {
    element.style.display = "inline-flex";
    element.style.alignItems = "center";
    element.style.padding = `${metrics.paddingY}px ${metrics.paddingX}px`;
    element.style.margin = `0 ${metrics.gapX}px`;
    element.style.borderRadius = `${metrics.radius}px`;
    element.style.background = palette.background;
    element.style.color = palette.color;
    element.style.fontSize = `${metrics.fontSize}px`;
    element.style.lineHeight = `${metrics.lineHeight}`;
    element.style.border = "none";
    element.style.verticalAlign = "baseline";
    element.style.whiteSpace = "nowrap";
    element.style.maxWidth = `${metrics.maxWidth}px`;
    element.style.overflow = "hidden";
    element.style.textOverflow = "ellipsis";
    element.style.transform = `translateY(${metrics.offsetY}px)`;
}

function createFileMentionNode(
    part: Extract<AIComposerPart, { type: "file_mention" }>,
    metrics: ChatPillMetrics,
): HTMLSpanElement {
    const el = document.createElement("span");
    el.contentEditable = "false";
    el.dataset.kind = "file_mention";
    el.dataset.label = part.label;
    el.dataset.path = part.path;
    el.dataset.relativePath = part.relativePath;
    el.dataset.languageId = part.languageId;
    el.textContent = `@${part.label}`;
    applyComposerPillStyles(el, metrics, CHAT_PILL_VARIANTS.file);
    return el;
}

function createFolderMentionNode(
    part: Extract<AIComposerPart, { type: "folder_mention" }>,
    metrics: ChatPillMetrics,
): HTMLSpanElement {
    const el = document.createElement("span");
    el.contentEditable = "false";
    el.dataset.kind = "folder_mention";
    el.dataset.folderPath = part.folderPath;
    el.dataset.label = part.label;
    el.textContent = `@${part.label}`;
    applyComposerPillStyles(el, metrics, CHAT_PILL_VARIANTS.folder);
    return el;
}

function createFetchMentionNode(metrics: ChatPillMetrics): HTMLSpanElement {
    const el = document.createElement("span");
    el.contentEditable = "false";
    el.dataset.kind = "fetch_mention";
    el.textContent = "@fetch";
    applyComposerPillStyles(el, metrics, CHAT_PILL_VARIANTS.success);
    return el;
}

function createPlanMentionNode(metrics: ChatPillMetrics): HTMLSpanElement {
    const el = document.createElement("span");
    el.contentEditable = "false";
    el.dataset.kind = "plan_mention";
    el.textContent = "/plan";
    applyComposerPillStyles(el, metrics, CHAT_PILL_VARIANTS.neutral);
    return el;
}

/* ─── DOM → parts extraction ─── */

function readPartsFromNode(node: Node, parts: AIComposerPart[]): void {
    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        if (text) parts.push({ type: "text", text });
        return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;

    if (el.contentEditable === "false" && el.dataset.kind) {
        switch (el.dataset.kind) {
            case "file_mention":
                parts.push({
                    type: "file_mention",
                    label: el.dataset.label ?? "",
                    path: el.dataset.path ?? "",
                    relativePath: el.dataset.relativePath ?? "",
                    languageId: el.dataset.languageId ?? "",
                });
                return;
            case "folder_mention":
                parts.push({
                    type: "folder_mention",
                    folderPath: el.dataset.folderPath ?? "",
                    label: el.dataset.label ?? "",
                });
                return;
            case "fetch_mention":
                parts.push({ type: "fetch_mention" });
                return;
            case "plan_mention":
                parts.push({ type: "plan_mention" });
                return;
        }
    }

    for (const child of node.childNodes) {
        readPartsFromNode(child, parts);
    }

    const tag = el.tagName;
    if (tag === "DIV" || tag === "P" || tag === "BR") {
        const last = parts[parts.length - 1];
        if (!last || last.type !== "text" || !last.text.endsWith("\n")) {
            parts.push({ type: "text", text: "\n" });
        }
    }
}

function readPartsFromDom(root: HTMLElement): AIComposerPart[] {
    const raw: AIComposerPart[] = [];
    for (const child of root.childNodes) {
        readPartsFromNode(child, raw);
    }
    const normalized = normalizeComposerParts(raw);

    while (normalized.length > 0) {
        const last = normalized[normalized.length - 1];
        if (last && last.type === "text" && last.text === "\n") {
            normalized.pop();
        } else {
            break;
        }
    }

    return normalized;
}

/* ─── Parts → DOM sync ─── */

function syncComposerDom(
    root: HTMLElement,
    parts: readonly AIComposerPart[],
    metrics: ChatPillMetrics,
): void {
    root.replaceChildren();
    for (const part of parts) {
        switch (part.type) {
            case "text":
                root.appendChild(document.createTextNode(part.text));
                break;
            case "file_mention":
                root.appendChild(createFileMentionNode(part, metrics));
                break;
            case "folder_mention":
                root.appendChild(createFolderMentionNode(part, metrics));
                break;
            case "fetch_mention":
                root.appendChild(createFetchMentionNode(metrics));
                break;
            case "plan_mention":
                root.appendChild(createPlanMentionNode(metrics));
                break;
            default:
                break;
        }
    }
}

/* ─── Caret helpers ─── */

function setCaretAtEnd(root: HTMLElement) {
    const range = document.createRange();
    const sel = window.getSelection();
    if (!sel) return;
    range.selectNodeContents(root);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}

function insertPlainTextAtSelection(root: HTMLElement, text: string) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) return;
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    sel.removeAllRanges();
    sel.addRange(range);
}

function getLanguageIdFromPath(path: string): string {
    const extension = path.split(".").at(-1);
    if (!extension || extension === path) {
        return "";
    }

    return extension.toLowerCase();
}

function removeAdjacentPill(root: HTMLElement): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return false;

    const container = range.startContainer;
    const offset = range.startOffset;

    if (container === root && offset > 0) {
        const prevChild = root.childNodes[offset - 1];
        if (
            prevChild instanceof HTMLElement &&
            prevChild.contentEditable === "false"
        ) {
            prevChild.remove();
            return true;
        }
    }

    if (container.nodeType === Node.TEXT_NODE && offset === 0) {
        const prev = container.previousSibling;
        if (prev instanceof HTMLElement && prev.contentEditable === "false") {
            prev.remove();
            return true;
        }
    }

    return false;
}

/* ─── Inline trigger detection ─── */

function getInlineTriggerMatch(
    root: HTMLElement,
    pattern: RegExp,
): { query: string; range: Range } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;

    const container = range.startContainer;
    if (container.nodeType !== Node.TEXT_NODE) return null;
    if (!root.contains(container)) return null;

    const textBefore = (container.textContent ?? "").slice(
        0,
        range.startOffset,
    );
    const match = textBefore.match(pattern);
    if (!match) return null;

    const query = match[2] ?? "";
    const triggerStart = textBefore.length - match[0].length;

    const triggerRange = document.createRange();
    triggerRange.setStart(container, triggerStart);
    triggerRange.setEnd(container, range.startOffset);

    return { query, range: triggerRange };
}

/* ─── Props ─── */

interface AIChatComposerProps {
    readonly parts: readonly AIComposerPart[];
    readonly resetNonce?: number;
    readonly status: AiSessionSnapshot["status"];
    readonly runtimeName: string;
    readonly disabled?: boolean;
    readonly composerFontFamily?: string;
    readonly composerFontSize?: number;
    readonly availableCommands: readonly AiAvailableCommand[];
    readonly agentControls?: ReactNode;
    readonly draftFileContexts: readonly AiFileContextAttachment[];
    readonly draftAttachments: readonly AiImageAttachment[];
    readonly onChange: (parts: AIComposerPart[]) => void;
    readonly onSearchProjectEntries: (
        query: string,
    ) => Promise<readonly ProjectTreeNode[]>;
    readonly onAttachFile?: () => void;
    readonly onPasteImage?: (file: File) => void;
    readonly onSubmit: () => void;
    readonly onStop: () => void;
    readonly onRemoveFileContext: (contextId: string) => void;
    readonly onRemoveAttachment: (attachmentId: string) => void;
    readonly fileInputRef: RefObject<HTMLInputElement | null>;
    readonly renderFileContextPill: (fc: AiFileContextAttachment) => ReactNode;
    readonly renderImageChip: (att: AiImageAttachment) => ReactNode;
}

/* ─── Component ─── */

export function AIChatComposer({
    parts,
    resetNonce = 0,
    status,
    runtimeName,
    disabled = false,
    composerFontFamily,
    composerFontSize = 14,
    availableCommands,
    agentControls,
    draftFileContexts,
    draftAttachments,
    onChange,
    onSearchProjectEntries,
    onAttachFile,
    onPasteImage,
    onSubmit,
    onStop,
    fileInputRef,
    renderFileContextPill,
    renderImageChip,
}: AIChatComposerProps) {
    const composerRef = useRef<HTMLDivElement>(null);
    const [customHeight, setCustomHeight] = useState<number | null>(null);
    const [isFileDragOver, setIsFileDragOver] = useState(false);
    const dragOverCounter = useRef(0);
    const resizeSession = useRef<{
        startY: number;
        startHeight: number;
    } | null>(null);

    const [mentionState, setMentionState] = useState<{
        open: boolean;
        query: string;
        items: MentionSuggestion[];
        selectedIndex: number;
    }>({ open: false, query: "", items: [], selectedIndex: 0 });

    const [slashState, setSlashState] = useState<{
        open: boolean;
        query: string;
        items: AiAvailableCommand[];
        selectedIndex: number;
    }>({ open: false, query: "", items: [], selectedIndex: 0 });

    const lastSyncedParts = useRef<string>("");

    const metrics = useMemo(
        () => getChatPillMetrics(composerFontSize),
        [composerFontSize],
    );

    const isStreaming = status === "streaming" || status === "starting";
    const isSessionBusy =
        isStreaming ||
        status === "waiting_permission" ||
        status === "waiting_user_input";
    const hasDraft =
        parts.some((p) => p.type !== "text" || p.text.trim().length > 0) ||
        draftAttachments.length > 0 ||
        draftFileContexts.length > 0;
    const canSubmit = !disabled && hasDraft;
    const submitLabel = isSessionBusy ? "Queue" : "Send";

    /* ─ Sync parts → DOM when parts change externally ─ */
    useEffect(() => {
        const root = composerRef.current;
        if (!root) return;

        const serialized = JSON.stringify(parts);
        if (serialized === lastSyncedParts.current) return;
        lastSyncedParts.current = serialized;

        syncComposerDom(root, parts, metrics);
        setCaretAtEnd(root);
    }, [parts, metrics]);

    useEffect(() => {
        const root = composerRef.current;
        if (!root) return;

        const emptyParts: AIComposerPart[] = [{ type: "text", text: "" }];
        lastSyncedParts.current = JSON.stringify(emptyParts);
        syncComposerDom(root, emptyParts, metrics);
        setCaretAtEnd(root);
    }, [metrics, resetNonce]);

    /* ─ Read DOM → parts on input ─ */
    const syncFromDom = useCallback(() => {
        const root = composerRef.current;
        if (!root) return;
        const newParts = readPartsFromDom(root);
        lastSyncedParts.current = JSON.stringify(newParts);
        onChange(newParts);
    }, [onChange]);

    /* ─ Update inline pickers ─ */
    const updatePickers = useCallback(async () => {
        const root = composerRef.current;
        if (!root) return;

        const mentionMatch = getInlineTriggerMatch(root, /(^|\s)@([^\s@]*)$/);
        if (mentionMatch) {
            const entries = await onSearchProjectEntries(mentionMatch.query);
            const items = getMentionSuggestions(mentionMatch.query, entries);
            setMentionState({
                open: true,
                query: mentionMatch.query,
                items,
                selectedIndex: 0,
            });
            setSlashState((s) => ({ ...s, open: false }));
            return;
        }

        const slashMatch = getInlineTriggerMatch(root, /(^|\s)\/([^\s/]*)$/);
        if (slashMatch) {
            const items = getCommandSuggestions(
                slashMatch.query,
                availableCommands,
            );
            setSlashState({
                open: true,
                query: slashMatch.query,
                items,
                selectedIndex: 0,
            });
            setMentionState((s) => ({ ...s, open: false }));
            return;
        }

        setMentionState((s) => ({ ...s, open: false }));
        setSlashState((s) => ({ ...s, open: false }));
    }, [availableCommands, onSearchProjectEntries]);

    /* ─ Handle input event ─ */
    const handleInput = useCallback(() => {
        syncFromDom();
        void updatePickers();
    }, [syncFromDom, updatePickers]);

    /* ─ Replace the trigger text with a pill ─ */
    const replaceTriggerWithPill = useCallback(
        (part: AIComposerPart) => {
            const root = composerRef.current;
            if (!root) return;

            const pattern =
                part.type === "plan_mention"
                    ? /(^|\s)\/([^\s/]*)$/
                    : /(^|\s)@([^\s@]*)$/;
            const match = getInlineTriggerMatch(root, pattern);
            if (match) {
                match.range.deleteContents();
                const leading = match.range.startContainer;
                if (
                    leading.nodeType === Node.TEXT_NODE &&
                    leading.textContent?.endsWith(" ")
                ) {
                    // keep the space
                }
            }

            let node: HTMLSpanElement | null = null;
            switch (part.type) {
                case "file_mention":
                    node = createFileMentionNode(part, metrics);
                    break;
                case "folder_mention":
                    node = createFolderMentionNode(part, metrics);
                    break;
                case "fetch_mention":
                    node = createFetchMentionNode(metrics);
                    break;
                case "plan_mention":
                    node = createPlanMentionNode(metrics);
                    break;
            }

            if (node) {
                const sel = window.getSelection();
                if (sel && sel.rangeCount > 0) {
                    const range = sel.getRangeAt(0);
                    range.insertNode(node);
                    const space = document.createTextNode(" ");
                    node.after(space);
                    range.setStartAfter(space);
                    range.setEndAfter(space);
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }

            syncFromDom();
        },
        [metrics, syncFromDom],
    );

    /* ─ Handle mention selection ─ */
    const handleMentionSelect = useCallback(
        (item: MentionSuggestion) => {
            switch (item.kind) {
                case "fetch":
                    replaceTriggerWithPill({ type: "fetch_mention" });
                    break;
                case "plan":
                    replaceTriggerWithPill({ type: "plan_mention" });
                    break;
                case "file":
                    replaceTriggerWithPill({
                        type: "file_mention",
                        label: item.entry.name,
                        path: item.entry.relativePath,
                        relativePath: item.entry.relativePath,
                        languageId: item.entry.extension ?? "",
                    });
                    break;
                case "folder":
                    replaceTriggerWithPill({
                        type: "folder_mention",
                        folderPath: item.entry.relativePath,
                        label: item.entry.name,
                    });
                    break;
            }
            setMentionState((s) => ({ ...s, open: false }));
        },
        [replaceTriggerWithPill],
    );

    /* ─ Handle command selection ─ */
    const handleCommandSelect = useCallback(
        (cmd: AiAvailableCommand) => {
            const root = composerRef.current;
            if (!root) return;

            const match = getInlineTriggerMatch(root, /(^|\s)\/([^\s/]*)$/);
            if (match) {
                match.range.deleteContents();
            }

            insertPlainTextAtSelection(root, cmd.insertText);
            syncFromDom();
            setSlashState((s) => ({ ...s, open: false }));
        },
        [syncFromDom],
    );

    /* ─ Keyboard ─ */
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (mentionState.open) {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMentionState((s) => ({
                        ...s,
                        selectedIndex: (s.selectedIndex + 1) % s.items.length,
                    }));
                    return;
                }
                if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionState((s) => ({
                        ...s,
                        selectedIndex:
                            (s.selectedIndex - 1 + s.items.length) %
                            s.items.length,
                    }));
                    return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    const item = mentionState.items[mentionState.selectedIndex];
                    if (item) handleMentionSelect(item);
                    return;
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    setMentionState((s) => ({ ...s, open: false }));
                    return;
                }
            }

            if (slashState.open) {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashState((s) => ({
                        ...s,
                        selectedIndex: (s.selectedIndex + 1) % s.items.length,
                    }));
                    return;
                }
                if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashState((s) => ({
                        ...s,
                        selectedIndex:
                            (s.selectedIndex - 1 + s.items.length) %
                            s.items.length,
                    }));
                    return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    const item = slashState.items[slashState.selectedIndex];
                    if (item) handleCommandSelect(item);
                    return;
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    setSlashState((s) => ({ ...s, open: false }));
                    return;
                }
            }

            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (canSubmit) onSubmit();
                else if (isSessionBusy) onStop();
                return;
            }

            if (e.key === "Backspace") {
                const root = composerRef.current;
                if (root && removeAdjacentPill(root)) {
                    e.preventDefault();
                    syncFromDom();
                }
            }
        },
        [
            mentionState,
            slashState,
            canSubmit,
            isSessionBusy,
            onSubmit,
            onStop,
            handleMentionSelect,
            handleCommandSelect,
            syncFromDom,
        ],
    );

    /* ─ Paste ─ */
    const handlePaste = useCallback(
        (e: React.ClipboardEvent<HTMLDivElement>) => {
            e.preventDefault();

            for (const item of e.clipboardData.items) {
                if (item.kind === "file" && item.type.startsWith("image/")) {
                    const file = item.getAsFile();
                    if (file && onPasteImage) {
                        onPasteImage(file);
                        return;
                    }
                }
            }

            const text = e.clipboardData.getData("text/plain");
            if (text) {
                const root = composerRef.current;
                if (root) {
                    insertPlainTextAtSelection(root, text);
                    syncFromDom();
                }
            }
        },
        [onPasteImage, syncFromDom],
    );

    /* ─ Drag & drop ─ */
    const handleDrop = useCallback(
        (e: React.DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            dragOverCounter.current = 0;
            setIsFileDragOver(false);

            if (disabled) {
                return;
            }

            const composerEntryData = parseComposerProjectEntryDragData(
                e.dataTransfer.getData(COMPOSER_PROJECT_ENTRY_MIME),
            );

            if (composerEntryData) {
                const nextParts =
                    composerEntryData.kind === "directory"
                        ? appendFolderMentionPart(
                              parts,
                              composerEntryData.relativePath,
                              composerEntryData.name,
                          )
                        : appendFileMentionPart(parts, {
                              label: composerEntryData.name,
                              path: composerEntryData.relativePath,
                              relativePath: composerEntryData.relativePath,
                              languageId: getLanguageIdFromPath(
                                  composerEntryData.relativePath,
                              ),
                          });

                onChange(nextParts);
                return;
            }

            if (e.dataTransfer.files.length > 0) {
                for (const file of e.dataTransfer.files) {
                    if (file.type.startsWith("image/") && onPasteImage) {
                        onPasteImage(file);
                    }
                }
            }
        },
        [disabled, onChange, onPasteImage, parts],
    );

    /* ─ Resize handle ─ */
    const shellRef = useRef<HTMLDivElement>(null);

    const handleResizePointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            e.preventDefault();
            const target = e.currentTarget;
            target.setPointerCapture(e.pointerId);
            const rect = shellRef.current?.getBoundingClientRect();
            resizeSession.current = {
                startY: e.clientY,
                startHeight: rect?.height ?? MIN_COMPOSER_HEIGHT,
            };
            document.body.classList.add("resizing-composer");
        },
        [],
    );

    const handleResizePointerMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (!resizeSession.current) return;
            const delta = resizeSession.current.startY - e.clientY;
            const next = Math.min(
                MAX_COMPOSER_HEIGHT,
                Math.max(
                    MIN_COMPOSER_HEIGHT,
                    resizeSession.current.startHeight + delta,
                ),
            );
            setCustomHeight(next);
        },
        [],
    );

    const handleResizePointerUp = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            resizeSession.current = null;
            document.body.classList.remove("resizing-composer");
        },
        [],
    );

    /* ─ Render ─ */
    const hasAttachments =
        draftFileContexts.length > 0 || draftAttachments.length > 0;

    const isEmpty = parts.every(
        (p) => p.type === "text" && p.text.trim().length === 0,
    );

    return (
        <div
            ref={shellRef}
            className="relative flex flex-col"
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onDragEnter={(e) => {
                e.preventDefault();
                dragOverCounter.current += 1;
                if (dragOverCounter.current === 1) setIsFileDragOver(true);
            }}
            onDragLeave={() => {
                dragOverCounter.current -= 1;
                if (dragOverCounter.current <= 0) {
                    dragOverCounter.current = 0;
                    setIsFileDragOver(false);
                }
            }}
            style={{
                boxShadow: isFileDragOver
                    ? "0 0 0 2px color-mix(in srgb, var(--color-accent) 20%, transparent)"
                    : "none",
                overflow: "hidden",
                transition: "box-shadow 0.15s ease",
                ...(customHeight != null ? { height: customHeight } : {}),
            }}
        >
            {/* Resize handle */}
            <div
                className="absolute left-0 right-0 touch-none"
                onPointerDown={handleResizePointerDown}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerUp}
                style={{
                    cursor: "row-resize",
                    height: 9,
                    top: -4,
                    zIndex: 5,
                }}
            >
                <div
                    className="mx-auto rounded-full"
                    style={{
                        backgroundColor: "var(--color-border)",
                        height: 3,
                        marginTop: 3,
                        opacity: 0,
                        transition: "opacity 0.15s ease",
                        width: 32,
                    }}
                />
            </div>

            {/* Pickers */}
            <AIChatMentionPicker
                items={mentionState.items}
                onClose={() => setMentionState((s) => ({ ...s, open: false }))}
                onHoverIndex={(i) =>
                    setMentionState((s) => ({
                        ...s,
                        selectedIndex: i,
                    }))
                }
                onSelect={handleMentionSelect}
                open={mentionState.open}
                selectedIndex={mentionState.selectedIndex}
                x={0}
                y={0}
            />
            <AIChatCommandPicker
                items={slashState.items}
                onClose={() => setSlashState((s) => ({ ...s, open: false }))}
                onHoverIndex={(i) =>
                    setSlashState((s) => ({
                        ...s,
                        selectedIndex: i,
                    }))
                }
                onSelect={handleCommandSelect}
                open={slashState.open}
                selectedIndex={slashState.selectedIndex}
                x={0}
                y={0}
            />

            {/* Attachments bar */}
            {hasAttachments ? (
                <div className="flex max-h-24 flex-wrap items-center gap-1.5 overflow-y-auto px-3 pb-1.5 pt-2">
                    {draftFileContexts.map((fc) => (
                        <Fragment key={fc.id}>
                            {renderFileContextPill(fc)}
                        </Fragment>
                    ))}
                    {draftAttachments.map((att) => (
                        <Fragment key={att.id}>{renderImageChip(att)}</Fragment>
                    ))}
                </div>
            ) : null}

            {/* Hidden file input */}
            <input
                accept="image/*"
                className="hidden"
                multiple
                ref={fileInputRef}
                type="file"
            />

            {/* Contenteditable input */}
            <div className="relative min-h-0 flex-1">
                {isEmpty && !disabled ? (
                    <div
                        className="pointer-events-none absolute left-3.5 top-3"
                        style={{
                            color: "var(--color-text-secondary)",
                            fontFamily: composerFontFamily,
                            fontSize: composerFontSize,
                            lineHeight: 1.5,
                            opacity: 0.6,
                            right: 36,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        Message {runtimeName} — @ to include context, / for
                        commands
                    </div>
                ) : null}
                <div
                    ref={composerRef}
                    className="app-no-drag h-full w-full outline-none"
                    contentEditable={!disabled}
                    onInput={handleInput}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    role="textbox"
                    style={{
                        color: "var(--color-text-primary)",
                        fontFamily: composerFontFamily,
                        fontSize: composerFontSize,
                        lineHeight: 1.5,
                        minHeight: MIN_COMPOSER_HEIGHT,
                        overflowY: "auto",
                        padding: "10px 36px 10px 14px",
                        whiteSpace: "pre-wrap",
                    }}
                    suppressContentEditableWarning
                />
            </div>

            {/* Bottom toolbar */}
            <div className="mt-auto flex items-center justify-between gap-2 px-2 pb-1.5">
                <div className="min-w-0 flex-1">
                    {agentControls ? agentControls : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {/* Attach button (paperclip icon) */}
                    <button
                        className="app-no-drag flex shrink-0 items-center justify-center rounded-md"
                        onClick={() => {
                            if (onAttachFile) onAttachFile();
                            else fileInputRef.current?.click();
                        }}
                        style={{
                            background: "transparent",
                            border: "none",
                            borderRadius: 6,
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            height: 28,
                            transition: "all 0.15s ease",
                            width: 28,
                        }}
                        type="button"
                    >
                        <svg
                            fill="none"
                            height="15"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.5"
                            viewBox="0 0 24 24"
                            width="15"
                        >
                            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                        </svg>
                    </button>
                    <button
                        aria-label={submitLabel}
                        className="app-no-drag flex shrink-0 items-center justify-center rounded-full"
                        onClick={() => {
                            if (canSubmit) onSubmit();
                        }}
                        style={{
                            backgroundColor: canSubmit
                                ? "var(--color-accent)"
                                : "transparent",
                            border: "none",
                            borderRadius: "50%",
                            color: canSubmit
                                ? "#fff"
                                : "var(--color-text-secondary)",
                            cursor: canSubmit ? "pointer" : "default",
                            height: 28,
                            opacity: canSubmit ? 1 : 0.4,
                            transition: "all 0.15s ease",
                            width: 28,
                        }}
                        title={submitLabel}
                        type="button"
                    >
                        <svg
                            fill="none"
                            height="16"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            viewBox="0 0 24 24"
                            width="16"
                        >
                            <line x1="12" x2="12" y1="19" y2="5" />
                            <polyline points="5 12 12 5 19 12" />
                        </svg>
                    </button>
                    {isSessionBusy ? (
                        <button
                            aria-label="Stop"
                            className="app-no-drag flex shrink-0 items-center justify-center rounded-full"
                            onClick={onStop}
                            style={{
                                backgroundColor: "#b91c1c",
                                border: "none",
                                borderRadius: "50%",
                                color: "#fff",
                                cursor: "pointer",
                                height: 28,
                                transition: "all 0.15s ease",
                                width: 28,
                            }}
                            title="Stop"
                            type="button"
                        >
                            <svg
                                fill="currentColor"
                                height="10"
                                viewBox="0 0 10 10"
                                width="10"
                            >
                                <rect height="10" rx="1.5" width="10" />
                            </svg>
                        </button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
