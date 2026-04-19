export type AppChannel = "dev" | "release";

interface AppIconPaths {
    readonly macos: string;
    readonly windows: string;
    readonly png: string;
}

export interface AppIdentity {
    readonly bundleIdPlaceholder: string;
    readonly channel: AppChannel;
    readonly iconPaths: AppIconPaths;
    readonly id: string;
    readonly name: string;
    readonly productName: string;
    readonly windowTitle: string;
}

const iconPaths = {
    macos: "resources/icons/macos.icon",
    windows: "resources/icons/windows.ico",
    png: "resources/icons/app.png",
} as const satisfies AppIconPaths;

const APP_IDENTITIES = {
    dev: {
        bundleIdPlaceholder: "com.placeholder.comando",
        channel: "dev",
        iconPaths,
        id: "comando-dev",
        name: "Comando Dev",
        productName: "Comando Dev",
        windowTitle: "Comando Dev",
    },
    release: {
        bundleIdPlaceholder: "com.placeholder.comando",
        channel: "release",
        iconPaths,
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
