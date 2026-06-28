import React from "react";
import ReactDOM from "react-dom/client";

import { initReviewEngine } from "@shared/ai-review-engine/reviewEngine";

import { App } from "./App";
import { SettingsApp } from "./SettingsApp";
import "./styles.css";

const windowMode = new URLSearchParams(window.location.search).get("window");
const RootComponent = windowMode === "settings" ? SettingsApp : App;

const userAgentPlatform = navigator.platform.toLowerCase();
const detectedPlatform = userAgentPlatform.startsWith("mac")
    ? "darwin"
    : userAgentPlatform.includes("win")
      ? "win32"
      : "linux";
document.documentElement.setAttribute("data-platform", detectedPlatform);

document.documentElement.dataset.comandoRenderer = "booted";

// The review diff/patch engine lives in Rust/WASM. Load it before mounting so
// review computation is never invoked before the engine is ready.
try {
    await initReviewEngine();
} catch (error) {
    console.error("Failed to initialize the review engine", error);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <RootComponent />
    </React.StrictMode>,
);

document.documentElement.dataset.comandoRendered = "mounted";
