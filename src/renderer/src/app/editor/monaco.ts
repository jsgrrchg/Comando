import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

export type ComandoMonacoTheme = "comando-light" | "comando-dark";

type MonacoEnvironmentShape = {
    MonacoEnvironment?: {
        getWorker: (_moduleId: string, label: string) => Worker;
    };
    __comandoMonacoConfigured?: boolean;
};

const monacoGlobal = globalThis as typeof globalThis & MonacoEnvironmentShape;
const LIGHT_THEME_NAME: ComandoMonacoTheme = "comando-light";
const DARK_THEME_NAME: ComandoMonacoTheme = "comando-dark";

if (!monacoGlobal.__comandoMonacoConfigured) {
    monacoGlobal.MonacoEnvironment = {
        getWorker: (_moduleId, label) => {
            if (label === "json") {
                return new jsonWorker();
            }

            if (label === "css" || label === "scss" || label === "less") {
                return new cssWorker();
            }

            if (
                label === "html" ||
                label === "handlebars" ||
                label === "razor"
            ) {
                return new htmlWorker();
            }

            if (label === "typescript" || label === "javascript") {
                return new tsWorker();
            }

            return new editorWorker();
        },
    };

    loader.config({ monaco });
    monacoGlobal.__comandoMonacoConfigured = true;
}

function isHexColor(value: string): boolean {
    return /^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(value);
}

function clampColorChannel(value: number): number {
    return Math.min(255, Math.max(0, Math.round(value)));
}

function channelToHex(value: number): string {
    return clampColorChannel(value).toString(16).padStart(2, "0");
}

function normalizeMonacoColor(value: string, fallback: string): string {
    const normalized = value.trim();

    if (!normalized) {
        return fallback;
    }

    if (isHexColor(normalized)) {
        return normalized;
    }

    const match = normalized.match(
        /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(\d*\.?\d+))?\s*\)$/i,
    );
    if (!match) {
        return fallback;
    }

    const [, red, green, blue, alpha] = match;
    const alphaHex =
        alpha === undefined ? "" : channelToHex(Number.parseFloat(alpha) * 255);

    return `#${channelToHex(Number.parseInt(red, 10))}${channelToHex(Number.parseInt(green, 10))}${channelToHex(Number.parseInt(blue, 10))}${alphaHex}`;
}

function withAlpha(hexColor: string, alpha: number): string {
    const normalized = normalizeMonacoColor(hexColor, hexColor);
    const base = normalized.slice(0, 7);
    return `${base}${channelToHex(alpha * 255)}`;
}

function parseHexColor(value: string): {
    readonly blue: number;
    readonly green: number;
    readonly red: number;
} | null {
    const normalized = normalizeMonacoColor(value, "");

    if (!/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(normalized)) {
        return null;
    }

    return {
        blue: Number.parseInt(normalized.slice(5, 7), 16),
        green: Number.parseInt(normalized.slice(3, 5), 16),
        red: Number.parseInt(normalized.slice(1, 3), 16),
    };
}

function mixHexColors(
    base: string,
    overlay: string,
    overlayWeight: number,
): string {
    const baseColor = parseHexColor(base);
    const overlayColor = parseHexColor(overlay);
    const normalizedWeight = Math.min(1, Math.max(0, overlayWeight));

    if (!baseColor || !overlayColor) {
        return normalizeMonacoColor(overlay, base);
    }

    const baseWeight = 1 - normalizedWeight;

    return `#${channelToHex(baseColor.red * baseWeight + overlayColor.red * normalizedWeight)}${channelToHex(baseColor.green * baseWeight + overlayColor.green * normalizedWeight)}${channelToHex(baseColor.blue * baseWeight + overlayColor.blue * normalizedWeight)}`;
}

function themeRuleColor(value: string): string {
    return normalizeMonacoColor(value, value).slice(1, 7);
}

function readThemeColor(
    styles: CSSStyleDeclaration,
    propertyName: string,
    fallback: string,
): string {
    return normalizeMonacoColor(
        styles.getPropertyValue(propertyName),
        fallback,
    );
}

export function getMonacoThemeFromDom(): ComandoMonacoTheme {
    if (typeof document === "undefined") {
        return LIGHT_THEME_NAME;
    }

    return document.documentElement.classList.contains("dark")
        ? DARK_THEME_NAME
        : LIGHT_THEME_NAME;
}

