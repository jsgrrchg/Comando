import {
    memo,
    useCallback,
    useMemo,
    useRef,
    useState,
    type MouseEvent,
    type ReactElement,
} from "react";

import { extractFenceLanguageToken } from "../../app/editor/codeLanguage";
import { openExternalUrl } from "../../app/utils/external-url";
import {
    parseMarkdownListItem,
    type MarkdownListItem,
} from "../../app/editor/markdownLists";
import { HighlightedCodeText } from "../../app/editor/staticCodeHighlight";
import { useMarkdownCodeLanguageSupport } from "../../app/editor/useCodeLanguageSupport";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../context-menu/ContextMenu";
import { useTextContextMenu } from "../context-menu/useTextContextMenu";
import { DiffLineView } from "./review/DiffLineView";
import {
    DIFF_PANEL_MAX_HEIGHT,
    computeUnifiedDiffLines,
} from "./review/reviewDiff";
import {
    getChatCodeBlockFontSize,
    getChatCodeLabelFontSize,
} from "./chat/chatCodeSizing";
import { ChatInlinePill } from "./chat/ChatInlinePill";
import { getChatPillMetrics } from "./chat/chatPillMetrics";
import { type ChatPillVariant } from "./chat/chatPillPalette";
import {
    type ResolvedProjectFileReference,
} from "./projectFileReferences";

interface MarkdownContentProps {
    readonly canRenderRawFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly content: string;
    readonly chatFontSize?: number;
    readonly chatFontFamily?: string;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenFile?: (reference: ResolvedProjectFileReference) => void;
    readonly onRevealFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}

interface Block {
    readonly content: string;
    readonly info: string;
    readonly type: "code" | "text";
}

interface MarkdownFenceOpening {
    readonly char: "`" | "~";
    readonly info: string;
    readonly length: number;
}

interface TextRange {
    readonly from: number;
    readonly to: number;
}

/* ─── Table parsing ─── */

interface ParsedTable {
    readonly headers: string[];
    readonly rows: string[][];
}

function tryParseTable(lines: string[]): ParsedTable | null {
    if (lines.length < 2) return null;
    const headerLine = lines[0];
    const separatorLine = lines[1];
    if (!headerLine || !separatorLine) return null;

    if (!headerLine.includes("|") || !/^\|?[\s-:|]+\|?$/.test(separatorLine)) {
        return null;
    }

    const parseRow = (line: string) =>
        line
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((cell) => cell.trim());

    const headers = parseRow(headerLine);
    const rows: string[][] = [];

    for (let i = 2; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.includes("|")) break;
        rows.push(parseRow(line));
    }

    if (rows.length === 0) return null;
    return { headers, rows };
}

/* ─── Block parsing ─── */

const PARSED_BLOCK_CACHE_LIMIT = 250;
const parsedBlockCache = new Map<string, Block[]>();

function rememberParsedBlocks(text: string, blocks: Block[]): Block[] {
    if (parsedBlockCache.has(text)) {
        parsedBlockCache.delete(text);
    }
    parsedBlockCache.set(text, blocks);
    if (parsedBlockCache.size > PARSED_BLOCK_CACHE_LIMIT) {
        const oldestKey = parsedBlockCache.keys().next().value;
        if (oldestKey !== undefined) {
            parsedBlockCache.delete(oldestKey);
        }
    }
    return blocks;
}

function parseBlocks(text: string): Block[] {
    const cached = parsedBlockCache.get(text);
    if (cached) return cached;
    const blocks: Block[] = [];
    let cursor = 0;
    let lastIndex = 0;

    while (cursor < text.length) {
        const lineEnd = text.indexOf("\n", cursor);
        const lineTo = lineEnd === -1 ? text.length : lineEnd;
        const lineText = text.slice(cursor, lineTo);
        const opening = parseMarkdownFenceOpening(lineText);

        if (!opening) {
            cursor = lineEnd === -1 ? text.length : lineEnd + 1;
            continue;
        }

        const before = text.slice(lastIndex, cursor);
        if (before) blocks.push({ content: before, info: "", type: "text" });

        const contentStart = lineEnd === -1 ? lineTo : lineEnd + 1;
        const closing = findMarkdownFenceClosing(text, contentStart, opening);
        const contentEnd = closing?.from ?? text.length;
        const content = text.slice(contentStart, contentEnd).replace(/\n$/, "");

        blocks.push({
            content,
            info: opening.info.toLowerCase(),
            type: "code",
        });
        lastIndex = closing?.to ?? text.length;
        cursor = lastIndex;
    }

    const tail = text.slice(lastIndex);
    if (tail) {
        blocks.push({ content: tail, info: "", type: "text" });
    }

    return rememberParsedBlocks(text, blocks);
}

