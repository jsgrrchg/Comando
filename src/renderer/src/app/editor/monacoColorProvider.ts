import type * as monaco from "monaco-editor";

import { TEXT_MATE_MAX_DOCUMENT_BYTES } from "./monacoPerformance";

type MonacoNamespace = typeof import("monaco-editor");

export interface ParsedCssColor {
    readonly alpha: number;
    readonly blue: number;
    readonly green: number;
    readonly red: number;
}

export interface CssColorLiteralMatch {
    readonly color: ParsedCssColor;
    readonly endIndex: number;
    readonly startIndex: number;
}

const COLOR_PROVIDER_LANGUAGE_IDS = [
    "css",
    "scss",
    "less",
    "html",
    "typescriptreact",
    "javascriptreact",
    "tsx",
    "jsx",
] as const;

const HEX_COLOR_REGEX =
    /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\da-f])/gi;
const RGB_COLOR_REGEX =
    /\brgba?\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)%?)\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)%?)\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)%?)(?:\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)%?))?\s*\)/gi;
const HSL_COLOR_REGEX =
    /\bhsla?\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:deg)?\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)%)\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)%)(?:\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)%?))?\s*\)/gi;

let didRegisterColorProviders = false;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function parseFloatStrict(value: string): number | null {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseAlpha(value: string | undefined): number {
    if (value === undefined) {
        return 1;
    }

    const parsed = parseFloatStrict(value);
    if (parsed === null) {
        return 1;
    }

    return value.endsWith("%")
        ? clamp(parsed / 100, 0, 1)
        : clamp(parsed, 0, 1);
}

function parseRgbChannel(value: string): number | null {
    const parsed = parseFloatStrict(value);
    if (parsed === null) {
        return null;
    }

    const channel = value.endsWith("%") ? (parsed / 100) * 255 : parsed;
    return clamp(Math.round(channel), 0, 255);
}

function parsePercentage(value: string): number | null {
    const parsed = parseFloatStrict(value);
    return parsed === null ? null : clamp(parsed / 100, 0, 1);
}

function normalizeHue(value: number): number {
    return ((value % 360) + 360) % 360;
}

function hueToRgb(p: number, q: number, hue: number): number {
    let normalizedHue = hue;

    if (normalizedHue < 0) {
        normalizedHue += 1;
    }
    if (normalizedHue > 1) {
        normalizedHue -= 1;
    }

    if (normalizedHue < 1 / 6) {
        return p + (q - p) * 6 * normalizedHue;
    }
    if (normalizedHue < 1 / 2) {
        return q;
    }
    if (normalizedHue < 2 / 3) {
        return p + (q - p) * (2 / 3 - normalizedHue) * 6;
    }

    return p;
}

function hslToRgb(
    hue: number,
    saturation: number,
    lightness: number,
): readonly [number, number, number] {
    if (saturation === 0) {
        const channel = Math.round(lightness * 255);
        return [channel, channel, channel];
    }

    const normalizedHue = normalizeHue(hue) / 360;
    const q =
        lightness < 0.5
            ? lightness * (1 + saturation)
            : lightness + saturation - lightness * saturation;
    const p = 2 * lightness - q;

    return [
        Math.round(hueToRgb(p, q, normalizedHue + 1 / 3) * 255),
        Math.round(hueToRgb(p, q, normalizedHue) * 255),
        Math.round(hueToRgb(p, q, normalizedHue - 1 / 3) * 255),
    ];
}

function parseHexColor(value: string): ParsedCssColor | null {
    const raw = value.slice(1);
    const normalized =
        raw.length === 3 || raw.length === 4
            ? raw
                  .split("")
                  .map((character) => `${character}${character}`)
                  .join("")
            : raw;

    const red = Number.parseInt(normalized.slice(0, 2), 16);
    const green = Number.parseInt(normalized.slice(2, 4), 16);
    const blue = Number.parseInt(normalized.slice(4, 6), 16);
    const alpha =
        normalized.length === 8
            ? Number.parseInt(normalized.slice(6, 8), 16) / 255
            : 1;

    if ([red, green, blue, alpha].some((channel) => !Number.isFinite(channel))) {
        return null;
    }

    return { alpha, blue, green, red };
}

function parseRgbColor(match: RegExpExecArray): ParsedCssColor | null {
    const red = parseRgbChannel(match[1] ?? "");
    const green = parseRgbChannel(match[2] ?? "");
    const blue = parseRgbChannel(match[3] ?? "");

    if (red === null || green === null || blue === null) {
        return null;
    }

    return {
        alpha: parseAlpha(match[4]),
        blue,
        green,
        red,
    };
}

function parseHslColor(match: RegExpExecArray): ParsedCssColor | null {
    const hue = parseFloatStrict(match[1] ?? "");
    const saturation = parsePercentage(match[2] ?? "");
    const lightness = parsePercentage(match[3] ?? "");

    if (hue === null || saturation === null || lightness === null) {
        return null;
    }

    const [red, green, blue] = hslToRgb(hue, saturation, lightness);

    return {
        alpha: parseAlpha(match[4]),
        blue,
        green,
        red,
    };
}

function collectMatches(
    line: string,
    regex: RegExp,
    parseColor: (match: RegExpExecArray) => ParsedCssColor | null,
): CssColorLiteralMatch[] {
    const matches: CssColorLiteralMatch[] = [];

    regex.lastIndex = 0;
    for (let match = regex.exec(line); match; match = regex.exec(line)) {
        const literal = match[0];
        const startIndex = match.index;
        const color = parseColor(match);

        if (!color) {
            continue;
        }

        matches.push({
            color,
            endIndex: startIndex + literal.length,
            startIndex,
        });
    }

    return matches;
}

export function findCssColorLiterals(line: string): CssColorLiteralMatch[] {
    const matches = [
        ...collectMatches(line, HEX_COLOR_REGEX, (match) =>
            parseHexColor(match[0]),
        ),
        ...collectMatches(line, RGB_COLOR_REGEX, parseRgbColor),
        ...collectMatches(line, HSL_COLOR_REGEX, parseHslColor),
    ];
    const seenRanges = new Set<string>();

    return matches
        .sort((left, right) => left.startIndex - right.startIndex)
        .filter((match) => {
            const key = `${match.startIndex}:${match.endIndex}`;
            if (seenRanges.has(key)) {
                return false;
            }

            seenRanges.add(key);
            return true;
        });
}

function normalizeColorChannel(value: number): number {
    return clamp(Math.round(value), 0, 255);
}

function toMonacoColor(color: ParsedCssColor): monaco.languages.IColor {
    return {
        alpha: clamp(color.alpha, 0, 1),
        blue: normalizeColorChannel(color.blue) / 255,
        green: normalizeColorChannel(color.green) / 255,
        red: normalizeColorChannel(color.red) / 255,
    };
}

function channelToHex(value: number): string {
    return normalizeColorChannel(value).toString(16).padStart(2, "0");
}

function colorInfoToHex(color: monaco.languages.IColor): string {
    return `#${channelToHex(color.red * 255)}${channelToHex(
        color.green * 255,
    )}${channelToHex(color.blue * 255)}`;
}

function colorInfoToRgb(color: monaco.languages.IColor): string {
    const red = normalizeColorChannel(color.red * 255);
    const green = normalizeColorChannel(color.green * 255);
    const blue = normalizeColorChannel(color.blue * 255);

    if (color.alpha < 1) {
        return `rgba(${red}, ${green}, ${blue}, ${Number(color.alpha.toFixed(3))})`;
    }

    return `rgb(${red}, ${green}, ${blue})`;
}

function createColorProvider(): monaco.languages.DocumentColorProvider {
    return {
        provideColorPresentations: (_model, colorInfo) => [
            { label: colorInfoToHex(colorInfo.color) },
            { label: colorInfoToRgb(colorInfo.color) },
        ],
        provideDocumentColors: (model, token) => {
            if (model.getValueLength() > TEXT_MATE_MAX_DOCUMENT_BYTES) {
                return [];
            }

            const colors: monaco.languages.IColorInformation[] = [];
            const lineCount = model.getLineCount();

            for (let lineNumber = 1; lineNumber <= lineCount; lineNumber += 1) {
                if (token.isCancellationRequested) {
                    return [];
                }

                const line = model.getLineContent(lineNumber);
                for (const match of findCssColorLiterals(line)) {
                    colors.push({
                        color: toMonacoColor(match.color),
                        range: {
                            endColumn: match.endIndex + 1,
                            endLineNumber: lineNumber,
                            startColumn: match.startIndex + 1,
                            startLineNumber: lineNumber,
                        },
                    });
                }
            }

            return colors;
        },
    };
}

export function configureMonacoColorDecorators(monacoNsps: MonacoNamespace): void {
    if (didRegisterColorProviders) {
        return;
    }

    monacoNsps.languages.registerColorProvider(
        [...COLOR_PROVIDER_LANGUAGE_IDS],
        createColorProvider(),
    );
    didRegisterColorProviders = true;
}
