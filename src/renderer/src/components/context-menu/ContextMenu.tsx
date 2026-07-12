import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { getViewportSafeMenuPosition } from "@renderer/app/utils/menu-position";

export type ContextMenuEntry =
    | {
          readonly type?: "item";
          readonly label: string;
          readonly action?: () => void;
          readonly danger?: boolean;
          readonly disabled?: boolean;
          readonly title?: string;
          readonly children?: readonly ContextMenuEntry[];
      }
    | {
          readonly type: "separator";
      };

export interface ContextMenuState<T = void> {
    readonly x: number;
    readonly y: number;
    readonly payload: T;
}

type ContextMenuItemEntry = Exclude<
    ContextMenuEntry,
    { readonly type: "separator" }
>;
type SubmenuDirection = "left" | "right";

interface SubmenuState {
    readonly resetKey: string;
    readonly openIndex: number | null;
    readonly directionByIndex: Readonly<Record<number, SubmenuDirection>>;
}

const SUBMENU_GAP_PX = 4;
const EMPTY_SUBMENU_DIRECTIONS: Readonly<Record<number, SubmenuDirection>> = {};

function getEntryStateKey(entry: ContextMenuEntry) {
    if (entry.type === "separator") {
        return { type: "separator" };
    }

    return {
        type: "item",
        label: entry.label,
        disabled: Boolean(entry.disabled),
        children: entry.children?.map((child) =>
            child.type === "separator"
                ? { type: "separator" }
                : {
                      type: "item",
                      label: child.label,
                      disabled: Boolean(child.disabled),
                  },
        ),
    };
}

function getItemClassName(
    entry: ContextMenuItemEntry,
    variant: "default" | "popover",
) {
    return [
        "flex w-full items-center rounded-md text-left transition",
        variant === "popover"
            ? "px-2.5 py-1.5 text-[13px]"
            : "px-3 py-1.5 text-xs",
        entry.disabled
            ? "cursor-not-allowed text-text-secondary/50"
            : entry.danger
              ? "text-[var(--diff-remove)] hover:bg-[color-mix(in_srgb,var(--diff-remove)_10%,transparent)]"
              : "text-text-primary hover:bg-bg-tertiary",
    ].join(" ");
}

