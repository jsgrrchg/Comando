import { describe, expect, it } from "vitest";

import {
    parseAppChannel,
    resolveAppChannel,
    resolveAppIdentity,
} from "./app-identity";

describe("resolveAppChannel", () => {
    it("uses the development channel for unpackaged runs by default", () => {
        expect(
            resolveAppChannel({
                envChannel: null,
                isPackaged: false,
            }),
        ).toBe("dev");
    });

    it("uses the release channel for packaged runs by default", () => {
        expect(
            resolveAppChannel({
                envChannel: null,
                isPackaged: true,
            }),
        ).toBe("release");
    });

    it("accepts explicit channel overrides", () => {
        expect(
            resolveAppChannel({
                envChannel: "release",
                isPackaged: false,
            }),
        ).toBe("release");
    });

    it("ignores unsupported channel overrides", () => {
        expect(parseAppChannel("preview")).toBeNull();
        expect(
            resolveAppChannel({
                envChannel: "preview",
                isPackaged: false,
            }),
        ).toBe("dev");
    });
});

describe("resolveAppIdentity", () => {
    it("returns a dedicated identity for the development channel", () => {
        expect(resolveAppIdentity("dev")).toMatchObject({
            channel: "dev",
            id: "comando-dev",
            name: "Comando Dev",
            windowTitle: "Comando Dev",
        });
    });

    it("keeps the release identity unchanged", () => {
        expect(resolveAppIdentity("release")).toMatchObject({
            channel: "release",
            id: "comando",
            name: "Comando",
            windowTitle: "Comando",
        });
    });
});
