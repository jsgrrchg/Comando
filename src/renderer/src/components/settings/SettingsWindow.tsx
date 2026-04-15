import { useState } from "react";
import {
    PENDING_REVIEW_CARD_TEXT_ZOOM_MAX,
    PENDING_REVIEW_CARD_TEXT_ZOOM_MIN,
} from "@renderer/app/ai/sessionReviewContracts";
import {
    APP_ZOOM_FACTOR_MAX,
    APP_ZOOM_FACTOR_MIN,
    APP_ZOOM_FACTOR_STEP,
    formatAppZoomPercent,
} from "@shared/app-zoom";
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
    NumberStepper,
    Row,
    SectionLabel,
    SegmentedControl,
    SelectField,
    SliderField,
    ThemePicker,
    Toggle,
} from "./primitives";

import type {
    ProjectAppearanceState,
    ProjectEditorState,
    RuntimeActionOption,
    RuntimeCardOption,
    SettingsAiChatState,
    SettingsEditorControlState,
    SettingsThemeControlState,
    SettingsWindowProps,
    ShortcutEntryOption,
    ThemeMode,
} from "./settings-types";

type Category =
    | "appearance"
    | "editor"
    | "ai"
    | "project"
    | "shortcuts"
    | "runtimes";

const CATEGORIES: { id: Category; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "editor", label: "Editor" },
    { id: "ai", label: "AI" },
    { id: "project", label: "Project" },
    { id: "shortcuts", label: "Shortcuts" },
    { id: "runtimes", label: "AI Runtimes" },
];

const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
    appearance: "Theme mode and visual presets",
    editor: "Typography and editor defaults",
    ai: "Chat, composer, and AI behavior",
    project: "Project-specific overrides",
    shortcuts: "Keyboard shortcuts reference",
    runtimes: "AI runtime authentication and wiring",
};