export function ContextMenu<T>({
    entries,
    menu,
    minWidth = 180,
    onClose,
    variant = "default",
    zIndex = 10000,
}: {
    readonly entries: readonly ContextMenuEntry[];
    readonly menu: ContextMenuState<T>;
    readonly minWidth?: number;
    readonly onClose: () => void;
    readonly variant?: "default" | "popover";
    readonly zIndex?: number;
}) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState({ x: menu.x, y: menu.y });
    const submenuResetKey = JSON.stringify({
        x: menu.x,
        y: menu.y,
        entries: entries.map(getEntryStateKey),
    });
    const [submenuState, setSubmenuState] = useState<SubmenuState>({
        resetKey: submenuResetKey,
        openIndex: null,
        directionByIndex: EMPTY_SUBMENU_DIRECTIONS,
    });
    const currentSubmenuState: SubmenuState =
        submenuState.resetKey === submenuResetKey
            ? submenuState
            : {
                  resetKey: submenuResetKey,
                  openIndex: null,
                  directionByIndex: EMPTY_SUBMENU_DIRECTIONS,
              };

    const updateSubmenuState = (
        updater: (current: SubmenuState) => SubmenuState,
    ) => {
        setSubmenuState((current) =>
            updater(
                current.resetKey === submenuResetKey
                    ? current
                    : {
                          resetKey: submenuResetKey,
                          openIndex: null,
                          directionByIndex: EMPTY_SUBMENU_DIRECTIONS,
                      },
            ),
        );
    };

    const getSubmenuDirection = (element: HTMLElement): SubmenuDirection => {
        const rect = element.getBoundingClientRect();
        const availableRight =
            window.innerWidth - rect.right - SUBMENU_GAP_PX;
        const availableLeft = rect.left - SUBMENU_GAP_PX;

        return availableRight < minWidth && availableLeft > availableRight
            ? "left"
            : "right";
    };

    const openSubmenu = (index: number, element: HTMLElement) => {
        const direction = getSubmenuDirection(element);
        updateSubmenuState((current) => ({
            ...current,
            openIndex: index,
            directionByIndex: {
                ...current.directionByIndex,
                [index]: direction,
            },
        }));
    };

    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) {
            return;
        }

        const rect = element.getBoundingClientRect();
        setPosition(
            getViewportSafeMenuPosition(
                menu.x,
                menu.y,
                rect.width,
                rect.height,
            ),
        );
    }, [entries.length, menu.x, menu.y]);

    useEffect(() => {
        const handleMouseDown = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                onClose();
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };

        document.addEventListener("mousedown", handleMouseDown);
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            document.removeEventListener("mousedown", handleMouseDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [onClose]);

    const closeAndRunAction = (action?: () => void) => {
        onClose();
        if (!action) {
            return;
        }

        queueMicrotask(action);
    };

    return createPortal(
        <div
            className={[
                "fixed border border-border bg-bg-panel shadow-[0_10px_30px_rgba(15,23,42,0.18)]",
                variant === "popover" ? "rounded-md p-2" : "rounded-lg p-1",
            ].join(" ")}
            data-context-menu-root="true"
            ref={ref}
            style={{
                left: position.x,
                minWidth,
                top: position.y,
                zIndex,
            }}
        >
            {entries.map((entry, index) => {
                if (entry.type === "separator") {
                    return (
                        <div
                            className={
                                variant === "popover"
                                    ? "my-2 border-t border-border"
                                    : "my-1 border-t border-border"
                            }
                            key={`separator-${index}`}
                            role="separator"
                        />
                    );
                }

                const hasChildren = Boolean(entry.children?.length);
                const submenuOpen =
                    hasChildren && currentSubmenuState.openIndex === index;
                const submenuDirection =
                    currentSubmenuState.directionByIndex[index] ?? "right";

                return (
                    <div
                        className="relative"
                        key={`${entry.label}-${index}`}
                        onMouseEnter={(event) => {
                            if (!hasChildren || entry.disabled) {
                                updateSubmenuState((current) =>
                                    current.openIndex === null
                                        ? current
                                        : { ...current, openIndex: null },
                                );
                                return;
                            }

                            openSubmenu(index, event.currentTarget);
                        }}
                        onMouseLeave={() => {
                            if (!hasChildren) {
                                return;
                            }

                            updateSubmenuState((current) =>
                                current.openIndex === index
                                    ? { ...current, openIndex: null }
                                    : current,
                            );
                        }}
                    >
                        <button
                            aria-expanded={hasChildren ? submenuOpen : undefined}
                            aria-haspopup={hasChildren ? "menu" : undefined}
                            aria-label={entry.label}
                            className={[
                                getItemClassName(entry, variant),
                                hasChildren ? "justify-between gap-3" : "",
                            ].join(" ")}
                            disabled={entry.disabled}
                            onClick={(event) => {
                                if (entry.disabled) {
                                    return;
                                }
                                if (hasChildren) {
                                    if (submenuOpen) {
                                        updateSubmenuState((current) => ({
                                            ...current,
                                            openIndex: null,
                                        }));
                                    } else {
                                        openSubmenu(
                                            index,
                                            event.currentTarget.parentElement ??
                                                event.currentTarget,
                                        );
                                    }
                                    return;
                                }

                                closeAndRunAction(entry.action);
                            }}
                            title={entry.title}
                            type="button"
                        >
                            <span>{entry.label}</span>
                            {hasChildren ? (
                                <span
                                    aria-hidden="true"
                                    className={[
                                        "text-[10px] opacity-70 transition-transform",
                                        submenuDirection === "left"
                                            ? "rotate-180"
                                            : "",
                                    ].join(" ")}
                                >
                                    ›
                                </span>
                            ) : null}
                        </button>

                        {submenuOpen ? (
                            <div
                                data-context-submenu-bridge={submenuDirection}
                                style={{
                                    position: "absolute",
                                    top: variant === "popover" ? -8 : -4,
                                    zIndex: zIndex + 1,
                                    ...(submenuDirection === "right"
                                        ? {
                                              left: "100%",
                                              paddingLeft: SUBMENU_GAP_PX,
                                          }
                                        : {
                                              right: "100%",
                                              paddingRight: SUBMENU_GAP_PX,
                                          }),
                                }}
                            >
                                <div
                                    className={[
                                        "border border-border bg-bg-panel shadow-[0_10px_30px_rgba(15,23,42,0.18)]",
                                        variant === "popover"
                                            ? "rounded-md p-2"
                                            : "rounded-lg p-1",
                                    ].join(" ")}
                                    data-context-submenu="true"
                                    role="menu"
                                    style={{ minWidth }}
                                >
                                    {entry.children?.map(
                                        (child, childIndex) => {
                                            if (child.type === "separator") {
                                                return (
                                                    <div
                                                        className={
                                                            variant === "popover"
                                                                ? "my-2 border-t border-border"
                                                                : "my-1 border-t border-border"
                                                        }
                                                        key={`submenu-separator-${childIndex}`}
                                                        role="separator"
                                                    />
                                                );
                                            }

                                            return (
                                                <button
                                                    aria-label={child.label}
                                                    className={getItemClassName(
                                                        child,
                                                        variant,
                                                    )}
                                                    disabled={child.disabled}
                                                    key={`${child.label}-${childIndex}`}
                                                    onClick={() => {
                                                        if (child.disabled) {
                                                            return;
                                                        }
                                                        closeAndRunAction(
                                                            child.action,
                                                        );
                                                    }}
                                                    title={child.title}
                                                    type="button"
                                                >
                                                    {child.label}
                                                </button>
                                            );
                                        },
                                    )}
                                </div>
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </div>,
        document.body,
    );
}