function parseMarkdownFenceOpening(lineText: string): MarkdownFenceOpening | null {
    const match = lineText.match(/^(?: {0,3})(`{3,}|~{3,})(.*)$/);
    if (!match) {
        return null;
    }

    const marker = match[1] ?? "";
    const info = (match[2] ?? "").trim();
    const char = marker[0];
    if (char !== "`" && char !== "~") {
        return null;
    }
    if (char === "`" && info.includes("`")) {
        return null;
    }

    return {
        char,
        info,
        length: marker.length,
    };
}

function findMarkdownFenceClosing(
    text: string,
    startOffset: number,
    opening: MarkdownFenceOpening,
): TextRange | null {
    let cursor = startOffset;

    while (cursor < text.length) {
        const lineEnd = text.indexOf("\n", cursor);
        const lineTo = lineEnd === -1 ? text.length : lineEnd;
        const lineText = text.slice(cursor, lineTo);

        if (isMarkdownFenceClosingLine(lineText, opening)) {
            return {
                from: cursor,
                to: lineEnd === -1 ? lineTo : lineEnd + 1,
            };
        }

        if (lineEnd === -1) {
            break;
        }
        cursor = lineEnd + 1;
    }

    return null;
}

function isMarkdownFenceClosingLine(
    lineText: string,
    opening: MarkdownFenceOpening,
): boolean {
    let cursor = 0;
    while (cursor < lineText.length && lineText[cursor] === " " && cursor < 3) {
        cursor += 1;
    }

    let markerLength = 0;
    while (lineText[cursor + markerLength] === opening.char) {
        markerLength += 1;
    }
    if (markerLength < opening.length) {
        return false;
    }

    return lineText.slice(cursor + markerLength).trim().length === 0;
}

/* ─── Inline rendering ─── */

interface InlineOptions {
    readonly canRenderRawFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onFileContextMenu?: (
        event: MouseEvent<HTMLElement>,
        payload: FileReferencePillContextMenuPayload,
    ) => void;
    readonly metrics?: ReturnType<typeof getChatPillMetrics>;
    readonly onOpenFile?: (reference: ResolvedProjectFileReference) => void;
    readonly onRevealFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}

interface FileReferencePillContextMenuPayload {
    readonly rawReference: string;
    readonly resolvedReference: ResolvedProjectFileReference;
}

type FileReferencePillSource = "inline_code" | "markdown_link" | "raw_text";

interface ParsedInlineMarkdownLink {
    readonly altText?: string;
    readonly endIndex: number;
    readonly image: boolean;
    readonly label: string;
    readonly target: string;
}

interface ParsedList {
    readonly element: ReactElement;
    readonly nextIndex: number;
}

type MarkdownLineBlockKind =
    | "blank"
    | "blockquote"
    | "fence"
    | "heading"
    | "horizontal_rule"
    | "paragraph"
    | "table";

function getPillVariant(label: string): ChatPillVariant {
    if (label === "@fetch") return "success";
    if (label === "/plan") return "neutral";
    if (label.startsWith("commit:")) return "commit";
    if (label.startsWith("symbol:")) return "neutral";
    if (label.startsWith("@")) {
        return /\.\w+$/.test(label.slice(1)) ? "file" : "folder";
    }
    if (label.startsWith("\u{1F4CE}")) return "file";
    return "accent";
}

function getSerializedPillDisplayLabel(label: string): string {
    if (label.startsWith("symbol:")) {
        return label.slice("symbol:".length).trim() || label;
    }

    return label;
}

const EXPLICIT_RELATIVE_PATH_RE = /^\.{1,2}[\\/]/;
const FILE_URL_RE = /^file:\/\//i;
const RAW_TEXT_FILE_REFERENCE_RE =
    /file:\/\/[^\s<>"'`()[\]{}]+|(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|[A-Za-z0-9_@.-]+[\\/])[^\s<>"'`()[\]{}]+/gi;
const RAW_GIT_COMMIT_REFERENCE_RE =
    /\b(?:commit|revision|sha)\s*:?\s*([0-9a-f]{7,40})\b/gi;
const KNOWN_EXTENSIONLESS_FILE_NAMES = new Set([
    "Brewfile",
    "CMakeLists",
    "Dockerfile",
    "Gemfile",
    "Guardfile",
    "Justfile",
    "Makefile",
    "Podfile",
    "Procfile",
    "Rakefile",
]);

function getFileReferenceTraits(
    rawReference: string,
    resolvedReference: ResolvedProjectFileReference,
): {
    readonly hasFileExtension: boolean;
    readonly hasKnownExtensionlessFileName: boolean;
    readonly hasLineReference: boolean;
    readonly isExplicitRelativePath: boolean;
    readonly isFileUrl: boolean;
} {
    const trimmedReference = rawReference.trim();
    const fileName = resolvedReference.relativePath.split("/").pop() ?? "";
    const hasFileExtension = /\.[^/.]+$/.test(fileName);
    const hasKnownExtensionlessFileName =
        KNOWN_EXTENSIONLESS_FILE_NAMES.has(fileName);
    const hasLineReference =
        resolvedReference.startLine !== null ||
        resolvedReference.endLine !== null;

    return {
        hasFileExtension,
        hasKnownExtensionlessFileName,
        hasLineReference,
        isExplicitRelativePath: EXPLICIT_RELATIVE_PATH_RE.test(trimmedReference),
        isFileUrl: FILE_URL_RE.test(trimmedReference),
    };
}

function isStructurallyRenderableFileReference(
    rawReference: string,
    resolvedReference: ResolvedProjectFileReference,
    source: FileReferencePillSource,
): boolean {
    const trimmedReference = rawReference.trim();
    const {
        hasFileExtension,
        hasKnownExtensionlessFileName,
        hasLineReference,
        isExplicitRelativePath,
        isFileUrl,
    } = getFileReferenceTraits(rawReference, resolvedReference);

    if (/^https?:\/\//i.test(trimmedReference)) {
        return false;
    }

    if (isFileUrl) {
        return true;
    }

    if (resolvedReference.isAbsolute) {
        return (
            resolvedReference.relativePath.includes("/") ||
            hasFileExtension ||
            hasKnownExtensionlessFileName ||
            hasLineReference
        );
    }

    if (isExplicitRelativePath) {
        return (
            hasFileExtension ||
            hasKnownExtensionlessFileName ||
            source !== "raw_text"
        );
    }

    if (hasLineReference || hasKnownExtensionlessFileName) {
        return true;
    }

    return hasFileExtension;
}

function canRenderResolvedFileReferencePill(
    rawReference: string,
    resolvedReference: ResolvedProjectFileReference,
    source: FileReferencePillSource,
    options: InlineOptions | undefined,
): boolean {
    if (
        !isStructurallyRenderableFileReference(
            rawReference,
            resolvedReference,
            source,
        )
    ) {
        return false;
    }

    const canRenderRawFileReference = options?.canRenderRawFileReference;
    if (!canRenderRawFileReference) {
        return source !== "raw_text";
    }

    if (source !== "raw_text") {
        return true;
    }

    return canRenderRawFileReference(rawReference, resolvedReference);
}

function splitRawTextFileReferenceCandidate(rawCandidate: string): {
    readonly reference: string;
    readonly trailing: string;
} {
    const reference = rawCandidate.replace(/[.,;!?:]+$/, "");
    return {
        reference,
        trailing: rawCandidate.slice(reference.length),
    };
}

function getFileReferenceName(reference: ResolvedProjectFileReference): string {
    return reference.relativePath.split("/").pop() ?? reference.relativePath;
}

function getRawReferenceLocationSuffix(rawReference: string): string {
    const trimmedReference = rawReference.trim();
    const trailingLineMatch = trimmedReference.match(
        /:(\d+)(?::(\d+))?(?:[.,;!?])?$/,
    );
    if (trailingLineMatch) {
        return trailingLineMatch[2]
            ? `:${trailingLineMatch[1]}:${trailingLineMatch[2]}`
            : `:${trailingLineMatch[1]}`;
    }

    const hashLineMatch = trimmedReference.match(
        /#L?(\d+)(?:-L?(\d+))?(?:[.,;!?])?$/i,
    );
    if (!hashLineMatch) {
        return "";
    }

    return hashLineMatch[2]
        ? `:${hashLineMatch[1]}-${hashLineMatch[2]}`
        : `:${hashLineMatch[1]}`;
}

function getRawFileReferencePillLabel(
    rawReference: string,
    resolvedReference: ResolvedProjectFileReference,
): string {
    return `${getFileReferenceName(resolvedReference)}${getRawReferenceLocationSuffix(rawReference)}`;
}

function getRevealFileReferenceLabel(): string {
    if (typeof navigator === "undefined") {
        return "Reveal in Folder";
    }

    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes("mac")) {
        return "Reveal in Finder";
    }
    if (userAgent.includes("windows")) {
        return "Reveal in Explorer";
    }

    return "Reveal in Folder";
}

async function writeTextToClipboard(text: string): Promise<void> {
    if (window.comando?.writeClipboardText) {
        try {
            await window.comando.writeClipboardText(text);
            return;
        } catch {
            // Fall through to the Web Clipboard API when the native bridge is unavailable.
        }
    }

    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Context menu actions should stay quiet if clipboard access is denied.
        }
    }
}

