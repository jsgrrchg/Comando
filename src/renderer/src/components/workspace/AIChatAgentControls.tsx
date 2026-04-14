import { useEffect, useMemo, useRef, useState } from "react";

import type {
    AiRuntimeId,
    AiSessionConfigOption,
    AiSessionMode,
    AiSessionModel,
} from "@shared/ipc";

interface AIChatAgentControlsProps {
    readonly configOptions: readonly AiSessionConfigOption[];
    readonly disabled?: boolean;
    readonly modeId: string;
    readonly modelId: string;
    readonly modes: readonly AiSessionMode[];
    readonly models: readonly AiSessionModel[];
    readonly onConfigOptionChange: (
        optionId: string,
        value: boolean | string,
    ) => void;
    readonly onModeChange: (modeId: string) => void;
    readonly onModelChange: (modelId: string) => void;
    readonly runtimeId: AiRuntimeId;
}

interface DropdownOption {
    readonly description?: string | null;
    readonly groupLabel?: string | null;
    readonly label: string;
    readonly value: string;
}

interface DropdownFieldProps {
    readonly disabled?: boolean;
    readonly emptySearchMessage?: string;
    readonly label: string;
    readonly onChange: (value: string) => void;
    readonly options: readonly DropdownOption[];
    readonly searchable?: boolean;
    readonly searchPlaceholder?: string;
    readonly value: string;
}

function formatFallbackLabel(value: string): string {
    if (value.trim().includes(" ")) {
        return value;
    }

    return value
        .replace(/_/g, " ")
        .split("-")
        .map((token) => {
            if (!token) return token;
            if (/^gpt$/i.test(token)) return "GPT";
            if (/^claude$/i.test(token)) return "Claude";
            if (/^\d+(\.\d+)?$/.test(token)) return token;
            if (/^[a-z]\d+$/i.test(token)) return token.toUpperCase();
            return token.charAt(0).toUpperCase() + token.slice(1);
        })
        .join(" ");
}

function ChevronIcon({ open }: { readonly open: boolean }) {
    return (
        <svg
            fill="none"
            height="10"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            style={{
                opacity: 0.7,
                transform: open ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 100ms ease",
            }}
            viewBox="0 0 24 24"
            width="10"
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    );
}

