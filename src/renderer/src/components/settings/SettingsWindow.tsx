import type { AppUpdateState } from "@shared/ipc";
import { useEffect, useState, type CSSProperties } from "react";
import {
    AGENTS_SIDEBAR_SCALE_MAX,
    AGENTS_SIDEBAR_SCALE_MIN,
    AGENTS_SIDEBAR_SCALE_STEP,
    clampAgentsSidebarScale,
} from "@shared/agents-sidebar-scale";
import {
    APP_ZOOM_FACTOR_MAX,
    APP_ZOOM_FACTOR_MIN,
    APP_ZOOM_FACTOR_STEP,
    clampAppZoomFactor,
} from "@shared/app-zoom";
import {
    EDITOR_AUTOSAVE_DELAY_MS_MAX,
    EDITOR_AUTOSAVE_DELAY_MS_MIN,
} from "@shared/editor-autosave";
import {
    FILE_TREE_SCALE_MAX,
    FILE_TREE_SCALE_MIN,
    FILE_TREE_SCALE_STEP,
    formatFileTreeScalePercent,
} from "@shared/file-tree-scale";
import {
    AI_CHAT_FONT_SIZE_MAX,
    AI_CHAT_FONT_SIZE_MIN,
    AI_COMPOSER_FONT_SIZE_MAX,
    AI_COMPOSER_FONT_SIZE_MIN,
    EDITOR_FONT_SIZE_MAX,
    EDITOR_FONT_SIZE_MIN,
} from "@shared/typography";
import {
    CLAUDE_CODE_MODEL_OPTIONS,
    TERMINAL_FONT_SIZE_MAX,
    TERMINAL_FONT_SIZE_MIN,
    WINDOWS_TERMINAL_SHELL_OPTIONS,
    normalizeTerminalFontFamily,
    normalizeTerminalFontSize,
    normalizeWindowsTerminalShell,
} from "@shared/terminal-settings";

import {
    IdeActionButton,
    IdeBarDotSeparator,
    IdeBarHeader,
    IdeBarLabel,
    IdeBarSearchIcon,
} from "@renderer/components/workspace/ide-bar";

import {
    NumberStepper,
    Row,
    SectionLabel,
    SegmentedControl,
    SelectField,
    SliderField,
    ThemePicker,
    Toggle,
} from "./primitives";
import { AIProvidersSettings } from "./AIProvidersSettings";

import type {
    SettingsAiChatState,
    SettingsEditorControlState,
    SettingsGitHubState,
    SettingsPrivacyState,
    SettingsProjectOption,
    SettingsProjectsState,
    SettingsTerminalState,
    SettingsThemeControlState,
    SettingsUpdatesState,
    SettingsWindowProps,
    ShortcutEntryOption,
} from "./settings-types";

type Category = SettingsWindowProps["initialCategory"] extends infer T
    ? NonNullable<T>
    : never;

const CATEGORIES: { id: Category; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "editor", label: "Editor" },
    { id: "terminal", label: "Terminal" },
    { id: "ai", label: "AI" },
    { id: "runtimes", label: "AI Runtimes" },
    { id: "projects", label: "Projects" },
    { id: "github", label: "GitHub" },
    { id: "shortcuts", label: "Shortcuts" },
    { id: "privacy", label: "Privacy" },
    { id: "updates", label: "Updates" },
];

const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
    appearance: "Theme mode and visual presets",
    editor: "Typography and editor behavior",
    terminal: "Font, size, and shell environment settings",
    projects: "Project locations and saved app data",
    github: "Issues, pull requests, and repository auth",
    ai: "Chat, composer, and AI behavior",
    privacy: "Protected folders and macOS permission guidance",
    shortcuts: "Keyboard shortcuts reference",
    runtimes: "AI runtime authentication and wiring",
    updates: "App version and updates",
};

type SearchValue = string | number | null | undefined;

interface SettingsSearchQuery {
    readonly normalized: string;
    readonly terms: readonly string[];
}

interface SettingsSearchContext {
    readonly aiChat: SettingsAiChatState;
    readonly appAppearance: SettingsThemeControlState;
    readonly appEditor: SettingsEditorControlState;
    readonly terminal: SettingsTerminalState;
    readonly github: SettingsGitHubState;
    readonly privacy: SettingsPrivacyState;
    readonly projects: SettingsProjectsState;
    readonly shortcuts: readonly ShortcutEntryOption[];
    readonly updates: SettingsUpdatesState;
}

const EMPTY_SEARCH_QUERY: SettingsSearchQuery = {
    normalized: "",
    terms: [],
};

const STATIC_CATEGORY_SEARCH_VALUES: Record<Category, readonly SearchValue[]> = {
    appearance: [
        "Workspace",
        "File tree size",
        "Scale the rows, icons, and labels in the file tree.",
        "Sidebar list size",
        "Scale text and rows in the Agents, Issues, and Pull Requests sidebars.",
        "Sticky folders",
        "Keep parent folders pinned while scrolling the file tree.",
        "Window transparency",
        "Use native acrylic transparency on Windows and vibrancy on macOS.",
        "Mode",
        "System theme",
        "Choose how the app looks. System follows your OS preference.",
        "Light",
        "Dark",
        "Theme",
        "Visual presets",
        "Accessibility",
        "Boost code contrast",
        "WCAG AA contrast ratio syntax colors editor background palette",
        "Zoom",
        "App zoom",
        "Scale the entire app UI View menu keyboard shortcut",
    ],
    editor: [
        "Typography",
        "Autosave delay",
        "Delay after the last edit before dirty files are saved automatically.",
        "Font size",
        "Text size in the editor pixels shortcut zoom",
        "Font family",
        "Font used in the editor.",
        "Line spacing",
        "Line height multiplier for the editor.",
        "Minimap",
        "Show Monaco code minimap on the side of the editor.",
        "Relative line numbers",
        "Show line numbers as distance from the cursor.",
        "Autocomplete suggestions",
        "Show Monaco suggestions automatically while typing trigger manually.",
        "Vim mode",
        "Use Vim keybindings in Monaco editors.",
        "modal editing",
    ],
    terminal: [
        "Terminal",
        "Font",
        "Font family",
        "Nerd Fonts",
        "FiraCode",
        "Font size",
        "Shell Environment",
        "Fullscreen rendering",
        "CLAUDE_CODE_NO_FLICKER",
        "Claude Code",
        "Claude Code CLI",
        "claude command",
        "Skip permissions",
        "dangerously-skip-permissions",
        "--dangerously-skip-permissions",
        "Model",
        "Continue",
        "Continue last session",
    ],
    projects: [
        "Projects",
        "Project locations",
        "Saved app data",
        "Add project",
        "Change location",
        "Clear app data",
        "Remove from Comando",
        "Reveal in Finder",
        "Reveal in Explorer",
        "Chat history transcripts review artifacts workspace tabs",
    ],
    github: [
        "GitHub",
        "Connect GitHub",
        "Token source",
        "gh CLI",
        "gh auth login",
        "stored_token",
        "PAT",
        "stored PAT",
        "Token read from the gh CLI",
        "A stored PAT takes priority if both are present.",
        "No token found. Add a PAT below or run gh auth login.",
        "Personal access token",
        "Save Token",
        "Disconnect",
        "gh auth logout",
        "Token saved securely on this machine.",
        "Missing token",
        "Invalid token",
        "Read-only access",
        "Issues write access",
        "Pull requests write access",
        "Actions read access",
        "metadata issues pull requests contents read",
        "comments in PRs use GitHub issue comments permissions",
        "Some actions are disabled because the token is missing write permissions.",
    ],
    ai: [
        "Chat",
        "Chat font family",
        "Font used for messages in the chat.",
        "Chat font size",
        "Font size of messages in the chat.",
        "Tool activity",
        "Choose whether tool activity starts collapsed or expanded.",
        "Collapsed",
        "Expanded",
        "Review",
        "Chat history retention",
        "How long saved chat histories stay on disk before automatic deletion.",
        "Forever",
        "Composer",
        "Require command enter control enter to send",
        "Press shortcut to send messages Enter adds new line.",
        "Context window indicator",
        "Show a thin bar below the composer indicating context window usage.",
        "Screenshot retention",
        "How long pasted screenshots stay in the composer before automatic removal.",
        "Composer font family",
        "Font used in the message input box.",
        "Composer font size",
        "Font size of the message input box.",
    ],
    privacy: [
        "Protected folders",
        "macOS filesystem access",
        "Last blocked path",
        "Full Disk Access",
        "Privacy & Security",
        "Documents Desktop protected folders",
    ],
    shortcuts: [
        "Keyboard shortcuts",
        "Keyboard shortcuts reference",
        "Hotkeys",
        "Keys",
        "Commands",
    ],
    runtimes: [
        "Runtimes",
        "AI runtimes",
        "Authentication",
        "Wiring",
        "Actions",
        "Configured runtimes",
    ],
    updates: [
        "Version",
        "Current version",
        "Last checked",
        "Check for updates",
        "Release notes",
        "Restart and install",
        "Automatic updates",
        "Update status",
        "Available",
        "Downloading",
        "Ready",
        "Up to date",
        "Unavailable",
    ],
};

export function createSettingsSearchQuery(value: string): SettingsSearchQuery {
    const normalized = normalizeSearchText(value);

    if (!normalized) {
        return EMPTY_SEARCH_QUERY;
    }

    return {
        normalized,
        terms: normalized.split(" ").filter(Boolean),
    };
}