export function applyMonacoThemeFromDom(): ComandoMonacoTheme {
    const themeName = getMonacoThemeFromDom();

    if (typeof document === "undefined") {
        return themeName;
    }

    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const isDark = themeName === DARK_THEME_NAME;
    const editorBackground = readThemeColor(
        styles,
        "--color-editor",
        isDark ? "#1c1c1c" : "#ffffff",
    );
    const editorForeground = readThemeColor(
        styles,
        "--color-editor-text",
        isDark ? "#e8e8e8" : "#1c1c1c",
    );
    const textSecondary = readThemeColor(
        styles,
        "--color-text-secondary",
        isDark ? "#8a8a8a" : "#737373",
    );
    const border = readThemeColor(
        styles,
        "--color-border",
        isDark ? "#383838" : "#e5e5e5",
    );
    const borderSubtle = readThemeColor(
        styles,
        "--color-border-subtle",
        isDark ? "#38383873" : "#e5e5e559",
    );
    const accent = readThemeColor(
        styles,
        "--color-accent",
        isDark ? "#818cf8" : "#6366f1",
    );
    const accentSoft = readThemeColor(
        styles,
        "--color-accent-soft",
        withAlpha(accent, isDark ? 0.16 : 0.12),
    );
    const selection = readThemeColor(
        styles,
        "--color-selection",
        withAlpha(accent, isDark ? 0.2 : 0.12),
    );
    const elevatedBackground = readThemeColor(
        styles,
        "--color-bg-elevated",
        isDark ? "#232323" : "#fcfcfc",
    );
    const secondaryBackground = readThemeColor(
        styles,
        "--color-bg-secondary",
        isDark ? "#252525" : "#f5f5f5",
    );
    const keywordColor = mixHexColors(editorForeground, accent, 0.84);
    const typeColor = mixHexColors(editorForeground, accent, 0.66);
    const functionColor = mixHexColors(editorForeground, accent, 0.58);
    const stringColor = mixHexColors(editorForeground, accent, 0.4);
    const numberColor = mixHexColors(editorForeground, accent, 0.74);
    const constantColor = mixHexColors(editorForeground, accent, 0.7);
    const tagColor = mixHexColors(editorForeground, accent, 0.8);
    const attributeColor = mixHexColors(editorForeground, accent, 0.48);
    const regexpColor = mixHexColors(editorForeground, accent, 0.52);
    const lineHighlight = withAlpha(editorForeground, isDark ? 0.04 : 0.035);
    const scrollbar = withAlpha(editorForeground, isDark ? 0.14 : 0.1);
    const scrollbarHover = withAlpha(editorForeground, isDark ? 0.22 : 0.16);
    const insertedBackground = withAlpha("#10b981", isDark ? 0.18 : 0.12);
    const removedBackground = withAlpha("#ef4444", isDark ? 0.18 : 0.12);

    monaco.editor.defineTheme(themeName, {
        base: isDark ? "vs-dark" : "vs",
        inherit: true,
        rules: [
            {
                token: "comment",
                foreground: themeRuleColor(textSecondary),
                fontStyle: "italic",
            },
            { token: "keyword", foreground: themeRuleColor(keywordColor) },
            { token: "operator", foreground: themeRuleColor(keywordColor) },
            {
                token: "keyword.control",
                foreground: themeRuleColor(keywordColor),
            },
            { token: "string", foreground: themeRuleColor(stringColor) },
            { token: "number", foreground: themeRuleColor(numberColor) },
            {
                token: "constant",
                foreground: themeRuleColor(constantColor),
            },
            { token: "regexp", foreground: themeRuleColor(regexpColor) },
            { token: "type", foreground: themeRuleColor(typeColor) },
            {
                token: "type.identifier",
                foreground: themeRuleColor(typeColor),
            },
            { token: "class", foreground: themeRuleColor(typeColor) },
            { token: "interface", foreground: themeRuleColor(typeColor) },
            {
                token: "entity.name.type",
                foreground: themeRuleColor(typeColor),
            },
            { token: "function", foreground: themeRuleColor(functionColor) },
            {
                token: "function.method",
                foreground: themeRuleColor(functionColor),
            },
            {
                token: "entity.name.function",
                foreground: themeRuleColor(functionColor),
            },
            { token: "tag", foreground: themeRuleColor(tagColor) },
            {
                token: "attribute.name",
                foreground: themeRuleColor(attributeColor),
            },
        ],
        colors: {
            "diffEditor.insertedTextBackground": insertedBackground,
            "diffEditor.removedTextBackground": removedBackground,
            "dropdown.background": elevatedBackground,
            "dropdown.border": border,
            "dropdown.foreground": editorForeground,
            "editor.background": editorBackground,
            "editor.foreground": editorForeground,
            "editorCursor.foreground": accent,
            "editorGutter.background": editorBackground,
            "editorHoverWidget.background": elevatedBackground,
            "editorHoverWidget.border": border,
            "editor.lineHighlightBackground": lineHighlight,
            "editor.lineHighlightBorder": "#00000000",
            "editorIndentGuide.activeBackground1": border,
            "editorIndentGuide.background1": borderSubtle,
            "editorLineNumber.activeForeground": editorForeground,
            "editorLineNumber.foreground": textSecondary,
            "editor.selectionBackground": selection,
            "editor.selectionHighlightBackground": accentSoft,
            "editor.inactiveSelectionBackground": accentSoft,
            "editorWhitespace.foreground": borderSubtle,
            "editorSuggestWidget.background": elevatedBackground,
            "editorSuggestWidget.border": border,
            "editorSuggestWidget.foreground": editorForeground,
            "editorSuggestWidget.selectedBackground": accentSoft,
            "editorWidget.background": elevatedBackground,
            "editorWidget.border": border,
            focusBorder: accent,
            "input.background": secondaryBackground,
            "input.border": border,
            "input.foreground": editorForeground,
            "inputOption.activeBorder": accent,
            "list.activeSelectionBackground": selection,
            "list.activeSelectionForeground": editorForeground,
            "list.hoverBackground": accentSoft,
            "list.inactiveSelectionBackground": accentSoft,
            "list.inactiveSelectionForeground": editorForeground,
            "minimap.background": editorBackground,
            "minimap.selectionHighlight": selection,
            "peekView.border": border,
            "peekViewEditor.background": editorBackground,
            "peekViewResult.background": secondaryBackground,
            "scrollbarSlider.activeBackground": scrollbarHover,
            "scrollbarSlider.background": scrollbar,
            "scrollbarSlider.hoverBackground": scrollbarHover,
        },
    });
    monaco.editor.setTheme(themeName);

    return themeName;
}
