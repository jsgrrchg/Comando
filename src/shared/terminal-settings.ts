export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 24;
export const TERMINAL_FONT_SIZE_DEFAULT = 13;
export const TERMINAL_FONT_FAMILY_MAX_LENGTH = 160;

export const CLAUDE_CODE_MAX_TURNS_MIN = 0;
export const CLAUDE_CODE_MAX_TURNS_UI_MAX = 200;
export const CLAUDE_CODE_MAX_TURNS_STORAGE_MAX = 1000;

export const ALLOWED_CLAUDE_CODE_MODELS = [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
] as const;

export type ClaudeCodeModel = (typeof ALLOWED_CLAUDE_CODE_MODELS)[number];

export interface ClaudeCodeModelOption {
    readonly value: "" | ClaudeCodeModel;
    readonly label: string;
}

export const CLAUDE_CODE_MODEL_OPTIONS: readonly ClaudeCodeModelOption[] = [
    {
        label: "Default (Claude Code decides)",
        value: "",
    },
    {
        label: "Opus 4.7 - most capable",
        value: "claude-opus-4-7",
    },
    {
        label: "Sonnet 4.6 - balanced",
        value: "claude-sonnet-4-6",
    },
    {
        label: "Haiku 4.5 - fast",
        value: "claude-haiku-4-5",
    },
];

export const WINDOWS_TERMINAL_SHELLS = [
    "default",
    "cmd",
    "powershell",
    "pwsh",
] as const;

export type WindowsTerminalShell = (typeof WINDOWS_TERMINAL_SHELLS)[number];

export interface WindowsTerminalShellOption {
    readonly value: WindowsTerminalShell;
    readonly label: string;
}

export const WINDOWS_TERMINAL_SHELL_OPTIONS: readonly WindowsTerminalShellOption[] =
    [
        {
            label: "Default (Windows decides)",
            value: "default",
        },
        {
            label: "Command Prompt (cmd.exe)",
            value: "cmd",
        },
        {
            label: "Windows PowerShell",
            value: "powershell",
        },
        {
            label: "PowerShell 7 (pwsh)",
            value: "pwsh",
        },
    ];

export interface AppTerminalSettings {
    readonly terminalFontFamily: string;
    readonly terminalFontSize: number;
    readonly windowsShell: WindowsTerminalShell;
    readonly claudeCodeOptimized: boolean;
    readonly claudeCodeSkipPermissions: boolean;
    readonly claudeCodeModel: string;
    readonly claudeCodeContinueSession: boolean;
    readonly claudeCodeMaxTurns: number;
}

export const DEFAULT_APP_TERMINAL_SETTINGS: AppTerminalSettings = {
    claudeCodeContinueSession: false,
    claudeCodeMaxTurns: 0,
    claudeCodeModel: "",
    claudeCodeOptimized: false,
    claudeCodeSkipPermissions: false,
    terminalFontFamily: "",
    terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
    windowsShell: "default",
};

export type AppTerminalSettingsInput = {
    readonly [Key in keyof AppTerminalSettings]?: unknown;
};

function isAllowedClaudeCodeModel(
    value: string,
): value is ClaudeCodeModel {
    return ALLOWED_CLAUDE_CODE_MODELS.includes(value as ClaudeCodeModel);
}

function isWindowsTerminalShell(
    value: string,
): value is WindowsTerminalShell {
    return WINDOWS_TERMINAL_SHELLS.includes(value as WindowsTerminalShell);
}

function normalizeNumber(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

function clampInteger(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeTerminalFontFamily(value: unknown): string {
    if (typeof value !== "string") {
        return "";
    }

    return value
        .replace(/[\r\n]+/g, " ")
        .trim()
        .slice(0, TERMINAL_FONT_FAMILY_MAX_LENGTH);
}

export function normalizeTerminalFontSize(value: unknown): number {
    const normalizedValue = normalizeNumber(value);
    if (normalizedValue === null) {
        return TERMINAL_FONT_SIZE_DEFAULT;
    }

    return clampInteger(
        normalizedValue,
        TERMINAL_FONT_SIZE_MIN,
        TERMINAL_FONT_SIZE_MAX,
    );
}

export function normalizeClaudeCodeModel(value: unknown): string {
    if (typeof value !== "string") {
        return "";
    }

    const trimmed = value.trim();
    return trimmed === "" || isAllowedClaudeCodeModel(trimmed) ? trimmed : "";
}

export function normalizeWindowsTerminalShell(
    value: unknown,
): WindowsTerminalShell {
    if (typeof value !== "string") {
        return DEFAULT_APP_TERMINAL_SETTINGS.windowsShell;
    }

    const trimmed = value.trim();
    return isWindowsTerminalShell(trimmed)
        ? trimmed
        : DEFAULT_APP_TERMINAL_SETTINGS.windowsShell;
}

export function normalizeClaudeCodeMaxTurns(
    value: unknown,
    max = CLAUDE_CODE_MAX_TURNS_STORAGE_MAX,
): number {
    const normalizedValue = normalizeNumber(value);
    if (normalizedValue === null) {
        return DEFAULT_APP_TERMINAL_SETTINGS.claudeCodeMaxTurns;
    }

    return clampInteger(
        normalizedValue,
        CLAUDE_CODE_MAX_TURNS_MIN,
        Math.max(CLAUDE_CODE_MAX_TURNS_MIN, Math.round(max)),
    );
}

export function normalizeAppTerminalSettings(
    value: AppTerminalSettingsInput | null | undefined,
): AppTerminalSettings {
    return {
        claudeCodeContinueSession:
            value?.claudeCodeContinueSession === true,
        claudeCodeMaxTurns: normalizeClaudeCodeMaxTurns(
            value?.claudeCodeMaxTurns,
        ),
        claudeCodeModel: normalizeClaudeCodeModel(value?.claudeCodeModel),
        claudeCodeOptimized: value?.claudeCodeOptimized === true,
        claudeCodeSkipPermissions:
            value?.claudeCodeSkipPermissions === true,
        terminalFontFamily: normalizeTerminalFontFamily(
            value?.terminalFontFamily,
        ),
        terminalFontSize: normalizeTerminalFontSize(value?.terminalFontSize),
        windowsShell: normalizeWindowsTerminalShell(value?.windowsShell),
    };
}
