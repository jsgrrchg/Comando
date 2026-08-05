import { LanguageSupport, type Language } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { useMemo, type ReactNode } from "react";
import { incrementChatPerformanceCounter } from "@renderer/app/debug/chatPerformanceCounters";
import { measureChatPerformance } from "@renderer/app/debug/chatPerformanceProbe";

type HighlightSegment = {
    readonly text: string;
    readonly className: string | null;
};

const FALLBACK_CODE_TOKEN_RE =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b(?:class|const|else|enum|export|for|from|function|if|import|in|let|namespace|new|private|protected|public|return|static|switch|template|throw|try|using|while)\b|\b(?:auto|bool|char|double|float|int|long|short|string|void)\b/g;

const staticTokenHighlighter = tagHighlighter([
    {
        tag: [
            tags.comment,
            tags.lineComment,
            tags.blockComment,
            tags.docComment,
        ],
        class: "cm-static-token-comment",
    },
    {
        tag: [
            tags.keyword,
            tags.controlKeyword,
            tags.operatorKeyword,
            tags.definitionKeyword,
            tags.moduleKeyword,
        ],
        class: "cm-static-token-keyword",
    },
    {
        tag: [tags.name, tags.variableName],
        class: "cm-static-token-variable",
    },
    {
        tag: [
            tags.definition(tags.variableName),
            tags.definition(tags.propertyName),
            tags.definition(tags.tagName),
            tags.definition(tags.attributeName),
            tags.labelName,
        ],
        class: "cm-static-token-definition",
    },
    {
        tag: [
            tags.function(tags.variableName),
            tags.function(tags.propertyName),
            tags.function(tags.className),
            tags.function(tags.labelName),
            tags.standard(tags.variableName),
        ],
        class: "cm-static-token-function",
    },
    {
        tag: [tags.className, tags.typeName, tags.namespace, tags.macroName],
        class: "cm-static-token-type",
    },
    {
        tag: [tags.propertyName],
        class: "cm-static-token-property",
    },
    {
        tag: [tags.tagName],
        class: "cm-static-token-tag",
    },
    {
        tag: [tags.attributeName],
        class: "cm-static-token-attribute",
    },
    {
        tag: [tags.attributeValue],
        class: "cm-static-token-attribute-value",
    },
    {
        tag: [
            tags.string,
            tags.special(tags.string),
            tags.regexp,
            tags.character,
        ],
        class: "cm-static-token-string",
    },
    {
        tag: [tags.number, tags.integer, tags.float],
        class: "cm-static-token-number",
    },
    {
        tag: [tags.bool, tags.atom, tags.null],
        class: "cm-static-token-atom",
    },
    {
        tag: [
            tags.operator,
            tags.derefOperator,
            tags.arithmeticOperator,
            tags.logicOperator,
            tags.bitwiseOperator,
            tags.compareOperator,
            tags.updateOperator,
            tags.definitionOperator,
            tags.typeOperator,
            tags.controlOperator,
        ],
        class: "cm-static-token-operator",
    },
    {
        tag: [
            tags.punctuation,
            tags.separator,
            tags.paren,
            tags.squareBracket,
            tags.brace,
            tags.angleBracket,
        ],
        class: "cm-static-token-punctuation",
    },
    {
        tag: [tags.meta, tags.processingInstruction, tags.documentMeta],
        class: "cm-static-token-meta",
    },
    {
        tag: [tags.escape],
        class: "cm-static-token-escape",
    },
    {
        tag: [tags.invalid],
        class: "cm-static-token-invalid",
    },
]);

function toLanguage(
    language: LanguageSupport | Language | null,
): Language | null {
    if (!language) {
        return null;
    }
    return language instanceof LanguageSupport ? language.language : language;
}

function buildHighlightSegments(
    text: string,
    language: Language | null,
): HighlightSegment[] {
    if (!text) {
        return [];
    }

    if (!language) {
        return [{ text, className: null }];
    }

    return measureChatPerformance(
        "code_highlight_ms",
        { values: { contentChars: text.length } },
        () => buildLanguageHighlightSegments(text, language),
    );
}

function buildLanguageHighlightSegments(
    text: string,
    language: Language,
): HighlightSegment[] {
    incrementChatPerformanceCounter(
        "code_highlight_chars_reparsed",
        text.length,
    );
    const tree = language.parser.parse(text);
    const segments: HighlightSegment[] = [];
    let cursor = 0;

    highlightTree(tree, staticTokenHighlighter, (from, to, classes) => {
        if (from > cursor) {
            segments.push({
                text: text.slice(cursor, from),
                className: null,
            });
        }
        if (to > from) {
            segments.push({
                text: text.slice(from, to),
                className: classes || null,
            });
        }
        cursor = to;
    });

    if (cursor < text.length) {
        segments.push({
            text: text.slice(cursor),
            className: null,
        });
    }

    return segments;
}

function buildFallbackHighlightSegments(text: string): HighlightSegment[] {
    const segments: HighlightSegment[] = [];
    let cursor = 0;

    for (const match of text.matchAll(FALLBACK_CODE_TOKEN_RE)) {
        const token = match[0];
        const from = match.index ?? cursor;
        if (from > cursor) {
            segments.push({ text: text.slice(cursor, from), className: null });
        }

        const className = token.startsWith("//") ||
            token.startsWith("/*") ||
            token.startsWith("#")
            ? "cm-static-token-comment"
            : token.startsWith('"') ||
                token.startsWith("'") ||
                token.startsWith("`")
              ? "cm-static-token-string"
              : /^\d/.test(token)
                ? "cm-static-token-number"
                : /^(?:auto|bool|char|double|float|int|long|short|string|void)$/.test(
                      token,
                  )
                  ? "cm-static-token-type"
                  : "cm-static-token-keyword";
        segments.push({ text: token, className });
        cursor = from + token.length;
    }

    if (cursor < text.length) {
        segments.push({ text: text.slice(cursor), className: null });
    }

    return segments;
}

function renderHighlightSegments(
    segments: readonly HighlightSegment[],
    keyPrefix: string,
): ReactNode {
    return segments.map((segment, index) =>
        segment.className ? (
            <span key={`${keyPrefix}:${index}`} className={segment.className}>
                {segment.text}
            </span>
        ) : (
            <span key={`${keyPrefix}:${index}`}>{segment.text}</span>
        ),
    );
}

export function HighlightedCodeText({
    fallbackHighlighting = false,
    text,
    language,
    segmentKeyPrefix = "cm-static",
}: {
    /** Gives a loading streaming parser an immediate lightweight token pass. */
    readonly fallbackHighlighting?: boolean;
    readonly text: string;
    readonly language: LanguageSupport | Language | null;
    readonly segmentKeyPrefix?: string;
}) {
    const segments = useMemo(
        () =>
            language
                ? buildHighlightSegments(text, toLanguage(language))
                : fallbackHighlighting
                  ? buildFallbackHighlightSegments(text)
                  : [{ className: null, text }],
        [fallbackHighlighting, language, text],
    );

    return (
        <span
            className="cm-static-code"
        >
            {renderHighlightSegments(segments, segmentKeyPrefix)}
        </span>
    );
}
