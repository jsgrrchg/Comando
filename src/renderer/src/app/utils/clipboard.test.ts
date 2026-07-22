/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeClipboardText } from "./clipboard";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("writeClipboardText", () => {
    it("prefers the native clipboard bridge", async () => {
        const writeClipboardTextNative = vi.fn(() => Promise.resolve());
        const writeClipboardTextWeb = vi.fn(() => Promise.resolve());
        vi.stubGlobal("comando", {
            writeClipboardText: writeClipboardTextNative,
        });
        vi.stubGlobal("navigator", {
            ...navigator,
            clipboard: { writeText: writeClipboardTextWeb },
        });

        await writeClipboardText("/projects/comando");

        expect(writeClipboardTextNative).toHaveBeenCalledWith(
            "/projects/comando",
        );
        expect(writeClipboardTextWeb).not.toHaveBeenCalled();
    });

    it("falls back to the Web Clipboard API when the native bridge fails", async () => {
        const writeClipboardTextWeb = vi.fn(() => Promise.resolve());
        vi.stubGlobal("comando", {
            writeClipboardText: vi.fn(() =>
                Promise.reject(new Error("IPC unavailable")),
            ),
        });
        vi.stubGlobal("navigator", {
            ...navigator,
            clipboard: { writeText: writeClipboardTextWeb },
        });

        await writeClipboardText("/projects/comando");

        expect(writeClipboardTextWeb).toHaveBeenCalledWith("/projects/comando");
    });
});