function renderFileReferencePill({
    key,
    label,
    metrics,
    onFileContextMenu,
    onOpenFile,
    rawReference,
    resolvedReference,
}: {
    readonly key: number;
    readonly label: string;
    readonly metrics: ReturnType<typeof getChatPillMetrics>;
    readonly onFileContextMenu?: InlineOptions["onFileContextMenu"];
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
    readonly rawReference: string;
    readonly resolvedReference: ResolvedProjectFileReference;
}): ReactElement {
    return (
        <ChatInlinePill
            interactive
            key={key}
            label={label}
            metrics={metrics}
            onClick={() => onOpenFile(resolvedReference)}
            onContextMenu={(event) =>
                onFileContextMenu?.(event, {
                    rawReference,
                    resolvedReference,
                })
            }
            title={rawReference}
            variant="file"
        />
    );
}

function renderRawGitCommitReferencePills(
    text: string,
    metrics: ReturnType<typeof getChatPillMetrics>,
    keyStart: number,
): {
    readonly nextKey: number;
    readonly parts: Array<ReactElement | string>;
} {
    const parts: Array<ReactElement | string> = [];
    let cursor = 0;
    let key = keyStart;
    RAW_GIT_COMMIT_REFERENCE_RE.lastIndex = 0;

    for (const match of text.matchAll(RAW_GIT_COMMIT_REFERENCE_RE)) {
        const fullMatch = match[0];
        const sha = match[1];
        const matchIndex = match.index ?? 0;
        if (!sha) {
            continue;
        }

        const shaIndex = matchIndex + fullMatch.lastIndexOf(sha);
        if (shaIndex > cursor) {
            parts.push(text.slice(cursor, shaIndex));
        }
        parts.push(
            <ChatInlinePill
                key={key++}
                label={sha.slice(0, 12)}
                metrics={metrics}
                title={sha}
                variant="commit"
            />,
        );
        cursor = shaIndex + sha.length;
    }

    if (cursor < text.length) {
        parts.push(text.slice(cursor));
    }

    return { nextKey: key, parts };
}

function renderRawTextFileReferencePills(
    text: string,
    options: InlineOptions | undefined,
    keyStart: number,
): {
    readonly nextKey: number;
    readonly parts: Array<ReactElement | string>;
} {
    const metrics = options?.metrics ?? getChatPillMetrics(14);
    const handleOpenFile = options?.onOpenFile;
    const resolveFileReference = options?.resolveFileReference;

    if (!handleOpenFile || !resolveFileReference) {
        return renderRawGitCommitReferencePills(text, metrics, keyStart);
    }

    const parts: Array<ReactElement | string> = [];
    let cursor = 0;
    let key = keyStart;
    RAW_TEXT_FILE_REFERENCE_RE.lastIndex = 0;

    for (const match of text.matchAll(RAW_TEXT_FILE_REFERENCE_RE)) {
        const matchIndex = match.index ?? 0;
        const rawCandidate = match[0];
        const candidateEnd = matchIndex + rawCandidate.length;
        const { reference, trailing } =
            splitRawTextFileReferenceCandidate(rawCandidate);
        if (!reference) {
            continue;
        }

        const resolvedReference = resolveFileReference(reference);
        if (
            !resolvedReference ||
            !canRenderResolvedFileReferencePill(
                reference,
                resolvedReference,
                "raw_text",
                options,
            )
        ) {
            continue;
        }

        if (matchIndex > cursor) {
            const renderedText = renderRawGitCommitReferencePills(
                text.slice(cursor, matchIndex),
                metrics,
                key,
            );
            parts.push(...renderedText.parts);
            key = renderedText.nextKey;
        }
        parts.push(
            renderFileReferencePill({
                key: key++,
                label: getRawFileReferencePillLabel(
                    reference,
                    resolvedReference,
                ),
                metrics,
                onFileContextMenu: options.onFileContextMenu,
                onOpenFile: handleOpenFile,
                rawReference: reference,
                resolvedReference,
            }),
        );
        if (trailing) {
            parts.push(trailing);
        }
        cursor = candidateEnd;
    }

    if (cursor < text.length) {
        const renderedText = renderRawGitCommitReferencePills(
            text.slice(cursor),
            metrics,
            key,
        );
        parts.push(...renderedText.parts);
        key = renderedText.nextKey;
    }

    return { nextKey: key, parts };
}

