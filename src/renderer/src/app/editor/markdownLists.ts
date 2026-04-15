export const MARKDOWN_LIST_ITEM_RE =
    /^([ \t]*)(?:(\d+)([.)])|([-+*]))([ \t]+)(?:\[( |x|X|~|\/)\]([ \t]*))?(.*)$/;

export type MarkdownTaskMarker = " " | "x" | "X" | "~" | "/" | null;

export interface MarkdownListItem {
    readonly content: string;
    readonly indent: string;
    readonly isEmpty: boolean;
    readonly isTask: boolean;
    readonly marker: string;
    readonly orderedDelimiter: ")" | "." | null;
    readonly orderedNumber: number | null;
    readonly prefixLength: number;
    readonly taskMarker: MarkdownTaskMarker;
}

export interface MarkdownListContinuationResult {
    readonly selectionEnd: number;
    readonly selectionOffset: number;
    readonly selectionStart: number;
    readonly text: string;
}

interface TextRange {
    readonly from: number;
    readonly to: number;
}

interface LineRange extends TextRange {
    readonly hasTrailingNewline: boolean;
    readonly text: string;
}

interface OrderedListContext {
    readonly indentWidth: number;
    readonly kind: "ordered" | "unordered";
    nextNumber: number;
}

interface TextReplacement extends TextRange {
    readonly insert: string;
}

export function parseMarkdownListItem(
    lineText: string,
): MarkdownListItem | null {
    const match = lineText.match(MARKDOWN_LIST_ITEM_RE);
    if (!match) {
        return null;
    }

    const [
        fullMatch,
        indent,
        orderedDigits,
        orderedDelimiterRaw,
        bulletMarker,
        ,
        taskMarker,
        ,
        content,
    ] = match;
    const orderedDelimiter =
        orderedDelimiterRaw === "." || orderedDelimiterRaw === ")"
            ? orderedDelimiterRaw
            : null;
    const orderedNumber =
        orderedDigits == null
            ? null
            : Number.parseInt(orderedDigits, 10) || null;
    const marker = orderedDigits
        ? `${orderedDigits}${orderedDelimiter ?? "."}`
        : (bulletMarker ?? "-");

    return {
        content,
        indent,
        isEmpty: content.trim().length === 0,
        isTask: taskMarker !== undefined,
        marker,
        orderedDelimiter,
        orderedNumber,
        prefixLength: fullMatch.length - content.length,
        taskMarker: (taskMarker as MarkdownTaskMarker | undefined) ?? null,
    };
}

export function buildContinuedListPrefix(item: MarkdownListItem): string {
    const marker =
        item.orderedNumber === null
            ? item.marker
            : `${item.orderedNumber + 1}${item.orderedDelimiter ?? "."}`;
    const taskSuffix = item.isTask ? "[ ] " : "";

    return `${item.indent}${marker} ${taskSuffix}`;
}

export function continueMarkdownList(
    text: string,
    cursorOffset: number,
): MarkdownListContinuationResult | null {
    const line = getLineRangeAtOffset(text, cursorOffset);
    const item = parseMarkdownListItem(line.text);
    if (!item) {
        return null;
    }

    if (item.isEmpty) {
        const deletionRange = getEmptyListDeletionRange(line);
        const nextText =
            text.slice(0, deletionRange.from) + text.slice(deletionRange.to);

        return {
            selectionEnd: deletionRange.from,
            selectionOffset: deletionRange.from,
            selectionStart: deletionRange.from,
            text: nextText,
        };
    }

    const contentStart = line.from + item.prefixLength;
    const insertAt = cursorOffset <= contentStart ? line.to : cursorOffset;
    const insert = `\n${buildContinuedListPrefix(item)}`;
    const nextText = text.slice(0, insertAt) + insert + text.slice(insertAt);
    const nextSelectionOffset = insertAt + insert.length;

    return normalizeMarkdownListText(
        nextText,
        nextSelectionOffset,
        nextSelectionOffset,
    );
}

