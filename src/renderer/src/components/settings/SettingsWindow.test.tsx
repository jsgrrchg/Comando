import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
    createSettingsSearchQuery,
    SettingsWindow,
    TerminalContent,
} from "./SettingsWindow";
import { NumberStepper, SelectField, Toggle } from "./primitives";
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
        isWindows: false,
        terminalFontFamily: "",
        terminalFontSize: 13,
        windowsShell: "default",
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
            toolActivityDefaultExpansion: "collapsed",
        },
        aiProviders: {
            runtimeStatuses: {},
        },
        appAppearance: {
            boostCodeContrast: false,
            chatContentWidth: 600,
            chromeTransparency: 45,
            mode: "system",
            presetId: "default",
            presets: [],
            stickyFoldersEnabled: true,
            transparencyEnabled: true,
        },
        appEditor: {
            autoSaveDelayMs: 900,
            fontFamilies: [],
            fontFamilyId: "ibm-plex-mono",
            fontSize: 14,
            lineHeight: 1.55,
            minimapEnabled: true,
            relativeLineNumbersEnabled: false,
            suggestionsEnabled: true,
            vimModeEnabled: false,
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

    it("renders as an embedded main-window view with an explicit return control", () => {
        const markup = renderToStaticMarkup(
            <SettingsWindow
                {...createSettingsWindowProps()}
                embedded
                onClose={vi.fn()}
            />,
        );

        expect(markup).toContain('aria-label="Close settings"');
        expect(markup).toContain("Workspace");
        expect(markup).toContain('height:100%');
        expect(markup).not.toContain('height:100vh');
    });

    it("centers the settings content inside the main-window pane", () => {
        const markup = renderToStaticMarkup(
            <SettingsWindow {...createSettingsWindowProps()} embedded />,
        );

        expect(markup).toContain("margin-inline:auto");
        expect(markup).toContain("max-width:600px");
    });

    it("warns when the autosave delay can overlap with agent edits", () => {
        const highDelayMarkup = renderToStaticMarkup(
            <SettingsWindow
                {...createSettingsWindowProps({
                    initialCategory: "editor",
                    appEditor: {
                        ...createSettingsWindowProps().appEditor,
                        autoSaveDelayMs: 2000,
                    },
                })}
            />,
        );
        const defaultMarkup = renderToStaticMarkup(
            <SettingsWindow
                {...createSettingsWindowProps({ initialCategory: "editor" })}
            />,
        );

        expect(highDelayMarkup).toContain(
            "Long autosave delays can leave edits pending while agents modify files",
        );
        expect(defaultMarkup).not.toContain(
            "Long autosave delays can leave edits pending while agents modify files",
        );
    });

    it("renders the default tool activity expansion preference in AI settings", () => {
        const props = createSettingsWindowProps({ initialCategory: "ai" });
        const markup = renderToStaticMarkup(
            <SettingsWindow {...props} />,
        );
        const expandedMarkup = renderToStaticMarkup(
            <SettingsWindow
                {...props}
                aiChat={{
                    ...props.aiChat,
                    toolActivityDefaultExpansion: "expanded",
                }}
            />,
        );

        expect(markup).toContain("Tool activity");
        expect(markup).toContain(
            "Choose whether tool activity starts collapsed or expanded.",
        );
        expect(markup).toContain("Collapsed");
        expect(expandedMarkup).toContain("Expanded");
    });

    it("renders a release notes action in the Updates category", () => {
        const markup = renderToStaticMarkup(
            <SettingsWindow
                {...createSettingsWindowProps({
                    initialCategory: "updates",
                    updates: {
                        ...createSettingsWindowProps().updates,
                        onOpenReleaseNotes: vi.fn(),
                    },
                })}
            />,
        );

        expect(markup).toContain("release notes");
        expect(markup).toContain("check for updates");
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
        expect(markup).not.toContain("Windows shell");
        expect(markup).not.toContain("PowerShell 7 (pwsh) requires");
        expect(markup).toContain("Claude Code CLI");
        expect(markup).toContain("Install the claude command to use the launcher.");
        expect(markup).toContain("Skip permissions");
        expect(markup).toContain("--dangerously-skip-permissions");
        expect(markup).toContain("will not ask for approval");
        expect(markup).toContain("Default (Claude Code decides)");
        expect(markup).toContain("Continue last session");
        expect(markup).not.toContain("Max turns");
        expect(markup).not.toContain("--max-turns");
    });

    it("renders the Windows shell dropdown and pwsh notice only on Windows", () => {
        const windowsMarkup = renderTerminal(
            createTerminalState({
                isWindows: true,
                pwshAvailable: null,
                windowsShell: "pwsh",
            }),
        );

        expect(windowsMarkup).toContain("Windows shell");
        expect(windowsMarkup).toContain("Choose which shell new integrated terminals open on Windows.");
        expect(windowsMarkup).toContain("PowerShell 7 (pwsh)");
        expect(windowsMarkup).toContain(
            "PowerShell 7 (pwsh) requires PowerShell 7 to be installed on this machine.",
        );
        expect(windowsMarkup).toContain(
            "new terminals will fall back to Windows PowerShell",
        );

        const nonWindowsMarkup = renderTerminal(
            createTerminalState({
                isWindows: false,
                windowsShell: "pwsh",
            }),
        );

        expect(nonWindowsMarkup).not.toContain("Windows shell");
        expect(nonWindowsMarkup).not.toContain("PowerShell 7 (pwsh)");
    });

    it("renders a fallback diagnostic when PowerShell 7 is selected but missing", () => {
        const markup = renderTerminal(
            createTerminalState({
                isWindows: true,
                pwshAvailable: false,
                windowsShell: "pwsh",
            }),
        );

        expect(markup).toContain(
            "PowerShell 7 (pwsh) was not found. New terminals will fall back to Windows PowerShell.",
        );
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
        expect(turnsMarkup).toContain("No matching settings in this panel.");
        expect(turnsMarkup).not.toContain("--max-turns");
    });

    it("wires terminal control handlers and clamps numeric values", () => {
        const handlers = {
            onClaudeCodeContinueSessionChange: vi.fn(),
            onClaudeCodeMaxTurnsChange: vi.fn(),
            onClaudeCodeModelChange: vi.fn(),
            onClaudeCodeOptimizedChange: vi.fn(),
            onClaudeCodeSkipPermissionsChange: vi.fn(),
            onTerminalFontFamilyChange: vi.fn(),
            onTerminalFontSizeChange: vi.fn(),
            onWindowsShellChange: vi.fn(),
        };
        const tree = createTerminalContentTree(
            createTerminalState({
                ...handlers,
                claudeCodeAvailable: false,
                terminalFontSize: 8,
            }),
        );

        const fontFamilyInput = findIntrinsicElement<InputElementProps>(
            tree,
            "input",
            {
                "aria-label": "Terminal font family",
            },
        );
        fontFamilyInput.props.onChange({
            target: { value: "  FiraCode Nerd Font  " },
        });
        expect(handlers.onTerminalFontFamilyChange).toHaveBeenCalledWith(
            "FiraCode Nerd Font",
        );

        const fontSizeStepper = findNumberStepper(tree, "Terminal font size");
        expect(fontSizeStepper.props.min).toBe(8);
        expect(fontSizeStepper.props.max).toBe(24);
        fontSizeStepper.props.onChange(7);
        fontSizeStepper.props.onChange(25);
        expect(handlers.onTerminalFontSizeChange).toHaveBeenNthCalledWith(1, 8);
        expect(handlers.onTerminalFontSizeChange).toHaveBeenNthCalledWith(2, 24);

        const toggles = findElementsByType<ToggleProps>(tree, Toggle);
        expect(toggles).toHaveLength(3);
        toggles[0].props.onChange(true);
        toggles[1].props.onChange(true);
        toggles[2].props.onChange(true);
        expect(handlers.onClaudeCodeOptimizedChange).toHaveBeenCalledWith(true);
        expect(handlers.onClaudeCodeSkipPermissionsChange).toHaveBeenCalledWith(
            true,
        );
        expect(
            handlers.onClaudeCodeContinueSessionChange,
        ).toHaveBeenCalledWith(true);

        const modelSelect = findElementsByType<SelectFieldProps>(
            tree,
            SelectField,
        )[0];
        modelSelect.props.onChange("claude-opus-4-7");
        expect(handlers.onClaudeCodeModelChange).toHaveBeenCalledWith(
            "claude-opus-4-7",
        );
    });

    it("wires the Windows shell dropdown", () => {
        const handlers = {
            onWindowsShellChange: vi.fn(),
        };
        const tree = createTerminalContentTree(
            createTerminalState({
                ...handlers,
                isWindows: true,
            }),
        );

        const windowsShellSelect = findElementsByType<SelectFieldProps>(
            tree,
            SelectField,
        )[0];
        windowsShellSelect.props.onChange("powershell");

        expect(handlers.onWindowsShellChange).toHaveBeenCalledWith(
            "powershell",
        );
    });

    it("keeps Claude Code controls editable when the CLI is not found", () => {
        const tree = createTerminalContentTree(
            createTerminalState({ claudeCodeAvailable: false }),
        );

        expect(renderTerminal(createTerminalState({ claudeCodeAvailable: false })))
            .toContain("Install the claude command to use the launcher.");
        expect(findElementsByType<ToggleProps>(tree, Toggle)).toHaveLength(3);
        expect(findElementsByType<SelectFieldProps>(tree, SelectField)).toHaveLength(
            1,
        );
    });
});

