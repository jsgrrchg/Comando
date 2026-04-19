import type { AppUpdateState } from "@shared/ipc";
import { useState } from "react";
import {
    APP_ZOOM_FACTOR_MAX,
    APP_ZOOM_FACTOR_MIN,
    APP_ZOOM_FACTOR_STEP,
    formatAppZoomPercent,
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

import type {
    RuntimeActionOption,
    RuntimeCardOption,
    SettingsAiChatState,
    SettingsEditorControlState,
    SettingsThemeControlState,
    SettingsUpdatesState,
    SettingsWindowProps,
    ShortcutEntryOption,
    ThemeMode,
} from "./settings-types";

type Category =
    | "appearance"
    | "editor"
    | "ai"
    | "shortcuts"
    | "runtimes"
    | "updates";

const CATEGORIES: { id: Category; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "editor", label: "Editor" },
    { id: "ai", label: "AI" },
    { id: "shortcuts", label: "Shortcuts" },
    { id: "runtimes", label: "AI Runtimes" },
    { id: "updates", label: "Updates" },
];

const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
    appearance: "Theme mode and visual presets",
    editor: "Typography and editor behavior",
    ai: "Chat, composer, and AI behavior",
    shortcuts: "Keyboard shortcuts reference",
    runtimes: "AI runtime authentication and wiring",
    updates: "App version and changelog",
};