const INLINE_TOKEN_START_RE =
    /`|\*|\[|!\[|<img\b|https?:\/\/|\u200B\u00AB/gi;
const GENERIC_MARKDOWN_FILE_LINK_LABELS = new Set([
    "click here",
    "file",
    "here",
    "link",
    "source",
    "this",
]);

function findNextInlineTokenIndex(text: string, fromIndex: number): number {
    INLINE_TOKEN_START_RE.lastIndex = fromIndex;
    const match = INLINE_TOKEN_START_RE.exec(text);
    return match?.index ?? -1;
}

function isEscaped(text: string, index: number): boolean {
    let slashCount = 0;
    for (
        let cursor = index - 1;
        cursor >= 0 && text[cursor] === "\\";
        cursor--
    ) {
        slashCount += 1;
    }

    return slashCount % 2 === 1;
}

function findUnescapedChar(
    text: string,
    char: string,
    fromIndex: number,
): number {
    for (let cursor = fromIndex; cursor < text.length; cursor++) {
        if (text[cursor] === char && !isEscaped(text, cursor)) {
            return cursor;
        }
    }

    return -1;
}

function parseInlineMarkdownLinkAt(
    text: string,
    startIndex: number,
): ParsedInlineMarkdownLink | "incomplete" | null {
    const image = text.startsWith("![", startIndex);
    if (!image && text[startIndex] !== "[") {
        return null;
    }

    const labelStart = startIndex + (image ? 2 : 1);
    const labelEnd = findUnescapedChar(text, "]", labelStart);
    if (labelEnd === -1) {
        return "incomplete";
    }

    if (text[labelEnd + 1] !== "(") {
        return null;
    }

    const targetStart = labelEnd + 2;
    const parsedTarget = parseInlineMarkdownLinkTarget(text, targetStart);
    if (parsedTarget === "incomplete") {
        return "incomplete";
    }
    if (!parsedTarget) {
        return null;
    }

    const label = text.slice(labelStart, labelEnd);
    return {
        altText: image ? label : undefined,
        endIndex: parsedTarget.endIndex,
        image,
        label,
        target: parsedTarget.target,
    };
}

function parseInlineMarkdownLinkTarget(
    text: string,
    startIndex: number,
):
    | { readonly endIndex: number; readonly target: string }
    | "incomplete"
    | null {
    if (startIndex >= text.length) {
        return "incomplete";
    }

    if (text[startIndex] === "<") {
        const closingAngleIndex = findUnescapedChar(text, ">", startIndex + 1);
        if (closingAngleIndex === -1) {
            return "incomplete";
        }

        if (text[closingAngleIndex + 1] !== ")") {
            return closingAngleIndex + 1 >= text.length ? "incomplete" : null;
        }

        return {
            endIndex: closingAngleIndex + 2,
            target: text.slice(startIndex, closingAngleIndex + 1),
        };
    }

    let depth = 0;
    let cursor = startIndex;
    while (cursor < text.length) {
        const char = text[cursor];
        if (char === "\\") {
            cursor += 2;
            continue;
        }

        if (char === "(") {
            depth += 1;
            cursor += 1;
            continue;
        }

        if (char === ")") {
            if (depth === 0) {
                return {
                    endIndex: cursor + 1,
                    target: text.slice(startIndex, cursor),
                };
            }

            depth -= 1;
        }

        cursor += 1;
    }

    return "incomplete";
}

function unwrapMarkdownLinkHref(target: string): string {
    const trimmed = target.trim();
    if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
        return trimmed.slice(1, -1).trim();
    }

    return trimmed;
}

function isUsefulMarkdownFileLinkLabel(
    label: string,
    rawTarget: string,
): boolean {
    const normalizedLabel = label.trim().replace(/\s+/g, " ");
    if (!normalizedLabel) {
        return false;
    }

    const normalizedLowerLabel = normalizedLabel.toLowerCase();
    if (GENERIC_MARKDOWN_FILE_LINK_LABELS.has(normalizedLowerLabel)) {
        return false;
    }

    return normalizedLabel !== unwrapMarkdownLinkHref(rawTarget);
}

function getMarkdownFileReferencePillLabel(
    label: string,
    rawTarget: string,
    resolvedReference: ResolvedProjectFileReference,
): string {
    const normalizedLabel = label.trim().replace(/\s+/g, " ");
    if (isUsefulMarkdownFileLinkLabel(normalizedLabel, rawTarget)) {
        return normalizedLabel;
    }

    return getRawFileReferencePillLabel(rawTarget, resolvedReference);
}

function renderPlainInlineText(
    text: string,
    options: InlineOptions | undefined,
    keyStart: number,
): {
    readonly nextKey: number;
    readonly parts: Array<ReactElement | string>;
} {
    return renderRawTextFileReferencePills(text, options, keyStart);
}

function renderInline(
    text: string,
    options?: InlineOptions,
): Array<ReactElement | string> {
    const parts: Array<ReactElement | string> = [];
    let cursor = 0;
    let key = 0;

    while (cursor < text.length) {
        const tokenIndex = findNextInlineTokenIndex(text, cursor);
        if (tokenIndex === -1) {
            const renderedTail = renderPlainInlineText(
                text.slice(cursor),
                options,
                key,
            );
            parts.push(...renderedTail.parts);
            break;
        }

        if (tokenIndex > cursor) {
            const renderedBefore = renderPlainInlineText(
                text.slice(cursor, tokenIndex),
                options,
                key,
            );
            parts.push(...renderedBefore.parts);
            key = renderedBefore.nextKey;
        }

        if (text.startsWith("\u200B\u00AB", tokenIndex)) {
            const pillEndIndex = text.indexOf("\u00BB\u200B", tokenIndex + 2);
            if (pillEndIndex === -1) {
                parts.push(text.slice(tokenIndex));
                break;
            }

            const pillLabel = text.slice(tokenIndex + 2, pillEndIndex);
            const displayLabel = getSerializedPillDisplayLabel(pillLabel);
            const variant = getPillVariant(pillLabel);
            const pillMetrics = options?.metrics ?? getChatPillMetrics(14);
            parts.push(
                <ChatInlinePill
                    key={key++}
                    label={displayLabel}
                    metrics={pillMetrics}
                    title={pillLabel}
                    variant={variant}
                />,
            );
            cursor = pillEndIndex + 2;
            continue;
        }

        if (text[tokenIndex] === "`") {
            const closingIndex = text.indexOf("`", tokenIndex + 1);
            if (closingIndex <= tokenIndex + 1) {
                parts.push(text[tokenIndex]);
                cursor = tokenIndex + 1;
                continue;
            }

            const codeText = text.slice(tokenIndex + 1, closingIndex);
            const resolvedCodeReference =
                options?.resolveFileReference?.(codeText) ?? null;
            const inlineMetrics = options?.metrics;
            const handleOpenFile = options?.onOpenFile;
            if (
                resolvedCodeReference &&
                inlineMetrics &&
                handleOpenFile &&
                canRenderResolvedFileReferencePill(
                    codeText,
                    resolvedCodeReference,
                    "inline_code",
                    options,
                )
            ) {
                parts.push(
                    renderFileReferencePill({
                        key: key++,
                        label: codeText,
                        metrics: inlineMetrics,
                        onFileContextMenu: options.onFileContextMenu,
                        onOpenFile: handleOpenFile,
                        rawReference: codeText,
                        resolvedReference: resolvedCodeReference,
                    }),
                );
            } else {
                parts.push(
                    <code
                        key={key++}
                        style={{
                            backgroundColor: "var(--color-bg-tertiary)",
                            borderRadius: 4,
                            color: "var(--color-accent)",
                            fontSize: "0.85em",
                            padding: "1px 5px",
                        }}
                    >
                        {codeText}
                    </code>,
                );
            }
            cursor = closingIndex + 1;
            continue;
        }

        if (text.startsWith("**", tokenIndex)) {
            const closingIndex = text.indexOf("**", tokenIndex + 2);
            if (closingIndex === -1) {
                parts.push(text[tokenIndex]);
                cursor = tokenIndex + 1;
                continue;
            }

            parts.push(
                <strong
                    key={key++}
                    style={{ color: "var(--color-text-primary)" }}
                >
                    {text.slice(tokenIndex + 2, closingIndex)}
                </strong>,
            );
            cursor = closingIndex + 2;
            continue;
        }

        if (text[tokenIndex] === "*") {
            const closingIndex = text.indexOf("*", tokenIndex + 1);
            if (closingIndex <= tokenIndex + 1) {
                parts.push(text[tokenIndex]);
                cursor = tokenIndex + 1;
                continue;
            }

            parts.push(
                <em key={key++}>{text.slice(tokenIndex + 1, closingIndex)}</em>,
            );
            cursor = closingIndex + 1;
            continue;
        }

        if (text.startsWith("![", tokenIndex) || text[tokenIndex] === "[") {
            const parsedLink = parseInlineMarkdownLinkAt(text, tokenIndex);
            if (parsedLink === "incomplete") {
                parts.push(text.slice(tokenIndex));
                break;
            }

            if (!parsedLink) {
                parts.push(text[tokenIndex]);
                cursor = tokenIndex + 1;
                continue;
            }

            const rawTarget = parsedLink.target.trim();
            const hrefTarget = unwrapMarkdownLinkHref(rawTarget);

            if (parsedLink.image) {
                if (/^(https?:\/\/|data:)/i.test(hrefTarget)) {
                    parts.push(
                        <img
                            alt={parsedLink.altText ?? ""}
                            key={key++}
                            src={hrefTarget}
                            style={{
                                borderRadius: 6,
                                display: "block",
                                height: "auto",
                                margin: "8px 0",
                                maxWidth: "100%",
                            }}
                        />,
                    );
                } else {
                    parts.push(text.slice(tokenIndex, parsedLink.endIndex));
                }
                cursor = parsedLink.endIndex;
                continue;
            }

            const resolvedLinkReference =
                options?.resolveFileReference?.(rawTarget) ?? null;
            const inlineMetrics = options?.metrics;
            const handleOpenFile = options?.onOpenFile;
            if (
                resolvedLinkReference &&
                inlineMetrics &&
                handleOpenFile &&
                canRenderResolvedFileReferencePill(
                    rawTarget,
                    resolvedLinkReference,
                    "markdown_link",
                    options,
                )
            ) {
                parts.push(
                    renderFileReferencePill({
                        key: key++,
                        label: getMarkdownFileReferencePillLabel(
                            parsedLink.label,
                            rawTarget,
                            resolvedLinkReference,
                        ),
                        metrics: inlineMetrics,
                        onFileContextMenu: options.onFileContextMenu,
                        onOpenFile: handleOpenFile,
                        rawReference: rawTarget,
                        resolvedReference: resolvedLinkReference,
                    }),
                );
            } else {
                parts.push(
                    <a
                        key={key++}
                        href={hrefTarget}
                        onClick={(event) => {
                            event.preventDefault();
                            openExternalUrl(hrefTarget);
                        }}
                        rel="noopener noreferrer"
                        style={{ color: "var(--color-accent)" }}
                        target="_blank"
                    >
                        {parsedLink.label}
                    </a>,
                );
            }

            cursor = parsedLink.endIndex;
            continue;
        }

        if (/^<img\b/i.test(text.slice(tokenIndex))) {
            const tagEndIndex = text.indexOf(">", tokenIndex + 4);
            if (tagEndIndex === -1) {
                parts.push(text[tokenIndex]);
                cursor = tokenIndex + 1;
                continue;
            }

            const tag = text.slice(tokenIndex, tagEndIndex + 1);
            const srcMatch = tag.match(/src\s*=\s*["']([^"']+)["']/i);
            const src = srcMatch?.[1] ?? "";
            if (src && /^(https?:\/\/|data:)/i.test(src)) {
                const widthMatch = tag.match(/width\s*=\s*["']?(\d+)["']?/i);
                const heightMatch = tag.match(/height\s*=\s*["']?(\d+)["']?/i);
                const altMatch = tag.match(/alt\s*=\s*["']([^"']*)["']/i);
                const widthValue = widthMatch ? Number(widthMatch[1]) : undefined;
                const heightValue = heightMatch
                    ? Number(heightMatch[1])
                    : undefined;
                parts.push(
                    <img
                        alt={altMatch?.[1] ?? ""}
                        height={heightValue}
                        key={key++}
                        src={src}
                        style={{
                            borderRadius: 6,
                            display: "block",
                            height: "auto",
                            margin: "8px 0",
                            maxWidth: "100%",
                        }}
                        width={widthValue}
                    />,
                );
            } else {
                parts.push(tag);
            }
            cursor = tagEndIndex + 1;
            continue;
        }

        const urlMatch = text
            .slice(tokenIndex)
            .match(/^https?:\/\/[^\s<>"')\]]+/i);
        if (urlMatch) {
            const url = urlMatch[0];
            const trimmedUrl = url.replace(/[.,;:!?]+$/, "");
            const trailing = url.slice(trimmedUrl.length);
            parts.push(
                <a
                    key={key++}
                    href={trimmedUrl}
                    onClick={(event) => {
                        event.preventDefault();
                        openExternalUrl(trimmedUrl);
                    }}
                    rel="noopener noreferrer"
                    style={{ color: "var(--color-accent)" }}
                    target="_blank"
                >
                    {trimmedUrl}
                </a>,
            );
            if (trailing) parts.push(trailing);
            cursor = tokenIndex + url.length;
            continue;
        }

        parts.push(text[tokenIndex]);
        cursor = tokenIndex + 1;
    }

    return parts;
}

function getIndentWidth(indent: string): number {
    let width = 0;

    for (const char of indent) {
        width += char === "\t" ? 4 : 1;
    }

    return width;
}

function getLineIndentWidth(line: string): number {
    let cursor = 0;
    while (cursor < line.length && (line[cursor] === " " || line[cursor] === "\t")) {
        cursor += 1;
    }

    return getIndentWidth(line.slice(0, cursor));
}

function getMarkdownLineBlockKind(
    lines: readonly string[],
    index: number,
): MarkdownLineBlockKind {
    const line = lines[index] ?? "";
    const trimmed = line.trimStart();

    if (trimmed.length === 0) return "blank";
    if (/^(#{1,6})\s+(.+)$/.test(trimmed)) return "heading";
    if (/^---+\s*$/.test(trimmed)) return "horizontal_rule";
    if (/^>\s/.test(trimmed)) return "blockquote";
    if (parseMarkdownFenceOpening(line)) return "fence";
    if (isMarkdownTableStart(lines, index)) return "table";

    return "paragraph";
}

function isMarkdownTableStart(
    lines: readonly string[],
    startIndex: number,
): boolean {
    const tableLines: string[] = [];

    for (let index = startIndex; index < lines.length; index++) {
        const line = lines[index]?.trimStart() ?? "";
        if (!line.includes("|")) break;
        tableLines.push(line);
    }

    return tryParseTable(tableLines) !== null;
}

function shouldBreakListForBlockStart(
    lines: readonly string[],
    index: number,
    baseIndentWidth: number,
): boolean {
    if (getLineIndentWidth(lines[index] ?? "") > baseIndentWidth) {
        return false;
    }

    const blockKind = getMarkdownLineBlockKind(lines, index);
    return (
        blockKind === "blockquote" ||
        blockKind === "fence" ||
        blockKind === "heading" ||
        blockKind === "horizontal_rule" ||
        blockKind === "table"
    );
}

function shouldBreakListForParagraphContinuation(
    line: string,
    baseIndentWidth: number,
    requiresIndentedContinuation: boolean,
): boolean {
    if (!requiresIndentedContinuation) {
        return false;
    }

    return getLineIndentWidth(line) <= baseIndentWidth;
}

function shouldBreakListForOutdent(
    line: string,
    baseIndentWidth: number,
): boolean {
    return getLineIndentWidth(line) < baseIndentWidth;
}

function findNextNonEmptyLineIndex(
    lines: readonly string[],
    startIndex: number,
): number {
    for (let index = startIndex; index < lines.length; index++) {
        if ((lines[index] ?? "").trim().length > 0) {
            return index;
        }
    }

    return -1;
}

function renderParagraphLines(
    lines: readonly string[],
    key: string,
    inlineOptions?: InlineOptions,
): ReactElement {
    return (
        <div
            key={key}
            style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
            }}
        >
            {lines.map((line, index) => (
                <div
                    key={`${key}-${index}`}
                    style={{
                        lineHeight: 1.6,
                        maxWidth: "100%",
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                    }}
                >
                    {renderInline(line, inlineOptions)}
                </div>
            ))}
        </div>
    );
}

function buildListItemLeadLine(item: MarkdownListItem): string {
    if (!item.isTask) {
        return item.content;
    }

    return `[${item.taskMarker ?? " "}] ${item.content}`;
}

function parseList(
    lines: readonly string[],
    startIndex: number,
    inlineOptions?: InlineOptions,
): ParsedList | null {
    const firstItem = parseMarkdownListItem(lines[startIndex] ?? "");
    if (!firstItem) {
        return null;
    }

    const ordered = firstItem.orderedNumber !== null;
    const baseIndentWidth = getIndentWidth(firstItem.indent);
    const startNumber =
        ordered && firstItem.orderedNumber !== 1
            ? firstItem.orderedNumber
            : undefined;
    const items: ReactElement[] = [];
    let cursor = startIndex;

    while (cursor < lines.length) {
        const currentItem = parseMarkdownListItem(lines[cursor] ?? "");
        if (!currentItem) {
            break;
        }

        const currentIndentWidth = getIndentWidth(currentItem.indent);
        const currentOrdered = currentItem.orderedNumber !== null;
        if (
            currentIndentWidth !== baseIndentWidth ||
            currentOrdered !== ordered
        ) {
            break;
        }

        const childElements: ReactElement[] = [];
        let paragraphLines = [buildListItemLeadLine(currentItem)];
        let paragraphCount = 0;
        let requiresIndentedContinuation = false;
        cursor += 1;

        const flushParagraph = () => {
            if (paragraphLines.length === 0) {
                return;
            }

            childElements.push(
                renderParagraphLines(
                    paragraphLines,
                    `list-item-${startIndex}-${items.length}-${paragraphCount}`,
                    inlineOptions,
                ),
            );
            paragraphLines = [];
            paragraphCount += 1;
        };

        while (cursor < lines.length) {
            const currentLine = lines[cursor] ?? "";
            const trimmedLine = currentLine.trim();

            if (trimmedLine.length === 0) {
                flushParagraph();
                requiresIndentedContinuation = true;
                const nextNonEmptyIndex = findNextNonEmptyLineIndex(
                    lines,
                    cursor + 1,
                );
                if (nextNonEmptyIndex === -1) {
                    cursor = lines.length;
                    break;
                }

                if (
                    shouldBreakListForOutdent(
                        lines[nextNonEmptyIndex] ?? "",
                        baseIndentWidth,
                    )
                ) {
                    cursor = nextNonEmptyIndex;
                    break;
                }

                if (
                    shouldBreakListForBlockStart(
                        lines,
                        nextNonEmptyIndex,
                        baseIndentWidth,
                    )
                ) {
                    cursor = nextNonEmptyIndex;
                    break;
                }

                const nextItem = parseMarkdownListItem(
                    lines[nextNonEmptyIndex] ?? "",
                );
                if (nextItem) {
                    const nextIndentWidth = getIndentWidth(nextItem.indent);
                    if (nextIndentWidth <= baseIndentWidth) {
                        cursor = nextNonEmptyIndex;
                        break;
                    }
                }

                if (
                    shouldBreakListForParagraphContinuation(
                        lines[nextNonEmptyIndex] ?? "",
                        baseIndentWidth,
                        requiresIndentedContinuation,
                    )
                ) {
                    cursor = nextNonEmptyIndex;
                    break;
                }

                cursor = nextNonEmptyIndex;
                continue;
            }

            if (shouldBreakListForOutdent(currentLine, baseIndentWidth)) {
                break;
            }

            if (shouldBreakListForBlockStart(lines, cursor, baseIndentWidth)) {
                break;
            }

            const nextItem = parseMarkdownListItem(currentLine);
            if (nextItem) {
                const nextIndentWidth = getIndentWidth(nextItem.indent);
                if (nextIndentWidth > baseIndentWidth) {
                    flushParagraph();
                    const nestedList = parseList(lines, cursor, inlineOptions);
                    if (nestedList) {
                        childElements.push(nestedList.element);
                        cursor = nestedList.nextIndex;
                        requiresIndentedContinuation = true;
                        continue;
                    }
                }

                if (nextIndentWidth <= baseIndentWidth) {
                    break;
                }
            }

            if (
                shouldBreakListForParagraphContinuation(
                    currentLine,
                    baseIndentWidth,
                    requiresIndentedContinuation,
                )
            ) {
                break;
            }

            paragraphLines.push(trimmedLine);
            requiresIndentedContinuation = false;
            cursor += 1;
        }

        flushParagraph();
        items.push(
            <li key={`list-item-${startIndex}-${items.length}`}>
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                    }}
                >
                    {childElements}
                </div>
            </li>,
        );
    }

    if (items.length === 0) {
        return null;
    }

    return {
        element: ordered ? (
            <ol
                key={`ol-${startIndex}`}
                start={startNumber}
                style={{
                    listStyleType: "decimal",
                    margin: "4px 0",
                    paddingLeft: "1.25rem",
                }}
            >
                {items}
            </ol>
        ) : (
            <ul
                key={`ul-${startIndex}`}
                style={{
                    listStyleType: "disc",
                    margin: "4px 0",
                    paddingLeft: "1.25rem",
                }}
            >
                {items}
            </ul>
        ),
        nextIndex: cursor,
    };
}

/* ─── Copy button SVG icons ─── */

function CopyIcon() {
    return (
        <svg
            fill="none"
            height="11"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 14 14"
            width="11"
        >
            <rect x="5" y="3" width="6" height="8" rx="1.2" />
            <path d="M3.5 9.5H3A1 1 0 012 8.5v-5A1.5 1.5 0 013.5 2H8" />
        </svg>
    );
}

function CheckIcon() {
    return (
        <svg
            fill="none"
            height="11"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 14 14"
            width="11"
        >
            <path d="M3 7l2.2 2.2L11 3.8" />
        </svg>
    );
}

/* ─── Code block ─── */

function CodeBlock({
    block,
    chatFontSize = 14,
}: {
    readonly block: Block;
    readonly chatFontSize?: number;
}) {
    const [copied, setCopied] = useState(false);
    const languageSupport = useMarkdownCodeLanguageSupport(block.info);
    const languageToken = extractFenceLanguageToken(block.info ?? "");
    const isDiffBlock =
        languageToken?.toLowerCase() === "diff" ||
        languageToken?.toLowerCase() === "patch";
    const diffLines = useMemo(
        () => (isDiffBlock ? computeUnifiedDiffLines(block.content) : []),
        [block.content, isDiffBlock],
    );
    const codeFontSize = getChatCodeBlockFontSize(chatFontSize);
    const languageLabel =
        languageToken?.toLowerCase() === "md"
            ? "Markdown"
            : (languageToken ?? block.info?.trim());

    const handleCopy = useCallback(() => {
        void navigator.clipboard.writeText(block.content).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        });
    }, [block.content]);

    const copyButton = (
        <button
            aria-label="Copy code block"
            onClick={handleCopy}
            onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "1";
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "0.9";
            }}
            title={copied ? "Copied" : "Copy"}
            style={{
                alignItems: "center",
                backgroundColor:
                    "color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)",
                border: "1px solid var(--color-border)",
                borderRadius: 6,
                color: copied
                    ? "var(--color-accent)"
                    : "var(--color-text-secondary)",
                cursor: "pointer",
                display: "inline-flex",
                height: 22,
                justifyContent: "center",
                opacity: 0.9,
                transition: "opacity 100ms ease, background-color 100ms ease",
                width: 22,
            }}
            type="button"
        >
            {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
    );

    return (
        <div
            className="group relative my-2 min-w-0 max-w-full select-none overflow-hidden rounded-lg"
            style={{
                backgroundColor: "var(--color-bg-tertiary)",
                border: "1px solid var(--color-border)",
            }}
        >
            {languageLabel ? (
                <div
                    className="flex items-center justify-between px-3 py-2 pr-9"
                    style={{
                        borderBottom: "1px solid var(--color-border)",
                        color: "var(--color-text-secondary)",
                        fontSize: getChatCodeLabelFontSize(chatFontSize),
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                    }}
                >
                    <span>{languageLabel}</span>
                </div>
            ) : null}
            <div
                className="absolute right-2"
                style={{ top: languageLabel ? 5 : 8 }}
            >
                {copyButton}
            </div>
            <pre
                className="select-text overflow-x-auto p-3"
                style={{
                    color: "var(--color-text-primary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: codeFontSize,
                    lineHeight: 1.6,
                    margin: 0,
                    overflowWrap: "anywhere",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                }}
            >
                {isDiffBlock && diffLines.length > 0 ? (
                    <div
                        data-testid="markdown-diff-block"
                        style={{
                            color: "var(--color-text-primary)",
                            display: "flex",
                            flexDirection: "column",
                            maxHeight: DIFF_PANEL_MAX_HEIGHT,
                            minWidth: 0,
                            overflow: "auto",
                        }}
                    >
                        {diffLines.map((line, index) => (
                            <DiffLineView
                                compactLineNumbers={false}
                                key={`markdown-diff:${index}:${line.oldLineNumber ?? "n"}:${line.newLineNumber ?? "n"}:${line.type}`}
                                line={line}
                                lineWrapping
                            />
                        ))}
                    </div>
                ) : (
                    <code
                        style={{
                            color: "var(--color-text-primary)",
                            whiteSpace: "inherit",
                            overflowWrap: "inherit",
                            wordBreak: "inherit",
                        }}
                    >
                        <HighlightedCodeText
                            text={block.content}
                            language={languageSupport}
                            segmentKeyPrefix={`chat-code:${languageToken ?? "plain"}:${block.content.length}`}
                        />
                    </code>
                )}
            </pre>
        </div>
    );
}

