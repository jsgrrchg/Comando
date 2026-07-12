import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";

import type {
    AiRuntimeId,
    AiSessionConfigOption,
    AiSessionMode,
    AiSessionModel,
} from "@shared/ipc";

import { getViewportSafeMenuPosition } from "@renderer/app/utils/menu-position";

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

interface DropdownOptionGroup {
    readonly label: string | null;
    readonly options: readonly DropdownOption[];
}

interface DropdownFieldProps {
    readonly buttonLabel?: string;
    readonly collapsibleGroupLabels?: readonly string[];
    readonly disabled?: boolean;
    readonly emptySearchMessage?: string;
    readonly label: string;
    readonly onChange: (value: string) => void;
    readonly options: readonly DropdownOption[];
    readonly searchable?: boolean;
    readonly searchPlaceholder?: string;
    readonly value: string;
}

interface DropdownMenuPosition {
    readonly minWidth: number;
    readonly x: number;
    readonly y: number;
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

function groupDropdownOptions(
    options: readonly DropdownOption[],
): readonly DropdownOptionGroup[] {
    const groups: Array<{ label: string | null; options: DropdownOption[] }> = [];

    for (const option of options) {
        const label = option.groupLabel?.trim() || null;
        const group = groups.find((candidate) => candidate.label === label);
        if (group) {
            group.options.push(option);
        } else {
            groups.push({ label, options: [option] });
        }
    }

    return groups;
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
    buttonLabel,
    collapsibleGroupLabels = [],
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
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
        () => new Set(),
    );
    const containerRef = useRef<HTMLDivElement | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const [menuPosition, setMenuPosition] =
        useState<DropdownMenuPosition | null>(null);
    const selectedOption = options.find((option) => option.value === value);
    const displayValue =
        buttonLabel ?? selectedOption?.label ?? formatFallbackLabel(value);
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
    const collapsibleGroupKey = collapsibleGroupLabels.join("\u0000");
    const collapsibleGroups = useMemo(
        () =>
            new Set(collapsibleGroupKey.split("\u0000").filter(Boolean)),
        [collapsibleGroupKey],
    );
    const hasActiveSearch = searchable && query.trim().length > 0;
    const optionGroups = useMemo(
        () =>
            collapsibleGroups.size > 0
                ? groupDropdownOptions(filteredOptions)
                : [{ label: null, options: filteredOptions }],
        [collapsibleGroups, filteredOptions],
    );
    const visibleRowCount = useMemo(
        () =>
            optionGroups.reduce((count, group) => {
                const isCollapsible =
                    group.label !== null && collapsibleGroups.has(group.label);
                const isExpanded =
                    !isCollapsible ||
                    hasActiveSearch ||
                    expandedGroups.has(group.label ?? "");
                return (
                    count +
                    (group.label === null ? 0 : 1) +
                    (isExpanded ? group.options.length : 0)
                );
            }, 0),
        [collapsibleGroups, expandedGroups, hasActiveSearch, optionGroups],
    );

    const updateMenuPosition = useCallback(() => {
        const button = buttonRef.current;
        if (!button) return;

        const buttonRect = button.getBoundingClientRect();
        const measuredMenuRect = menuRef.current?.getBoundingClientRect();
        const minWidth = Math.max(180, Math.ceil(buttonRect.width));
        const width = Math.min(
            300,
            Math.max(minWidth, Math.ceil(measuredMenuRect?.width ?? minWidth)),
        );
        const estimatedHeight = Math.min(
            288,
            visibleRowCount * 32 + (searchable ? 52 : 0) + 8,
        );
        const height = Math.ceil(measuredMenuRect?.height ?? estimatedHeight);
        const spaceAbove = buttonRect.top - 8;
        const spaceBelow = window.innerHeight - buttonRect.bottom - 8;
        const openAbove = spaceAbove >= height || spaceAbove > spaceBelow;
        const offset = 4;
        const preferredY = openAbove
            ? buttonRect.top - height - offset
            : buttonRect.bottom + offset;
        const safePosition = getViewportSafeMenuPosition(
            buttonRect.left,
            preferredY,
            width,
            height,
        );

        setMenuPosition({
            minWidth,
            x: safePosition.x,
            y: safePosition.y,
        });
    }, [searchable, visibleRowCount]);

