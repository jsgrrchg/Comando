export type AppChannel = "dev" | "release";

interface AppIconPlaceholderPaths {
    readonly macos: string;
    readonly windows: string;
    readonly png: string;
}

export interface AppIdentity {
    readonly bundleIdPlaceholder: string;
    readonly channel: AppChannel;
    readonly iconPlaceholderPaths: AppIconPlaceholderPaths;
    readonly id: string;
    readonly name: string;
    readonly productName: string;
    readonly windowTitle: string;
}

const iconPlaceholderPaths = {
    macos: "resources/icons/macos-placeholder.icns",
    windows: "resources/icons/windows-placeholder.ico",
    png: "resources/icons/app-placeholder.png",
} as const satisfies AppIconPlaceholderPaths;

const APP_IDENTITIES = {
    dev: {
        bundleIdPlaceholder: "com.placeholder.comando",
        channel: "dev",
        iconPlaceholderPaths,
        id: "comando-dev",
        name: "Comando Dev",
        productName: "Comando Dev",
        windowTitle: "Comando Dev",
    },
    release: {
        bundleIdPlaceholder: "com.placeholder.comando",
        channel: "release",
        iconPlaceholderPaths,
        id: "comando",
        name: "Comando",
        productName: "Comando",
        windowTitle: "Comando",
    },
} as const satisfies Record<AppChannel, AppIdentity>;

export const appIdentity = APP_IDENTITIES.release;

export function parseAppChannel(
    value: string | null | undefined,
): AppChannel | null {
    if (value === "dev" || value === "release") {
        return value;
    }

    return null;
}

export function resolveAppChannel(options: {
    readonly envChannel?: string | null;
    readonly isPackaged: boolean;
}): AppChannel {
    return (
        parseAppChannel(options.envChannel) ??
        (options.isPackaged ? "release" : "dev")
    );
}

export function resolveAppIdentity(channel: AppChannel): AppIdentity {
    return APP_IDENTITIES[channel];
}