export function SettingsWindow({
    aiChat,
    appAppearance,
    appEditor,
    onClose,
    onProjectSelect,
    onRuntimeAction,
    projectAppearance,
    projectEditor,
    projectName,
    projects = [],
    shortcuts = [],
    runtimes = [],
    selectedProjectId = null,
}: SettingsWindowProps) {
    const [active, setActive] = useState<Category>("appearance");
    const [search, setSearch] = useState("");

    const filteredCategories = CATEGORIES.filter(
        (c) => !search || c.label.toLowerCase().includes(search.toLowerCase()),
    );
    const activeInfo = CATEGORIES.find((c) => c.id === active)!;

    return (
        <div
            style={{
                height: "100vh",
                backgroundColor: "var(--color-bg-primary)",
                color: "var(--color-text-primary)",
                display: "flex",
                flexDirection: "column",
            }}
        >
            {/* Header */}
            <div
                className="app-drag"
                style={{
                    display: "flex",
                    alignItems: "center",
                    position: "relative",
                    padding: "0 20px",
                    height: 52,
                    borderBottom: "1px solid var(--color-border)",
                    flexShrink: 0,
                    backgroundColor: "var(--color-bg-secondary)",
                }}
            >
                <div style={{ width: 70, flexShrink: 0 }} />
                <span
                    style={{
                        position: "absolute",
                        left: "50%",
                        transform: "translateX(-50%)",
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--color-text-primary)",
                        pointerEvents: "none",
                        whiteSpace: "nowrap",
                    }}
                >
                    Settings
                </span>
                {onClose && (
                    <button
                        onClick={onClose}
                        title="Close settings (Esc)"
                        className="app-no-drag"
                        style={{
                            width: 24,
                            height: 24,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            borderRadius: 5,
                            border: "none",
                            background: "transparent",
                            cursor: "pointer",
                            fontSize: 16,
                            color: "var(--color-text-secondary)",
                            opacity: 0.6,
                            marginLeft: "auto",
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.opacity = "1";
                            e.currentTarget.style.backgroundColor =
                                "var(--color-bg-tertiary)";
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.opacity = "0.6";
                            e.currentTarget.style.backgroundColor =
                                "transparent";
                        }}
                    >
                        ✕
                    </button>
                )}
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
                    style={{
                        width: 220,
                        flexShrink: 0,
                        borderRight: "1px solid var(--color-border)",
                        display: "flex",
                        flexDirection: "column",
                        backgroundColor: "var(--color-bg-secondary)",
                        overflow: "hidden",
                    }}
                >
                    <div style={{ padding: "10px 10px 6px" }}>
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                backgroundColor: "var(--color-bg-primary)",
                                border: "1px solid var(--color-border)",
                                borderRadius: 7,
                                padding: "5px 10px",
                            }}
                        >
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 16 16"
                                fill="none"
                                style={{ opacity: 0.4, flexShrink: 0 }}
                            >
                                <circle
                                    cx="7"
                                    cy="7"
                                    r="5"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                />
                                <path
                                    d="m13 13-2.5-2.5"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                />
                            </svg>
                            <input
                                autoCapitalize="off"
                                autoCorrect="off"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search settings…"
                                className="app-no-drag"
                                spellCheck={false}
                                style={{
                                    flex: 1,
                                    border: "none",
                                    background: "transparent",
                                    fontSize: 12,
                                    color: "var(--color-text-primary)",
                                    outline: "none",
                                    fontFamily: "inherit",
                                }}
                            />
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
                            const isActive = cat.id === active;
                            return (
                                <button
                                    key={cat.id}
                                    onClick={() => setActive(cat.id)}
                                    className="app-no-drag"
                                    style={{
                                        width: "100%",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 8,
                                        padding: "6px 10px",
                                        borderRadius: 6,
                                        border: "none",
                                        cursor: "pointer",
                                        fontSize: 13,
                                        fontFamily: "inherit",
                                        textAlign: "left",
                                        backgroundColor: isActive
                                            ? "color-mix(in srgb, var(--color-accent) 14%, transparent)"
                                            : "transparent",
                                        color: isActive
                                            ? "var(--color-accent)"
                                            : "var(--color-text-secondary)",
                                        fontWeight: isActive ? 500 : 400,
                                        marginBottom: 1,
                                    }}
                                    onMouseEnter={(e) => {
                                        if (!isActive)
                                            e.currentTarget.style.backgroundColor =
                                                "var(--color-bg-tertiary)";
                                    }}
                                    onMouseLeave={(e) => {
                                        if (!isActive)
                                            e.currentTarget.style.backgroundColor =
                                                "transparent";
                                    }}
                                >
                                    {cat.label}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Content */}
                <div
                    className="shell-scrollbar"
                    style={{
                        flex: 1,
                        overflowY: "auto",
                        padding: "0 48px 48px",
                    }}
                >
                    <div style={{ maxWidth: 600 }}>
                        <div
                            style={{
                                padding: "24px 0 12px",
                                marginBottom: 4,
                            }}
                        >
                            <h2
                                style={{
                                    fontSize: 18,
                                    fontWeight: 600,
                                    color: "var(--color-text-primary)",
                                    margin: 0,
                                    lineHeight: 1.2,
                                }}
                            >
                                {activeInfo.label}
                            </h2>
                            <p
                                style={{
                                    fontSize: 12,
                                    color: "var(--color-text-secondary)",
                                    margin: "4px 0 0",
                                    fontFamily: "monospace",
                                }}
                            >
                                {CATEGORY_DESCRIPTIONS[active]}
                            </p>
                        </div>

                        {active === "appearance" && (
                            <AppearanceContent state={appAppearance} />
                        )}
                        {active === "editor" && (
                            <EditorContent state={appEditor} />
                        )}
                        {active === "ai" && <AiChatContent state={aiChat} />}
                        {active === "project" && (
                            <ProjectContent
                                projects={projects}
                                selectedProjectId={selectedProjectId}
                                onProjectSelect={onProjectSelect}
                                projectName={projectName}
                                projectAppearance={projectAppearance}
                                projectEditor={projectEditor}
                            />
                        )}
                        {active === "shortcuts" && (
                            <ShortcutsContent shortcuts={shortcuts} />
                        )}
                        {active === "runtimes" && (
                            <RuntimesContent
                                runtimes={runtimes}
                                onAction={onRuntimeAction}
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function AppearanceContent({ state }: { state: SettingsThemeControlState }) {
    const isMac =
        typeof navigator !== "undefined" &&
        navigator.platform.toLowerCase().startsWith("mac");
    const appZoomShortcut = isMac
        ? "⌘+Plus / ⌘+- / ⌘+0"
        : "Ctrl+Plus / Ctrl+- / Ctrl+0";

    return (
        <div>
            <SectionLabel>Workspace</SectionLabel>
            <Row
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

            <SectionLabel>Mode</SectionLabel>
            <Row
                label="System theme"
                description="Choose how the app looks. 'System' follows your OS preference."
                control={
                    <SegmentedControl
                        value={state.mode}
                        options={[
                            { value: "system" as ThemeMode, label: "System" },
                            { value: "light" as ThemeMode, label: "Light" },
                            { value: "dark" as ThemeMode, label: "Dark" },
                        ]}
                        onChange={(v) => state.onModeChange?.(v)}
                    />
                }
            />

            <SectionLabel>Theme</SectionLabel>
            <ThemePicker
                value={state.presetId}
                presets={state.presets}
                onChange={(id) => state.onPresetChange?.(id)}
            />

            <SectionLabel>Zoom</SectionLabel>
            <Row
                label="App zoom"
                description={`Scale the entire app UI. Use ${appZoomShortcut} from the keyboard or the View menu. Editor, chat, and composer font sizes stay independent.`}
                control={
                    <SliderField
                        value={state.zoomFactor ?? 1}
                        min={APP_ZOOM_FACTOR_MIN}
                        max={APP_ZOOM_FACTOR_MAX}
                        step={APP_ZOOM_FACTOR_STEP}
                        onChange={(v) => state.onZoomFactorChange?.(v)}
                        formatValue={(v) => formatAppZoomPercent(v)}
                    />
                }
            />
        </div>
    );
}

function EditorContent({ state }: { state: SettingsEditorControlState }) {
    const isMac =
        typeof navigator !== "undefined" &&
        navigator.platform.toLowerCase().startsWith("mac");
    const editorZoomShortcut = isMac
        ? "⌘+⌥+Plus / ⌘+⌥+- / ⌘+⌥+0"
        : "Ctrl+Alt+Plus / Ctrl+Alt+- / Ctrl+Alt+0";

    return (
        <div>
            <SectionLabel>Typography</SectionLabel>
            <Row
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
            <Row
                label="Font family"
                description="Font used in the editor."
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
            <Row
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
            <Row
                label="Minimap"
                description="Show Monaco's code minimap on the side of the editor."
                control={
                    <Toggle
                        value={state.minimapEnabled}
                        onChange={(v) => state.onMinimapEnabledChange?.(v)}
                    />
                }
            />
            <Row
                label="Autocomplete suggestions"
                description="Show Monaco suggestions automatically while typing. You can still trigger them manually."
                control={
                    <Toggle
                        value={state.suggestionsEnabled}
                        onChange={(v) => state.onSuggestionsEnabledChange?.(v)}
                    />
                }
            />
        </div>
    );
}

function ProjectContent({
    projects,
    selectedProjectId,
    onProjectSelect,
    projectName,
    projectAppearance,
    projectEditor,
}: {
    projects: SettingsWindowProps["projects"];
    selectedProjectId: string | null;
    onProjectSelect?: (projectId: string | null) => void;
    projectName?: string | null;
    projectAppearance?: ProjectAppearanceState | null;
    projectEditor?: ProjectEditorState | null;
}) {
    const projectOptions = [
        { value: "" as string, label: "App defaults only" },
        ...(projects ?? []).map((p) => ({ value: p.id, label: p.name })),
    ];

    return (
        <div>
            <SectionLabel>Scope</SectionLabel>
            <Row
                label="Active project"
                description="Select a project to configure overrides."
                control={
                    <SelectField
                        value={selectedProjectId ?? ""}
                        options={projectOptions}
                        onChange={(v) => onProjectSelect?.(v === "" ? null : v)}
                    />
                }
            />

            {!selectedProjectId && (
                <p
                    style={{
                        fontSize: 12,
                        color: "var(--color-text-secondary)",
                        padding: "20px 0",
                        lineHeight: 1.5,
                    }}
                >
                    Select a project above to configure project-specific
                    overrides. Project settings override app defaults without
                    affecting other projects.
                </p>
            )}

            {selectedProjectId && projectAppearance && (
                <>
                    <SectionLabel>Appearance override</SectionLabel>
                    <Row
                        label="Override appearance"
                        description={`Use a custom theme for ${projectName ?? "this project"}.`}
                        control={
                            <Toggle
                                value={projectAppearance.enabled}
                                onChange={(v) =>
                                    projectAppearance.onEnabledChange?.(v)
                                }
                            />
                        }
                    />
                    {projectAppearance.enabled && (
                        <>
                            <Row
                                label="Theme mode"
                                description="Override the system theme for this project."
                                control={
                                    <SegmentedControl
                                        value={projectAppearance.mode}
                                        options={[
                                            {
                                                value: "system" as ThemeMode,
                                                label: "System",
                                            },
                                            {
                                                value: "light" as ThemeMode,
                                                label: "Light",
                                            },
                                            {
                                                value: "dark" as ThemeMode,
                                                label: "Dark",
                                            },
                                        ]}
                                        onChange={(v) =>
                                            projectAppearance.onModeChange?.(v)
                                        }
                                    />
                                }
                            />
                            <ThemePicker
                                value={projectAppearance.presetId}
                                presets={projectAppearance.presets}
                                onChange={(id) =>
                                    projectAppearance.onPresetChange?.(id)
                                }
                            />
                        </>
                    )}
                </>
            )}

            {selectedProjectId && projectEditor && (
                <>
                    <SectionLabel>Editor override</SectionLabel>
                    <Row
                        label="Override editor"
                        description={`Use custom editor settings for ${projectName ?? "this project"}.`}
                        control={
                            <Toggle
                                value={projectEditor.enabled}
                                onChange={(v) =>
                                    projectEditor.onEnabledChange?.(v)
                                }
                            />
                        }
                    />
                    {projectEditor.enabled && (
                        <>
                            <Row
                                label="Font size"
                                description="Text size in the editor, in pixels."
                                control={
                                    <NumberStepper
                                        value={projectEditor.fontSize}
                                        min={EDITOR_FONT_SIZE_MIN}
                                        max={EDITOR_FONT_SIZE_MAX}
                                        onChange={(v) =>
                                            projectEditor.onFontSizeChange?.(v)
                                        }
                                    />
                                }
                            />
                            <Row
                                label="Font family"
                                description="Font used in the editor."
                                control={
                                    <SelectField
                                        value={projectEditor.fontFamilyId}
                                        options={projectEditor.fontFamilies.map(
                                            (f) => ({
                                                disabled: f.disabled,
                                                group: f.group,
                                                value: f.id,
                                                label: f.label,
                                            }),
                                        )}
                                        onChange={(v) =>
                                            projectEditor.onFontFamilyChange?.(
                                                v,
                                            )
                                        }
                                    />
                                }
                            />
                            <Row
                                label="Line spacing"
                                description="Line height multiplier."
                                control={
                                    <SliderField
                                        value={projectEditor.lineHeight}
                                        min={1.2}
                                        max={2}
                                        step={0.05}
                                        onChange={(v) =>
                                            projectEditor.onLineHeightChange?.(
                                                v,
                                            )
                                        }
                                        formatValue={(v) => `${v.toFixed(2)}x`}
                                    />
                                }
                            />
                            <Row
                                label="Minimap"
                                description="Show Monaco's code minimap for this project."
                                control={
                                    <Toggle
                                        value={projectEditor.minimapEnabled}
                                        onChange={(v) =>
                                            projectEditor.onMinimapEnabledChange?.(
                                                v,
                                            )
                                        }
                                    />
                                }
                            />
                            <Row
                                label="Autocomplete suggestions"
                                description="Show Monaco suggestions automatically while typing in this project."
                                control={
                                    <Toggle
                                        value={projectEditor.suggestionsEnabled}
                                        onChange={(v) =>
                                            projectEditor.onSuggestionsEnabledChange?.(
                                                v,
                                            )
                                        }
                                    />
                                }
                            />
                        </>
                    )}
                </>
            )}
        </div>
    );
}

function AiChatContent({ state }: { state: SettingsAiChatState }) {
    const isMac =
        typeof navigator !== "undefined" &&
        navigator.platform.startsWith("Mac");
    const sendShortcut = isMac ? "⌘+Enter" : "Ctrl+Enter";

    return (
        <div>
            <SectionLabel>Chat</SectionLabel>
            <Row
                label="Chat font family"
                description="Font used for messages in the chat."
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
            <Row
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
            <SectionLabel>Review</SectionLabel>
            <Row
                label="Review diff zoom"
                description="Default zoom for pending-review diffs. Workspace adjustments override this per session."
                control={
                    <NumberStepper
                        value={state.reviewDiffZoomPercent}
                        min={64}
                        max={96}
                        onChange={(v) =>
                            state.onReviewDiffZoomPercentChange?.(v)
                        }
                    />
                }
            />
            <Row
                label="Pending review card text"
                description="Default text size for pending-review cards in the workspace. Session overrides keep their own value."
                control={
                    <NumberStepper
                        value={state.pendingReviewCardTextZoomPercent}
                        min={Math.round(
                            PENDING_REVIEW_CARD_TEXT_ZOOM_MIN * 100,
                        )}
                        max={Math.round(
                            PENDING_REVIEW_CARD_TEXT_ZOOM_MAX * 100,
                        )}
                        onChange={(v) =>
                            state.onPendingReviewCardTextZoomPercentChange?.(v)
                        }
                    />
                }
            />
            <Row
                label="Chat history retention"
                description="How long saved chat histories stay on disk before automatic deletion."
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

            <SectionLabel>Composer</SectionLabel>
            <Row
                label={`Require ${sendShortcut} to send`}
                description={`Press ${sendShortcut} to send messages. Enter alone adds a new line.`}
                control={
                    <Toggle
                        value={state.requireCmdEnterToSend}
                        onChange={(v) => state.onRequireCmdEnterChange?.(v)}
                    />
                }
            />
            <Row
                label="Screenshot retention"
                description="How long pasted screenshots stay in the composer before automatic removal."
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
            <Row
                label="Composer font family"
                description="Font used in the message input box."
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
            <Row
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

function ShortcutsContent({
    shortcuts,
}: {
    shortcuts: readonly ShortcutEntryOption[];
}) {
    const grouped = shortcuts.reduce<Record<string, ShortcutEntryOption[]>>(
        (acc, shortcut) => {
            const section = shortcut.section || "General";
            if (!acc[section]) acc[section] = [];
            acc[section].push(shortcut);
            return acc;
        },
        {},
    );

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
                                        display: "inline-block",
                                        padding: "3px 8px",
                                        fontSize: 11,
                                        fontFamily: "inherit",
                                        fontWeight: 500,
                                        borderRadius: 6,
                                        border: "1px solid var(--color-border)",
                                        backgroundColor:
                                            "var(--color-bg-secondary)",
                                        color: "var(--color-text-primary)",
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

function RuntimesContent({
    runtimes,
    onAction,
}: {
    runtimes: readonly RuntimeCardOption[];
    onAction?: (runtimeId: string, actionId: string) => void;
}) {
    if (runtimes.length === 0) {
        return (
            <div>
                <SectionLabel>Runtimes</SectionLabel>
                <p
                    style={{
                        fontSize: 12,
                        color: "var(--color-text-secondary)",
                        padding: "12px 0",
                    }}
                >
                    No runtimes configured yet.
                </p>
            </div>
        );
    }

    return (
        <div>
            <SectionLabel>Runtimes</SectionLabel>
            {runtimes.map((runtime) => (
                <RuntimeCard
                    key={runtime.id}
                    runtime={runtime}
                    onAction={onAction}
                />
            ))}
        </div>
    );
}

function RuntimeCard({
    runtime,
    onAction,
}: {
    runtime: RuntimeCardOption;
    onAction?: (runtimeId: string, actionId: string) => void;
}) {
    return (
        <div
            style={{
                padding: "14px 0",
                borderBottom: "1px solid var(--color-border)",
            }}
        >
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                }}
            >
                <div style={{ minWidth: 0 }}>
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                        }}
                    >
                        <span
                            style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: "var(--color-text-primary)",
                            }}
                        >
                            {runtime.name}
                        </span>
                        {runtime.status && (
                            <span
                                style={{
                                    fontSize: 10,
                                    fontWeight: 600,
                                    letterSpacing: "0.04em",
                                    textTransform: "uppercase",
                                    padding: "2px 6px",
                                    borderRadius: 4,
                                    backgroundColor:
                                        "color-mix(in srgb, var(--color-accent) 14%, transparent)",
                                    color: "var(--color-accent)",
                                }}
                            >
                                {runtime.status}
                            </span>
                        )}
                    </div>
                    {runtime.description && (
                        <div
                            style={{
                                fontSize: 11,
                                color: "var(--color-text-secondary)",
                                marginTop: 2,
                                lineHeight: 1.4,
                            }}
                        >
                            {runtime.description}
                        </div>
                    )}
                </div>

                {runtime.actions && runtime.actions.length > 0 && (
                    <div
                        style={{
                            display: "flex",
                            gap: 6,
                            flexShrink: 0,
                        }}
                    >
                        {runtime.actions.map((action) => (
                            <RuntimeActionBtn
                                key={action.id}
                                action={action}
                                onClick={() =>
                                    onAction?.(runtime.id, action.id)
                                }
                            />
                        ))}
                    </div>
                )}
            </div>

            {runtime.details && (
                <div
                    style={{
                        fontSize: 11,
                        color: "var(--color-text-secondary)",
                        marginTop: 6,
                        fontFamily: "monospace",
                        lineHeight: 1.5,
                        padding: "6px 8px",
                        backgroundColor: "var(--color-bg-secondary)",
                        borderRadius: 6,
                        border: "1px solid var(--color-border)",
                    }}
                >
                    {runtime.details}
                </div>
            )}
        </div>
    );
}

