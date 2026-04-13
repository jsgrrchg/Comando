import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

interface SplitHandleProps {
    readonly label: string;
    readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    readonly onStepBackward: () => void;
    readonly onStepForward: () => void;
}

export function SplitHandle({
    label,
    onPointerDown,
    onStepBackward,
    onStepForward,
}: SplitHandleProps) {
    return (
        <div
            aria-label={label}
            aria-orientation="vertical"
            className="group relative z-2 flex h-full cursor-col-resize items-center justify-center"
            onKeyDown={handleKeyDown}
            onPointerDown={onPointerDown}
            role="separator"
            style={{ marginLeft: -5, marginRight: -5, width: 11 }}
            tabIndex={0}
        >
            <div className="h-full w-px bg-border transition-colors duration-100 group-hover:bg-accent group-focus-visible:bg-accent group-focus-visible:outline-none" />
        </div>
    );

    function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            event.preventDefault();
            onStepBackward();
        }

        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            onStepForward();
        }
    }
}
