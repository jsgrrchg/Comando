import type { NativeProjectId, NativeRuntimeId } from "./ids";

export type NativeRuntimeSettings = {
    readonly runtimeId: NativeRuntimeId;
    readonly authMethod: string | null;
    readonly binaryPath: string | null;
};

export type NativeSettingsSnapshot = {
    readonly runtimes: readonly NativeRuntimeSettings[];
    readonly updatedAt: string;
};

export type NativeProjectSettingsSnapshot = {
    readonly projectId: NativeProjectId;
    readonly editor: unknown;
    readonly appearance: unknown;
};

export type NativeSecretRef = {
    readonly id: string;
    readonly label: string;
    readonly redacted: boolean;
};

export type NativeSecretStatus = "invalid" | "missing" | "present" | "unknown";

export type NativeSecretRedactionPolicy = {
    readonly fieldPaths: readonly string[];
    readonly replacement: string;
};

export type NativeRuntimeEnvResolution = {
    readonly runtimeId: NativeRuntimeId;
    readonly inheritedPath: string | null;
    readonly resolvedCommand: string | null;
    readonly redactions: readonly NativeSecretRedactionPolicy[];
};
