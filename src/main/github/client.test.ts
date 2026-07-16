import { describe, expect, it, vi } from "vitest";

import {
    GitHubApiClient,
    type GitHubFetch,
} from "@main/github/client";

const repository = {
    host: "github.com",
    owner: "octocat",
    repo: "hello-world",
};

describe("GitHubApiClient", () => {
    it("loads and maps every page of pull request files", async () => {
        const fetchMock = vi
            .fn<GitHubFetch>()
            .mockResolvedValueOnce(
                jsonResponse({
                    ...rawPullRequest(),
                    additions: 3,
                    changed_files: 2,
                    deletions: 1,
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse(
                    [
                        {
                            additions: 2,
                            deletions: 1,
                            filename: "src/a.ts",
                            patch: "@@ -1 +1,2 @@\n-old\n+new\n+next",
                            status: "modified",
                        },
                    ],
                    {
                        Link: '<https://api.github.com/repos/octocat/hello-world/pulls/7/files?page=2>; rel="next"',
                    },
                ),
            )
            .mockResolvedValueOnce(
                jsonResponse([
                    {
                        additions: 1,
                        filename: "src/new.ts",
                        status: "added",
                    },
                ]),
            );
        const client = new GitHubApiClient({ fetch: fetchMock, token: "ghp_test" });

        const result = await client.getPullRequestDiff({ number: 7, repository });

        expect(result.fileListComplete).toBe(true);
        expect(result.contentComplete).toBe(false);
        expect(result.files[0]?.hunks[0]?.lines).toHaveLength(3);
        expect(result.files[1]).toMatchObject({
            contentState: "unavailable",
            kind: "create",
            statusLabel: "added",
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    it("aborts pending REST requests after the request timeout", async () => {
        let requestSignal: AbortSignal | undefined;
        const fetchMock = vi.fn<GitHubFetch>((_, init) =>
            pendingAbortableResponse(init, (signal) => {
                requestSignal = signal;
            }),
        );
        const client = new GitHubApiClient({
            fetch: fetchMock,
            requestTimeoutMs: 10,
            token: "ghp_test",
        });

        await expect(client.listIssues({ repository })).rejects.toMatchObject({
            code: "timeout",
            message: "GitHub request timed out.",
        });
        expect(requestSignal?.aborted).toBe(true);
    });

    it("maps explicit fetch aborts to timeout errors", async () => {
        const fetchMock = vi.fn<GitHubFetch>().mockRejectedValue(
            new DOMException("The operation was aborted.", "AbortError"),
        );
        const client = new GitHubApiClient({
            fetch: fetchMock,
            requestTimeoutMs: 1_000,
            token: "ghp_test",
        });

        await expect(client.listIssues({ repository })).rejects.toMatchObject({
            code: "timeout",
            message: "GitHub request timed out.",
        });
    });

    it("aborts pending REST response bodies after the request timeout", async () => {
        let requestSignal: AbortSignal | undefined;
        const fetchMock = vi.fn<GitHubFetch>((_, init) =>
            Promise.resolve(
                pendingAbortableBodyResponse(init, (signal) => {
                    requestSignal = signal;
                }),
            ),
        );
        const client = new GitHubApiClient({
            fetch: fetchMock,
            requestTimeoutMs: 10,
            token: "ghp_test",
        });

        await expect(client.listIssues({ repository })).rejects.toMatchObject({
            code: "timeout",
            message: "GitHub request timed out.",
        });
        expect(requestSignal?.aborted).toBe(true);
    });

    it("aborts pending GraphQL requests after the request timeout", async () => {
        let requestSignal: AbortSignal | undefined;
        const fetchMock = vi
            .fn<GitHubFetch>()
            .mockResolvedValueOnce(jsonResponse(rawPullRequest()))
            .mockResolvedValueOnce(jsonResponse([]))
            .mockResolvedValueOnce(jsonResponse([]))
            .mockImplementation((_, init) =>
                pendingAbortableResponse(init, (signal) => {
                    requestSignal = signal;
                }),
            );
        const client = new GitHubApiClient({
            fetch: fetchMock,
            requestTimeoutMs: 10,
            token: "ghp_test",
        });

        await expect(
            client.setPullRequestDraftState({
                draft: true,
                number: 7,
                repository,
            }),
        ).rejects.toMatchObject({
            code: "timeout",
            message: "GitHub request timed out.",
        });
        expect(requestSignal?.aborted).toBe(true);
    });

    it("aborts pending GraphQL response bodies after the request timeout", async () => {
        let requestSignal: AbortSignal | undefined;
        const fetchMock = vi
            .fn<GitHubFetch>()
            .mockResolvedValueOnce(jsonResponse(rawPullRequest()))
            .mockResolvedValueOnce(jsonResponse([]))
            .mockResolvedValueOnce(jsonResponse([]))
            .mockImplementation((_, init) =>
                Promise.resolve(
                    pendingAbortableBodyResponse(init, (signal) => {
                        requestSignal = signal;
                    }),
                ),
            );
        const client = new GitHubApiClient({
            fetch: fetchMock,
            requestTimeoutMs: 10,
            token: "ghp_test",
        });

        await expect(
            client.setPullRequestDraftState({
                draft: true,
                number: 7,
                repository,
            }),
        ).rejects.toMatchObject({
            code: "timeout",
            message: "GitHub request timed out.",
        });
        expect(requestSignal?.aborted).toBe(true);
    });
});

function pendingAbortableResponse(
    init: RequestInit | undefined,
    onSignal: (signal: AbortSignal | undefined) => void,
): Promise<Response> {
    const signal = init?.signal ?? undefined;
    onSignal(signal);
    return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
        });
    });
}

function pendingAbortableBodyResponse(
    init: RequestInit | undefined,
    onSignal: (signal: AbortSignal | undefined) => void,
): Response {
    const signal = init?.signal ?? undefined;
    onSignal(signal);
    const body = new ReadableStream({
        start(controller) {
            signal?.addEventListener("abort", () => {
                controller.error(
                    new DOMException("The operation was aborted.", "AbortError"),
                );
            });
        },
    });
    return new Response(body, {
        headers: { "content-type": "application/json" },
        status: 200,
    });
}

function jsonResponse(body: unknown, headers?: HeadersInit): Response {
    return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json", ...headers },
        status: 200,
    });
}

function rawPullRequest() {
    return {
        base: rawPullRequestRef("main"),
        body: "",
        closed_at: null,
        comments: 0,
        created_at: "2026-05-07T00:00:00Z",
        draft: false,
        head: rawPullRequestRef("feature/demo"),
        html_url: "https://github.com/octocat/hello-world/pull/7",
        id: 7,
        labels: [],
        mergeable: true,
        merged_at: null,
        node_id: "PR_7",
        number: 7,
        state: "open",
        title: "Pull request",
        updated_at: "2026-05-07T00:00:00Z",
        user: rawUser(),
    };
}

function rawPullRequestRef(ref: string) {
    return {
        label: `octocat:${ref}`,
        ref,
        repo: {
            full_name: "octocat/hello-world",
            name: "hello-world",
            owner: rawUser(),
        },
        sha: "abc1234",
    };
}

function rawUser() {
    return {
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/octocat",
        id: 1,
        login: "octocat",
    };
}
