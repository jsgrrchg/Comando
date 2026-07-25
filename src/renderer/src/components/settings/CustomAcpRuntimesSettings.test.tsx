/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    CustomAcpRuntimeDefinition,
} from "@shared/ipc";

import { CustomAcpRuntimesSettings } from "./CustomAcpRuntimesSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.unstubAllGlobals();
});

describe("CustomAcpRuntimesSettings", () => {
    it("renders multiple definitions without provider authentication controls", () => {
        const untrusted = {
            ...definition(
                "11111111-1111-4111-8111-111111111111",
                "<img src=x onerror=alert(1)>",
            ),
            command: "$(touch /tmp/should-not-run)",
        };
        mount(
            <CustomAcpRuntimesSettings
                definitions={[
                    definition("550e8400-e29b-41d4-a716-446655440000", "Pi"),
                    definition(
                        "7d444840-9dc0-11d1-b245-5ffdce74fad2",
                        "Pi development",
                    ),
                    untrusted,
                ]}
            />,
        );

        expect(document.body.textContent).toContain("Pi");
        expect(document.body.textContent).toContain("Pi development");
        expect(document.body.textContent).toContain(
            "Authentication managed by the runtime",
        );
        expect(document.body.textContent).toContain(
            "does not pass provider credentials",
        );
        expect(document.body.textContent).not.toContain("Log in");
        expect(document.body.textContent).not.toContain("API key");
        expect(document.body.querySelector("img")).toBeNull();
        expect(document.body.textContent).toContain(
            "$(touch /tmp/should-not-run)",
        );
    });

    it("validates, verifies, and creates a runtime with structured arguments and environment", async () => {
        const onCreate = vi.fn(() =>
            Promise.resolve(
                definition(
                    "550e8400-e29b-41d4-a716-446655440000",
                    "Pi",
                ),
            ),
        );
        const onVerify = vi.fn(() => Promise.resolve(readyStatus()));
        mount(
            <CustomAcpRuntimesSettings
                onCreate={onCreate}
                onVerify={onVerify}
            />,
        );

        clickButton("Add runtime");
        const inputs = document.body.querySelectorAll<HTMLInputElement>("input");
        const textareas =
            document.body.querySelectorAll<HTMLTextAreaElement>("textarea");
        changeValue(inputs[0], "Pi");
        changeValue(inputs[1], "/opt/homebrew/bin/pi-acp");
        changeValue(textareas[0], "--profile\ndevelopment");
        changeValue(textareas[1], "PI_PROFILE=development");

        await clickButtonAsync("Verify executable");
        expect(onVerify).toHaveBeenCalledWith({
            args: ["--profile", "development"],
            authMode: "external",
            command: "/opt/homebrew/bin/pi-acp",
            displayName: "Pi",
            env: { PI_PROFILE: "development" },
        });
        expect(document.body.textContent).toContain("Executable verified");

        await clickButtonAsync("Add runtime", 1);
        expect(onCreate).toHaveBeenCalledOnce();
    });

    it("announces inline secret validation and confirms destructive deletion", async () => {
        const runtime = definition(
            "550e8400-e29b-41d4-a716-446655440000",
            "Pi",
        );
        const onDelete = vi.fn(() =>
            Promise.resolve({ deleted: true, historyReferenceCount: 2 }),
        );
        vi.stubGlobal("confirm", vi.fn(() => true));
        mount(
            <CustomAcpRuntimesSettings
                definitions={[runtime]}
                onDelete={onDelete}
            />,
        );

        clickButton("Edit");
        const textarea =
            document.body.querySelectorAll<HTMLTextAreaElement>("textarea")[1];
        changeValue(textarea, "OPENAI_API_KEY=secret");
        await clickButtonAsync("Save changes");
        const alert = document.body.querySelector('[role="alert"]');
        expect(alert?.textContent).toContain("looks secret");
        expect(onDelete).not.toHaveBeenCalled();

        await clickButtonAsync("Delete");
        expect(globalThis.confirm).toHaveBeenCalledWith(
            expect.stringContaining("Saved history will remain"),
        );
        expect(onDelete).toHaveBeenCalledWith(runtime.id);
    });

    it("restores a deleted definition with its original identity", async () => {
        const runtime = definition(
            "550e8400-e29b-41d4-a716-446655440000",
            "Pi",
        );
        const onRestore = vi.fn(() => Promise.resolve(runtime));
        mount(
            <CustomAcpRuntimesSettings
                deletedDefinitions={[runtime]}
                onRestore={onRestore}
            />,
        );

        expect(document.body.textContent).toContain(
            "Deleted definitions retained for history",
        );
        await clickButtonAsync("Restore");
        expect(onRestore).toHaveBeenCalledWith(runtime.id);
    });

    it("requires confirmation before changing a persisted launch contract", async () => {
        const runtime = definition(
            "550e8400-e29b-41d4-a716-446655440000",
            "Pi",
        );
        const onUpdate = vi.fn(() => Promise.resolve(runtime));
        const confirm = vi.fn(() => false);
        vi.stubGlobal("confirm", confirm);
        mount(
            <CustomAcpRuntimesSettings
                definitions={[runtime]}
                onUpdate={onUpdate}
            />,
        );

        clickButton("Edit");
        const command =
            document.body.querySelectorAll<HTMLInputElement>("input")[1];
        changeValue(command, "/usr/local/bin/pi-acp");
        await clickButtonAsync("Save changes");

        expect(confirm).toHaveBeenCalledWith(
            expect.stringContaining("Existing history keeps its original fingerprint"),
        );
        expect(onUpdate).not.toHaveBeenCalled();
    });
});

function mount(node: ReactNode): void {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(node));
}

function changeValue(
    element: HTMLInputElement | HTMLTextAreaElement | undefined,
    value: string,
): void {
    expect(element).toBeTruthy();
    act(() => {
        const prototype =
            element instanceof HTMLInputElement
                ? HTMLInputElement.prototype
                : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
            element,
            value,
        );
        element?.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

function clickButton(label: string, index = 0): void {
    const button = buttons(label)[index];
    expect(button).toBeTruthy();
    act(() => button?.click());
}

async function clickButtonAsync(label: string, index = 0): Promise<void> {
    const button = buttons(label)[index];
    expect(button).toBeTruthy();
    await act(async () => {
        button?.click();
        await Promise.resolve();
    });
}

function buttons(label: string): HTMLButtonElement[] {
    return [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter(
        (button) => button.textContent?.trim() === label,
    );
}

function definition(
    uuid: string,
    displayName: string,
): CustomAcpRuntimeDefinition {
    return {
        args: [],
        authMode: "external",
        command: "/opt/homebrew/bin/pi-acp",
        displayName,
        env: {},
        id: `custom:${uuid}`,
        launchFingerprint: "a".repeat(64),
        revision: 1,
    };
}

function readyStatus(): AiRuntimeStatus {
    return {
        authCredentialSource: "external-runtime",
        authCredentialSourceLabel: "Authentication managed by the runtime",
        authMethod: "external",
        authMethods: [],
        authReady: true,
        checkedAt: "2026-07-24T00:00:00.000Z",
        command: "/opt/homebrew/bin/pi-acp",
        hasCustomBinaryPath: true,
        hasGatewayConfig: false,
        hasGatewayUrl: false,
        message: null,
        onboardingRequired: false,
        runtimeId: "custom:550e8400-e29b-41d4-a716-446655440000",
        source: "settings",
        state: "ready",
    };
}
