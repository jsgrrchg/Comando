import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { IPC_CHANNELS } from "@shared/ipc";

// Text-level enforcement: every channel declared in `IPC_CHANNELS` must be
// referenced by an `ipcMain.handle(IPC_CHANNELS.<key>, …)` call in the main
// IPC module. Catches the "declared but unhandled" drift that caused B11.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IPC_INDEX_PATH = path.join(HERE, "index.ts");

describe("IPC channel coverage", () => {
    const source = fs.readFileSync(IPC_INDEX_PATH, "utf8");

    for (const key of Object.keys(IPC_CHANNELS)) {
        it(`registers a handler for IPC_CHANNELS.${key}`, () => {
            const pattern = new RegExp(
                `ipcMain\\.handle\\(\\s*IPC_CHANNELS\\.${key}\\b`,
            );
            expect(
                pattern.test(source),
                `Expected ipcMain.handle(IPC_CHANNELS.${key}, ...) in ${IPC_INDEX_PATH}`,
            ).toBe(true);
        });
    }
});
