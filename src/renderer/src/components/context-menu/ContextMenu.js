import { jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getViewportSafeMenuPosition } from "@renderer/app/utils/menu-position";
export function ContextMenu({ entries, menu, minWidth = 180, onClose, zIndex = 10000, }) {
    const ref = useRef(null);
    const [position, setPosition] = useState({ x: menu.x, y: menu.y });
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) {
            return;
        }
        const rect = element.getBoundingClientRect();
        setPosition(getViewportSafeMenuPosition(menu.x, menu.y, rect.width, rect.height));
    }, [entries.length, menu.x, menu.y]);
    useEffect(() => {
        const handleMouseDown = (event) => {
            if (ref.current && !ref.current.contains(event.target)) {
                onClose();
            }
        };
        const handleKeyDown = (event) => {
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
    const closeAndRunAction = (action) => {
        onClose();
        if (!action) {
            return;
        }
        queueMicrotask(action);
    };
    return createPortal(_jsx("div", { className: "fixed rounded-lg border border-border bg-bg-panel p-1 shadow-[0_10px_30px_rgba(15,23,42,0.18)]", ref: ref, style: {
            left: position.x,
            minWidth,
            top: position.y,
            zIndex,
        }, children: entries.map((entry, index) => {
            if (entry.type === "separator") {
                return (_jsx("div", { className: "my-1 border-t border-border" }, `separator-${index}`));
            }
            return (_jsx("button", { className: [
                    "flex w-full items-center rounded-md px-3 py-1.5 text-left text-xs transition",
                    entry.disabled
                        ? "cursor-not-allowed text-text-secondary/50"
                        : entry.danger
                            ? "text-red-600 hover:bg-red-500/10"
                            : "text-text-primary hover:bg-bg-secondary",
                ].join(" "), disabled: entry.disabled, onClick: () => closeAndRunAction(entry.action), type: "button", children: entry.label }, `${entry.label}-${index}`));
        }) }), document.body);
}