    useEffect(() => {
        if (!isOpen) return;
        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (containerRef.current?.contains(target)) return;
            if (menuRef.current?.contains(target)) return;
            setIsOpen(false);
            setQuery("");
            setExpandedGroups(new Set());
        };
        document.addEventListener("mousedown", handlePointerDown);
        return () =>
            document.removeEventListener("mousedown", handlePointerDown);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;

        const handleViewportChange = () => {
            updateMenuPosition();
        };

        handleViewportChange();
        window.addEventListener("resize", handleViewportChange);
        window.addEventListener("scroll", handleViewportChange, true);
        return () => {
            window.removeEventListener("resize", handleViewportChange);
            window.removeEventListener("scroll", handleViewportChange, true);
        };
    }, [isOpen, updateMenuPosition]);

    useLayoutEffect(() => {
        if (!isOpen) return;
        updateMenuPosition();
    }, [isOpen, updateMenuPosition]);

    useEffect(() => {
        if (!isOpen || !searchable) return;
        searchRef.current?.focus();
        searchRef.current?.select();
    }, [isOpen, searchable]);

    return (
        <div className="relative" ref={containerRef}>
            <button
                className="app-no-drag flex items-center gap-1 rounded-md px-2 py-1 text-xs active:scale-90"
                disabled={isDisabled}
                ref={buttonRef}
                onClick={() => {
                    if (isDisabled) return;
                    const nextIsOpen = !isOpen;
                    setIsOpen(nextIsOpen);
                    setQuery("");
                    if (nextIsOpen) {
                        setExpandedGroups(new Set());
                    }
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
                    transition:
                        "background-color 100ms ease, color 100ms ease, transform 75ms ease",
                }}
                title={label}
                type="button"
            >
                <span className="min-w-0 max-w-[160px] truncate">
                    {displayValue}
                </span>
                <ChevronIcon open={isOpen} />
            </button>

            {isOpen
                ? createPortal(
                      <div
                          className="z-[10010] overflow-hidden rounded-lg border"
                          ref={menuRef}
                          style={{
                              backgroundColor: "var(--color-bg-secondary)",
                              borderColor: "var(--color-border)",
                              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
                              left: menuPosition?.x ?? 8,
                              maxWidth: 300,
                              minWidth: menuPosition?.minWidth ?? 180,
                              position: "fixed",
                              top: menuPosition?.y ?? 8,
                          }}
                      >
                          {searchable ? (
                              <div
                                  className="border-b p-2"
                                  style={{
                                      borderColor: "var(--color-border)",
                                  }}
                              >
                                  <input
                                      autoCapitalize="off"
                                      autoCorrect="off"
                                      className="ide-input app-no-drag w-full text-xs"
                                      onChange={(event) =>
                                          setQuery(event.target.value)
                                      }
                                      onKeyDown={(event) => {
                                          event.stopPropagation();
                                      }}
                                      placeholder={searchPlaceholder}
                                      ref={searchRef}
                                      spellCheck={false}
                                      value={query}
                                  />
                              </div>
                          ) : null}

                          <div className="max-h-72 overflow-x-auto overflow-y-auto py-1">
                              {filteredOptions.length === 0 ? (
                                  <div className="px-3 py-2 text-[11px] text-text-secondary">
                                      {emptySearchMessage}
                                  </div>
                              ) : (
                                  optionGroups.map((group) => {
                                      const isCollapsible =
                                          group.label !== null &&
                                          collapsibleGroups.has(group.label);
                                      const isExpanded =
                                          !isCollapsible ||
                                          hasActiveSearch ||
                                          expandedGroups.has(group.label ?? "");

                                      return (
                                          <div
                                              key={group.label ?? "ungrouped"}
                                          >
                                              {group.label ? (
                                                  isCollapsible ? (
                                                      <button
                                                          aria-expanded={isExpanded}
                                                          className="app-no-drag flex min-w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-xs transition"
                                                          onClick={() => {
                                                              setExpandedGroups(
                                                                  (current) => {
                                                                      const next =
                                                                          new Set(
                                                                              current,
                                                                          );
                                                                      if (
                                                                          next.has(
                                                                              group.label ??
                                                                                  "",
                                                                          )
                                                                      ) {
                                                                          next.delete(
                                                                              group.label ??
                                                                                  "",
                                                                          );
                                                                      } else {
                                                                          next.add(
                                                                              group.label ??
                                                                                  "",
                                                                          );
                                                                      }
                                                                      return next;
                                                                  },
                                                              );
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
                                                              backgroundColor:
                                                                  "transparent",
                                                              border: "none",
                                                              color: "var(--color-text-primary)",
                                                              transition:
                                                                  "background-color 100ms ease",
                                                          }}
                                                          type="button"
                                                      >
                                                          <span className="whitespace-nowrap">
                                                              {group.label}
                                                          </span>
                                                          <ChevronIcon
                                                              open={isExpanded}
                                                          />
                                                      </button>
                                                  ) : (
                                                      <div
                                                          className="px-3 pb-1 pt-2 text-[11px]"
                                                          style={{
                                                              color: "var(--color-text-secondary)",
                                                          }}
                                                      >
                                                          {group.label}
                                                      </div>
                                                  )
                                              ) : null}

                                              {isExpanded
                                                  ? group.options.map((option) => (
                                                        <button
                                                            className={`app-no-drag flex min-w-full items-center gap-2 rounded-md py-1.5 text-left text-xs transition ${
                                                                isCollapsible
                                                                    ? "pl-7 pr-3"
                                                                    : "px-3"
                                                            }`}
                                                            key={`${option.groupLabel ?? "default"}:${option.value}`}
                                                            onClick={() => {
                                                                onChange(
                                                                    option.value,
                                                                );
                                                                setIsOpen(false);
                                                                setQuery("");
                                                                setExpandedGroups(
                                                                    new Set(),
                                                                );
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
                                                                backgroundColor:
                                                                    "transparent",
                                                                border: "none",
                                                                color:
                                                                    option.value ===
                                                                    value
                                                                        ? "var(--color-accent)"
                                                                        : "var(--color-text-primary)",
                                                                width: "max-content",
                                                                transition:
                                                                    "background-color 100ms ease",
                                                            }}
                                                            type="button"
                                                        >
                                                            <div className="whitespace-nowrap">
                                                                <div>
                                                                    {collapsibleGroups.size ===
                                                                        0 &&
                                                                    option.groupLabel ? (
                                                                        <span
                                                                            style={{
                                                                                color: "var(--color-text-secondary)",
                                                                            }}
                                                                        >
                                                                            {
                                                                                option.groupLabel
                                                                            }{" "}
                                                                            /{" "}
                                                                        </span>
                                                                    ) : null}
                                                                    <span>
                                                                        {option.label}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                        </button>
                                                    ))
                                                  : null}
                                          </div>
                                      );
                                  })
                              )}
                          </div>
                      </div>,
                      document.body,
                  )
                : null}
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
                className="app-no-drag flex items-center gap-1.5 rounded-md px-2 py-1 text-xs active:scale-90"
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
                    transition:
                        "background-color 100ms ease, color 100ms ease, transform 75ms ease",
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
    includeGroupLabels = true,
) {
    return option.options.map((item) => ({
        description: item.description,
        groupLabel: includeGroupLabels ? item.groupLabel : null,
        label: formatFallbackLabel(item.label),
        value: item.value,
    }));
}