function normalizeSearchText(value: SearchValue): string {
    return String(value ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function matchesSearch(
    query: SettingsSearchQuery,
    ...values: readonly SearchValue[]
): boolean {
    if (query.terms.length === 0) {
        return true;
    }

    const haystack = normalizeSearchText(
        values
            .filter((value) => value !== null && value !== undefined)
            .join(" "),
    );
    return query.terms.every((term) => haystack.includes(term));
}

function categoryHeaderMatchesSearch(
    category: Category,
    query: SettingsSearchQuery,
): boolean {
    const info = CATEGORIES.find((candidate) => candidate.id === category);
    return matchesSearch(
        query,
        info?.label,
        CATEGORY_DESCRIPTIONS[category],
    );
}

function categoryMatchesSearch(
    category: Category,
    query: SettingsSearchQuery,
    context: SettingsSearchContext,
): boolean {
    return (
        categoryHeaderMatchesSearch(category, query) ||
        matchesSearch(
            query,
            ...STATIC_CATEGORY_SEARCH_VALUES[category],
            ...getDynamicCategorySearchValues(category, context),
        )
    );
}

function getDynamicCategorySearchValues(
    category: Category,
    context: SettingsSearchContext,
): readonly SearchValue[] {
    switch (category) {
        case "appearance":
            return context.appAppearance.presets.flatMap((preset) => [
                preset.id,
                preset.label,
                preset.description,
            ]);
        case "editor":
            return context.appEditor.fontFamilies.flatMap((font) => [
                font.id,
                font.group,
                font.label,
                font.description,
                font.preview,
            ]);
        case "terminal":
            return [
                context.terminal.terminalFontFamily,
                context.terminal.terminalFontSize,
                context.terminal.isWindows
                    ? context.terminal.windowsShell
                    : null,
                ...(context.terminal.isWindows
                    ? WINDOWS_TERMINAL_SHELL_OPTIONS.flatMap((option) => [
                          option.label,
                          option.value,
                      ])
                    : []),
                context.terminal.claudeCodeModel,
                context.terminal.claudeCodeAvailable === false
                    ? "Install the claude command to use the launcher."
                    : null,
                ...CLAUDE_CODE_MODEL_OPTIONS.flatMap((option) => [
                    option.label,
                    option.value,
                ]),
            ];
        case "projects":
            return [
                context.projects.error,
                ...context.projects.projects.flatMap((project) => [
                    project.id,
                    project.name,
                    project.rootPath,
                    project.lastOpenedAt,
                ]),
            ];
        case "github":
            return [
                context.github.error,
                context.github.notice,
                context.github.status.errorCode,
                context.github.status.host,
                context.github.status.state,
                context.github.status.tokenSource,
                context.github.status.user?.login,
                context.github.status.readOnly ? "Read-only access" : null,
                context.github.status.canReadActions
                    ? "Actions read access"
                    : null,
                context.github.status.canWriteActions
                    ? "Actions write access"
                    : null,
                context.github.status.canWriteIssues
                    ? "Issues write access"
                    : null,
                context.github.status.canWritePullRequests
                    ? "Pull requests write access"
                    : null,
            ];
        case "ai":
            return [
                ...context.aiChat.chatFontFamilies.flatMap((font) => [
                    font.id,
                    font.group,
                    font.label,
                ]),
                ...context.aiChat.composerFontFamilies.flatMap((font) => [
                    font.id,
                    font.group,
                    font.label,
                ]),
            ];
        case "privacy":
            return [
                context.privacy.state.message,
                context.privacy.state.lastDeniedPath,
                context.privacy.state.status,
            ];
        case "shortcuts":
            return context.shortcuts.flatMap((shortcut) => [
                shortcut.id,
                shortcut.section,
                shortcut.label,
                shortcut.description,
                shortcut.keys,
            ]);
        case "runtimes":
            return [
                "AI Providers",
                "Codex",
                "Claude",
                "Kilo",
                "API keys",
                "terminal sign-in",
                "Open sign-in terminal",
                "Anthropic API key",
                "Bedrock gateway",
                "Custom gateway",
                "Kilo API key",
                "Diagnostics",
            ];
        case "updates":
            return [
                context.updates.state.status,
                context.updates.state.message,
                context.updates.state.currentVersion,
                context.updates.state.availableVersion,
                context.updates.state.lastCheckedAt,
                context.updates.onOpenReleaseNotes ? "release notes" : null,
            ];
    }
}

export function SettingsWindow({
    aiChat,
    appAppearance,
    appEditor,
    terminal,
    github,
    privacy,
    projects,
    aiProviders,
    shortcuts = [],
    updates,
    initialCategory = "appearance",
    initialCategoryRequestId = 0,
}: SettingsWindowProps) {
    const [active, setActive] = useState<Category>(initialCategory);
    const [search, setSearch] = useState("");
    const searchQuery = createSettingsSearchQuery(search);
    const searchContext: SettingsSearchContext = {
        aiChat,
        appAppearance,
        appEditor,
        terminal,
        github,
        privacy,
        projects,
        shortcuts,
        updates,
    };
    const filteredCategories = CATEGORIES.filter((category) =>
        categoryMatchesSearch(category.id, searchQuery, searchContext),
    );
    const activeCategory =
        filteredCategories.find((category) => category.id === active)?.id ??
        filteredCategories[0]?.id ??
        active;
    const activeInfo =
        CATEGORIES.find((category) => category.id === activeCategory) ??
        CATEGORIES[0];
    const activeSearchQuery = categoryHeaderMatchesSearch(
        activeCategory,
        searchQuery,
    )
        ? EMPTY_SEARCH_QUERY
        : searchQuery;
    const hasSearch = searchQuery.terms.length > 0;

    useEffect(() => {
        setActive(initialCategory);
        setSearch("");
    }, [initialCategory, initialCategoryRequestId]);

    useEffect(() => {
        if (activeCategory !== active) {
            setActive(activeCategory);
        }
    }, [active, activeCategory]);

    return (
        <div
            style={{
                height: "100vh",
                backgroundColor: "transparent",
                color: "var(--color-text-primary)",
                display: "flex",
                flexDirection: "column",
            }}
        >
            {/* Header */}
            <div
                className="app-drag settings-chrome"
                style={{
                    alignItems: "center",
                    borderBottom:
                        "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                    display: "flex",
                    flexShrink: 0,
                    fontFamily: "var(--font-mono)",
                    height: 42,
                    padding: "0 20px",
                    position: "relative",
                }}
            >
                <div style={{ width: 70, flexShrink: 0 }} />
                <span
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: 10,
                        fontWeight: 600,
                        left: "50%",
                        letterSpacing: "0.06em",
                        pointerEvents: "none",
                        position: "absolute",
                        textTransform: "uppercase",
                        transform: "translateX(-50%)",
                        whiteSpace: "nowrap",
                    }}
                >
                    Settings
                </span>
            </div>

            {/* Body */}
            <div
                style={{
                    flex: 1,
                    minHeight: 0,
                    display: "flex",
                    overflow: "hidden",
                }}
            >
                {/* Sidebar */}
                <div
                    className="settings-chrome"
                    style={{
                        borderRight:
                            "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                        display: "flex",
                        flexDirection: "column",
                        flexShrink: 0,
                        overflow: "hidden",
                        width: 220,
                    }}
                >
                    <div style={{ padding: "10px 10px 6px" }}>
                        <div
                            className="app-no-drag"
                            style={{ position: "relative", width: "100%" }}
                        >
                            <input
                                aria-label="Search settings"
                                autoCapitalize="off"
                                autoCorrect="off"
                                onChange={(e) => setSearch(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                        e.preventDefault();
                                        setSearch("");
                                    }
                                }}
                                placeholder="Search settings..."
                                spellCheck={false}
                                style={{
                                    backgroundColor: "transparent",
                                    border: "1px solid color-mix(in srgb, var(--color-border) 45%, transparent)",
                                    borderRadius: 3,
                                    color: "var(--color-text-primary)",
                                    fontFamily: "var(--font-mono)",
                                    fontSize: 11,
                                    height: 22,
                                    lineHeight: "20px",
                                    outline: "none",
                                    padding: "0 22px 0 22px",
                                    width: "100%",
                                }}
                                type="text"
                                value={search}
                            />
                            <span
                                aria-hidden="true"
                                style={{
                                    color: "var(--color-text-secondary)",
                                    left: 6,
                                    pointerEvents: "none",
                                    position: "absolute",
                                    top: "50%",
                                    transform: "translateY(-50%)",
                                }}
                            >
                                <IdeBarSearchIcon />
                            </span>
                            {search.length > 0 ? (
                                <button
                                    aria-label="Clear search"
                                    onClick={() => setSearch("")}
                                    style={{
                                        background: "transparent",
                                        border: "none",
                                        color: "var(--color-text-secondary)",
                                        cursor: "pointer",
                                        fontSize: 10,
                                        padding: "0 4px",
                                        position: "absolute",
                                        right: 2,
                                        top: "50%",
                                        transform: "translateY(-50%)",
                                    }}
                                    type="button"
                                >
                                    ×
                                </button>
                            ) : null}
                        </div>
                    </div>

                    <div
                        style={{
                            flex: 1,
                            overflowY: "auto",
                            padding: "4px 8px",
                        }}
                    >
                        {filteredCategories.map((cat) => {
                            const isActive = cat.id === activeCategory;
                            return (
                                <button
                                    className="app-no-drag"
                                    key={cat.id}
                                    onClick={() => setActive(cat.id)}
                                    onMouseEnter={(e) => {
                                        if (!isActive)
                                            e.currentTarget.style.backgroundColor =
                                                "color-mix(in srgb, var(--color-border) 25%, transparent)";
                                    }}
                                    onMouseLeave={(e) => {
                                        if (!isActive)
                                            e.currentTarget.style.backgroundColor =
                                                "transparent";
                                    }}
                                    style={{
                                        alignItems: "center",
                                        backgroundColor: isActive
                                            ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                                            : "transparent",
                                        border: isActive
                                            ? "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)"
                                            : "1px solid transparent",
                                        borderRadius: 3,
                                        color: isActive
                                            ? "var(--color-text-primary)"
                                            : "var(--color-text-secondary)",
                                        cursor: "pointer",
                                        display: "flex",
                                        fontFamily: "var(--font-mono)",
                                        fontSize: 11,
                                        fontWeight: 500,
                                        gap: 8,
                                        marginBottom: 2,
                                        padding: "4px 8px",
                                        textAlign: "left",
                                        textTransform: "lowercase",
                                        width: "100%",
                                    }}
                                >
                                    {cat.label}
                                </button>
                            );
                        })}
                        {filteredCategories.length === 0 ? (
                            <div
                                style={{
                                    color: "var(--color-text-secondary)",
                                    fontFamily: "var(--font-mono)",
                                    fontSize: 11,
                                    lineHeight: 1.4,
                                    padding: "8px 8px",
                                }}
                            >
                                No settings found.
                            </div>
                        ) : null}
                    </div>
                </div>

                {/* Content */}
                <div
                    style={{
                        backgroundColor: "var(--color-bg-primary)",
                        display: "flex",
                        flex: 1,
                        flexDirection: "column",
                        minHeight: 0,
                        minWidth: 0,
                    }}
                >
                    <IdeBarHeader>
                        <IdeBarLabel>{activeInfo.label}</IdeBarLabel>
                        <IdeBarDotSeparator />
                        <span
                            style={{
                                color: "var(--color-text-secondary)",
                                fontSize: "10.5px",
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                            }}
                        >
                            {CATEGORY_DESCRIPTIONS[activeCategory]}
                        </span>
                    </IdeBarHeader>

                    <div
                        className="shell-scrollbar"
                        style={{
                            flex: 1,
                            minHeight: 0,
                            overflowY: "auto",
                            padding: "8px 48px 48px",
                        }}
                    >
                        <div style={{ maxWidth: 600 }}>
                            {filteredCategories.length === 0 && hasSearch ? (
                                <EmptySettingsSearch search={search} />
                            ) : null}
                            {filteredCategories.length > 0 &&
                                activeCategory === "appearance" && (
                                    <AppearanceContent
                                        searchQuery={activeSearchQuery}
                                        state={appAppearance}
                                    />
                                )}
                            {filteredCategories.length > 0 &&
                                activeCategory === "editor" && (
                                    <EditorContent
                                        searchQuery={activeSearchQuery}
                                        state={appEditor}
                                    />
                                )}
                            {filteredCategories.length > 0 &&
                                activeCategory === "terminal" && (
                                    <TerminalContent
                                        searchQuery={activeSearchQuery}
                                        state={terminal}
                                    />
                                )}
                            {filteredCategories.length > 0 &&
                                activeCategory === "projects" && (
                                    <ProjectsContent
                                        searchQuery={activeSearchQuery}
                                        state={projects}
                                    />
                                )}
                            {filteredCategories.length > 0 &&
                                activeCategory === "github" && (
                                    <GitHubContent
                                        searchQuery={activeSearchQuery}
                                        state={github}
                                    />
                                )}
                            {filteredCategories.length > 0 &&
                                activeCategory === "ai" && (
                                    <AiChatContent
                                        searchQuery={activeSearchQuery}
                                        state={aiChat}
                                    />
                                )}
                            {filteredCategories.length > 0 &&
                                activeCategory === "privacy" && (
                                    <PrivacyContent
                                        onOpenFullDiskAccessSettings={
                                            privacy.onOpenFullDiskAccessSettings
                                        }
                                        searchQuery={activeSearchQuery}
                                        state={privacy.state}
                                    />
                                )}
                            {filteredCategories.length > 0 &&
                                activeCategory === "shortcuts" && (
                                    <ShortcutsContent
                                        searchQuery={activeSearchQuery}
                                        shortcuts={shortcuts}
                                    />
                                )}
                            {filteredCategories.length > 0 &&
                                activeCategory === "runtimes" && (
                                    <AIProvidersSettings {...aiProviders} />
                                )}
                            {filteredCategories.length > 0 &&
                                activeCategory === "updates" && (
                                    <UpdatesContent
                                        onCheckForUpdates={
                                            updates.onCheckForUpdates
                                        }
                                        onInstallUpdate={
                                            updates.onInstallUpdate
                                        }
                                        searchQuery={activeSearchQuery}
                                        state={updates.state}
                                    />
                                )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function EmptySettingsSearch({ search }: { search: string }) {
    return (
        <div
            style={{
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1.5,
                padding: "24px 0",
            }}
        >
            No settings match "{search.trim()}".
        </div>
    );
}

function EmptyPanelSearchResult() {
    return (
        <div
            style={{
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1.5,
                padding: "24px 0",
            }}
        >
            No matching settings in this panel.
        </div>
    );
}

function SearchableRow({
    control,
    description,
    disabled,
    keywords = [],
    label,
    searchQuery,
    section,
}: {
    readonly control: React.ReactNode;
    readonly description?: string;
    readonly disabled?: boolean;
    readonly keywords?: readonly SearchValue[];
    readonly label: string;
    readonly searchQuery: SettingsSearchQuery;
    readonly section: string;
}) {
    if (!matchesSearch(searchQuery, section, label, description, ...keywords)) {
        return null;
    }

    return (
        <Row
            control={control}
            description={description}
            disabled={disabled}
            label={label}
        />
    );
}

function sectionHasMatches(
    searchQuery: SettingsSearchQuery,
    section: string,
    rows: readonly (readonly SearchValue[])[],
): boolean {
    return rows.some((row) => matchesSearch(searchQuery, section, ...row));
}

function ProjectsContent({
    searchQuery,
    state,
}: {
    searchQuery: SettingsSearchQuery;
    state: SettingsProjectsState;
}) {
    const isMac =
        typeof navigator !== "undefined" &&
        navigator.platform.toLowerCase().startsWith("mac");
    const revealLabel = isMac ? "Reveal in Finder" : "Reveal in Explorer";
    const visibleProjects = state.projects.filter((project) =>
        matchesSearch(
            searchQuery,
            "Projects",
            project.id,
            project.name,
            project.rootPath,
            project.lastOpenedAt,
            revealLabel,
            "Move",
            "Change location",
            "Clear data",
            "Clear app data",
            "Remove",
            "Remove from Comando",
        ),
    );

    return (
        <div>
            <SectionLabel>Library</SectionLabel>
            <div
                style={{
                    alignItems: "center",
                    borderBottom:
                        "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                    display: "flex",
                    gap: 16,
                    justifyContent: "space-between",
                    padding: "11px 0",
                }}
            >
                <div>
                    <div
                        style={{
                            color: "var(--color-text-primary)",
                            fontSize: 13,
                            fontWeight: 500,
                            lineHeight: 1.3,
                        }}
                    >
                        Add projects
                    </div>
                    <div
                        style={{
                            color: "var(--color-text-secondary)",
                            fontSize: 11,
                            lineHeight: 1.4,
                            marginTop: 2,
                        }}
                    >
                        Choose folders to add to Comando.
                    </div>
                </div>
                <IdeActionButton
                    disabled={state.loading}
                    onClick={() => state.onAddProject?.()}
                >
                    Add Project...
                </IdeActionButton>
            </div>

            <SectionLabel>Projects</SectionLabel>
            {state.error ? (
                <div
                    style={{
                        background:
                            "color-mix(in srgb, var(--color-danger, #f87171) 10%, transparent)",
                        border:
                            "1px solid color-mix(in srgb, var(--color-danger, #f87171) 35%, transparent)",
                        borderRadius: 6,
                        color: "var(--color-text-primary)",
                        fontSize: 11,
                        lineHeight: 1.5,
                        marginBottom: 10,
                        padding: "8px 10px",
                    }}
                >
                    {state.error}
                </div>
            ) : null}
            {visibleProjects.length === 0 ? (
                searchQuery.terms.length > 0 ? (
                    <EmptyPanelSearchResult />
                ) : (
                    <div
                        style={{
                            color: "var(--color-text-secondary)",
                            fontSize: 11,
                            lineHeight: 1.5,
                            padding: "10px 0",
                        }}
                    >
                        No projects added yet.
                    </div>
                )
            ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                    {visibleProjects.map((project, index) => (
                        <ProjectSettingsRow
                            isFirst={index === 0}
                            key={project.id}
                            project={project}
                            revealLabel={revealLabel}
                            state={state}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function ProjectSettingsRow({
    isFirst,
    project,
    revealLabel,
    state,
}: {
    isFirst: boolean;
    project: SettingsProjectOption;
    revealLabel: string;
    state: SettingsProjectsState;
}) {
    const disabled = state.loading;
    const lastOpened = formatProjectLastOpened(project.lastOpenedAt);
    const subtleBorder =
        "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)";

    return (
        <div
            style={{
                alignItems: "center",
                borderBottom: subtleBorder,
                borderTop: isFirst ? subtleBorder : undefined,
                display: "flex",
                gap: 16,
                justifyContent: "space-between",
                padding: "10px 0",
            }}
        >
            <div style={{ minWidth: 0 }}>
                <div
                    style={{
                        color: "var(--color-text-primary)",
                        fontSize: 13,
                        fontWeight: 500,
                        lineHeight: 1.3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                    }}
                >
                    {project.name}
                </div>
                <div
                    title={project.rootPath}
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: 11,
                        lineHeight: 1.4,
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                    }}
                >
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                        {project.rootPath}
                    </span>
                    {lastOpened ? (
                        <span
                            style={{
                                color: "var(--color-text-tertiary, var(--color-text-secondary))",
                                opacity: 0.75,
                            }}
                        >
                            {"  ·  "}
                            {`Opened ${lastOpened}`}
                        </span>
                    ) : null}
                </div>
            </div>
            <div
                style={{
                    display: "flex",
                    flexShrink: 0,
                    gap: 4,
                }}
            >
                <IdeActionButton
                    disabled={disabled}
                    onClick={() => state.onRevealProject?.(project.id)}
                    title={revealLabel}
                >
                    {revealLabel}
                </IdeActionButton>
                <IdeActionButton
                    disabled={disabled}
                    onClick={() => state.onRelocateProject?.(project.id)}
                    title="Change project location"
                >
                    Move...
                </IdeActionButton>
                <IdeActionButton
                    disabled={disabled}
                    onClick={() => {
                        void confirmClearProjectAppData(state, project);
                    }}
                    title="Clear saved app data for this project"
                >
                    Clear Data...
                </IdeActionButton>
                <IdeActionButton
                    disabled={disabled}
                    onClick={() => {
                        if (
                            window.confirm(
                                `Remove "${project.name}" from Comando?\n\nThis will hide the project from the app, but it will not delete project files or saved chat history.`,
                            )
                        ) {
                            state.onRemoveProject?.(project.id);
                        }
                    }}
                    title="Remove project from Comando"
                >
                    Remove
                </IdeActionButton>
            </div>
        </div>
    );
}

async function confirmClearProjectAppData(
    state: SettingsProjectsState,
    project: SettingsProjectOption,
): Promise<void> {
    const summary = state.onGetAppDataSummary
        ? await state.onGetAppDataSummary(project.id).catch(() => null)
        : null;
    const details = summary
        ? [
              `- ${summary.chatSessionCount} chat history session(s) and transcripts`,
              "- AI review artifacts linked to those sessions",
              `- ${summary.projectSettingsCount} project-specific setting(s)`,
              `- ${summary.workspaceTabCount} restored workspace tab(s)`,
              `- ${summary.workspaceLayoutCount} workspace layout(s) linked to this project`,
              `- ${summary.workspaceSessionCount} workspace session reference(s)`,
              `- ${summary.recentProjectCount} recent project activity record(s)`,
          ].join("\n")
        : [
              "- chat history and transcripts",
              "- AI review artifacts",
              "- project-specific settings",
              "- recent project activity",
              "- restored workspace tabs and layout state linked to this project",
          ].join("\n");
    const confirmed = window.confirm(
        `Clear saved app data for "${project.name}"?\n\nThis will delete:\n\n${details}\n\nProject files on disk will not be deleted.`,
    );

    if (confirmed) {
        state.onClearAppData?.(project.id);
    }
}

function formatProjectLastOpened(value: string | null): string | null {
    if (!value) {
        return null;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    });
}

function GitHubContent({
    searchQuery,
    state,
}: {
    searchQuery: SettingsSearchQuery;
    state: SettingsGitHubState;
}) {
    const canSave = state.tokenDraft.trim().length > 0 && !state.saving;
    const canDisconnect =
        state.status.tokenSource === "stored_token" &&
        state.status.state !== "missing" &&
        state.status.state !== "unknown";
    const isConnected = state.status.state === "authenticated";
    const showConnection = sectionHasMatches(searchQuery, "Connection", [
        [
            "Connect GitHub",
            "Personal access token",
            "Save Token",
            "Disconnect",
            "Token saved securely on this machine.",
            "Missing token",
            "Invalid token",
            "Token source",
            "gh CLI",
            "gh auth login",
            "stored_token",
            "PAT",
            "stored PAT",
            "Token read from the gh CLI",
            "No token found. Add a PAT below or run gh auth login.",
            state.status.state,
            state.status.tokenSource,
            state.status.user?.login,
            state.error,
            state.notice,
        ],
    ]);
    const showPermissions = sectionHasMatches(searchQuery, "Permissions", [
        [
            "Read-only access",
            "Issues write access",
            "Pull requests write access",
            "Actions read access",
            "metadata issues read pull requests read contents read",
            "comments in PRs use GitHub issue comments permissions",
            "Some actions are disabled because the token is missing write permissions.",
        ],
    ]);

    if (!showConnection && !showPermissions) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            {showConnection ? <SectionLabel>Connection</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Connection"
                label="GitHub status"
                description={formatGitHubStatusDescription(state)}
                keywords={[
                    state.status.state,
                    state.status.errorCode,
                    state.status.user?.login,
                    state.status.host,
                ]}
                control={
                    <div
                        style={{
                            alignItems: "center",
                            display: "flex",
                            gap: 8,
                        }}
                    >
                        <GitHubStatusBadge status={state.status.state} />
                        <IdeActionButton
                            disabled={state.loading}
                            onClick={() => state.onRefresh?.()}
                            title="Refresh GitHub auth status"
                        >
                            refresh
                        </IdeActionButton>
                    </div>
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Connection"
                label="Token source"
                description={
                    state.status.tokenSource === "gh_cli"
                        ? "Token read from the gh CLI (gh auth login). A stored PAT takes priority if both are present."
                        : state.status.tokenSource === "stored_token"
                          ? "Using a personal access token stored securely on this machine."
                          : "No token found. Add a PAT below or run gh auth login."
                }
                keywords={["gh CLI", "gh auth login", "stored_token", "PAT"]}
                control={
                    <span
                        style={{
                            color:
                                state.status.tokenSource === "gh_cli"
                                    ? "var(--color-success)"
                                    : state.status.tokenSource === "stored_token"
                                      ? "var(--color-success)"
                                      : "var(--color-muted)",
                            fontFamily: "var(--font-mono)",
                            fontSize: "0.85em",
                        }}
                    >
                        {state.status.tokenSource === "gh_cli"
                            ? "gh CLI"
                            : state.status.tokenSource === "stored_token"
                              ? "PAT"
                              : "none"}
                    </span>
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Connection"
                label="Personal access token"
                description="Paste a fine-grained PAT. Stored tokens take priority over gh CLI. Comando stores it securely on this machine and never exposes the saved token to the renderer."
                keywords={[
                    "Connect GitHub",
                    "Save Token",
                    "Token saved securely on this machine.",
                    "secure storage",
                ]}
                control={
                    <div
                        style={{
                            alignItems: "center",
                            display: "flex",
                            gap: 6,
                        }}
                    >
                        <input
                            aria-label="GitHub personal access token"
                            autoCapitalize="off"
                            autoComplete="off"
                            autoCorrect="off"
                            className="ide-input"
                            disabled={state.saving}
                            onChange={(event) =>
                                state.onTokenDraftChange?.(event.target.value)
                            }
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && canSave) {
                                    event.preventDefault();
                                    state.onSaveToken?.();
                                }
                            }}
                            placeholder={
                                isConnected
                                    ? "Paste a new token to replace"
                                    : "github_pat_..."
                            }
                            spellCheck={false}
                            style={{
                                fontFamily: "var(--font-mono)",
                                width: 220,
                            }}
                            type="password"
                            value={state.tokenDraft}
                        />
                        <IdeActionButton
                            active={canSave}
                            disabled={!canSave}
                            onClick={() => state.onSaveToken?.()}
                            title="Save GitHub token"
                        >
                            {state.saving ? "saving..." : "save token"}
                        </IdeActionButton>
                    </div>
                }
            />
            {state.error ? (
                <SearchableRow
                    searchQuery={searchQuery}
                    section="Connection"
                    label="GitHub error"
                    description={state.error}
                    keywords={[
                        "secure storage unavailable",
                        "invalid token",
                        "forbidden",
                    ]}
                    control={<DangerText>attention</DangerText>}
                />
            ) : null}
            {state.notice ? (
                <SearchableRow
                    searchQuery={searchQuery}
                    section="Connection"
                    label="Saved token"
                    description={state.notice}
                    keywords={["Token saved securely on this machine."]}
                    control={<PositiveText>saved</PositiveText>}
                />
            ) : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Connection"
                label="Disconnect"
                description={
                    state.status.tokenSource === "gh_cli"
                        ? "No stored PAT to remove. To revoke gh CLI access run: gh auth logout."
                        : "Remove the stored PAT from this machine. If gh CLI is logged in, it will be used as a fallback automatically."
                }
                keywords={["clear token", "remove token", "logout"]}
                control={
                    <IdeActionButton
                        disabled={
                            state.loading || !canDisconnect
                        }
                        onClick={() => state.onDisconnect?.()}
                        title={
                            state.status.tokenSource === "gh_cli"
                                ? "Use gh auth logout to revoke gh CLI access"
                                : "Remove stored GitHub token"
                        }
                    >
                        disconnect
                    </IdeActionButton>
                }
            />

            {showPermissions ? (
                <SectionLabel>Permissions</SectionLabel>
            ) : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Permissions"
                label="Read-only access"
                description="Minimum useful token permissions: metadata, issues read, pull requests read, and contents read."
                keywords={["metadata", "issues read", "pull requests read"]}
                control={<PermissionBadge enabled={isConnected} />}
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Permissions"
                label="Issues write access"
                description="Required to create issues, close or reopen issues, and comment on issue conversations."
                control={
                    <PermissionBadge enabled={state.status.canWriteIssues} />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Permissions"
                label="Pull requests write access"
                description="Required to create PRs, update draft/ready state, and operate pull request metadata."
                control={
                    <PermissionBadge
                        enabled={state.status.canWritePullRequests}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Permissions"
                label="PR conversation comments"
                description="General PR comments use GitHub issue comments permissions because GitHub models PR conversations as issues."
                keywords={["comments in PRs", "issue comments permissions"]}
                control={
                    <PermissionBadge enabled={state.status.canWriteIssues} />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Permissions"
                label="Actions read access"
                description="Optional for future CI and Actions panels."
                control={
                    <PermissionBadge enabled={state.status.canReadActions} />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Permissions"
                label="Actions write access"
                description="Required to re-run failed jobs or cancel workflow runs."
                control={
                    <PermissionBadge enabled={state.status.canWriteActions} />
                }
            />
            {isConnected && state.status.readOnly ? (
                <SearchableRow
                    searchQuery={searchQuery}
                    section="Permissions"
                    label="Write actions"
                    description="Some actions are disabled because the token is missing write permissions."
                    control={<DangerText>read-only</DangerText>}
                />
            ) : null}
        </div>
    );
}

function PermissionBadge({ enabled }: { enabled: boolean }) {
    return enabled ? (
        <PositiveText>enabled</PositiveText>
    ) : (
        <StatusText tone="neutral">unavailable</StatusText>
    );
}

function PositiveText({ children }: { children: string }) {
    return <StatusText tone="positive">{children}</StatusText>;
}

function DangerText({ children }: { children: string }) {
    return <StatusText tone="danger">{children}</StatusText>;
}

function StatusText({
    children,
    tone,
}: {
    readonly children: string;
    readonly tone: "danger" | "neutral" | "positive";
}) {
    const colors: Record<typeof tone, string> = {
        danger: "var(--diff-remove)",
        neutral: "var(--color-text-secondary)",
        positive: "var(--diff-add)",
    };

    return (
        <span
            style={{
                color: colors[tone],
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
            }}
        >
            {children}
        </span>
    );
}

function formatGitHubStatusDescription(state: SettingsGitHubState): string {
    const login = state.status.user?.login;
    const viaGhCli = state.status.tokenSource === "gh_cli";
    switch (state.status.state) {
        case "authenticated": {
            const source = viaGhCli ? " via gh CLI" : "";
            return login
                ? `Connected to ${state.status.host} as ${login}${source}.`
                : `Connected to ${state.status.host}${source}.`;
        }
        case "invalid":
            return "The GitHub token is invalid or expired. Paste a new token to reconnect.";
        case "missing":
            return "No token found. Paste a PAT below or log in with the gh CLI.";
        case "unknown":
        default:
            return "GitHub auth status could not be verified yet.";
    }
}

function AppearanceContent({
    searchQuery,
    state,
}: {
    searchQuery: SettingsSearchQuery;
    state: SettingsThemeControlState;
}) {
    const isMac =
        typeof navigator !== "undefined" &&
        navigator.platform.toLowerCase().startsWith("mac");
    const appZoomShortcut = isMac
        ? "⌘= / ⌘- / ⌘0"
        : "Ctrl= / Ctrl- / Ctrl0";
    const showWorkspace = sectionHasMatches(searchQuery, "Workspace", [
        [
            "File tree size",
            "Scale the rows, icons, and labels in the file tree.",
        ],
        [
            "Sidebar list size",
            "Scale text and rows in the Agents, Issues, and Pull Requests sidebars.",
        ],
        [
            "Sticky folders",
            "Keep parent folders pinned while scrolling the file tree.",
        ],
        [
            "Window transparency",
            "Use native acrylic transparency on Windows and vibrancy on macOS.",
        ],
    ]);
    const showMode = sectionHasMatches(searchQuery, "Mode", [
        [
            "System theme",
            "Choose how the app looks. System follows your OS preference.",
            "Light",
            "Dark",
        ],
    ]);
    const showTheme = matchesSearch(
        searchQuery,
        "Theme",
        "Visual presets",
        ...state.presets.flatMap((preset) => [
            preset.id,
            preset.label,
            preset.description,
        ]),
    );
    const showAccessibility = sectionHasMatches(searchQuery, "Accessibility", [
        [
            "Boost code contrast",
            "Darken or lighten syntax colors that fall below the WCAG AA contrast ratio against the editor background. Turn this off to see each preset's exact original palette.",
        ],
    ]);
    const showZoom = sectionHasMatches(searchQuery, "Zoom", [
        [
            "App zoom",
            `Scale the entire app UI, in percent. Use ${appZoomShortcut} from the keyboard or the View menu. Editor, chat, and composer font sizes stay independent.`,
        ],
    ]);

    return (
        <div>
            {showWorkspace ? <SectionLabel>Workspace</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Workspace"
                label="File tree size"
                description="Scale the rows, icons, and labels in the file tree."
                control={
                    <SliderField
                        value={state.fileTreeScale ?? 1}
                        min={FILE_TREE_SCALE_MIN}
                        max={FILE_TREE_SCALE_MAX}
                        step={FILE_TREE_SCALE_STEP}
                        onChange={(v) => state.onFileTreeScaleChange?.(v)}
                        formatValue={(v) => formatFileTreeScalePercent(v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Workspace"
                label="Sidebar list size"
                description="Scale text and rows in the Agents, Issues, and Pull Requests sidebars."
                control={
                    <PercentScaleStepper
                        label="Sidebar list size"
                        value={state.agentsSidebarScale ?? 1}
                        min={AGENTS_SIDEBAR_SCALE_MIN}
                        max={AGENTS_SIDEBAR_SCALE_MAX}
                        step={AGENTS_SIDEBAR_SCALE_STEP}
                        clampValue={clampAgentsSidebarScale}
                        onChange={(v) =>
                            state.onAgentsSidebarScaleChange?.(v)
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Workspace"
                label="Sticky folders"
                description="Keep parent folders pinned while scrolling the file tree."
                control={
                    <Toggle
                        value={state.stickyFoldersEnabled}
                        onChange={(v) =>
                            state.onStickyFoldersEnabledChange?.(v)
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Workspace"
                label="Window transparency"
                description="Use native acrylic transparency on Windows and vibrancy on macOS."
                control={
                    <Toggle
                        value={state.transparencyEnabled}
                        onChange={(v) =>
                            state.onTransparencyEnabledChange?.(v)
                        }
                    />
                }
            />

            {showMode ? <SectionLabel>Mode</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Mode"
                label="System theme"
                description="Choose how the app looks. 'System' follows your OS preference."
                keywords={["Light", "Dark"]}
                control={
                    <SegmentedControl
                        value={state.mode}
                        options={[
                            { value: "system", label: "System" },
                            { value: "light", label: "Light" },
                            { value: "dark", label: "Dark" },
                        ]}
                        onChange={(v) => state.onModeChange?.(v)}
                    />
                }
            />

            {showTheme ? (
                <>
                    <SectionLabel>Theme</SectionLabel>
                    <ThemePicker
                        value={state.presetId}
                        presets={state.presets}
                        onChange={(id) => state.onPresetChange?.(id)}
                    />
                </>
            ) : null}

            {showAccessibility ? (
                <SectionLabel>Accessibility</SectionLabel>
            ) : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Accessibility"
                label="Boost code contrast"
                description="Darken or lighten syntax colors that fall below the WCAG AA contrast ratio against the editor background. Turn this off to see each preset's exact original palette."
                control={
                    <Toggle
                        value={state.boostCodeContrast}
                        onChange={(v) =>
                            state.onBoostCodeContrastChange?.(v)
                        }
                    />
                }
            />

            {showZoom ? <SectionLabel>Zoom</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Zoom"
                label="App zoom"
                description={`Scale the entire app UI, in percent. Use ${appZoomShortcut} from the keyboard or the View menu. Editor, chat, and composer font sizes stay independent.`}
                control={
                    <PercentScaleStepper
                        label="App zoom"
                        value={state.zoomFactor ?? 1}
                        min={APP_ZOOM_FACTOR_MIN}
                        max={APP_ZOOM_FACTOR_MAX}
                        step={APP_ZOOM_FACTOR_STEP}
                        clampValue={clampAppZoomFactor}
                        onChange={(v) => state.onZoomFactorChange?.(v)}
                    />
                }
            />
        </div>
    );
}

function PercentScaleStepper({
    clampValue,
    label,
    max,
    min,
    step,
    value,
    onChange,
}: {
    clampValue: (value: number) => number;
    label: string;
    max: number;
    min: number;
    step: number;
    value: number;
    onChange: (value: number) => void;
}) {
    const scale = clampValue(value);
    const scalePercent = Math.round(scale * 100);
    const canDecrease = scale > min;
    const canIncrease = scale < max;
    const changeBy = (direction: -1 | 1) => {
        onChange(clampValue(scale + step * direction));
    };

    const buttonStyle = (disabled: boolean): CSSProperties => ({
        alignItems: "center",
        background: "transparent",
        border: "none",
        color: "var(--color-text-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex",
        fontFamily: "inherit",
        fontSize: 13,
        height: 26,
        justifyContent: "center",
        opacity: disabled ? 0.45 : 1,
        padding: 0,
        transition: "background-color 100ms ease, color 100ms ease",
        width: 28,
    });

    return (
        <div
            aria-label={label}
            role="group"
            style={{
                alignItems: "center",
                backgroundColor: "var(--color-bg-tertiary)",
                border: "1px solid var(--color-border)",
                borderRadius: 6,
                display: "inline-flex",
                overflow: "hidden",
            }}
        >
            <button
                aria-label={`Decrease ${label.toLowerCase()}`}
                disabled={!canDecrease}
                onClick={() => changeBy(-1)}
                onMouseEnter={(e) => {
                    if (canDecrease) {
                        e.currentTarget.style.backgroundColor =
                            "var(--color-bg-secondary)";
                        e.currentTarget.style.color =
                            "var(--color-text-primary)";
                    }
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.color = "var(--color-text-secondary)";
                }}
                style={buttonStyle(!canDecrease)}
                type="button"
            >
                −
            </button>
            <span
                style={{
                    color: "var(--color-text-primary)",
                    fontSize: 12,
                    fontVariantNumeric: "tabular-nums",
                    minWidth: 32,
                    textAlign: "center",
                }}
            >
                {scalePercent}
            </span>
            <button
                aria-label={`Increase ${label.toLowerCase()}`}
                disabled={!canIncrease}
                onClick={() => changeBy(1)}
                onMouseEnter={(e) => {
                    if (canIncrease) {
                        e.currentTarget.style.backgroundColor =
                            "var(--color-bg-secondary)";
                        e.currentTarget.style.color =
                            "var(--color-text-primary)";
                    }
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.color = "var(--color-text-secondary)";
                }}
                style={buttonStyle(!canIncrease)}
                type="button"
            >
                +
            </button>
        </div>
    );
}

function EditorContent({
    searchQuery,
    state,
}: {
    searchQuery: SettingsSearchQuery;
    state: SettingsEditorControlState;
}) {
    const isMac =
        typeof navigator !== "undefined" &&
        navigator.platform.toLowerCase().startsWith("mac");
    const editorZoomShortcut = isMac
        ? "⌘+⌥+Plus / ⌘+⌥+- / ⌘+⌥+0"
        : "Ctrl+Alt+Plus / Ctrl+Alt+- / Ctrl+Alt+0";
    const showTypography = sectionHasMatches(searchQuery, "Typography", [
        [
            "Autosave delay",
            "Delay after the last edit before dirty files are saved automatically, in milliseconds.",
            "save files",
        ],
        [
            "Font size",
            `Text size in the editor, in pixels. This does not change the overall app zoom. Shortcut: ${editorZoomShortcut}.`,
        ],
        [
            "Font family",
            "Font used in the editor.",
            ...state.fontFamilies.flatMap((font) => [
                font.id,
                font.group,
                font.label,
                font.description,
                font.preview,
            ]),
        ],
        ["Line spacing", "Line height multiplier for the editor."],
        ["Minimap", "Show Monaco's code minimap on the side of the editor."],
        [
            "Relative line numbers",
            "Show line numbers as distance from the cursor.",
            "vim motions",
            "5j 3k",
        ],
        [
            "Autocomplete suggestions",
            "Show Monaco suggestions automatically while typing. You can still trigger them manually.",
        ],
        [
            "Vim mode",
            "Use Vim keybindings in Monaco editors. Disabled by default.",
            "modal editing",
            "normal insert visual command",
        ],
    ]);

    return (
        <div>
            {showTypography ? <SectionLabel>Typography</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Typography"
                label="Autosave delay"
                description="Delay after the last edit before dirty files are saved automatically, in milliseconds."
                keywords={["save files"]}
                control={
                    <NumberStepper
                        value={state.autoSaveDelayMs}
                        min={EDITOR_AUTOSAVE_DELAY_MS_MIN}
                        max={EDITOR_AUTOSAVE_DELAY_MS_MAX}
                        inputWidth={52}
                        onChange={(v) => state.onAutoSaveDelayMsChange?.(v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Typography"
                label="Font size"
                description={`Text size in the editor, in pixels. This does not change the overall app zoom. Shortcut: ${editorZoomShortcut}.`}
                control={
                    <NumberStepper
                        value={state.fontSize}
                        min={EDITOR_FONT_SIZE_MIN}
                        max={EDITOR_FONT_SIZE_MAX}
                        onChange={(v) => state.onFontSizeChange?.(v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Typography"
                label="Font family"
                description="Font used in the editor."
                keywords={state.fontFamilies.flatMap((font) => [
                    font.id,
                    font.group,
                    font.label,
                    font.description,
                    font.preview,
                ])}
                control={
                    <SelectField
                        value={state.fontFamilyId}
                        options={state.fontFamilies.map((f) => ({
                            disabled: f.disabled,
                            group: f.group,
                            value: f.id,
                            label: f.label,
                        }))}
                        onChange={(v) => state.onFontFamilyChange?.(v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Typography"
                label="Line spacing"
                description="Line height multiplier for the editor."
                control={
                    <SliderField
                        value={state.lineHeight}
                        min={1.2}
                        max={2}
                        step={0.05}
                        onChange={(v) => state.onLineHeightChange?.(v)}
                        formatValue={(v) => `${v.toFixed(2)}x`}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Typography"
                label="Minimap"
                description="Show Monaco's code minimap on the side of the editor."
                control={
                    <Toggle
                        value={state.minimapEnabled}
                        onChange={(v) => state.onMinimapEnabledChange?.(v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Typography"
                label="Relative line numbers"
                description="Show line numbers as distance from the cursor."
                keywords={["vim motions", "5j 3k"]}
                control={
                    <Toggle
                        value={state.relativeLineNumbersEnabled}
                        onChange={(v) =>
                            state.onRelativeLineNumbersEnabledChange?.(v)
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Typography"
                label="Autocomplete suggestions"
                description="Show Monaco suggestions automatically while typing. You can still trigger them manually."
                control={
                    <Toggle
                        value={state.suggestionsEnabled}
                        onChange={(v) => state.onSuggestionsEnabledChange?.(v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Typography"
                label="Vim mode"
                description="Use Vim keybindings in Monaco editors. Disabled by default."
                keywords={["modal editing", "normal insert visual command"]}
                control={
                    <Toggle
                        value={state.vimModeEnabled}
                        onChange={(v) => state.onVimModeEnabledChange?.(v)}
                    />
                }
            />
        </div>
    );
}

export function TerminalContent({
    searchQuery,
    state,
}: {
    searchQuery: SettingsSearchQuery;
    state: SettingsTerminalState;
}) {
    const modelOptions = CLAUDE_CODE_MODEL_OPTIONS.map((option) => ({
        label: option.label,
        value: option.value,
    }));
    const windowsShellOptions = WINDOWS_TERMINAL_SHELL_OPTIONS.map(
        (option) => ({
            label: option.label,
            value: option.value,
        }),
    );
    const showFont = sectionHasMatches(searchQuery, "Font", [
        [
            "Font family",
            "Font used by integrated terminals. Leave blank to use Comando's default terminal font stack.",
            "Nerd Fonts",
            "FiraCode",
            state.terminalFontFamily,
        ],
        ["Font size", "Text size in integrated terminals, in pixels."],
    ]);
    const windowsShellRowSearchValues = [
        "Windows shell",
        "Choose which shell new integrated terminals open on Windows.",
        "Default",
        "Command Prompt",
        "cmd.exe",
        "Windows PowerShell",
        "PowerShell 7",
        "pwsh",
        "PowerShell 7 (pwsh) requires PowerShell 7 to be installed on this machine.",
        "PowerShell 7 (pwsh) was not found. New terminals will fall back to Windows PowerShell.",
        "Using PowerShell 7 for new terminals.",
        state.windowsShell,
    ] as const;
    const showWindowsShellRow =
        state.isWindows === true &&
        matchesSearch(
            searchQuery,
            "Shell Environment",
            ...windowsShellRowSearchValues,
        );
    const showShellEnvironment = sectionHasMatches(
        searchQuery,
        "Shell Environment",
        [
            ...(state.isWindows === true ? [windowsShellRowSearchValues] : []),
            [
                "Fullscreen rendering (experimental)",
                "Sets CLAUDE_CODE_NO_FLICKER=1. Reduces flicker in Claude Code but disables scrollback. Applies to new terminals only.",
                "CLAUDE_CODE_NO_FLICKER",
            ],
        ],
    );
    const showClaudeCode = sectionHasMatches(searchQuery, "Claude Code", [
        [
            "Claude Code CLI",
            "Install the claude command to use the launcher.",
            "claude command",
        ],
        [
            "Skip permissions",
            "Passes --dangerously-skip-permissions. Claude Code will not ask for approval before running tools or writing files.",
            "--dangerously-skip-permissions",
            "dangerously-skip-permissions",
        ],
        [
            "Model",
            "Model passed to Claude Code when launching from Comando.",
            ...CLAUDE_CODE_MODEL_OPTIONS.flatMap((option) => [
                option.label,
                option.value,
            ]),
        ],
        ["Continue last session", "Passes --continue to Claude Code."],
    ]);

    if (!showFont && !showShellEnvironment && !showClaudeCode) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            {showFont ? <SectionLabel>Font</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Font"
                label="Font family"
                description="Font used by integrated terminals. Leave blank to use Comando's default terminal font stack."
                keywords={["Nerd Fonts", "FiraCode", state.terminalFontFamily]}
                control={
                    <input
                        aria-label="Terminal font family"
                        autoCapitalize="off"
                        autoCorrect="off"
                        onChange={(event) =>
                            state.onTerminalFontFamilyChange?.(
                                normalizeTerminalFontFamily(
                                    event.target.value,
                                ),
                            )
                        }
                        placeholder="e.g. FiraCode Nerd Font"
                        spellCheck={false}
                        style={{
                            backgroundColor: "var(--color-bg-tertiary)",
                            border: "1px solid var(--color-border)",
                            borderRadius: 6,
                            color: "var(--color-text-primary)",
                            fontFamily: "var(--font-mono)",
                            fontSize: 12,
                            height: 28,
                            outline: "none",
                            padding: "0 9px",
                            width: 240,
                        }}
                        type="text"
                        value={state.terminalFontFamily}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Font"
                label="Font size"
                description="Text size in integrated terminals, in pixels."
                control={
                    <NumberStepper
                        ariaLabel="Terminal font size"
                        value={state.terminalFontSize}
                        min={TERMINAL_FONT_SIZE_MIN}
                        max={TERMINAL_FONT_SIZE_MAX}
                        onChange={(value) =>
                            state.onTerminalFontSizeChange?.(
                                normalizeTerminalFontSize(value),
                            )
                        }
                    />
                }
            />

            {showShellEnvironment ? (
                <SectionLabel>Shell Environment</SectionLabel>
            ) : null}
            {state.isWindows === true ? (
                <>
                    <SearchableRow
                        searchQuery={searchQuery}
                        section="Shell Environment"
                        label="Windows shell"
                        description="Choose which shell new integrated terminals open on Windows. Applies to new terminals only."
                        keywords={windowsShellRowSearchValues}
                        control={
                            <SelectField
                                value={state.windowsShell}
                                options={windowsShellOptions}
                                onChange={(value) =>
                                    state.onWindowsShellChange?.(
                                        normalizeWindowsTerminalShell(value),
                                    )
                                }
                            />
                        }
                    />
                    {showWindowsShellRow && state.windowsShell === "pwsh" ? (
                        <PwshRequirementBanner
                            available={state.pwshAvailable ?? null}
                        />
                    ) : null}
                </>
            ) : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Shell Environment"
                label="Fullscreen rendering (experimental)"
                description="Sets CLAUDE_CODE_NO_FLICKER=1. Reduces flicker in Claude Code but disables scrollback. Applies to new terminals only."
                keywords={["CLAUDE_CODE_NO_FLICKER"]}
                control={
                    <Toggle
                        value={state.claudeCodeOptimized}
                        onChange={(value) =>
                            state.onClaudeCodeOptimizedChange?.(value)
                        }
                    />
                }
            />

            {showClaudeCode ? <SectionLabel>Claude Code</SectionLabel> : null}
            {state.claudeCodeAvailable === false ? (
                <SearchableRow
                    searchQuery={searchQuery}
                    section="Claude Code"
                    label="Claude Code CLI"
                    description="Install the claude command to use the launcher."
                    keywords={["claude command", "launcher"]}
                    control={
                        <span
                            style={{
                                color: "var(--color-text-secondary)",
                                fontFamily: "var(--font-mono)",
                                fontSize: 11,
                            }}
                        >
                            not found
                        </span>
                    }
                />
            ) : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Claude Code"
                label="Skip permissions"
                description="Passes --dangerously-skip-permissions. Claude Code will not ask for approval before running tools or writing files."
                keywords={[
                    "--dangerously-skip-permissions",
                    "dangerously-skip-permissions",
                    "approval",
                    "tools",
                    "write files",
                ]}
                control={
                    <Toggle
                        value={state.claudeCodeSkipPermissions}
                        onChange={(value) =>
                            state.onClaudeCodeSkipPermissionsChange?.(value)
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Claude Code"
                label="Model"
                description="Model passed to Claude Code when launching from Comando."
                keywords={CLAUDE_CODE_MODEL_OPTIONS.flatMap((option) => [
                    option.label,
                    option.value,
                ])}
                control={
                    <SelectField
                        value={state.claudeCodeModel}
                        options={modelOptions}
                        onChange={(value) =>
                            state.onClaudeCodeModelChange?.(value)
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Claude Code"
                label="Continue last session"
                description="Passes --continue to Claude Code."
                keywords={["--continue", "continue"]}
                control={
                    <Toggle
                        value={state.claudeCodeContinueSession}
                        onChange={(value) =>
                            state.onClaudeCodeContinueSessionChange?.(value)
                        }
                    />
                }
            />
        </div>
    );
}

function PwshRequirementBanner({
    available,
}: {
    readonly available: boolean | null;
}) {
    const message =
        available === false
            ? "PowerShell 7 (pwsh) was not found. New terminals will fall back to Windows PowerShell."
            : available === true
              ? "Using PowerShell 7 for new terminals."
              : "PowerShell 7 (pwsh) requires PowerShell 7 to be installed on this machine. If it is missing, new terminals will fall back to Windows PowerShell.";

    return (
        <div
            style={{
                backgroundColor:
                    available === false
                        ? "color-mix(in srgb, var(--diff-warn) 12%, transparent)"
                        : "color-mix(in srgb, var(--color-accent) 8%, transparent)",
                border:
                    available === false
                        ? "1px solid color-mix(in srgb, var(--diff-warn) 32%, var(--color-border))"
                        : "1px solid color-mix(in srgb, var(--color-accent) 24%, var(--color-border))",
                borderRadius: 8,
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1.45,
                marginTop: 8,
                padding: "8px 10px",
            }}
        >
            {message}
        </div>
    );
}

function AiChatContent({
    searchQuery,
    state,
}: {
    searchQuery: SettingsSearchQuery;
    state: SettingsAiChatState;
}) {
    const isMac =
        typeof navigator !== "undefined" &&
        navigator.platform.startsWith("Mac");
    const sendShortcut = isMac ? "⌘+Enter" : "Ctrl+Enter";
    const chatFontKeywords = state.chatFontFamilies.flatMap((font) => [
        font.id,
        font.group,
        font.label,
    ]);
    const composerFontKeywords = state.composerFontFamilies.flatMap((font) => [
        font.id,
        font.group,
        font.label,
    ]);
    const showChat = sectionHasMatches(searchQuery, "Chat", [
        [
            "Chat font family",
            "Font used for messages in the chat.",
            ...chatFontKeywords,
        ],
        ["Chat font size", "Font size of messages in the chat, in pixels."],
        [
            "Tool activity",
            "Choose whether tool activity starts collapsed or expanded.",
            "Collapsed",
            "Expanded",
            "tools default disclosure",
        ],
    ]);
    const showReview = sectionHasMatches(searchQuery, "Review", [
        [
            "Chat history retention",
            "How long saved chat histories stay on disk before automatic deletion.",
            "Forever",
            "1 day",
            "7 days",
            "30 days",
            "90 days",
            "1 year",
        ],
    ]);
    const showComposer = sectionHasMatches(searchQuery, "Composer", [
        [
            `Require ${sendShortcut} to send`,
            `Press ${sendShortcut} to send messages. Enter alone adds a new line.`,
            "command enter control enter keyboard shortcut",
        ],
        [
            "Context window indicator",
            "Show a thin bar below the composer indicating how much of the context window is in use.",
            "token usage",
        ],
        [
            "Screenshot retention",
            "How long pasted screenshots stay in the composer before automatic removal.",
            "Forever",
            "seconds",
            "minutes",
        ],
        [
            "Composer font family",
            "Font used in the message input box.",
            ...composerFontKeywords,
        ],
        ["Composer font size", "Font size of the message input box, in pixels."],
    ]);

    return (
        <div>
            {showChat ? <SectionLabel>Chat</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Chat"
                label="Chat font family"
                description="Font used for messages in the chat."
                keywords={chatFontKeywords}
                control={
                    <SelectField
                        value={state.chatFontFamily}
                        options={state.chatFontFamilies.map((f) => ({
                            disabled: f.disabled,
                            group: f.group,
                            value: f.id,
                            label: f.label,
                        }))}
                        onChange={(v) => state.onChatFontFamilyChange?.(v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Chat"
                label="Chat font size"
                description="Font size of messages in the chat, in pixels."
                control={
                    <NumberStepper
                        value={state.chatFontSize}
                        min={AI_CHAT_FONT_SIZE_MIN}
                        max={AI_CHAT_FONT_SIZE_MAX}
                        onChange={(v) => state.onChatFontSizeChange?.(v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Chat"
                label="Tool activity"
                description="Choose whether tool activity starts collapsed or expanded."
                keywords={[
                    "Collapsed",
                    "Expanded",
                    "tools",
                    "default",
                    "disclosure",
                ]}
                control={
                    <SelectField
                        value={state.toolActivityDefaultExpansion}
                        options={[
                            { value: "collapsed", label: "Collapsed" },
                            { value: "expanded", label: "Expanded" },
                        ]}
                        onChange={(value) =>
                            state.onToolActivityDefaultExpansionChange?.(value)
                        }
                    />
                }
            />
            {showReview ? <SectionLabel>Review</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Review"
                label="Chat history retention"
                description="How long saved chat histories stay on disk before automatic deletion."
                keywords={[
                    "Forever",
                    "1 day",
                    "7 days",
                    "30 days",
                    "90 days",
                    "1 year",
                ]}
                control={
                    <SelectField
                        value={state.historyRetentionDays}
                        options={[
                            { value: 0, label: "Forever" },
                            { value: 1, label: "1 day" },
                            { value: 7, label: "7 days" },
                            { value: 30, label: "30 days" },
                            { value: 90, label: "90 days" },
                            { value: 365, label: "1 year" },
                        ]}
                        onChange={(v) =>
                            state.onHistoryRetentionChange?.(Number(v))
                        }
                    />
                }
            />

            {showComposer ? <SectionLabel>Composer</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Composer"
                label={`Require ${sendShortcut} to send`}
                description={`Press ${sendShortcut} to send messages. Enter alone adds a new line.`}
                keywords={[
                    "command enter",
                    "control enter",
                    "keyboard shortcut",
                ]}
                control={
                    <Toggle
                        value={state.requireCmdEnterToSend}
                        onChange={(v) => state.onRequireCmdEnterChange?.(v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Composer"
                label="Context window indicator"
                description="Show a thin bar below the composer indicating how much of the context window is in use."
                keywords={["token usage"]}
                control={
                    <Toggle
                        value={state.contextUsageBarEnabled}
                        onChange={(v) =>
                            state.onContextUsageBarEnabledChange?.(v)
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Composer"
                label="Screenshot retention"
                description="How long pasted screenshots stay in the composer before automatic removal."
                keywords={["Forever", "seconds", "minutes"]}
                control={
                    <SelectField
                        value={state.screenshotRetentionSeconds}
                        options={[
                            { value: 0, label: "Forever" },
                            { value: 30, label: "30 seconds" },
                            { value: 60, label: "1 minute" },
                            { value: 300, label: "5 minutes" },
                            { value: 900, label: "15 minutes" },
                            { value: 1800, label: "30 minutes" },
                        ]}
                        onChange={(v) =>
                            state.onScreenshotRetentionChange?.(Number(v))
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Composer"
                label="Composer font family"
                description="Font used in the message input box."
                keywords={composerFontKeywords}
                control={
                    <SelectField
                        value={state.composerFontFamily}
                        options={state.composerFontFamilies.map((f) => ({
                            disabled: f.disabled,
                            group: f.group,
                            value: f.id,
                            label: f.label,
                        }))}
                        onChange={(v) => state.onComposerFontFamilyChange?.(v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Composer"
                label="Composer font size"
                description="Font size of the message input box, in pixels."
                control={
                    <NumberStepper
                        value={state.composerFontSize}
                        min={AI_COMPOSER_FONT_SIZE_MIN}
                        max={AI_COMPOSER_FONT_SIZE_MAX}
                        onChange={(v) => state.onComposerFontSizeChange?.(v)}
                    />
                }
            />
        </div>
    );
}

function PrivacyContent({
    onOpenFullDiskAccessSettings,
    searchQuery,
    state,
}: SettingsPrivacyState & { readonly searchQuery: SettingsSearchQuery }) {
    const canOpenSettings =
        state.canOpenFullDiskAccessSettings &&
        onOpenFullDiskAccessSettings !== undefined;
    const showProtectedFolders = sectionHasMatches(
        searchQuery,
        "Protected folders",
        [
            ["macOS filesystem access", state.message, state.status],
            ["Last blocked path", state.lastDeniedPath],
            [
                "Full Disk Access",
                "If macOS blocks Comando from opening projects in Documents, Desktop, or other protected folders, add Comando to Privacy & Security > Full Disk Access.",
            ],
        ],
    );

    return (
        <div>
            {showProtectedFolders ? (
                <SectionLabel>Protected folders</SectionLabel>
            ) : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Protected folders"
                label="macOS filesystem access"
                description={state.message}
                keywords={[state.status]}
                control={<PrivacyStatusBadge status={state.status} />}
            />
            {state.lastDeniedPath ? (
                <SearchableRow
                    searchQuery={searchQuery}
                    section="Protected folders"
                    label="Last blocked path"
                    description={state.lastDeniedPath}
                    control={null}
                />
            ) : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Protected folders"
                label="Full Disk Access"
                description="If macOS blocks Comando from opening projects in Documents, Desktop, or other protected folders, add Comando to Privacy & Security > Full Disk Access."
                control={
                    <IdeActionButton
                        active={state.status === "attention-needed"}
                        disabled={!canOpenSettings}
                        onClick={() => onOpenFullDiskAccessSettings?.()}
                    >
                        open full disk access
                    </IdeActionButton>
                }
            />
        </div>
    );
}

function ShortcutsContent({
    searchQuery,
    shortcuts,
}: {
    searchQuery: SettingsSearchQuery;
    shortcuts: readonly ShortcutEntryOption[];
}) {
    const filteredShortcuts = shortcuts.filter((shortcut) =>
        matchesSearch(
            searchQuery,
            shortcut.section,
            shortcut.label,
            shortcut.description,
            shortcut.keys,
            shortcut.id,
        ),
    );
    const grouped = filteredShortcuts.reduce<
        Record<string, ShortcutEntryOption[]>
    >(
        (acc, shortcut) => {
            const section = shortcut.section || "General";
            if (!acc[section]) acc[section] = [];
            acc[section].push(shortcut);
            return acc;
        },
        {},
    );

    if (shortcuts.length === 0) {
        return (
            <div>
                <SectionLabel>Shortcuts</SectionLabel>
                <p
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: 12,
                        padding: "12px 0",
                    }}
                >
                    No shortcuts registered yet.
                </p>
            </div>
        );
    }

    if (filteredShortcuts.length === 0) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            {Object.entries(grouped).map(([section, items]) => (
                <div key={section}>
                    <SectionLabel>{section}</SectionLabel>
                    {items.map((shortcut) => (
                        <Row
                            key={shortcut.id}
                            label={shortcut.label}
                            description={shortcut.description}
                            control={
                                <kbd
                                    style={{
                                        backgroundColor:
                                            "var(--color-bg-secondary)",
                                        border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                                        borderRadius: 3,
                                        color: "var(--color-text-primary)",
                                        display: "inline-block",
                                        fontFamily: "var(--font-mono)",
                                        fontSize: 11,
                                        fontWeight: 500,
                                        padding: "2px 8px",
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    {shortcut.keys}
                                </kbd>
                            }
                        />
                    ))}
                </div>
            ))}
        </div>
    );
}

function UpdatesContent({
    onCheckForUpdates,
    onInstallUpdate,
    onOpenReleaseNotes,
    searchQuery,
    state,
}: SettingsUpdatesState & { readonly searchQuery: SettingsSearchQuery }) {
    const currentVersionLabel = formatVersionPillLabel(state.currentVersion);
    const lastCheckedLabel = formatLastCheckedLabel(state.lastCheckedAt);
    const primaryAction =
        state.canInstallUpdate && onInstallUpdate
            ? {
                  disabled: false,
                  label: "restart and install",
                  onClick: onInstallUpdate,
              }
            : {
                  disabled: !state.canCheckForUpdates || !onCheckForUpdates,
                  label: getCheckForUpdatesLabel(state),
                  onClick: onCheckForUpdates ?? (() => {}),
              };
    const showVersion = sectionHasMatches(searchQuery, "Version", [
        [
            "Current version",
            `You're on ${currentVersionLabel}. Last checked ${lastCheckedLabel}.`,
            primaryAction.label,
            "release notes",
            "github",
            state.currentVersion,
            state.availableVersion,
        ],
        [
            "Automatic updates",
            state.autoUpdatesEnabled
                ? "Enabled for packaged release builds. Updates download in the background and apply after restart."
                : "Unavailable on this build, channel, or packaging configuration.",
        ],
        [
            "Update status",
            state.message,
            state.status,
            state.availableVersion,
            state.progressPercent,
        ],
    ]);
    if (!showVersion) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            {showVersion ? <SectionLabel>Version</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Version"
                label="Current version"
                description={`You're on ${currentVersionLabel}. Last checked ${lastCheckedLabel}.`}
                keywords={[
                    primaryAction.label,
                    "release notes",
                    "github",
                    state.currentVersion,
                    state.availableVersion,
                ]}
                control={
                    <div
                        style={{
                            alignItems: "center",
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 8,
                            justifyContent: "flex-end",
                        }}
                    >
                        <span
                            style={{
                                backgroundColor:
                                    "color-mix(in srgb, var(--color-accent) 14%, transparent)",
                                borderRadius: 4,
                                color: "var(--color-accent)",
                                fontFamily: "var(--font-mono)",
                                fontSize: 10,
                                fontWeight: 600,
                                letterSpacing: "0.06em",
                                padding: "2px 6px",
                                textTransform: "uppercase",
                            }}
                        >
                            {currentVersionLabel}
                        </span>
                        <IdeActionButton
                            active={false}
                            disabled={!onOpenReleaseNotes}
                            onClick={onOpenReleaseNotes ?? (() => {})}
                            title="Open GitHub release notes"
                        >
                            release notes
                        </IdeActionButton>
                        <IdeActionButton
                            active={state.canInstallUpdate}
                            disabled={primaryAction.disabled}
                            onClick={primaryAction.onClick}
                        >
                            {primaryAction.label}
                        </IdeActionButton>
                    </div>
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Version"
                label="Automatic updates"
                description={
                    state.autoUpdatesEnabled
                        ? "Enabled for packaged release builds. Updates download in the background and apply after restart."
                        : "Unavailable on this build, channel, or packaging configuration."
                }
                control={
                    <Toggle
                        disabled
                        onChange={() => {}}
                        value={state.autoUpdatesEnabled}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Version"
                label="Update status"
                description={state.message}
                keywords={[
                    state.status,
                    state.availableVersion,
                    state.progressPercent,
                ]}
                control={
                    <div
                        style={{
                            alignItems: "center",
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 8,
                            justifyContent: "flex-end",
                        }}
                    >
                        <UpdateStatusBadge state={state} />
                        {state.availableVersion ? (
                            <span
                                style={{
                                    color: "var(--color-text-secondary)",
                                    fontFamily: "var(--font-mono)",
                                    fontSize: 10,
                                }}
                            >
                                {`target ${formatVersionPillLabel(state.availableVersion)}`}
                            </span>
                        ) : null}
                        {state.progressPercent !== null ? (
                            <span
                                style={{
                                    color: "var(--color-text-secondary)",
                                    fontFamily: "var(--font-mono)",
                                    fontSize: 10,
                                }}
                            >
                                {`${Math.round(state.progressPercent)}%`}
                            </span>
                        ) : null}
                    </div>
                }
            />

        </div>
    );
}

function UpdateStatusBadge({ state }: { state: AppUpdateState }) {
    const { backgroundColor, color, label } = getUpdateStatusPresentation(
        state.status,
    );

    return (
        <span
            style={{
                backgroundColor,
                borderRadius: 4,
                color,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                padding: "2px 6px",
                textTransform: "uppercase",
            }}
        >
            {label}
        </span>
    );
}

function PrivacyStatusBadge({
    status,
}: {
    status: SettingsPrivacyState["state"]["status"];
}) {
    const { backgroundColor, color, label } =
        getPrivacyStatusPresentation(status);

    return (
        <span
            style={{
                backgroundColor,
                borderRadius: 4,
                color,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                padding: "2px 6px",
                textTransform: "uppercase",
            }}
        >
            {label}
        </span>
    );
}

function GitHubStatusBadge({
    status,
}: {
    status: SettingsGitHubState["status"]["state"];
}) {
    const { backgroundColor, borderColor, color, label } =
        getGitHubStatusPresentation(status);

    return (
        <span
            style={{
                backgroundColor,
                border: `1px solid ${borderColor}`,
                borderRadius: 6,
                color,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                padding: "1px 6px",
                textTransform: "uppercase",
            }}
        >
            {label}
        </span>
    );
}

function getCheckForUpdatesLabel(state: AppUpdateState): string {
    switch (state.status) {
        case "checking":
            return "checking...";
        case "available":
        case "downloading":
            return "downloading...";
        default:
            return "check for updates";
    }
}

function formatVersionPillLabel(version: string): string {
    const normalizedVersion = version.trim();
    return normalizedVersion.length > 0
        ? `v${normalizedVersion}`
        : "unknown";
}

function formatLastCheckedLabel(lastCheckedAt: string | null): string {
    if (!lastCheckedAt) {
        return "never";
    }

    const checkedAtMs = Date.parse(lastCheckedAt);
    if (!Number.isFinite(checkedAtMs)) {
        return "recently";
    }

    const diffMs = Date.now() - checkedAtMs;
    if (diffMs < 60_000) {
        return "just now";
    }

    const diffMinutes = Math.floor(diffMs / 60_000);
    if (diffMinutes < 60) {
        return `${diffMinutes} min ago`;
    }

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
        return `${diffHours} hr ago`;
    }

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
        return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
    }

    return new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    }).format(new Date(checkedAtMs));
}

function getUpdateStatusPresentation(status: AppUpdateState["status"]): {
    readonly backgroundColor: string;
    readonly color: string;
    readonly label: string;
} {
    switch (status) {
        case "checking":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--color-accent) 12%, transparent)",
                color: "var(--color-accent)",
                label: "Checking",
            };
        case "available":
        case "downloading":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--color-accent) 14%, transparent)",
                color: "var(--color-accent)",
                label: status === "available" ? "Available" : "Downloading",
            };
        case "downloaded":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--diff-add) 18%, transparent)",
                color: "var(--diff-add)",
                label: "Ready",
            };
        case "not-available":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--color-text-secondary) 12%, transparent)",
                color: "var(--color-text-secondary)",
                label: "Up to date",
            };
        case "error":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--diff-remove) 14%, transparent)",
                color: "var(--diff-remove)",
                label: "Error",
            };
        case "idle":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--color-accent) 10%, transparent)",
                color: "var(--color-accent)",
                label: "Ready",
            };
        case "unsupported":
        default:
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--color-text-secondary) 12%, transparent)",
                color: "var(--color-text-secondary)",
                label: "Unavailable",
            };
    }
}

function getPrivacyStatusPresentation(
    status: SettingsPrivacyState["state"]["status"],
): {
    readonly backgroundColor: string;
    readonly color: string;
    readonly label: string;
} {
    switch (status) {
        case "attention-needed":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--diff-remove) 14%, transparent)",
                color: "var(--diff-remove)",
                label: "Needs attention",
            };
        case "monitoring":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--color-accent) 12%, transparent)",
                color: "var(--color-accent)",
                label: "Monitoring",
            };
        case "not-applicable":
        default:
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--color-text-secondary) 12%, transparent)",
                color: "var(--color-text-secondary)",
                label: "N/A",
            };
    }
}

function getGitHubStatusPresentation(
    status: SettingsGitHubState["status"]["state"],
): {
    readonly backgroundColor: string;
    readonly borderColor: string;
    readonly color: string;
    readonly label: string;
} {
    switch (status) {
        case "authenticated":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--diff-add) 8%, transparent)",
                borderColor:
                    "color-mix(in srgb, var(--diff-add) 35%, var(--color-border))",
                color: "var(--diff-add)",
                label: "Connected",
            };
        case "invalid":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--diff-remove) 8%, transparent)",
                borderColor:
                    "color-mix(in srgb, var(--diff-remove) 35%, var(--color-border))",
                color: "var(--diff-remove)",
                label: "Invalid",
            };
        case "missing":
            return {
                backgroundColor: "var(--color-bg-tertiary)",
                borderColor:
                    "color-mix(in srgb, var(--color-border) 60%, transparent)",
                color: "var(--color-text-secondary)",
                label: "Missing token",
            };
        case "unknown":
        default:
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--color-accent) 8%, transparent)",
                borderColor:
                    "color-mix(in srgb, var(--color-accent) 35%, var(--color-border))",
                color: "var(--color-accent)",
                label: "Unknown",
            };
    }
}