function DropdownField({
    disabled = false,
    emptySearchMessage = "No matches found.",
    label,
    onChange,
    options,
    searchable = false,
    searchPlaceholder = "Search…",
    value,
}: DropdownFieldProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState("");
    const containerRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const selectedOption = options.find((option) => option.value === value);
    const isDisabled = disabled || options.length === 0;
    const filteredOptions = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        if (!searchable || !normalizedQuery) return options;
        return options.filter((option) => {
            const haystack = [
                option.label,
                option.value,
                option.description ?? "",
                option.groupLabel ?? "",
            ]
                .join(" ")
                .toLowerCase();
            return haystack.includes(normalizedQuery);
        });
    }, [options, query, searchable]);

    useEffect(() => {
        if (!isOpen) return;
        const handlePointerDown = (event: MouseEvent) => {
            if (containerRef.current?.contains(event.target as Node)) return;
            setIsOpen(false);
            setQuery("");
        };
        document.addEventListener("mousedown", handlePointerDown);
        return () =>
            document.removeEventListener("mousedown", handlePointerDown);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen || !searchable) return;
        searchRef.current?.focus();
        searchRef.current?.select();
    }, [isOpen, searchable]);

    return (
        <div className="relative" ref={containerRef}>
            <button
                className="app-no-drag flex items-center gap-1 rounded-md px-2 py-1 text-xs"
                disabled={isDisabled}
                onClick={() => {
                    if (isDisabled) return;
                    setIsOpen((current) => !current);
                    setQuery("");
                }}
                onMouseEnter={(e) => {
                    if (!isDisabled) {
                        e.currentTarget.style.backgroundColor =
                            "color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent)";
                        e.currentTarget.style.color =
                            "var(--color-text-primary)";
                    }
                }}
                onMouseLeave={(e) => {
                    if (!isOpen) {
                        e.currentTarget.style.backgroundColor = "transparent";
                        e.currentTarget.style.color =
                            "var(--color-text-secondary)";
                    }
                }}
                style={{
                    backgroundColor: isOpen
                        ? "color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent)"
                        : "transparent",
                    border: "none",
                    color: isOpen
                        ? "var(--color-text-primary)"
                        : "var(--color-text-secondary)",
                    cursor: isDisabled ? "default" : "pointer",
                    opacity: isDisabled ? 0.45 : 1,
                    transition: "background-color 100ms ease, color 100ms ease",
                }}
                title={label}
                type="button"
            >
                <span className="min-w-0 max-w-[160px] truncate">
                    {selectedOption?.label ?? formatFallbackLabel(value)}
                </span>
                <ChevronIcon open={isOpen} />
            </button>

            {isOpen ? (
                <div
                    className="absolute bottom-full left-0 z-50 mb-1 min-w-[180px] max-w-[300px] overflow-hidden rounded-lg border"
                    style={{
                        backgroundColor: "var(--color-bg-secondary)",
                        borderColor: "var(--color-border)",
                        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
                    }}
                >
                    {searchable ? (
                        <div
                            className="border-b p-2"
                            style={{ borderColor: "var(--color-border)" }}
                        >
                            <input
                                className="ide-input app-no-drag w-full text-xs"
                                onChange={(event) =>
                                    setQuery(event.target.value)
                                }
                                onKeyDown={(event) => {
                                    event.stopPropagation();
                                }}
                                placeholder={searchPlaceholder}
                                ref={searchRef}
                                value={query}
                            />
                        </div>
                    ) : null}

                    <div className="max-h-72 overflow-y-auto py-1">
                        {filteredOptions.length === 0 ? (
                            <div className="px-3 py-2 text-[11px] text-text-secondary">
                                {emptySearchMessage}
                            </div>
                        ) : (
                            filteredOptions.map((option) => (
                                <button
                                    className="app-no-drag flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition"
                                    key={`${option.groupLabel ?? "default"}:${option.value}`}
                                    onClick={() => {
                                        onChange(option.value);
                                        setIsOpen(false);
                                        setQuery("");
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.backgroundColor =
                                            "var(--color-bg-tertiary)";
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.backgroundColor =
                                            "transparent";
                                    }}
                                    style={{
                                        backgroundColor: "transparent",
                                        border: "none",
                                        color:
                                            option.value === value
                                                ? "var(--color-accent)"
                                                : "var(--color-text-primary)",
                                    }}
                                    type="button"
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate">
                                            {option.groupLabel ? (
                                                <span
                                                    style={{
                                                        color: "var(--color-text-secondary)",
                                                    }}
                                                >
                                                    {option.groupLabel} /{" "}
                                                </span>
                                            ) : null}
                                            <span>{option.label}</span>
                                        </div>
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function BooleanField({
    disabled = false,
    label,
    onChange,
    value,
}: {
    readonly disabled?: boolean;
    readonly label: string;
    readonly onChange: (value: boolean) => void;
    readonly value: boolean;
}) {
    return (
        <div className="relative">
            <button
                className="app-no-drag flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
                disabled={disabled}
                onClick={() => onChange(!value)}
                onMouseEnter={(e) => {
                    if (!disabled) {
                        e.currentTarget.style.backgroundColor =
                            "color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent)";
                        e.currentTarget.style.color =
                            "var(--color-text-primary)";
                    }
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.color = "var(--color-text-secondary)";
                }}
                style={{
                    backgroundColor: "transparent",
                    border: "none",
                    color: "var(--color-text-secondary)",
                    cursor: disabled ? "default" : "pointer",
                    opacity: disabled ? 0.45 : 1,
                    transition: "background-color 100ms ease, color 100ms ease",
                }}
                title={label}
                type="button"
            >
                <span className="truncate">{label}</span>
                <span
                    style={{
                        color: value
                            ? "var(--color-accent)"
                            : "var(--color-text-secondary)",
                        fontSize: 10,
                        fontWeight: 600,
                    }}
                >
                    {value ? "ON" : "OFF"}
                </span>
            </button>
        </div>
    );
}

function getModelConfigOption(
    configOptions: readonly AiSessionConfigOption[],
): AiSessionConfigOption | null {
    return (
        configOptions.find(
            (option) =>
                option.category === "model" ||
                option.id.toLowerCase() === "model",
        ) ?? null
    );
}

function getModeConfigOption(
    configOptions: readonly AiSessionConfigOption[],
): AiSessionConfigOption | null {
    return (
        configOptions.find(
            (option) =>
                option.category === "mode" ||
                option.id.toLowerCase() === "mode",
        ) ?? null
    );
}

function mapConfigOption(
    option: Extract<AiSessionConfigOption, { type: "select" }>,
) {
    return option.options.map((item) => ({
        description: item.description,
        groupLabel: item.groupLabel,
        label: formatFallbackLabel(item.label),
        value: item.value,
    }));
}

function filterConfigOptions(option: AiSessionConfigOption) {
    if (option.type === "boolean") return option;
    return { ...option, options: mapConfigOption(option) };
}

export function AIChatAgentControls({
    configOptions,
    disabled = false,
    modeId,
    modelId,
    modes,
    models,
    onConfigOptionChange,
    onModeChange,
    onModelChange,
    runtimeId,
}: AIChatAgentControlsProps) {
    const modelConfig = useMemo(
        () => getModelConfigOption(configOptions),
        [configOptions],
    );
    const modeConfig = useMemo(
        () => getModeConfigOption(configOptions),
        [configOptions],
    );
    const selectedModelId =
        modelConfig?.type === "select" ? modelConfig.value : modelId;
    const selectedModeId =
        modeConfig?.type === "select" ? modeConfig.value : modeId;
    const visibleModes =
        modeConfig?.type === "select"
            ? mapConfigOption(modeConfig)
            : modes.map((mode) => ({
                  description: mode.description,
                  label: formatFallbackLabel(mode.name),
                  value: mode.id,
              }));
    const visibleModels =
        modelConfig?.type === "select"
            ? mapConfigOption(modelConfig)
            : models.map((model) => ({
                  description: model.description,
                  label: formatFallbackLabel(model.name),
                  value: model.id,
              }));
    const extraConfigs = useMemo(
        () =>
            [...configOptions]
                .filter((option) => option.id !== modelConfig?.id)
                .filter((option) => option.id !== modeConfig?.id)
                .filter(
                    (option) =>
                        option.category !== "mode" &&
                        option.category !== "model",
                )
                .sort((left, right) => {
                    const rank = (option: AiSessionConfigOption) =>
                        option.category === "reasoning" ? 0 : 1;
                    return rank(left) - rank(right);
                })
                .map(filterConfigOptions),
        [configOptions, modeConfig?.id, modelConfig?.id],
    );

    return (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
            {visibleModes.length > 0 ? (
                <DropdownField
                    disabled={disabled}
                    label="Approval Preset"
                    onChange={onModeChange}
                    options={visibleModes}
                    value={selectedModeId}
                />
            ) : null}

            {visibleModels.length > 0 ? (
                <DropdownField
                    disabled={disabled}
                    emptySearchMessage={`No ${runtimeId} models match that search.`}
                    label="Model"
                    onChange={onModelChange}
                    options={visibleModels}
                    searchable={visibleModels.length > 12}
                    searchPlaceholder="Search models…"
                    value={selectedModelId}
                />
            ) : null}

            {extraConfigs.map((option) =>
                option.type === "boolean" ? (
                    <BooleanField
                        disabled={disabled}
                        key={option.id}
                        label={option.label}
                        onChange={(value) =>
                            onConfigOptionChange(option.id, value)
                        }
                        value={option.value}
                    />
                ) : (
                    <DropdownField
                        disabled={disabled}
                        key={option.id}
                        label={option.label}
                        onChange={(value) =>
                            onConfigOptionChange(option.id, value)
                        }
                        options={option.options}
                        searchable={option.options.length > 10}
                        searchPlaceholder={`Search ${option.label.toLowerCase()}…`}
                        value={option.value}
                    />
                ),
            )}
        </div>
    );
}
