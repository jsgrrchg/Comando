export const DURABLE_WORKSPACE_FEATURE_FLAG_ENV = {
    newChrome: "COMANDO_FEATURE_DURABLE_WORKSPACES_NEW_CHROME",
    readV4: "COMANDO_FEATURE_DURABLE_WORKSPACES_READ_V4",
    singleWindowHost: "COMANDO_FEATURE_DURABLE_WORKSPACES_SINGLE_WINDOW_HOST",
    writeV4: "COMANDO_FEATURE_DURABLE_WORKSPACES_WRITE_V4",
} as const;

export interface DurableWorkspaceFeatureFlags {
    readonly newChrome: boolean;
    readonly readV4: boolean;
    readonly singleWindowHost: boolean;
    readonly writeV4: boolean;
}

export const DEFAULT_DURABLE_WORKSPACE_FEATURE_FLAGS = {
    newChrome: false,
    readV4: false,
    singleWindowHost: false,
    writeV4: false,
} as const satisfies DurableWorkspaceFeatureFlags;

export function resolveDurableWorkspaceFeatureFlags(
    environment: Readonly<Record<string, string | undefined>>,
): DurableWorkspaceFeatureFlags {
    return {
        newChrome: isExplicitlyEnabled(
            environment[DURABLE_WORKSPACE_FEATURE_FLAG_ENV.newChrome],
        ),
        readV4: isExplicitlyEnabled(
            environment[DURABLE_WORKSPACE_FEATURE_FLAG_ENV.readV4],
        ),
        singleWindowHost: isExplicitlyEnabled(
            environment[
                DURABLE_WORKSPACE_FEATURE_FLAG_ENV.singleWindowHost
            ],
        ),
        writeV4: isExplicitlyEnabled(
            environment[DURABLE_WORKSPACE_FEATURE_FLAG_ENV.writeV4],
        ),
    };
}

function isExplicitlyEnabled(value: string | undefined): boolean {
    // Strict opt-in prevents inherited or misspelled values from changing authority.
    return value === "1";
}
