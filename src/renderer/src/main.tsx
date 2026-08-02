import React from "react";
import ReactDOM from "react-dom/client";

import {
    rendererModeRequiresReviewEngine,
    resolveRendererMode,
} from "./app/renderer-mode";
import "./styles.css";

const rendererMode = resolveRendererMode(window.location.search);

const userAgentPlatform = navigator.platform.toLowerCase();
const detectedPlatform = userAgentPlatform.startsWith("mac")
    ? "darwin"
    : userAgentPlatform.includes("win")
      ? "win32"
      : "linux";
document.documentElement.setAttribute("data-platform", detectedPlatform);

document.documentElement.dataset.comandoRenderer = "booted";

if (rendererModeRequiresReviewEngine(rendererMode)) {
    // Host and settings never import the WASM review runtime.
    try {
        const { initReviewEngine } = await import(
            "@shared/ai-review-engine/reviewEngine"
        );
        await initReviewEngine();
    } catch (error) {
        console.error("Failed to initialize the review engine", error);
    }
}

const RootComponent = await loadRendererRoot(rendererMode);

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <RootComponent />
    </React.StrictMode>,
);

document.documentElement.dataset.comandoRendered = "mounted";

async function loadRendererRoot(mode: typeof rendererMode) {
    switch (mode) {
        case "settings":
            return (await import("./SettingsApp")).SettingsApp;
        case "workspace-host":
            return (await import("./WorkspaceHostApp")).WorkspaceHostApp;
        case "workspace-surface":
            return (await import("./WorkspaceSurfaceApp"))
                .WorkspaceSurfaceApp;
        case "legacy":
            return (await import("./App")).App;
    }
}