/* ─── Table block ─── */

function TableBlock({ table }: { readonly table: ParsedTable }) {
    return (
        <div className="my-2 max-w-full overflow-x-auto">
            <table
                style={{
                    borderCollapse: "collapse",
                    fontSize: "1em",
                    tableLayout: "fixed",
                    width: "100%",
                }}
            >
                <thead>
                    <tr>
                        {table.headers.map((header, i) => (
                            <th
                                key={i}
                                style={{
                                    background:
                                        "color-mix(in srgb, var(--color-bg-tertiary) 78%, transparent)",
                                    borderBottom:
                                        "1px solid var(--color-border)",
                                    color: "var(--color-text-primary)",
                                    overflowWrap: "anywhere",
                                    padding: "8px 10px",
                                    textAlign: "left",
                                    verticalAlign: "top",
                                    wordBreak: "break-word",
                                }}
                            >
                                {renderInline(header)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {table.rows.map((row, ri) => (
                        <tr key={ri}>
                            {row.map((cell, ci) => (
                                <td
                                    key={ci}
                                    style={{
                                        borderBottom:
                                            ri < table.rows.length - 1
                                                ? "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)"
                                                : undefined,
                                        color: "var(--color-text-secondary)",
                                        overflowWrap: "anywhere",
                                        padding: "8px 10px",
                                        verticalAlign: "top",
                                        wordBreak: "break-word",
                                    }}
                                >
                                    {renderInline(cell)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/* ─── Text block ─── */

function TextBlock({
    block,
    inlineOptions,
}: {
    readonly block: Block;
    readonly inlineOptions?: InlineOptions;
}) {
    const lines = block.content.split("\n");
    const elements: ReactElement[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i] ?? "";
        const trimmed = line.trimStart();

        if (!trimmed) {
            elements.push(<div key={i} style={{ height: 8 }} />);
            i++;
            continue;
        }

        /* ─ Headers ─ */
        const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
            const level = headerMatch[1].length;
            const sizes = [
                "1.4em",
                "1.2em",
                "1.05em",
                "1.05em",
                "0.9em",
                "0.9em",
            ];
            const weights = [600, 600, 600, 500, 500, 500];
            elements.push(
                <div
                    key={i}
                    style={{
                        color: "var(--color-text-primary)",
                        fontSize: sizes[level - 1],
                        fontWeight: weights[level - 1],
                        marginBottom: 4,
                        marginTop: i === 0 ? 0 : 10,
                    }}
                >
                    {renderInline(headerMatch[2], inlineOptions)}
                </div>,
            );
            i++;
            continue;
        }

        /* ─ Horizontal rule ─ */
        if (/^---+\s*$/.test(trimmed)) {
            elements.push(
                <hr
                    key={i}
                    style={{
                        border: "none",
                        borderTop: "1px solid var(--color-border)",
                        margin: "8px 0",
                    }}
                />,
            );
            i++;
            continue;
        }

        /* ─ Blockquote ─ */
        if (/^>\s/.test(trimmed)) {
            const quoteLines: string[] = [];
            while (
                i < lines.length &&
                /^>\s?/.test(lines[i]?.trimStart() ?? "")
            ) {
                quoteLines.push(
                    (lines[i] ?? "").trimStart().replace(/^>\s?/, ""),
                );
                i++;
            }
            elements.push(
                <blockquote
                    key={`bq-${i}`}
                    className="my-1 pl-3 italic"
                    style={{
                        borderLeft: "2px solid var(--color-accent)",
                        color: "var(--color-text-secondary)",
                    }}
                >
                    {quoteLines.map((ql, qi) => (
                        <div key={qi}>{renderInline(ql, inlineOptions)}</div>
                    ))}
                </blockquote>,
            );
            continue;
        }

        /* ─ Table ─ */
        if (trimmed.includes("|")) {
            const tableLines: string[] = [];
            let ti = i;
            while (ti < lines.length) {
                const tl = lines[ti]?.trimStart() ?? "";
                if (!tl.includes("|")) break;
                tableLines.push(tl);
                ti++;
            }
            const parsed = tryParseTable(tableLines);
            if (parsed) {
                elements.push(<TableBlock key={`table-${i}`} table={parsed} />);
                i = ti;
                continue;
            }
        }

        /* ─ Lists ─ */
        if (parseMarkdownListItem(lines[i] ?? "")) {
            const parsedList = parseList(lines, i, inlineOptions);
            if (parsedList) {
                elements.push(parsedList.element);
                i = parsedList.nextIndex;
                continue;
            }
        }

        /* ─ Paragraph ─ */
        elements.push(
            <div
                key={i}
                style={{
                    lineHeight: 1.6,
                    maxWidth: "100%",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                }}
            >
                {renderInline(line, inlineOptions)}
            </div>,
        );
        i++;
    }

    return <>{elements}</>;
}

/* ─── Main component ─── */

export const MarkdownContent = memo(function MarkdownContent({
    canRenderRawFileReference,
    content,
    chatFontFamily,
    chatFontSize = 14,
    onAddFileReferenceToChat,
    onOpenFile,
    onRevealFileReference,
    resolveFileReference,
}: MarkdownContentProps) {
    const blocks = useMemo(() => parseBlocks(content), [content]);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const [fileReferenceContextMenu, setFileReferenceContextMenu] =
        useState<ContextMenuState<FileReferencePillContextMenuPayload> | null>(
            null,
        );
    const { contextMenu: textContextMenu, handleContextMenu } =
        useTextContextMenu<HTMLDivElement>({
            containerRef: contentRef,
            getFallbackCopyText: () => content,
        });
    const closeFileReferenceContextMenu = useCallback(() => {
        setFileReferenceContextMenu(null);
    }, []);
    const handleFileReferenceContextMenu = useCallback(
        (
            event: MouseEvent<HTMLElement>,
            payload: FileReferencePillContextMenuPayload,
        ) => {
            event.preventDefault();
            event.stopPropagation();
            setFileReferenceContextMenu({
                x: event.clientX,
                y: event.clientY,
                payload,
            });
        },
        [],
    );
    const fileReferenceContextMenuEntries = useMemo((): readonly ContextMenuEntry[] => {
        if (!fileReferenceContextMenu || !onOpenFile) {
            return [];
        }

        const { rawReference, resolvedReference } =
            fileReferenceContextMenu.payload;
        const entries: ContextMenuEntry[] = [
            {
                label: "Open",
                action: () => onOpenFile(resolvedReference),
            },
            { type: "separator" },
            {
                label: "Copy Relative Path",
                action: () =>
                    void writeTextToClipboard(resolvedReference.relativePath),
            },
            {
                label: "Copy Absolute Path",
                action: () => void writeTextToClipboard(resolvedReference.path),
                disabled: !resolvedReference.isAbsolute,
            },
            {
                label: "Copy Reference",
                action: () => void writeTextToClipboard(rawReference),
            },
            { type: "separator" },
            {
                label: getRevealFileReferenceLabel(),
                action: () => onRevealFileReference?.(resolvedReference),
                disabled: !onRevealFileReference,
            },
            {
                label: "Add to Chat",
                action: () => onAddFileReferenceToChat?.(resolvedReference),
                disabled: !onAddFileReferenceToChat,
            },
        ];

        return entries;
    }, [
        fileReferenceContextMenu,
        onAddFileReferenceToChat,
        onOpenFile,
        onRevealFileReference,
    ]);

    const inlineOptions: InlineOptions | undefined = useMemo(() => {
        if (!onOpenFile || !resolveFileReference) return undefined;
        return {
            canRenderRawFileReference,
            onAddFileReferenceToChat,
            onFileContextMenu: handleFileReferenceContextMenu,
            metrics: getChatPillMetrics(chatFontSize),
            onOpenFile,
            onRevealFileReference,
            resolveFileReference,
        };
    }, [
        canRenderRawFileReference,
        chatFontSize,
        handleFileReferenceContextMenu,
        onAddFileReferenceToChat,
        onOpenFile,
        onRevealFileReference,
        resolveFileReference,
    ]);

    return (
        <div
            className="chat-assistant-content min-w-0 max-w-full"
            onContextMenu={handleContextMenu}
            ref={contentRef}
            style={{
                fontFamily: chatFontFamily,
                fontSize: chatFontSize,
                overflowWrap: "anywhere",
                wordBreak: "break-word",
            }}
        >
            {blocks.map((block, index) =>
                block.type === "code" ? (
                    <CodeBlock
                        block={block}
                        chatFontSize={chatFontSize}
                        key={index}
                    />
                ) : (
                    <TextBlock
                        block={block}
                        inlineOptions={inlineOptions}
                        key={index}
                    />
                ),
            )}
            {textContextMenu}
            {fileReferenceContextMenu &&
            fileReferenceContextMenuEntries.length > 0 ? (
                <ContextMenu
                    entries={fileReferenceContextMenuEntries}
                    menu={fileReferenceContextMenu}
                    onClose={closeFileReferenceContextMenu}
                />
            ) : null}
        </div>
    );
});
