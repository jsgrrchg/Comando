import type { LanguageSupport } from "@codemirror/language";
import { useMemo } from "react";

import { HighlightedCodeText } from "@renderer/app/editor/staticCodeHighlight";
import { useCodePathLanguageSupport } from "@renderer/app/editor/useCodeLanguageSupport";

import type { DiffLine } from "./reviewDiff";

function getGridTemplateColumns(options: {
    readonly compactLineNumbers: boolean;
    readonly exact: boolean;
    readonly lineWrapping: boolean;
}): string {
    const contentCol = options.lineWrapping ? "minmax(0, 1fr)" : "max-content";

    if (options.exact && !options.compactLineNumbers) {
        return `56px 56px ${contentCol}`;
    }

    if (options.exact && options.compactLineNumbers) {
        return `44px ${contentCol}`;
    }

    return `36px ${contentCol}`;
}

function getDisplayedLineNumber(line: DiffLine): number | "" {
    return line.oldLineNumber ?? line.newLineNumber ?? "";
}

function getLineBackground(type: DiffLine["type"]): string {
    if (type === "add") {
        return "color-mix(in srgb, var(--diff-add) 5%, transparent)";
    }

    if (type === "remove") {
        return "color-mix(in srgb, var(--diff-remove) 5%, transparent)";
    }

    return "transparent";
}

function getLineBorder(type: DiffLine["type"]): string {
    if (type === "add") {
        return "2px solid color-mix(in srgb, var(--diff-add) 45%, transparent)";
    }

    if (type === "remove") {
        return "2px solid color-mix(in srgb, var(--diff-remove) 45%, transparent)";
    }

    return "2px solid transparent";
}

function getTextColor(type: DiffLine["type"]): string {
    if (type === "add") {
        return "var(--diff-add)";
    }

    if (type === "remove") {
        return "var(--diff-remove)";
    }

    return "var(--color-text-secondary)";
}

function getTextStyles(lineWrapping: boolean) {
    return {
        overflowWrap: lineWrapping
            ? ("anywhere" as const)
            : ("normal" as const),
        whiteSpace: lineWrapping ? ("pre-wrap" as const) : ("pre" as const),
        wordBreak: lineWrapping ? ("break-all" as const) : ("normal" as const),
    };
}

export interface DiffLineViewProps {
    readonly line: DiffLine;
    readonly compactLineNumbers?: boolean;
    readonly filePath?: string | null;
    readonly language?: LanguageSupport | null;
    readonly lineWrapping?: boolean;
}

export function DiffLineView({
    line,
    compactLineNumbers = false,
    filePath = null,
    language = null,
    lineWrapping = true,
}: DiffLineViewProps) {
    const pathLanguage = useCodePathLanguageSupport(filePath);
    const resolvedLanguage = language ?? pathLanguage;
    const isExact = line.exact === true;
    const textStyles = getTextStyles(lineWrapping);
    const lineText = useMemo(
        () => (
            <HighlightedCodeText
                text={line.text || " "}
                language={resolvedLanguage}
                segmentKeyPrefix={`diff-line:${line.oldLineNumber ?? "n"}:${line.newLineNumber ?? "n"}:${line.text.length}`}
            />
        ),
        [line.newLineNumber, line.oldLineNumber, line.text, resolvedLanguage],
    );

    if (line.type === "separator") {
        return (
            <div
                data-diff-line="true"
                data-line-exact={String(isExact)}
                data-line-type="separator"
                data-line-wrapping={String(lineWrapping)}
                style={{
                    color: "var(--color-text-secondary)",
                    display: "grid",
                    gridTemplateColumns: getGridTemplateColumns({
                        compactLineNumbers,
                        exact: isExact,
                        lineWrapping,
                    }),
                    opacity: 0.5,
                    padding: "2px 8px",
                }}
            >
                <div />
                {isExact && !compactLineNumbers ? <div /> : null}
                <div style={{ textAlign: "center" }}>{line.text}</div>
            </div>
        );
    }

    if (isExact && !compactLineNumbers) {
        return (
            <div
                data-diff-line="true"
                data-line-exact="true"
                data-line-type={line.type}
                data-line-wrapping={String(lineWrapping)}
                style={{
                    ...textStyles,
                    alignItems: "stretch",
                    backgroundColor: getLineBackground(line.type),
                    borderLeft: getLineBorder(line.type),
                    color: getTextColor(line.type),
                    display: "grid",
                    gridTemplateColumns: getGridTemplateColumns({
                        compactLineNumbers,
                        exact: true,
                        lineWrapping,
                    }),
                }}
            >
                <div
                    style={{
                        borderRight:
                            "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)",
                        color: "var(--color-text-secondary)",
                        opacity: 0.55,
                        padding: "0 8px 0 6px",
                        textAlign: "right",
                        userSelect: "none",
                    }}
                >
                    {line.oldLineNumber ?? ""}
                </div>
                <div
                    style={{
                        borderRight:
                            "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)",
                        color: "var(--color-text-secondary)",
                        opacity: 0.55,
                        padding: "0 8px",
                        textAlign: "right",
                        userSelect: "none",
                    }}
                >
                    {line.newLineNumber ?? ""}
                </div>
                <div style={{ minWidth: 0, padding: "0 12px" }}>{lineText}</div>
            </div>
        );
    }

    return (
        <div
            data-diff-line="true"
            data-line-exact={String(isExact)}
            data-line-type={line.type}
            data-line-wrapping={String(lineWrapping)}
            style={{
                ...textStyles,
                alignItems: "stretch",
                backgroundColor: getLineBackground(line.type),
                borderLeft: getLineBorder(line.type),
                color: getTextColor(line.type),
                display: "grid",
                gridTemplateColumns: getGridTemplateColumns({
                    compactLineNumbers,
                    exact: isExact,
                    lineWrapping,
                }),
            }}
        >
            <div
                style={{
                    borderRight:
                        "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)",
                    color: "var(--color-text-secondary)",
                    fontSize: "0.85em",
                    opacity: 0.55,
                    padding: "0 4px 0 6px",
                    textAlign: "right",
                    userSelect: "none",
                }}
            >
                {getDisplayedLineNumber(line)}
            </div>
            <div
                style={{
                    minWidth: 0,
                    padding: compactLineNumbers ? "0 10px" : "0 8px",
                }}
            >
                {lineText}
            </div>
        </div>
    );
}
