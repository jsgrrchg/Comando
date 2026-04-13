import type { PointerEvent as ReactPointerEvent } from "react";
interface SplitHandleProps {
    readonly label: string;
    readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    readonly onStepBackward: () => void;
    readonly onStepForward: () => void;
}
export declare function SplitHandle({ label, onPointerDown, onStepBackward, onStepForward, }: SplitHandleProps): import("react/jsx-runtime").JSX.Element;
export {};
