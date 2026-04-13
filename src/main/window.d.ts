import { BrowserWindow } from "electron";
import type { PersistedWindowState } from "@shared/ipc";
export declare function createMainWindow(restoredState?: PersistedWindowState | null): BrowserWindow;
