import { describe, expect, it } from "vitest";

import {
    CLAUDE_CODE_MAX_TURNS_STORAGE_MAX,
    CLAUDE_CODE_MAX_TURNS_UI_MAX,
    DEFAULT_APP_TERMINAL_SETTINGS,
    TERMINAL_FONT_FAMILY_MAX_LENGTH,
    TERMINAL_FONT_SIZE_DEFAULT,
    TERMINAL_FONT_SIZE_MAX,
    TERMINAL_FONT_SIZE_MIN,
    normalizeAppTerminalSettings,
    normalizeClaudeCodeMaxTurns,
    normalizeClaudeCodeModel,
    normalizeTerminalFontFamily,
    normalizeTerminalFontSize,
    normalizeWindowsTerminalShell,
} from "./terminal-settings";

describe("normalizeTerminalFontFamily", () => {
    it("returns an empty string for non-string values", () => {
        expect(normalizeTerminalFontFamily(null)).toBe("");
        expect(normalizeTerminalFontFamily(13)).toBe("");
    });

    it("removes line breaks while preserving spaces, quotes, and commas", () => {
        expect(
            normalizeTerminalFontFamily(
                '  "FiraCode Nerd Font", Menlo\r\nmonospace  ',
            ),
        ).toBe('"FiraCode Nerd Font", Menlo monospace');
    });

    it("limits the persisted length", () => {
        expect(normalizeTerminalFontFamily("a".repeat(200))).toHaveLength(
            TERMINAL_FONT_FAMILY_MAX_LENGTH,
        );
    });
});

describe("normalizeTerminalFontSize", () => {
    it("returns the default for corrupt values", () => {
        expect(normalizeTerminalFontSize("")).toBe(TERMINAL_FONT_SIZE_DEFAULT);
        expect(normalizeTerminalFontSize(Number.NaN)).toBe(
            TERMINAL_FONT_SIZE_DEFAULT,
        );
    });

    it("rounds and clamps values to the terminal font range", () => {
        expect(normalizeTerminalFontSize(7)).toBe(TERMINAL_FONT_SIZE_MIN);
        expect(normalizeTerminalFontSize(25)).toBe(TERMINAL_FONT_SIZE_MAX);
        expect(normalizeTerminalFontSize(14.6)).toBe(15);
    });

    it("accepts numeric strings from persisted settings", () => {
        expect(normalizeTerminalFontSize("16")).toBe(16);
    });
});

describe("normalizeClaudeCodeModel", () => {
    it("allows the empty default model", () => {
        expect(normalizeClaudeCodeModel("")).toBe("");
    });

    it("allows only known Claude Code models", () => {
        expect(normalizeClaudeCodeModel("claude-opus-4-7")).toBe(
            "claude-opus-4-7",
        );
        expect(normalizeClaudeCodeModel(" claude-sonnet-4-6 ")).toBe(
            "claude-sonnet-4-6",
        );
    });

    it("returns the default for unknown or unsafe values", () => {
        expect(normalizeClaudeCodeModel("claude-opus-4-7; rm -rf /")).toBe("");
        expect(normalizeClaudeCodeModel("not-a-model")).toBe("");
        expect(normalizeClaudeCodeModel(null)).toBe("");
    });
});

describe("normalizeClaudeCodeMaxTurns", () => {
    it("returns the default for corrupt values", () => {
        expect(normalizeClaudeCodeMaxTurns("")).toBe(0);
        expect(normalizeClaudeCodeMaxTurns(Number.POSITIVE_INFINITY)).toBe(0);
    });

    it("rounds and clamps to the storage range by default", () => {
        expect(normalizeClaudeCodeMaxTurns(-1)).toBe(0);
        expect(normalizeClaudeCodeMaxTurns(42.5)).toBe(43);
        expect(normalizeClaudeCodeMaxTurns(5000)).toBe(
            CLAUDE_CODE_MAX_TURNS_STORAGE_MAX,
        );
    });

    it("supports a lower UI max when requested", () => {
        expect(normalizeClaudeCodeMaxTurns(500, CLAUDE_CODE_MAX_TURNS_UI_MAX))
            .toBe(CLAUDE_CODE_MAX_TURNS_UI_MAX);
    });
});

describe("normalizeWindowsTerminalShell", () => {
    it("allows known Windows shell options", () => {
        expect(normalizeWindowsTerminalShell("default")).toBe("default");
        expect(normalizeWindowsTerminalShell("cmd")).toBe("cmd");
        expect(normalizeWindowsTerminalShell("powershell")).toBe("powershell");
        expect(normalizeWindowsTerminalShell("pwsh")).toBe("pwsh");
    });

    it("returns the default for unknown or unsafe values", () => {
        expect(normalizeWindowsTerminalShell("cmd.exe /c calc")).toBe(
            "default",
        );
        expect(normalizeWindowsTerminalShell("bash")).toBe("default");
        expect(normalizeWindowsTerminalShell(null)).toBe("default");
    });
});

describe("normalizeAppTerminalSettings", () => {
    it("returns defaults when settings are missing", () => {
        expect(normalizeAppTerminalSettings(null)).toEqual(
            DEFAULT_APP_TERMINAL_SETTINGS,
        );
        expect(normalizeAppTerminalSettings(undefined)).toEqual(
            DEFAULT_APP_TERMINAL_SETTINGS,
        );
    });

    it("normalizes a complete settings object", () => {
        expect(
            normalizeAppTerminalSettings({
                claudeCodeContinueSession: true,
                claudeCodeMaxTurns: 3000,
                claudeCodeModel: "claude-haiku-4-5",
                claudeCodeOptimized: true,
                claudeCodeSkipPermissions: true,
                terminalFontFamily: " FiraCode Nerd Font ",
                terminalFontSize: 20,
                windowsShell: "pwsh",
            }),
        ).toEqual({
            claudeCodeContinueSession: true,
            claudeCodeMaxTurns: CLAUDE_CODE_MAX_TURNS_STORAGE_MAX,
            claudeCodeModel: "claude-haiku-4-5",
            claudeCodeOptimized: true,
            claudeCodeSkipPermissions: true,
            terminalFontFamily: "FiraCode Nerd Font",
            terminalFontSize: 20,
            windowsShell: "pwsh",
        });
    });

    it("falls back defensively for unsafe persisted values", () => {
        expect(
            normalizeAppTerminalSettings({
                claudeCodeContinueSession: false,
                claudeCodeMaxTurns: "bad" as unknown as number,
                claudeCodeModel: "`claude-opus-4-7`",
                claudeCodeOptimized: false,
                claudeCodeSkipPermissions: false,
                terminalFontFamily: 12 as unknown as string,
                terminalFontSize: "large" as unknown as number,
                windowsShell: "powershell; rm -rf /",
            }),
        ).toEqual(DEFAULT_APP_TERMINAL_SETTINGS);
    });
});