export function normalizeMarkdownListText(
    text: string,
    selectionStart: number,
    selectionEnd: number = selectionStart,
): MarkdownListContinuationResult {
    const contexts: OrderedListContext[] = [];
    const replacements: TextReplacement[] = [];

    for (const line of iterateLineRanges(text)) {
        const item = parseMarkdownListItem(line.text);
        if (!item) {
            continue;
        }

        const indentWidth = getIndentWidth(item.indent);
        while (
            contexts.length > 0 &&
            indentWidth < contexts[contexts.length - 1].indentWidth
        ) {
            contexts.pop();
        }

        const kind = item.orderedNumber === null ? "unordered" : "ordered";
        const top = contexts[contexts.length - 1];
        let expectedNumber: number | null = null;

        if (!top || indentWidth > top.indentWidth) {
            if (kind === "ordered") {
                expectedNumber = top ? 1 : (item.orderedNumber ?? 1);
                contexts.push({
                    indentWidth,
                    kind,
                    nextNumber: expectedNumber + 1,
                });
            } else {
                contexts.push({ indentWidth, kind, nextNumber: 0 });
            }
        } else if (top.kind === kind) {
            if (kind === "ordered") {
                expectedNumber = top.nextNumber;
                top.nextNumber += 1;
            }
        } else {
            contexts.pop();
            if (kind === "ordered") {
                expectedNumber = item.orderedNumber ?? 1;
                contexts.push({
                    indentWidth,
                    kind,
                    nextNumber: expectedNumber + 1,
                });
            } else {
                contexts.push({ indentWidth, kind, nextNumber: 0 });
            }
        }

        const normalizedTaskMarker = normalizeTaskMarker(item.taskMarker);
        const normalizedLine = buildNormalizedLine(
            line.text,
            item,
            expectedNumber,
            normalizedTaskMarker,
        );

        if (normalizedLine === line.text) {
            continue;
        }

        replacements.push({
            from: line.from,
            insert: normalizedLine,
            to: line.to,
        });
    }

    if (replacements.length === 0) {
        return {
            selectionEnd,
            selectionOffset: selectionEnd,
            selectionStart,
            text,
        };
    }

    return {
        selectionEnd: mapOffsetThroughReplacements(selectionEnd, replacements),
        selectionOffset: mapOffsetThroughReplacements(
            selectionEnd,
            replacements,
        ),
        selectionStart: mapOffsetThroughReplacements(
            selectionStart,
            replacements,
        ),
        text: applyReplacements(text, replacements),
    };
}

export function indentMarkdownListItems(
    text: string,
    selectionStart: number,
    selectionEnd: number,
    indentUnitSize: number,
): MarkdownListContinuationResult | null {
    const lines = getSelectedLineRanges(text, selectionStart, selectionEnd);
    if (lines.length === 0) {
        return null;
    }

    const replacements: TextReplacement[] = [];
    for (const line of lines) {
        const item = parseMarkdownListItem(line.text);
        if (!item) {
            return null;
        }

        replacements.push({
            from: line.from,
            insert: " ".repeat(getListIndentStep(item, indentUnitSize)),
            to: line.from,
        });
    }

    const preserveRange = selectionStart !== selectionEnd;
    const rawText = applyReplacements(text, replacements);
    const rawSelectionStart = mapOffsetThroughReplacements(
        preserveRange ? lines[0].from : selectionStart,
        replacements,
    );
    const rawSelectionEnd = mapOffsetThroughReplacements(
        preserveRange ? lines[lines.length - 1].to : selectionEnd,
        replacements,
    );

    return normalizeMarkdownListText(
        rawText,
        rawSelectionStart,
        rawSelectionEnd,
    );
}

export function outdentMarkdownListItems(
    text: string,
    selectionStart: number,
    selectionEnd: number,
    indentUnitSize: number,
): MarkdownListContinuationResult | null {
    const lines = getSelectedLineRanges(text, selectionStart, selectionEnd);
    if (lines.length === 0) {
        return null;
    }

    const replacements: TextReplacement[] = [];
    for (const line of lines) {
        const item = parseMarkdownListItem(line.text);
        if (!item) {
            return null;
        }

        const deleteLength = getOutdentDeleteLength(
            item.indent,
            getListIndentStep(item, indentUnitSize),
        );
        if (deleteLength <= 0) {
            continue;
        }

        replacements.push({
            from: line.from,
            insert: "",
            to: line.from + deleteLength,
        });
    }

    if (replacements.length === 0) {
        return null;
    }

    const preserveRange = selectionStart !== selectionEnd;
    const rawText = applyReplacements(text, replacements);
    const rawSelectionStart = mapOffsetThroughReplacements(
        preserveRange ? lines[0].from : selectionStart,
        replacements,
    );
    const rawSelectionEnd = mapOffsetThroughReplacements(
        preserveRange ? lines[lines.length - 1].to : selectionEnd,
        replacements,
    );

    return normalizeMarkdownListText(
        rawText,
        rawSelectionStart,
        rawSelectionEnd,
    );
}

