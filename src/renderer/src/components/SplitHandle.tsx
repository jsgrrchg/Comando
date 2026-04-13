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
            className="group flex h-full items-center justify-center"
            onKeyDown={handleKeyDown}
            onPointerDown={onPointerDown}
            role="separator"
            tabIndex={0}
        >
            <div className="flex h-full w-full items-center justify-center transition-colors duration-100 group-focus-visible:outline-none">
                <div className="h-8 w-px rounded-full bg-border-strong transition-all duration-100 group-hover:h-12 group-hover:bg-accent group-focus-visible:h-12 group-focus-visible:bg-accent" />
            </div>
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