export function SettingsWindow({
    aiChat,
    appAppearance,
    appEditor,
    onRuntimeAction,
    shortcuts = [],
    runtimes = [],
    updates,
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
                    alignItems: "center",
                    backgroundColor: "var(--color-bg-secondary)",
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
                    style={{
                        backgroundColor: "var(--color-bg-secondary)",
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
                            const isActive = cat.id === active;
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
                    </div>
                </div>

                {/* Content */}
                <div
                    style={{
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
                            {CATEGORY_DESCRIPTIONS[active]}
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
                            {active === "appearance" && (
                                <AppearanceContent state={appAppearance} />
                            )}
                            {active === "editor" && (
                                <EditorContent state={appEditor} />
                            )}
                            {active === "ai" && (
                                <AiChatContent state={aiChat} />
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
                            {active === "updates" && (
                                <UpdatesContent
                                    changelog={updates.changelog}
                                    onCheckForUpdates={
                                        updates.onCheckForUpdates
                                    }
                                    onInstallUpdate={updates.onInstallUpdate}
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
                label="Autosave delay"
                description="Delay after the last edit before dirty files are saved automatically, in milliseconds."
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
                label="Context window indicator"
                description="Show a thin bar below the composer indicating how much of the context window is in use."
                control={
                    <Toggle
                        value={state.contextUsageBarEnabled}
                        onChange={(v) =>
                            state.onContextUsageBarEnabledChange?.(v)
                        }
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
                borderBottom:
                    "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                padding: "14px 0",
            }}
        >
            <div
                style={{
                    alignItems: "center",
                    display: "flex",
                    gap: 12,
                    justifyContent: "space-between",
                }}
            >
                <div style={{ minWidth: 0 }}>
                    <div
                        style={{
                            alignItems: "center",
                            display: "flex",
                            gap: 8,
                        }}
                    >
                        <span
                            style={{
                                color: "var(--color-text-primary)",
                                fontSize: 13,
                                fontWeight: 500,
                            }}
                        >
                            {runtime.name}
                        </span>
                        {runtime.status && (
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
                                {runtime.status}
                            </span>
                        )}
                    </div>
                    {runtime.description && (
                        <div
                            style={{
                                color: "var(--color-text-secondary)",
                                fontSize: 11,
                                lineHeight: 1.4,
                                marginTop: 2,
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
                            flexShrink: 0,
                            gap: 6,
                        }}
                    >
                        {runtime.actions.map((action) => (
                            <RuntimeActionBtn
                                action={action}
                                key={action.id}
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
                        backgroundColor: "var(--color-bg-secondary)",
                        border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                        borderRadius: 6,
                        color: "var(--color-text-secondary)",
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        lineHeight: 1.5,
                        marginTop: 6,
                        padding: "6px 8px",
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

    if (isDanger) {
        return (
            <button
                disabled={action.disabled}
                onClick={onClick}
                style={{
                    background: "transparent",
                    border: "1px solid color-mix(in srgb, var(--diff-remove) 60%, transparent)",
                    borderRadius: 3,
                    color: "var(--diff-remove)",
                    cursor: action.disabled ? "not-allowed" : "pointer",
                    fontSize: 10,
                    fontWeight: 500,
                    lineHeight: "20px",
                    opacity: action.disabled ? 0.4 : 1,
                    padding: "0 8px",
                }}
                title={action.hint}
                type="button"
            >
                {action.label.toLowerCase()}
            </button>
        );
    }

    return (
        <IdeActionButton
            active={isPrimary}
            disabled={action.disabled}
            onClick={onClick}
            title={action.hint}
        >
            {action.label.toLowerCase()}
        </IdeActionButton>
    );
}

function UpdatesContent({
    changelog,
    onCheckForUpdates,
    onInstallUpdate,
    state,
}: SettingsUpdatesState) {
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

    return (
        <div>
            <SectionLabel>Version</SectionLabel>
            <Row
                label="Current version"
                description={`You're on ${currentVersionLabel}. Last checked ${lastCheckedLabel}.`}
                control={
                    <div
                        style={{
                            alignItems: "center",
                            display: "flex",
                            gap: 8,
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
                            active={state.canInstallUpdate}
                            disabled={primaryAction.disabled}
                            onClick={primaryAction.onClick}
                        >
                            {primaryAction.label}
                        </IdeActionButton>
                    </div>
                }
            />
            <Row
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
            <Row
                label="Update status"
                description={state.message}
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

            <SectionLabel>Changelog</SectionLabel>
            <div style={{ paddingTop: 4 }}>
                {changelog.length > 0 ? (
                    changelog.map((entry) => (
                        <ChangelogItem
                            entry={entry}
                            isLatest={entry.version === state.currentVersion}
                            key={entry.version}
                        />
                    ))
                ) : (
                    <div
                        style={{
                            color: "var(--color-text-secondary)",
                            fontFamily: "var(--font-mono)",
                            fontSize: 11,
                            padding: "8px 0",
                        }}
                    >
                        No changelog entries found in CHANGELOG.md.
                    </div>
                )}
            </div>
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

function ChangelogItem({
    entry,
    isLatest,
}: {
    entry: {
        readonly date: string | null;
        readonly highlights: readonly string[];
        readonly version: string;
    };
    isLatest: boolean;
}) {
    return (
        <div
            style={{
                borderBottom:
                    "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                padding: "14px 0",
            }}
        >
            <div
                style={{
                    alignItems: "center",
                    display: "flex",
                    gap: 8,
                    marginBottom: 6,
                }}
            >
                <span
                    style={{
                        color: "var(--color-text-primary)",
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        fontWeight: 600,
                    }}
                >
                    {`v${entry.version}`}
                </span>
                {isLatest && (
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
                        Latest
                    </span>
                )}
                <span
                    style={{
                        color: "var(--color-text-secondary)",
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        marginLeft: "auto",
                    }}
                >
                    {entry.date ?? "No date"}
                </span>
            </div>
            <ul
                style={{
                    color: "var(--color-text-secondary)",
                    fontSize: 12,
                    lineHeight: 1.5,
                    listStyle: "disc",
                    margin: 0,
                    paddingLeft: 18,
                }}
            >
                {entry.highlights.map((item) => (
                    <li key={item} style={{ marginBottom: 2 }}>
                        {item}
                    </li>
                ))}
            </ul>
        </div>
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
