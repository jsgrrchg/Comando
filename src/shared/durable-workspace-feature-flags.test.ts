import { describe, expect, it } from "vitest";

import {
    DEFAULT_DURABLE_WORKSPACE_FEATURE_FLAGS,
    DURABLE_WORKSPACE_FEATURE_FLAG_ENV,
    resolveDurableWorkspaceFeatureFlags,
} from "./durable-workspace-feature-flags";

describe("durable workspace feature flags", () => {
    it("keeps every v4 authority disabled by default", () => {
        expect(resolveDurableWorkspaceFeatureFlags({})).toEqual(
            DEFAULT_DURABLE_WORKSPACE_FEATURE_FLAGS,
        );
    });

    it("enables each rollout axis only through an explicit value", () => {
        expect(
            resolveDurableWorkspaceFeatureFlags({
                [DURABLE_WORKSPACE_FEATURE_FLAG_ENV.newChrome]: "1",
                [DURABLE_WORKSPACE_FEATURE_FLAG_ENV.readV4]: "true",
                [DURABLE_WORKSPACE_FEATURE_FLAG_ENV.singleWindowHost]: "0",
                [DURABLE_WORKSPACE_FEATURE_FLAG_ENV.writeV4]: "1",
            }),
        ).toEqual({
            newChrome: true,
            readV4: false,
            singleWindowHost: false,
            writeV4: true,
        });
    });
});
