import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import type { ShellPanelSide } from "../app/layout/shell-layout";

interface SplitHandleProps {
    readonly hidden?: boolean;
    readonly label: string;
    readonly max: number;
    readonly min: number;
    readonly onDecrease: () => void;
    readonly onIncrease: () => void;
    readonly onMaximum: () => void;
    readonly onMinimum: () => void;
    readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    readonly side: ShellPanelSide;
    readonly value: number;
}

export function SplitHandle({
    hidden = false,
    label,
    max,
    min,
    onDecrease,
    onIncrease,
    onMaximum,
    onMinimum,
    onPointerDown,
    side,
    value,
}: SplitHandleProps) {
    return (
        <div
            aria-label={label}
            aria-orientation="vertical"
            aria-valuemax={Math.round(max)}
            aria-valuemin={Math.round(min)}
            aria-valuenow={Math.round(value)}
            className="group relative z-2 flex h-full cursor-col-resize items-center justify-center"
            hidden={hidden}
            onKeyDown={handleKeyDown}
            onPointerDown={onPointerDown}
            role="separator"
            style={{ marginLeft: -3, marginRight: -3, width: 7 }}
            tabIndex={hidden ? -1 : 0}
        >
            <div className="h-full w-px bg-border transition-colors duration-100 group-hover:bg-accent group-focus-visible:bg-accent group-focus-visible:outline-none" />
        </div>
    );

    function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key === "Home") {
            event.preventDefault();
            onMinimum();
            return;
        }
        if (event.key === "End") {
            event.preventDefault();
            onMaximum();
            return;
        }
        if (event.key === "ArrowUp") {
            event.preventDefault();
            onDecrease();
            return;
        }
        if (event.key === "ArrowDown") {
            event.preventDefault();
            onIncrease();
            return;
        }

        // Horizontal arrows follow physical movement of each outer edge.
        const decreases =
            (side === "left" && event.key === "ArrowLeft") ||
            (side === "right" && event.key === "ArrowRight");
        const increases =
            (side === "left" && event.key === "ArrowRight") ||
            (side === "right" && event.key === "ArrowLeft");
        if (decreases || increases) {
            event.preventDefault();
            (decreases ? onDecrease : onIncrease)();
        }
    }
}
