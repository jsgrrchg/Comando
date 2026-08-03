import { useEffect, useMemo, useRef, useState } from "react";

import {
    createDefaultShellLayout,
    getOpenShellDrawerSide,
    getShellGridTemplateColumns,
    resolveShellResponsiveLayout,
    type ShellPanelSide,
} from "@renderer/app/layout/shell-layout";
import { DesktopWindowChrome } from "@renderer/components/DesktopWindowChrome";
import { ShellDrawer } from "@renderer/components/ShellDrawer";
import { SplitHandle } from "@renderer/components/SplitHandle";

export function ShellHarness() {
    const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
    const [leftCollapsed, setLeftCollapsed] = useState(false);
    const [rightCollapsed, setRightCollapsed] = useState(false);
    const [preferredDrawer, setPreferredDrawer] =
        useState<ShellPanelSide | null>(null);
    const navigatorToggleRef = useRef<HTMLButtonElement | null>(null);
    const inspectorToggleRef = useRef<HTMLButtonElement | null>(null);
    const platform =
        new URLSearchParams(window.location.search).get("platform") ?? "linux";
    const transparencyEnabled =
        new URLSearchParams(window.location.search).get("transparency") !==
        "false";
    const responsive = useMemo(
        () =>
            resolveShellResponsiveLayout(
                createDefaultShellLayout(),
                { leftCollapsed, preferredDrawer, rightCollapsed },
                viewportWidth,
            ),
        [leftCollapsed, preferredDrawer, rightCollapsed, viewportWidth],
    );
    const openDrawerSide = getOpenShellDrawerSide(responsive);

    useEffect(() => {
        const handleResize = () => setViewportWidth(window.innerWidth);
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    useEffect(() => {
        const root = document.documentElement;
        const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
        const syncTheme = () => root.classList.toggle("dark", darkMedia.matches);
        syncTheme();
        darkMedia.addEventListener("change", syncTheme);
        return () => darkMedia.removeEventListener("change", syncTheme);
    }, []);

    useEffect(() => {
        const root = document.documentElement;
        root.dataset.platform = platform;
        root.dataset.transparencyEnabled = transparencyEnabled
            ? "true"
            : "false";
        return () => {
            delete root.dataset.platform;
            delete root.dataset.transparencyEnabled;
        };
    }, [platform, transparencyEnabled]);

    const togglePanel = (side: ShellPanelSide) => {
        const usesDrawer =
            responsive.mode === "narrow" ||
            (responsive.mode === "medium" && side === "right");
        if (usesDrawer) {
            setPreferredDrawer((current) => (current === side ? null : side));
            return;
        }
        if (side === "left") {
            setLeftCollapsed((current) => !current);
        } else {
            setRightCollapsed((current) => !current);
        }
    };

    const closeDrawer = (side: ShellPanelSide) => {
        if (side === "left") {
            setPreferredDrawer((current) =>
                current === "left" ? null : current,
            );
        } else {
            setPreferredDrawer((current) =>
                current === "right" ? null : current,
            );
        }
    };

    const persistentLeft =
        !responsive.left.overlay && !responsive.left.collapsed;
    const persistentRight =
        !responsive.right.overlay && !responsive.right.collapsed;

    return (
        <main
            className="flex h-screen min-h-0 flex-col text-text-primary"
            data-shell-harness-mode={responsive.mode}
        >
            <DesktopWindowChrome
                inspectorControlsId={
                    responsive.right.overlay
                        ? "workspace-inspector-drawer"
                        : "workspace-inspector"
                }
                inspectorExpanded={!responsive.right.collapsed}
                inspectorToggleRef={inspectorToggleRef}
                navigatorControlsId={
                    responsive.left.overlay
                        ? "workspace-navigator-drawer"
                        : "workspace-navigator"
                }
                navigatorExpanded={!responsive.left.collapsed}
                navigatorToggleRef={navigatorToggleRef}
                onToggleInspector={() => togglePanel("right")}
                onToggleNavigator={() => togglePanel("left")}
                platform={platform}
            />
            <div
                className="shell-responsive-grid relative grid min-h-0 flex-1"
                data-shell-grid="true"
                style={{ gridTemplateColumns: getShellGridTemplateColumns(responsive) }}
            >
                <aside
                    aria-label="Workspace navigator"
                    hidden={!persistentLeft}
                    id={responsive.left.overlay ? undefined : "workspace-navigator"}
                >
                    <button type="button">Navigator action</button>
                </aside>
                <SplitHandle
                    controlsId="workspace-navigator"
                    hidden={!persistentLeft}
                    label="Resize workspace navigator"
                    max={420}
                    min={220}
                    onDecrease={() => undefined}
                    onIncrease={() => undefined}
                    onMaximum={() => undefined}
                    onMinimum={() => undefined}
                    onPointerDown={() => undefined}
                    side="left"
                    value={responsive.left.width}
                />
                <section
                    aria-label="Workspace surface"
                    className="grid min-h-0 place-items-center bg-bg-primary"
                    data-workspace-surface="true"
                >
                    Workspace surface
                </section>
                <SplitHandle
                    controlsId="workspace-inspector"
                    hidden={!persistentRight}
                    label="Resize workspace inspector"
                    max={500}
                    min={300}
                    onDecrease={() => undefined}
                    onIncrease={() => undefined}
                    onMaximum={() => undefined}
                    onMinimum={() => undefined}
                    onPointerDown={() => undefined}
                    side="right"
                    value={responsive.right.width}
                />
                <aside
                    aria-label="Workspace inspector"
                    hidden={!persistentRight}
                    id={responsive.right.overlay ? undefined : "workspace-inspector"}
                >
                    <button type="button">Inspector action</button>
                </aside>

                {responsive.left.overlay && responsive.left.collapsed ? (
                    <div hidden id="workspace-navigator-drawer" />
                ) : null}
                {openDrawerSide === "left" ? (
                    <ShellDrawer
                        id="workspace-navigator-drawer"
                        label="Workspace navigator"
                        onDismiss={() => closeDrawer("left")}
                        restoreFocusRef={navigatorToggleRef}
                        side="left"
                        width={responsive.left.width}
                    >
                        <button type="button">Navigator drawer action</button>
                    </ShellDrawer>
                ) : null}
                {responsive.right.overlay && responsive.right.collapsed ? (
                    <div hidden id="workspace-inspector-drawer" />
                ) : null}
                {openDrawerSide === "right" ? (
                    <ShellDrawer
                        id="workspace-inspector-drawer"
                        label="Workspace inspector"
                        onDismiss={() => closeDrawer("right")}
                        restoreFocusRef={inspectorToggleRef}
                        side="right"
                        width={responsive.right.width}
                    >
                        <button type="button">Inspector drawer action</button>
                    </ShellDrawer>
                ) : null}
            </div>
        </main>
    );
}
