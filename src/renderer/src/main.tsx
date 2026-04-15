import React from "react";
import ReactDOM from "react-dom/client";

import "./app/editor/monaco";
import { App } from "./App";
import { SettingsApp } from "./SettingsApp";
import "./styles.css";

const windowMode = new URLSearchParams(window.location.search).get("window");
const RootComponent = windowMode === "settings" ? SettingsApp : App;

document.documentElement.dataset.comandoRenderer = "booted";

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <RootComponent />
    </React.StrictMode>,
);

document.documentElement.dataset.comandoRendered = "mounted";
