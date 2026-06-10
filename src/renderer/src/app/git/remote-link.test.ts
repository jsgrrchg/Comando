import { describe, expect, it } from "vitest";

import type { GitRemoteSummary } from "@shared/ipc";

import { resolveGitHubRepositoryRef } from "./remote-link";

function createRemote(
    overrides: Partial<GitRemoteSummary> = {},
): GitRemoteSummary {
    return {
        aheadBy: 0,
        behindBy: 0,
        fetchUrl: "git@github.com:owner/repo.git",
        isDefault: false,
        name: "origin",
        pushUrl: null,
        refName: null,
        ...overrides,
    };
}

describe("resolveGitHubRepositoryRef", () => {
    it("resolves the default GitHub remote from ssh URLs", () => {
        const ref = resolveGitHubRepositoryRef([
            createRemote({
                fetchUrl: "https://gitlab.com/acme/other.git",
                name: "upstream",
            }),
            createRemote({
                fetchUrl: "git@github.com:comando/app.git",
                isDefault: true,
            }),
        ]);

        expect(ref).toEqual({
            host: "github.com",
            owner: "comando",
            repo: "app",
        });
    });

    it("resolves GitHub Enterprise https remotes", () => {
        const ref = resolveGitHubRepositoryRef([
            createRemote({
                fetchUrl: "https://github.internal.example/platform/client.git",
            }),
        ]);

        expect(ref).toEqual({
            host: "github.internal.example",
            owner: "platform",
            repo: "client",
        });
    });

    it("falls back to a secondary GitHub remote when the default is not GitHub", () => {
        const ref = resolveGitHubRepositoryRef([
            createRemote({
                fetchUrl: "https://gitlab.com/acme/other.git",
                isDefault: true,
                name: "upstream",
            }),
            createRemote({
                fetchUrl: "https://github.com/comando/app.git",
                name: "origin",
            }),
        ]);

        expect(ref).toEqual({
            host: "github.com",
            owner: "comando",
            repo: "app",
        });
    });

    it("returns null for non-GitHub remotes", () => {
        expect(
            resolveGitHubRepositoryRef([
                createRemote({
                    fetchUrl: "git@gitlab.com:comando/app.git",
                    isDefault: true,
                }),
            ]),
        ).toBeNull();
    });
});
