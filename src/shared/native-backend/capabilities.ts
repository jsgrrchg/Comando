import type { NativeProtocolVersion } from "./common";

export const NATIVE_BACKEND_NAME = "comando-native-backend";
export const NATIVE_PROTOCOL_VERSION = 1;
export const NATIVE_MINIMUM_CLIENT_PROTOCOL_VERSION = 1;
export const NATIVE_MINIMUM_BACKEND_PROTOCOL_VERSION = 1;

export type NativeCapabilitySet = {
    readonly domains: readonly string[];
    readonly commands: readonly string[];
    readonly events: readonly string[];
    readonly features: readonly string[];
};

export type NativeBackendHandshakeInput = {
    readonly clientName: string;
    readonly clientVersion: string;
    readonly protocolVersion: NativeProtocolVersion;
    readonly supportedProtocolVersions: readonly NativeProtocolVersion[];
};

export type NativeBackendHandshakeOutput = {
    readonly backendName: string;
    readonly backendVersion: string;
    readonly protocolVersion: NativeProtocolVersion;
    readonly minimumClientProtocolVersion: NativeProtocolVersion;
    readonly capabilities: NativeCapabilitySet;
};

export type NativeBackendCapabilitiesOutput = {
    readonly backendName: string;
    readonly backendVersion: string;
    readonly rustVersion: string;
    readonly protocolVersion: NativeProtocolVersion;
    readonly minimumClientProtocolVersion: NativeProtocolVersion;
    readonly minimumBackendProtocolVersion: NativeProtocolVersion;
    readonly capabilities: NativeCapabilitySet;
};

export type NativeProtocolCompatibility = {
    readonly protocolVersion: NativeProtocolVersion;
    readonly minimumClientProtocolVersion: NativeProtocolVersion;
    readonly minimumBackendProtocolVersion: NativeProtocolVersion;
    readonly supportedProtocolVersions: readonly NativeProtocolVersion[];
};

export function parseNativeCapabilitySet(value: unknown): NativeCapabilitySet {
    const record = requireRecord(value, "Native capabilities");

    return {
        domains: parseStringArray(record.domains, "domains"),
        commands: parseStringArray(record.commands, "commands"),
        events: parseStringArray(record.events, "events"),
        features: parseStringArray(record.features, "features"),
    };
}

export function parseNativeBackendHandshakeOutput(
    value: unknown,
): NativeBackendHandshakeOutput {
    const record = requireRecord(value, "Native handshake");

    return {
        backendName: requireString(record.backendName, "backendName"),
        backendVersion: requireString(record.backendVersion, "backendVersion"),
        protocolVersion: requireNumber(record.protocolVersion, "protocolVersion"),
        minimumClientProtocolVersion: requireNumber(
            record.minimumClientProtocolVersion,
            "minimumClientProtocolVersion",
        ),
        capabilities: parseNativeCapabilitySet(record.capabilities),
    };
}

export function parseNativeBackendCapabilitiesOutput(
    value: unknown,
): NativeBackendCapabilitiesOutput {
    const record = requireRecord(value, "Native backend capabilities");

    return {
        backendName: requireString(record.backendName, "backendName"),
        backendVersion: requireString(record.backendVersion, "backendVersion"),
        rustVersion: requireString(record.rustVersion, "rustVersion"),
        protocolVersion: requireNumber(record.protocolVersion, "protocolVersion"),
        minimumClientProtocolVersion: requireNumber(
            record.minimumClientProtocolVersion,
            "minimumClientProtocolVersion",
        ),
        minimumBackendProtocolVersion: requireNumber(
            record.minimumBackendProtocolVersion,
            "minimumBackendProtocolVersion",
        ),
        capabilities: parseNativeCapabilitySet(record.capabilities),
    };
}

export function isNativeProtocolCompatible(input: {
    readonly backendProtocolVersion: NativeProtocolVersion;
    readonly minimumClientProtocolVersion: NativeProtocolVersion;
    readonly clientProtocolVersion?: NativeProtocolVersion;
    readonly minimumBackendProtocolVersion?: NativeProtocolVersion;
}): boolean {
    const clientProtocolVersion =
        input.clientProtocolVersion ?? NATIVE_PROTOCOL_VERSION;
    const minimumBackendProtocolVersion =
        input.minimumBackendProtocolVersion ??
        NATIVE_MINIMUM_BACKEND_PROTOCOL_VERSION;

    return (
        input.backendProtocolVersion >= minimumBackendProtocolVersion &&
        clientProtocolVersion >= input.minimumClientProtocolVersion &&
        input.backendProtocolVersion === NATIVE_PROTOCOL_VERSION
    );
}

function parseStringArray(value: unknown, fieldName: string): readonly string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`Native capabilities ${fieldName} must be string[].`);
    }

    return value;
}

function requireRecord(
    value: unknown,
    label: string,
): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }

    return value as Record<string, unknown>;
}

function requireString(value: unknown, fieldName: string): string {
    if (typeof value !== "string") {
        throw new Error(`Native capability field ${fieldName} must be a string.`);
    }

    return value;
}

function requireNumber(value: unknown, fieldName: string): number {
    if (typeof value !== "number") {
        throw new Error(`Native capability field ${fieldName} must be a number.`);
    }

    return value;
}
