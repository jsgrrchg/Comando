/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiSessionConfigOption } from "@shared/ipc";

import { AIChatAgentControls } from "./AIChatAgentControls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLDivElement[] = [];

const SUBAGENT_CONFIG_OPTIONS: readonly AiSessionConfigOption[] = [
    {
        category: "model",
        description: null,
        id: "model",
        label: "Model",
        options: [
            {
                description: null,
                groupLabel: null,
                label: "gpt-5-mini",
                value: "gpt-5-mini",
            },
            {
                description: null,
                groupLabel: null,
                label: "gpt-5-pro",
                value: "gpt-5-pro",
            },
        ],
        type: "select",
        value: "gpt-5-mini",
    },
    {
        category: "reasoning",
        description: null,
        id: "codex-reasoning-effort",
        label: "Reasoning Effort",
        options: [
            {
                description: null,
                groupLabel: null,
                label: "low",
                value: "low",
            },
            {
                description: null,
                groupLabel: null,
                label: "high",
                value: "high",
            },
        ],
        type: "select",
        value: "high",
    },
];

const GPT_5_6_MODEL_CONFIG_OPTIONS: readonly AiSessionConfigOption[] = [
    {
        category: "model",
        description: null,
        id: "model",
        label: "Model",
        options: [
            {
                description: null,
                groupLabel: "GPT 5.6",
                label: "Sol",
                value: "gpt-5.6-sol",
            },
            {
                description: null,
                groupLabel: "GPT 5.6",
                label: "Terra",
                value: "gpt-5.6-terra",
            },
            {
                description: null,
                groupLabel: "GPT 5.6",
                label: "Luna",
                value: "gpt-5.6-luna",
            },
            {
                description: null,
                groupLabel: "Other models",
                label: "gpt-5.5",
                value: "gpt-5.5",
            },
        ],
        type: "select",
        value: "gpt-5.6-terra",
    },
];

function mountControls(
    overrides: Partial<Parameters<typeof AIChatAgentControls>[0]> = {},
) {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const root = createRoot(container);
    mountedRoots.push(root);
    mountedContainers.push(container);

    const props: Parameters<typeof AIChatAgentControls>[0] = {
        configOptions: SUBAGENT_CONFIG_OPTIONS,
        modeId: "",
        modelId: "gpt-5-pro",
        modes: [],
        models: [
            {
                description: null,
                id: "gpt-5-pro",
                name: "GPT-5 Pro",
            },
        ],
        onConfigOptionChange: vi.fn(),
        onModeChange: vi.fn(),
        onModelChange: vi.fn(),
        runtimeId: "codex",
        ...overrides,
    };

    act(() => {
        root.render(<AIChatAgentControls {...props} />);
    });

    return { container, props };
}

function getButtonByTitle(container: ParentNode, title: string): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
        `button[title="${title}"]`,
    );
    if (!button) {
        throw new Error(`Expected button titled ${title}`);
    }
    return button;
}

function getButtonByText(container: ParentNode, text: string): HTMLButtonElement {
    const buttons = Array.from(container.querySelectorAll("button"));
    const button = buttons.find(
        (candidate) => candidate.textContent?.trim() === text,
    );
    if (!button) {
        throw new Error(`Expected button with text ${text}`);
    }
    return button;
}

function click(element: Element): void {
    act(() => {
        element.dispatchEvent(
            new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
            }),
        );
    });
}

afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
        act(() => {
            root.unmount();
        });
    }

    for (const container of mountedContainers.splice(0)) {
        container.remove();
    }

    document.body.innerHTML = "";
});

describe("AIChatAgentControls", () => {
    it("renders the active subagent model and reasoning effort from config options", () => {
        const { container } = mountControls();

        expect(getButtonByTitle(container, "Model").textContent).toContain(
            "GPT 5 Mini",
        );
        expect(
            getButtonByTitle(container, "Reasoning Effort").textContent,
        ).toContain("High");
    });

    it("keeps controls disabled for a closed subagent", () => {
        const { container, props } = mountControls({ disabled: true });

        const modelButton = getButtonByTitle(container, "Model");
        const effortButton = getButtonByTitle(container, "Reasoning Effort");

        expect(modelButton.disabled).toBe(true);
        expect(effortButton.disabled).toBe(true);

        click(effortButton);

        expect(props.onConfigOptionChange).not.toHaveBeenCalled();
        expect(document.body.textContent).not.toContain("Low");
    });

    it("emits the active subagent effort option change", () => {
        const onConfigOptionChange = vi.fn();
        const { container } = mountControls({ onConfigOptionChange });

        click(getButtonByTitle(container, "Reasoning Effort"));
        click(getButtonByText(document.body, "Low"));

        expect(onConfigOptionChange).toHaveBeenCalledWith(
            "codex-reasoning-effort",
            "low",
        );
    });

    it("expands GPT-5.6 variants and shows the selected variant label", () => {
        const onConfigOptionChange = vi.fn();
        const { container } = mountControls({
            configOptions: GPT_5_6_MODEL_CONFIG_OPTIONS,
            modelId: "gpt-5.6-terra",
            onConfigOptionChange,
        });

        const modelButton = getButtonByTitle(container, "Model");
        expect(modelButton.textContent).toContain("Terra");
        expect(modelButton.textContent).not.toContain("GPT 5.6");

        click(modelButton);
        const groupButton = getButtonByText(document.body, "GPT 5.6");
        expect(groupButton.getAttribute("aria-expanded")).toBe("false");
        expect(() => getButtonByText(document.body, "Sol")).toThrow();

        click(groupButton);
        expect(groupButton.getAttribute("aria-expanded")).toBe("true");

        click(getButtonByText(document.body, "Sol"));
        expect(onConfigOptionChange).toHaveBeenCalledWith(
            "model",
            "gpt-5.6-sol",
        );
    });
});