function buildNormalizedLine(
    originalLine: string,
    item: MarkdownListItem,
    expectedNumber: number | null,
    normalizedTaskMarker: MarkdownTaskMarker,
): string {
    if (item.isTask) {
        const marker =
            item.orderedNumber === null
                ? item.marker
                : `${expectedNumber ?? item.orderedNumber}${item.orderedDelimiter ?? "."}`;

        return `${item.indent}${marker} [${normalizedTaskMarker ?? " "}] ${item.content}`;
    }

    if (
        item.orderedNumber !== null &&
        expectedNumber !== null &&
        expectedNumber !== item.orderedNumber
    ) {
        const markerStart = item.indent.length;
        const markerEnd = markerStart + String(item.orderedNumber).length;
        return (
            originalLine.slice(0, markerStart) +
            String(expectedNumber) +
            originalLine.slice(markerEnd)
        );
    }

    return originalLine;
}

function normalizeTaskMarker(
    taskMarker: MarkdownTaskMarker,
): MarkdownTaskMarker {
    if (taskMarker === "X") {
        return "x";
    }

    return taskMarker;
}

function getLineRangeAtOffset(text: string, offset: number): LineRange {
    const clampedOffset = Math.max(0, Math.min(offset, text.length));
    const start =
        clampedOffset <= 0 ? 0 : text.lastIndexOf("\n", clampedOffset - 1) + 1;
    const newlineIndex = text.indexOf("\n", clampedOffset);
    const end = newlineIndex === -1 ? text.length : newlineIndex;

    return {
        from: start,
        hasTrailingNewline: newlineIndex !== -1,
        text: text.slice(start, end),
        to: end,
    };
}

function getEmptyListDeletionRange(line: LineRange): TextRange {
    if (line.hasTrailingNewline) {
        return {
            from: line.from,
            to: line.to + 1,
        };
    }

    if (line.from === 0) {
        return line;
    }

    return {
        from: line.from - 1,
        to: line.to,
    };
}

function getSelectedLineRanges(
    text: string,
    selectionStart: number,
    selectionEnd: number,
): LineRange[] {
    const clampedStart = Math.max(0, Math.min(selectionStart, text.length));
    const clampedEnd = Math.max(0, Math.min(selectionEnd, text.length));
    let effectiveEnd = Math.max(clampedStart, clampedEnd);

    if (effectiveEnd > clampedStart) {
        const lineAtEnd = getLineRangeAtOffset(text, effectiveEnd);
        if (effectiveEnd === lineAtEnd.from) {
            effectiveEnd = Math.max(clampedStart, effectiveEnd - 1);
        }
    }

    const lines: LineRange[] = [];
    for (const line of iterateLineRanges(text)) {
        if (line.to < clampedStart) {
            continue;
        }
        if (line.from > effectiveEnd) {
            break;
        }
        lines.push(line);
    }

    return lines;
}

function* iterateLineRanges(text: string): Generator<LineRange> {
    let cursor = 0;

    while (cursor <= text.length) {
        const newlineIndex = text.indexOf("\n", cursor);
        const end = newlineIndex === -1 ? text.length : newlineIndex;

        yield {
            from: cursor,
            hasTrailingNewline: newlineIndex !== -1,
            text: text.slice(cursor, end),
            to: end,
        };

        if (newlineIndex === -1) {
            break;
        }

        cursor = newlineIndex + 1;
    }
}

function getIndentWidth(indent: string): number {
    let width = 0;

    for (const char of indent) {
        width += char === "\t" ? 4 : 1;
    }

    return width;
}

function getListIndentStep(
    item: MarkdownListItem,
    indentUnitSize: number,
): number {
    if (item.orderedNumber === null) {
        return indentUnitSize;
    }

    return Math.max(indentUnitSize, item.marker.length + 1);
}

function getOutdentDeleteLength(prefix: string, maxColumns: number): number {
    let consumed = 0;
    let columns = 0;

    while (consumed < prefix.length && columns < maxColumns) {
        const char = prefix[consumed];
        if (char === " ") {
            consumed += 1;
            columns += 1;
            continue;
        }
        if (char === "\t") {
            consumed += 1;
        }
        break;
    }

    return consumed;
}

function applyReplacements(
    text: string,
    replacements: readonly TextReplacement[],
) {
    let nextText = text;
    const descending = [...replacements].sort((a, b) => b.from - a.from);

    for (const replacement of descending) {
        nextText =
            nextText.slice(0, replacement.from) +
            replacement.insert +
            nextText.slice(replacement.to);
    }

    return nextText;
}

function mapOffsetThroughReplacements(
    offset: number,
    replacements: readonly TextReplacement[],
): number {
    let nextOffset = offset;
    const ascending = [...replacements].sort((a, b) => a.from - b.from);

    for (const replacement of ascending) {
        const delta =
            replacement.insert.length - (replacement.to - replacement.from);

        if (replacement.to <= nextOffset) {
            nextOffset += delta;
            continue;
        }

        if (replacement.from < nextOffset) {
            nextOffset = replacement.from + replacement.insert.length;
        }
    }

    return nextOffset;
}
