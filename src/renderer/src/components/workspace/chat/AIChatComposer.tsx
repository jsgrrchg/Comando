import {
    type CSSProperties,
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
import { resolveEditorLanguage } from "@shared/editor-language";

import {
    COMPOSER_PROJECT_ENTRY_LIST_MIME,
    COMPOSER_PROJECT_ENTRY_MIME,
    getExternalComposerDropItems,
    getWorkspaceTabComposerDragItems,
    WORKSPACE_TAB_COMPOSER_DRAG_EVENT,
    parseComposerProjectEntryListDragData,
    parseComposerProjectEntryDragData,
    type ComposerProjectEntryDragData,
    type WorkspaceTabComposerDragDetail,
} from "@renderer/app/drag-and-drop";
import { useRenderProbe } from "@renderer/app/debug/renderProbe";
import { getChatPillMetrics, type ChatPillMetrics } from "./chatPillMetrics";
import { CHAT_PILL_VARIANTS } from "./chatPillPalette";
import type { AIComposerPart } from "./composerParts";
import {
    appendFileAttachmentPart,
    appendFileMentionPart,
    appendFolderMentionPart,
    appendWorkspaceTabComposerItems,
    composerPartsToPlainText,
    normalizeComposerParts,
} from "./composerParts";
import { isActiveChatTurnStatus } from "./chatTurnStatus";
import {
    AIChatMentionPicker,
    getMentionSuggestions,
    type MentionSuggestion,
} from "./AIChatMentionPicker";
import {
    AIChatCommandPicker,
    getCommandSuggestions,
} from "./AIChatCommandPicker";
import { useTextContextMenu } from "../../context-menu/useTextContextMenu";

/* ─── Constants ─── */

const MIN_COMPOSER_INPUT_HEIGHT = 76;
const MIN_COMPOSER_HEIGHT = 112;
const MAX_COMPOSER_HEIGHT = 600;

type ComposerPillLayoutStyle = Pick<
    CSSProperties,
    | "maxWidth"
    | "overflow"
    | "overflowWrap"
    | "textOverflow"
    | "whiteSpace"
    | "wordBreak"
>;

export function getComposerShellSizingStyle(
    customHeight: number | null,
    options: { readonly expanded?: boolean } = {},
): Pick<CSSProperties, "height" | "maxHeight" | "minHeight"> {
    if (options.expanded === true) {
        return {
            minHeight: MIN_COMPOSER_HEIGHT,
        };
    }

    return {
        minHeight: MIN_COMPOSER_HEIGHT,
        maxHeight: MAX_COMPOSER_HEIGHT,
        ...(customHeight != null ? { height: customHeight } : {}),
    };
}

export function getComposerInputSizingStyle(): Pick<CSSProperties, "minHeight"> {
    return {
        minHeight: MIN_COMPOSER_INPUT_HEIGHT,
    };
}

/* ─── DOM pill helpers ─── */

export function getComposerPillLayoutStyle(
    metrics: ChatPillMetrics,
    options: { readonly compact?: boolean } = {},
): ComposerPillLayoutStyle {
    if (options.compact === true) {
        return {
            maxWidth: `${metrics.maxWidth}px`,
            overflow: "hidden",
            overflowWrap: "normal",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            wordBreak: "normal",
        };
    }

    return {
        maxWidth: "100%",
        overflow: "visible",
        overflowWrap: "anywhere",
        textOverflow: "clip",
        whiteSpace: "normal",
        wordBreak: "break-word",
    };
}

function applyComposerPillStyles(
    element: HTMLElement,
    metrics: ChatPillMetrics,
    palette: { background: string; color: string },
    options: { readonly compact?: boolean } = {},
) {
    const layout = getComposerPillLayoutStyle(metrics, options);
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
    element.style.whiteSpace = String(layout.whiteSpace);
    element.style.maxWidth = String(layout.maxWidth);
    element.style.overflow = String(layout.overflow);
    element.style.overflowWrap = String(layout.overflowWrap);
    element.style.textOverflow = String(layout.textOverflow);
    element.style.wordBreak = String(layout.wordBreak);
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

function createSelectionMentionNode(
    part: Extract<AIComposerPart, { type: "selection_mention" }>,
    metrics: ChatPillMetrics,
): HTMLSpanElement {
    const el = document.createElement("span");
    el.contentEditable = "false";
    el.dataset.kind = "selection_mention";
    el.dataset.label = part.label;
    el.dataset.path = part.path;
    el.dataset.selectedText = part.selectedText;
    el.dataset.startLine = String(part.startLine);
    el.dataset.endLine = String(part.endLine);
    el.textContent = part.label;
    applyComposerPillStyles(el, metrics, CHAT_PILL_VARIANTS.accent, {
        compact: true,
    });
    return el;
}

function createFileAttachmentNode(
    part: Extract<AIComposerPart, { type: "file_attachment" }>,
    metrics: ChatPillMetrics,
): HTMLSpanElement {
    const el = document.createElement("span");
    el.contentEditable = "false";
    el.dataset.kind = "file_attachment";
    el.dataset.filePath = part.filePath;
    el.dataset.mimeType = part.mimeType;
    el.dataset.label = part.label;
    el.textContent = part.label;
    applyComposerPillStyles(el, metrics, CHAT_PILL_VARIANTS.file);
    return el;
}

function createGitCommitMentionNode(
    part: Extract<AIComposerPart, { type: "git_commit_mention" }>,
    metrics: ChatPillMetrics,
): HTMLSpanElement {
    const el = document.createElement("span");
    el.contentEditable = "false";
    el.dataset.kind = "git_commit_mention";
    el.dataset.commitSha = part.commitSha;
    el.dataset.label = part.label;
    el.textContent = `commit: ${part.label}`;
    applyComposerPillStyles(el, metrics, CHAT_PILL_VARIANTS.commit);
    return el;
}

function createGitHubIssueMentionNode(
    part: Extract<AIComposerPart, { type: "github_issue_mention" }>,
    metrics: ChatPillMetrics,
): HTMLSpanElement {
    const el = document.createElement("span");
    el.contentEditable = "false";
    el.dataset.kind = "github_issue_mention";
    el.dataset.host = part.host;
    el.dataset.owner = part.owner;
    el.dataset.repo = part.repo;
    el.dataset.number = String(part.number);
    el.dataset.label = part.label;
    el.dataset.title = part.title;
    el.dataset.url = part.url;
    el.textContent = part.label;
    el.title = `${part.owner}/${part.repo} ${part.label}: ${part.title}`;
    applyComposerPillStyles(el, metrics, CHAT_PILL_VARIANTS.accent, {
        compact: true,
    });
    return el;
}

function createGitHubPullRequestMentionNode(
    part: Extract<AIComposerPart, { type: "github_pull_request_mention" }>,
    metrics: ChatPillMetrics,
): HTMLSpanElement {
    const el = document.createElement("span");
    el.contentEditable = "false";
    el.dataset.kind = "github_pull_request_mention";
    el.dataset.host = part.host;
    el.dataset.owner = part.owner;
    el.dataset.repo = part.repo;
    el.dataset.number = String(part.number);
    el.dataset.label = part.label;
    el.dataset.title = part.title;
    el.dataset.url = part.url;
    el.textContent = part.label;
    el.title = `${part.owner}/${part.repo} ${part.label}: ${part.title}`;
    applyComposerPillStyles(el, metrics, CHAT_PILL_VARIANTS.success, {
        compact: true,
    });
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
            case "selection_mention":
                if (
                    el.dataset.label &&
                    el.dataset.path &&
                    el.dataset.selectedText &&
                    el.dataset.startLine &&
                    el.dataset.endLine
                ) {
                    parts.push({
                        type: "selection_mention",
                        endLine: Number(el.dataset.endLine),
                        label: el.dataset.label,
                        path: el.dataset.path,
                        selectedText: el.dataset.selectedText,
                        startLine: Number(el.dataset.startLine),
                    });
                }
                return;
            case "file_attachment":
                if (
                    el.dataset.filePath &&
                    el.dataset.mimeType &&
                    el.dataset.label
                ) {
                    parts.push({
                        type: "file_attachment",
                        filePath: el.dataset.filePath,
                        label: el.dataset.label,
                        mimeType: el.dataset.mimeType,
                    });
                }
                return;
            case "git_commit_mention":
                if (el.dataset.commitSha && el.dataset.label) {
                    parts.push({
                        type: "git_commit_mention",
                        commitSha: el.dataset.commitSha,
                        label: el.dataset.label,
                    });
                }
                return;
            case "github_issue_mention":
                if (isValidGitHubMentionDataset(el.dataset)) {
                    parts.push({
                        type: "github_issue_mention",
                        host: el.dataset.host,
                        label: el.dataset.label,
                        number: Number(el.dataset.number),
                        owner: el.dataset.owner,
                        repo: el.dataset.repo,
                        title: el.dataset.title,
                        url: el.dataset.url,
                    });
                }
                return;
            case "github_pull_request_mention":
                if (isValidGitHubMentionDataset(el.dataset)) {
                    parts.push({
                        type: "github_pull_request_mention",
                        host: el.dataset.host,
                        label: el.dataset.label,
                        number: Number(el.dataset.number),
                        owner: el.dataset.owner,
                        repo: el.dataset.repo,
                        title: el.dataset.title,
                        url: el.dataset.url,
                    });
                }
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

function isValidGitHubMentionDataset(dataset: DOMStringMap): dataset is {
    readonly host: string;
    readonly label: string;
    readonly number: string;
    readonly owner: string;
    readonly repo: string;
    readonly title: string;
    readonly url: string;
} {
    return Boolean(
        dataset.host &&
            dataset.owner &&
            dataset.repo &&
            dataset.number &&
            Number.isFinite(Number(dataset.number)) &&
            dataset.label &&
            dataset.title &&
            dataset.url,
    );
}

export function appendComposerProjectEntries(
    parts: readonly AIComposerPart[],
    entries: readonly ComposerProjectEntryDragData[],
): AIComposerPart[] {
    return entries.reduce<AIComposerPart[]>((nextParts, entry) => {
        return entry.kind === "directory"
            ? appendFolderMentionPart(
                  nextParts,
                  entry.relativePath,
                  entry.name,
              )
            : appendFileMentionPart(nextParts, {
                  label: entry.name,
                  path: entry.relativePath,
                  relativePath: entry.relativePath,
                  languageId: getLanguageIdFromPath(entry.relativePath),
              });
    }, [...parts]);
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
            case "selection_mention":
                root.appendChild(createSelectionMentionNode(part, metrics));
                break;
            case "file_attachment":
                root.appendChild(createFileAttachmentNode(part, metrics));
                break;
            case "git_commit_mention":
                root.appendChild(createGitCommitMentionNode(part, metrics));
                break;
            case "github_issue_mention":
                root.appendChild(createGitHubIssueMentionNode(part, metrics));
                break;
            case "github_pull_request_mention":
                root.appendChild(
                    createGitHubPullRequestMentionNode(part, metrics),
                );
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
    return resolveEditorLanguage({ filePath: path }).id;
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
    readonly autoFocusKey?: string;
    readonly resetNonce?: number;
    readonly status: AiSessionSnapshot["status"];
    readonly runtimeName: string;
    readonly disabled?: boolean;
    readonly disabledReason?: string | null;
    readonly requireCmdEnterToSend?: boolean;
    readonly composerFontFamily?: string;
    readonly composerFontSize?: number;
    readonly availableCommands: readonly AiAvailableCommand[];
    readonly agentControls?: ReactNode;
    readonly bottomAccent?: ReactNode;
    readonly expanded?: boolean;
    readonly draftFileContexts: readonly AiFileContextAttachment[];
    readonly draftAttachments: readonly AiImageAttachment[];
    readonly onChange: (parts: AIComposerPart[]) => void;
    readonly onSearchProjectEntries: (
        query: string,
    ) => Promise<readonly ProjectTreeNode[]>;
    readonly onPasteImage?: (file: File) => void;
    readonly onSubmit: () => void;
    readonly onStop: () => void;
    readonly onToggleExpanded?: () => void;
    readonly onRemoveFileContext: (contextId: string) => void;
    readonly onRemoveAttachment: (attachmentId: string) => void;
    readonly fileInputRef: RefObject<HTMLInputElement | null>;
    readonly renderFileContextPill: (fc: AiFileContextAttachment) => ReactNode;
    readonly renderImageChip: (att: AiImageAttachment) => ReactNode;
}

export function shouldResetComposerForNonceChange(
    previousResetNonce: number | null,
    nextResetNonce: number,
): boolean {
    return previousResetNonce !== null && previousResetNonce !== nextResetNonce;
}

export function shouldAutoFocusComposerForKeyChange(
    previousAutoFocusKey: string | null,
    nextAutoFocusKey: string,
): boolean {
    return (
        previousAutoFocusKey !== null && previousAutoFocusKey !== nextAutoFocusKey
    );
}

type ComposerSubmitKeyboardAction = "submit" | "stop" | null;

export function getComposerSubmitKeyboardAction(input: {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly canSubmit: boolean;
    readonly isSessionBusy: boolean;
    readonly requireCmdEnterToSend: boolean;
}): ComposerSubmitKeyboardAction {
    if (input.key !== "Enter" || input.shiftKey || input.altKey) {
        return null;
    }

    const modifierPressed = input.metaKey || input.ctrlKey;

    if (input.requireCmdEnterToSend) {
        if (!modifierPressed) {
            return null;
        }
    } else if (modifierPressed) {
        return null;
    }

    if (input.canSubmit) {
        return "submit";
    }

    if (input.isSessionBusy) {
        return "stop";
    }

    return null;
}

/* ─── Component ─── */

export function AIChatComposer({
    parts,
    autoFocusKey,
    resetNonce = 0,
    status,
    runtimeName,
    disabled = false,
    disabledReason = null,
    requireCmdEnterToSend = false,
    composerFontFamily,
    composerFontSize = 14,
    availableCommands,
    agentControls,
    bottomAccent,
    expanded = false,
    draftFileContexts,
    draftAttachments,
    onChange,
    onSearchProjectEntries,
    onPasteImage,
    onSubmit,
    onStop,
    onToggleExpanded,
    fileInputRef,
    renderFileContextPill,
    renderImageChip,
}: AIChatComposerProps) {
    const composerRef = useRef<HTMLDivElement>(null);
    const [customHeight, setCustomHeight] = useState<number | null>(null);
    const [isFileDragOver, setIsFileDragOver] = useState(false);
    const [isWorkspaceTabDragOver, setIsWorkspaceTabDragOver] = useState(false);
    const dragOverCounter = useRef(0);
    const resizeSession = useRef<{
        startY: number;
        startHeight: number;
    } | null>(null);
    const partsRef = useRef(parts);
    const onChangeRef = useRef(onChange);

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
    const lastAutoFocusKeyRef = useRef<string | null>(null);
    const lastResetNonceRef = useRef<number | null>(null);
    const mentionSearchRequestRef = useRef(0);

    const metrics = useMemo(
        () => getChatPillMetrics(composerFontSize),
        [composerFontSize],
    );

    const isSessionBusy = isActiveChatTurnStatus(status);
    const hasDraft =
        parts.some((p) => p.type !== "text" || p.text.trim().length > 0) ||
        draftAttachments.length > 0 ||
        draftFileContexts.length > 0;
    const canSubmit = !disabled && hasDraft;
    const submitLabel = isSessionBusy ? "Queue" : "Send";
    const shouldShowDisabledReason =
        disabled &&
        typeof disabledReason === "string" &&
        disabledReason.length > 0;

    useRenderProbe("AIChatComposer", {
        attachments: draftAttachments.length,
        canSubmit,
        expanded,
        contexts: draftFileContexts.length,
        isSessionBusy,
        mentionOpen: mentionState.open,
        parts: parts.length,
        slashOpen: slashState.open,
        submitLabel,
    });

    useEffect(() => {
        partsRef.current = parts;
    }, [parts]);

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

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

        const previousResetNonce = lastResetNonceRef.current;
        lastResetNonceRef.current = resetNonce;

        if (
            !shouldResetComposerForNonceChange(previousResetNonce, resetNonce)
        ) {
            return;
        }

        const emptyParts: AIComposerPart[] = [{ type: "text", text: "" }];
        lastSyncedParts.current = JSON.stringify(emptyParts);
        syncComposerDom(root, emptyParts, metrics);
        setCaretAtEnd(root);
    }, [metrics, resetNonce]);

    useEffect(() => {
        if (!autoFocusKey || disabled) {
            return;
        }

        const root = composerRef.current;
        if (!root) {
            return;
        }

        const previousAutoFocusKey = lastAutoFocusKeyRef.current;
        lastAutoFocusKeyRef.current = autoFocusKey;

        if (
            previousAutoFocusKey !== null &&
            !shouldAutoFocusComposerForKeyChange(
                previousAutoFocusKey,
                autoFocusKey,
            )
        ) {
            return;
        }

        root.focus();
        setCaretAtEnd(root);
    }, [autoFocusKey, disabled]);

    /* ─ Read DOM → parts on input ─ */
    const syncFromDom = useCallback(() => {
        const root = composerRef.current;
        if (!root) return;
        const newParts = readPartsFromDom(root);
        lastSyncedParts.current = JSON.stringify(newParts);
        onChange(newParts);
    }, [onChange]);

    const applyWorkspaceTabComposerDrop = useCallback(
        (detail: WorkspaceTabComposerDragDetail) => {
            const dragItems = getWorkspaceTabComposerDragItems(detail);
            if (disabled || dragItems.length === 0) {
                return;
            }

            const nextParts: AIComposerPart[] = appendWorkspaceTabComposerItems(
                partsRef.current,
                dragItems,
            );

            onChangeRef.current(nextParts);

            const root = composerRef.current;
            if (root) {
                root.focus();
                setCaretAtEnd(root);
            }
        },
        [disabled],
    );

    /* ─ Update inline pickers ─ */
    const updatePickers = useCallback(async () => {
        const root = composerRef.current;
        if (!root) return;

        const mentionMatch = getInlineTriggerMatch(root, /(^|\s)@([^\s@]*)$/);
        if (mentionMatch) {
            const requestId = mentionSearchRequestRef.current + 1;
            mentionSearchRequestRef.current = requestId;
            const entries = await onSearchProjectEntries(mentionMatch.query);
            if (mentionSearchRequestRef.current !== requestId) {
                return;
            }

            const nextMatch = getInlineTriggerMatch(root, /(^|\s)@([^\s@]*)$/);
            if (!nextMatch || nextMatch.query !== mentionMatch.query) {
                return;
            }

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

        mentionSearchRequestRef.current += 1;

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
                case "git_commit_mention":
                    node = createGitCommitMentionNode(part, metrics);
                    break;
                case "github_issue_mention":
                    node = createGitHubIssueMentionNode(part, metrics);
                    break;
                case "github_pull_request_mention":
                    node = createGitHubPullRequestMentionNode(part, metrics);
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

            const submitAction = getComposerSubmitKeyboardAction({
                key: e.key,
                shiftKey: e.shiftKey,
                metaKey: e.metaKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                canSubmit,
                isSessionBusy,
                requireCmdEnterToSend,
            });

            if (submitAction) {
                e.preventDefault();
                if (submitAction === "submit") {
                    onSubmit();
                } else {
                    onStop();
                }
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
            requireCmdEnterToSend,
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
            if (disabled) {
                return;
            }

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
        [disabled, onPasteImage, syncFromDom],
    );

    const handleContextMenuPaste = useCallback(
        (text: string) => {
            if (disabled) {
                return;
            }

            const root = composerRef.current;
            if (!root) {
                return;
            }

            insertPlainTextAtSelection(root, text);
            syncFromDom();
            void updatePickers();
        },
        [disabled, syncFromDom, updatePickers],
    );

    const { contextMenu, handleContextMenu } =
        useTextContextMenu<HTMLDivElement>({
            containerRef: composerRef,
            editable: !disabled,
            getFallbackCopyText: () =>
                composerPartsToPlainText(partsRef.current),
            onContentChanged: () => {
                syncFromDom();
                void updatePickers();
            },
            onPasteText: handleContextMenuPaste,
        });

    /* ─ Drag & drop ─ */
    const handleDrop = useCallback(
        (e: React.DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            dragOverCounter.current = 0;
            setIsFileDragOver(false);

            if (disabled) {
                return;
            }

            const composerEntryListData = parseComposerProjectEntryListDragData(
                e.dataTransfer.getData(COMPOSER_PROJECT_ENTRY_LIST_MIME),
            );
            if (composerEntryListData) {
                onChange(
                    appendComposerProjectEntries(parts, composerEntryListData.entries),
                );
                return;
            }

            const composerEntryData = parseComposerProjectEntryDragData(
                e.dataTransfer.getData(COMPOSER_PROJECT_ENTRY_MIME),
            );

            if (composerEntryData) {
                onChange(appendComposerProjectEntries(parts, [composerEntryData]));
                return;
            }

            if (e.dataTransfer.files.length > 0) {
                const externalItems = getExternalComposerDropItems(
                    e.dataTransfer,
                );
                let nextParts: AIComposerPart[] = [...parts];
                let partsChanged = false;

                for (const item of externalItems) {
                    if (
                        item.kind === "file_attachment" &&
                        item.mimeType.startsWith("image/")
                    ) {
                        continue;
                    }

                    nextParts =
                        item.kind === "folder_mention"
                            ? appendFolderMentionPart(
                                  nextParts,
                                  item.folderPath,
                                  item.label,
                              )
                            : appendFileAttachmentPart(nextParts, {
                                  filePath: item.filePath,
                                  label: item.label,
                                  mimeType: item.mimeType,
                              });
                    partsChanged = true;
                }

                if (partsChanged) {
                    onChange(nextParts);
                }

                for (const file of e.dataTransfer.files) {
                    if (file.type.startsWith("image/") && onPasteImage) {
                        onPasteImage(file);
                    }
                }
            }
        },
        [disabled, onChange, onPasteImage, parts],
    );

    useEffect(() => {
        const handleWorkspaceTabDrag = (event: Event) => {
            const customEvent =
                event as CustomEvent<WorkspaceTabComposerDragDetail>;
            const detail = customEvent.detail;
            const shell = shellRef.current;
            if (!shell) {
                return;
            }

            const dragItems = getWorkspaceTabComposerDragItems(detail);
            if (detail.phase === "cancel" || dragItems.length === 0) {
                setIsWorkspaceTabDragOver(false);
                return;
            }

            const rect = shell.getBoundingClientRect();
            const isOver =
                detail.x >= rect.left &&
                detail.x <= rect.right &&
                detail.y >= rect.top &&
                detail.y <= rect.bottom;

            if (detail.phase === "start" || detail.phase === "move") {
                setIsWorkspaceTabDragOver(isOver);
                return;
            }

            setIsWorkspaceTabDragOver(false);
            if (detail.phase === "end" && isOver) {
                applyWorkspaceTabComposerDrop(detail);
            }
        };

        window.addEventListener(
            WORKSPACE_TAB_COMPOSER_DRAG_EVENT,
            handleWorkspaceTabDrag,
        );
        return () =>
            window.removeEventListener(
                WORKSPACE_TAB_COMPOSER_DRAG_EVENT,
                handleWorkspaceTabDrag,
            );
    }, [applyWorkspaceTabComposerDrop]);

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
    const shellSizingStyle = getComposerShellSizingStyle(customHeight, {
        expanded,
    });

    return (
        <div
            ref={shellRef}
            data-ai-composer-drop-zone="true"
            className={
                expanded
                    ? "relative flex min-h-0 flex-1 select-none flex-col"
                    : "relative flex select-none flex-col"
            }
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
                boxShadow:
                    isFileDragOver || isWorkspaceTabDragOver
                        ? "0 0 0 2px color-mix(in srgb, var(--color-accent) 20%, transparent)"
                        : "none",
                overflow: "hidden",
                transition: "box-shadow 0.15s ease",
                ...shellSizingStyle,
            }}
        >
            {/* Resize handle */}
            {!expanded ? (
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
            ) : null}

            {onToggleExpanded ? (
                <button
                    aria-label={
                        expanded ? "Collapse composer" : "Expand composer"
                    }
                    aria-pressed={expanded}
                    className="app-no-drag absolute right-2 top-2 flex items-center justify-center rounded active:scale-90"
                    onClick={onToggleExpanded}
                    onMouseDown={(e) => e.preventDefault()}
                    style={{
                        backgroundColor: "transparent",
                        border: "none",
                        color: "var(--color-text-secondary)",
                        cursor: "pointer",
                        height: 24,
                        opacity: 0.55,
                        transition:
                            "background-color 100ms ease, color 100ms ease, opacity 100ms ease, transform 75ms ease",
                        width: 24,
                        zIndex: 6,
                    }}
                    title={expanded ? "Collapse composer" : "Expand composer"}
                    type="button"
                    onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor =
                            "color-mix(in srgb, var(--color-bg-elevated) 70%, transparent)";
                        e.currentTarget.style.color =
                            "var(--color-text-primary)";
                        e.currentTarget.style.opacity = "1";
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "transparent";
                        e.currentTarget.style.color =
                            "var(--color-text-secondary)";
                        e.currentTarget.style.opacity = "0.55";
                    }}
                >
                    {expanded ? (
                        <svg
                            fill="none"
                            height="14"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.8"
                            viewBox="0 0 14 14"
                            width="14"
                        >
                            <path d="M5 1v4H1M9 13V9h4M5 5 1 1M9 9l4 4" />
                        </svg>
                    ) : (
                        <svg
                            fill="none"
                            height="14"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.8"
                            viewBox="0 0 14 14"
                            width="14"
                        >
                            <path d="M9 1h4v4M5 13H1V9M13 1 8 6M1 13l5-5" />
                        </svg>
                    )}
                </button>
            ) : null}

            {/* Pickers */}
            <AIChatMentionPicker
                anchorRef={shellRef}
                items={mentionState.items}
                onClose={() => setMentionState((s) => ({ ...s, open: false }))}
                onHoverIndex={(i) =>
                    setMentionState((s) => ({
                        ...s,
                        selectedIndex: i,
                    }))
                }
                onSelect={handleMentionSelect}
                open={!disabled && mentionState.open}
                selectedIndex={mentionState.selectedIndex}
                x={0}
                y={8}
            />
            <AIChatCommandPicker
                anchorRef={shellRef}
                items={slashState.items}
                onClose={() => setSlashState((s) => ({ ...s, open: false }))}
                onHoverIndex={(i) =>
                    setSlashState((s) => ({
                        ...s,
                        selectedIndex: i,
                    }))
                }
                onSelect={handleCommandSelect}
                open={!disabled && slashState.open}
                selectedIndex={slashState.selectedIndex}
                x={0}
                y={8}
            />

            {/* Attachments bar */}
            {hasAttachments ? (
                <div className="flex max-h-24 flex-wrap items-center gap-1.5 overflow-y-auto pb-1.5 pl-3 pr-11 pt-2">
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
                        className="pointer-events-none absolute left-3.5 top-3 select-none"
                        style={{
                            color: "var(--color-text-secondary)",
                            fontFamily: composerFontFamily,
                            fontSize: composerFontSize,
                            lineHeight: 1.5,
                            opacity: 0.6,
                            right: 42,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        Message {runtimeName} — @ to include context, / for
                        commands
                    </div>
                ) : null}
                {shouldShowDisabledReason ? (
                    <div
                        className="pointer-events-none absolute left-3.5 top-3 select-none"
                        style={{
                            color: "var(--color-text-secondary)",
                            fontFamily: composerFontFamily,
                            fontSize: composerFontSize,
                            lineHeight: 1.5,
                            opacity: 0.75,
                            overflow: "hidden",
                            right: 42,
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {disabledReason}
                    </div>
                ) : null}
                <div
                    autoCapitalize="off"
                    autoCorrect="off"
                    ref={composerRef}
                    className="app-no-drag h-full w-full select-text outline-none"
                    contentEditable={!disabled}
                    onInput={handleInput}
                    onContextMenu={handleContextMenu}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    role="textbox"
                    spellCheck={false}
                    style={{
                        color: shouldShowDisabledReason
                            ? "transparent"
                            : "var(--color-text-primary)",
                        fontFamily: composerFontFamily,
                        fontSize: composerFontSize,
                        lineHeight: 1.5,
                        ...getComposerInputSizingStyle(),
                        overflowY: "auto",
                        padding: "10px 42px 10px 14px",
                        userSelect: "text",
                        whiteSpace: "pre-wrap",
                    }}
                    suppressContentEditableWarning
                />
                {contextMenu}
            </div>

            {/* Bottom toolbar */}
            <div className="mt-auto flex items-center justify-between gap-2 px-2 pb-1.5">
                <div className="min-w-0 flex-1">
                    {agentControls ? agentControls : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <button
                        aria-label={submitLabel}
                        className={[
                            "app-no-drag flex shrink-0 items-center justify-center rounded-full",
                            canSubmit ? "active:scale-90" : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        onClick={() => {
                            if (canSubmit) onSubmit();
                        }}
                        onMouseEnter={(e) => {
                            if (canSubmit) {
                                e.currentTarget.style.filter =
                                    "brightness(1.15)";
                            }
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.filter = "brightness(1)";
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
                            filter: "brightness(1)",
                            height: 28,
                            opacity: canSubmit ? 1 : 0.4,
                            transition:
                                "background-color 100ms ease, filter 100ms ease, opacity 100ms ease, transform 75ms ease",
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
                            className="app-no-drag flex shrink-0 items-center justify-center rounded-full active:scale-90"
                            onClick={onStop}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.filter =
                                    "brightness(1.2)";
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.filter = "brightness(1)";
                            }}
                            style={{
                                backgroundColor: "#b91c1c",
                                border: "none",
                                borderRadius: "50%",
                                color: "#fff",
                                cursor: "pointer",
                                filter: "brightness(1)",
                                height: 28,
                                transition:
                                    "filter 100ms ease, transform 75ms ease",
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

            {bottomAccent}
        </div>
    );
}
