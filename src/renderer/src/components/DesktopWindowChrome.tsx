import type { ReactNode, RefObject } from "react";

interface DesktopWindowChromeProps {
    readonly gitContextControl?: ReactNode;
    readonly inspectorControlsId: string;
    readonly inspectorExpanded: boolean;
    readonly navigatorControlsId: string;
    readonly navigatorExpanded: boolean;
    readonly onToggleInspector: () => void;
    readonly onToggleNavigator: () => void;
    readonly platform: string | null;
    readonly inspectorToggleRef?: RefObject<HTMLButtonElement | null>;
    readonly navigatorToggleRef?: RefObject<HTMLButtonElement | null>;
}

export function DesktopWindowChrome({
    gitContextControl,
    inspectorControlsId,
    inspectorExpanded,
    navigatorControlsId,
    navigatorExpanded,
    onToggleInspector,
    onToggleNavigator,
    platform,
    inspectorToggleRef,
    navigatorToggleRef,
}: DesktopWindowChromeProps) {
    return (
        <header
            aria-label="Window controls"
            className="app-drag desktop-titlebar desktop-window-chrome relative flex shrink-0 items-center select-none"
            style={{
                height: "var(--desktop-titlebar-height, 32px)",
                paddingLeft: platform === "darwin" ? 84 : 8,
                paddingRight:
                    platform === "win32" || platform === "linux"
                        ? "var(--titlebar-controls-width, 138px)"
                        : 8,
            }}
        >
            <ChromePanelToggle
                controlsId={navigatorControlsId}
                expanded={navigatorExpanded}
                label="navigator"
                onToggle={onToggleNavigator}
                toggleRef={navigatorToggleRef}
                side="left"
            />
            {/* The wrapper remains draggable; interactive context controls opt out locally. */}
            <div
                aria-hidden={gitContextControl ? undefined : true}
                className="desktop-window-chrome__reserved"
                data-window-chrome-reserved="true"
            >
                {gitContextControl}
            </div>
            <ChromePanelToggle
                controlsId={inspectorControlsId}
                expanded={inspectorExpanded}
                label="inspector"
                onToggle={onToggleInspector}
                toggleRef={inspectorToggleRef}
                side="right"
            />
        </header>
    );
}

function ChromePanelToggle({
    controlsId,
    expanded,
    label,
    onToggle,
    side,
    toggleRef,
}: {
    readonly controlsId: string;
    readonly expanded: boolean;
    readonly label: "inspector" | "navigator";
    readonly onToggle: () => void;
    readonly side: "left" | "right";
    readonly toggleRef?: RefObject<HTMLButtonElement | null>;
}) {
    const action = expanded ? "Hide" : "Show";
    const accessibleLabel = `${action} workspace ${label}`;
    return (
        <button
            aria-controls={controlsId}
            aria-expanded={expanded}
            aria-label={accessibleLabel}
            className="app-no-drag desktop-window-chrome__toggle"
            data-chrome-control={label}
            onClick={onToggle}
            ref={toggleRef}
            title={accessibleLabel}
            type="button"
        >
            <svg
                aria-hidden="true"
                fill="none"
                height="14"
                viewBox="0 0 14 14"
                width="14"
            >
                <rect
                    height="9"
                    rx="1.3"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    width="11"
                    x="1.5"
                    y="2.5"
                />
                <path
                    d={side === "left" ? "M5 3.4v7.2" : "M9 3.4v7.2"}
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeOpacity="0.65"
                    strokeWidth="2.4"
                />
            </svg>
        </button>
    );
}
