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
      }
    | {
          readonly type: "separator";
      };

export interface ContextMenuState<T = void> {
    readonly x: number;
    readonly y: number;
    readonly payload: T;
}

export function ContextMenu<T>({
    entries,
    menu,
    minWidth = 180,
    onClose,
    zIndex = 10000,
}: {
    readonly entries: readonly ContextMenuEntry[];
    readonly menu: ContextMenuState<T>;
    readonly minWidth?: number;
    readonly onClose: () => void;
    readonly zIndex?: number;
}) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState({ x: menu.x, y: menu.y });

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
            className="fixed rounded-lg border border-border bg-bg-panel p-1 shadow-[0_10px_30px_rgba(15,23,42,0.18)]"
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
                            className="my-1 border-t border-border"
                            key={`separator-${index}`}
                        />
                    );
                }

                return (
                    <button
                        className={[
                            "flex w-full items-center rounded-md px-3 py-1.5 text-left text-xs transition",
                            entry.disabled
                                ? "cursor-not-allowed text-text-secondary/50"
                                : entry.danger
                                  ? "text-red-600 hover:bg-red-500/10"
                                  : "text-text-primary hover:bg-bg-tertiary",
                        ].join(" ")}
                        disabled={entry.disabled}
                        key={`${entry.label}-${index}`}
                        onClick={() => closeAndRunAction(entry.action)}
                        type="button"
                    >
                        {entry.label}
                    </button>
                );
            })}
        </div>,
        document.body,
    );
}
