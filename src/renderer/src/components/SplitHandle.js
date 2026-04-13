import { jsx as _jsx } from "react/jsx-runtime";
export function SplitHandle({ label, onPointerDown, onStepBackward, onStepForward, }) {
    return (_jsx("div", { "aria-label": label, "aria-orientation": "vertical", className: "group relative z-2 flex h-full cursor-col-resize items-center justify-center", onKeyDown: handleKeyDown, onPointerDown: onPointerDown, role: "separator", style: { marginLeft: -5, marginRight: -5, width: 11 }, tabIndex: 0, children: _jsx("div", { className: "h-full w-px bg-border transition-colors duration-100 group-hover:bg-accent group-focus-visible:bg-accent group-focus-visible:outline-none" }) }));
    function handleKeyDown(event) {
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