type NumberStepperProps = Parameters<typeof NumberStepper>[0];
type SelectFieldProps = Parameters<typeof SelectField<string>>[0];
type ToggleProps = Parameters<typeof Toggle>[0];
type InputElementProps = {
    readonly onChange: (event: {
        readonly target: { readonly value: string };
    }) => void;
};

function createTerminalContentTree(state: SettingsTerminalState): ReactElement {
    return TerminalContent({
        searchQuery: createSettingsSearchQuery(""),
        state,
    }) as ReactElement;
}

function findNumberStepper(
    tree: ReactNode,
    ariaLabel: string,
): ReactElement<NumberStepperProps> {
    const stepper = findElementsByType<NumberStepperProps>(
        tree,
        NumberStepper,
    ).find((element) => element.props.ariaLabel === ariaLabel);
    if (!stepper) {
        throw new Error(`Expected NumberStepper "${ariaLabel}".`);
    }
    return stepper;
}

function findIntrinsicElement<TProps extends Record<string, unknown>>(
    tree: ReactNode,
    type: string,
    props: Record<string, unknown>,
): ReactElement<TProps> {
    const match = collectElements(tree).find((element) => {
        if (element.type !== type) {
            return false;
        }
        return Object.entries(props).every(
            ([key, value]) =>
                (element.props as Record<string, unknown>)[key] === value,
        );
    });
    if (!match) {
        throw new Error(`Expected intrinsic element "${type}".`);
    }
    return match as ReactElement<TProps>;
}

function findElementsByType<TProps>(
    tree: ReactNode,
    type: unknown,
): ReactElement<TProps>[] {
    return collectElements(tree).filter(
        (element): element is ReactElement<TProps> => element.type === type,
    );
}

function collectElements(tree: ReactNode): ReactElement[] {
    const elements: ReactElement[] = [];
    const visit = (node: ReactNode): void => {
        if (Array.isArray(node)) {
            for (const child of node as readonly ReactNode[]) {
                visit(child);
            }
            return;
        }
        if (!isValidElement(node)) {
            return;
        }

        elements.push(node);
        const props = node.props as {
            readonly children?: ReactNode;
            readonly control?: ReactNode;
        };
        visit(props.children);
        visit(props.control);
    };

    visit(tree);
    return elements;
}