function filterConfigOptions(option: AiSessionConfigOption) {
    if (option.type === "boolean") return option;
    return { ...option, options: mapConfigOption(option) };
}

function getConfigButtonLabel(option: AiSessionConfigOption): string | undefined {
    if (option.type !== "select" || option.id !== "fast") {
        return undefined;
    }

    const selectedOption = option.options.find((item) => item.value === option.value);
    return `Fast: ${selectedOption?.label ?? formatFallbackLabel(option.value)}`;
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
    const handleModeChange = useCallback(
        (nextModeId: string) => {
            if (modeConfig?.type === "select") {
                onConfigOptionChange(modeConfig.id, nextModeId);
                return;
            }

            onModeChange(nextModeId);
        },
        [modeConfig, onConfigOptionChange, onModeChange],
    );
    const handleModelChange = useCallback(
        (nextModelId: string) => {
            if (modelConfig?.type === "select") {
                onConfigOptionChange(modelConfig.id, nextModelId);
                return;
            }

            onModelChange(nextModelId);
        },
        [modelConfig, onConfigOptionChange, onModelChange],
    );
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
            ? mapConfigOption(modelConfig, false)
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
                    onChange={handleModeChange}
                    options={visibleModes}
                    value={selectedModeId}
                />
            ) : null}

            {visibleModels.length > 0 ? (
                <DropdownField
                    disabled={disabled}
                    emptySearchMessage={`No ${runtimeId} models match that search.`}
                    label="Model"
                    onChange={handleModelChange}
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
                        buttonLabel={getConfigButtonLabel(option)}
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