function RuntimeActionBtn({
    action,
    onClick,
}: {
    action: RuntimeActionOption;
    onClick: () => void;
}) {
    const isPrimary = action.tone === "primary";
    const isDanger = action.tone === "danger";

    return (
        <button
            type="button"
            disabled={action.disabled}
            onClick={onClick}
            title={action.hint}
            style={{
                borderRadius: 6,
                border: isPrimary
                    ? "none"
                    : isDanger
                      ? "1px solid color-mix(in srgb, var(--color-danger, #e5484d) 35%, var(--color-border))"
                      : "1px solid var(--color-border)",
                backgroundColor: isPrimary
                    ? "var(--color-accent)"
                    : isDanger
                      ? "color-mix(in srgb, var(--color-danger, #e5484d) 12%, transparent)"
                      : "var(--color-bg-tertiary)",
                color: isPrimary
                    ? "#fff"
                    : isDanger
                      ? "var(--color-danger, #e5484d)"
                      : "var(--color-text-primary)",
                padding: "4px 10px",
                fontSize: 12,
                fontFamily: "inherit",
                cursor: action.disabled ? "not-allowed" : "pointer",
                opacity: action.disabled ? 0.5 : 1,
                fontWeight: isPrimary ? 500 : isDanger ? 500 : 400,
            }}
        >
            {action.label}
        </button>
    );
}
