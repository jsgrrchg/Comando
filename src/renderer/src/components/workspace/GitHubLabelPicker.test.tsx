// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitHubLabelSummary } from "@shared/ipc";

import { GitHubLabelPicker } from "./GitHubLabelPicker";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
    if (root) {
        act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
});

describe("GitHubLabelPicker", () => {
    it("keeps an assigned label that is absent from the loaded catalog", () => {
        const legacyLabel: GitHubLabelSummary = {
            color: "d73a4a",
            description: null,
            id: 1,
            name: "legacy",
        };
        const onSave = vi.fn();
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);

        act(() => {
            root?.render(
                createElement(GitHubLabelPicker, {
                    anchor: { x: 10, y: 10 },
                    error: null,
                    isLoading: false,
                    isSaving: false,
                    item: {
                        labels: [legacyLabel],
                        number: 7,
                        title: "Keep this label",
                    },
                    labels: [],
                    onClose: () => undefined,
                    onSave,
                }),
            );
        });

        const picker = document.querySelector("[data-context-menu-root='true']");
        const saveButton = [...(picker?.querySelectorAll("button") ?? [])].find(
            (button) => button.textContent === "Save",
        );
        expect(picker?.textContent).toContain("legacy");
        expect(saveButton).toBeDefined();

        act(() => saveButton?.click());

        expect(onSave).toHaveBeenCalledWith(["legacy"]);
    });
});
