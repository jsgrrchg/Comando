import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
    createSettingsSearchQuery,
    SettingsWindow,
    TerminalContent,
} from "./SettingsWindow";
import type { SettingsTerminalState, SettingsWindowProps } from "./settings-types";

function createTerminalState(
    overrides: Partial<SettingsTerminalState> = {},
): SettingsTerminalState {
    return {
        claudeCodeAvailable: null,
        claudeCodeContinueSession: false,
        claudeCodeMaxTurns: 0,
        claudeCodeModel: "",
        claudeCodeOptimized: false,
        claudeCodeSkipPermissions: false,
        terminalFontFamily: "",
        terminalFontSize: 13,
        ...overrides,
    };
}

function createSettingsWindowProps(
    overrides: Partial<SettingsWindowProps> = {},
): SettingsWindowProps {
    return {
        aiChat: {
            chatFontFamilies: [],
            chatFontFamily: "geist",
            chatFontSize: 14,
            composerFontFamilies: [],
            composerFontFamily: "geist",
            composerFontSize: 14,
            contextUsageBarEnabled: true,
            historyRetentionDays: 0,
            requireCmdEnterToSend: false,
            screenshotRetentionSeconds: 0,
            toolCardExpansionMode: "collapsed",
        },
        aiProviders: {
            runtimeStatuses: {},
        },
        appAppearance: {
            boostCodeContrast: false,
            mode: "system",
            presetId: "default",
            presets: [],
            stickyFoldersEnabled: true,
        },
        appEditor: {
            autoSaveDelayMs: 900,
            fontFamilies: [],
            fontFamilyId: "ibm-plex-mono",
            fontSize: 14,
            lineHeight: 1.55,
            minimapEnabled: true,
            suggestionsEnabled: true,
        },
        github: {
            error: null,
            loading: false,
            notice: null,
            saving: false,
            status: {
                canReadActions: false,
                canWriteActions: false,
                canWriteIssues: false,
                canWritePullRequests: false,
                checkedAt: "2026-06-01T00:00:00.000Z",
                errorCode: "missing_auth",
                host: "github.com",
                readOnly: true,
                state: "missing",
                tokenSource: null,
                user: null,
            },
            tokenDraft: "",
        },
        privacy: {
            state: {
                canOpenFullDiskAccessSettings: false,
                lastDeniedPath: null,
                lastUpdatedAt: null,
                message: "Not applicable.",
                status: "not-applicable",
            },
        },
        projects: {
            error: null,
            loading: false,
            projects: [],
        },
        terminal: createTerminalState(),
        updates: {
            changelog: [],
            state: {
                autoUpdatesEnabled: false,
                availableVersion: null,
                canCheckForUpdates: false,
                canInstallUpdate: false,
                currentVersion: "0.1.0",
                downloadedVersion: null,
                lastCheckedAt: null,
                message: "Updates unavailable.",
                progressPercent: null,
                status: "unsupported",
            },
        },
        ...overrides,
    };
}

function renderTerminal(
    state: SettingsTerminalState,
    search = "",
): string {
    return renderToStaticMarkup(
        <TerminalContent
            searchQuery={createSettingsSearchQuery(search)}
            state={state}
        />,
    );
}

describe("SettingsWindow terminal settings", () => {
    it("renders the Terminal category in the settings sidebar", () => {
        const markup = renderToStaticMarkup(
            <SettingsWindow {...createSettingsWindowProps()} />,
        );

        expect(markup).toContain("Terminal");
    });

    it("renders terminal controls and the Claude Code CLI notice", () => {
        const markup = renderTerminal(
            createTerminalState({ claudeCodeAvailable: false }),
        );

        expect(markup).toContain("Font family");
        expect(markup).toContain("Font size");
        expect(markup).toContain("Fullscreen rendering (experimental)");
        expect(markup).toContain("CLAUDE_CODE_NO_FLICKER=1");
        expect(markup).toContain("disables scrollback");
        expect(markup).toContain("Claude Code CLI");
        expect(markup).toContain("Install the claude command to use the launcher.");
        expect(markup).toContain("Skip permissions");
        expect(markup).toContain("--dangerously-skip-permissions");
        expect(markup).toContain("will not ask for approval");
        expect(markup).toContain("Default (Claude Code decides)");
        expect(markup).toContain("Continue last session");
        expect(markup).toContain("Max turns");
    });

    it("renders the selected Claude Code model label", () => {
        const markup = renderTerminal(
            createTerminalState({ claudeCodeModel: "claude-opus-4-7" }),
        );

        expect(markup).toContain("Opus 4.7 - most capable");
    });

    it("filters terminal rows by search terms", () => {
        const flickerMarkup = renderTerminal(
            createTerminalState(),
            "CLAUDE_CODE_NO_FLICKER",
        );
        expect(flickerMarkup).toContain("Fullscreen rendering");
        expect(flickerMarkup).not.toContain("Skip permissions");

        const permissionsMarkup = renderTerminal(
            createTerminalState(),
            "dangerously-skip-permissions",
        );
        expect(permissionsMarkup).toContain("Skip permissions");
        expect(permissionsMarkup).not.toContain("Font family");

        const turnsMarkup = renderTerminal(createTerminalState(), "Max turns");
        expect(turnsMarkup).toContain("Max turns");
        expect(turnsMarkup).toContain("--max-turns");
        expect(turnsMarkup).not.toContain("Font family");
    });
});
