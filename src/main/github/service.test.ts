import { describe, expect, it, vi } from "vitest";

import type { GitHubFetch } from "@main/github/client";
import { GitHubService } from "@main/github/service";
import type { SecretStoreGateway } from "@main/ai/secret-store";
import type { GitHubRepositoryRef } from "@shared/ipc";

const repository: GitHubRepositoryRef = {
    host: "github.com",
    owner: "octocat",
    repo: "hello-world",
};

describe("GitHubService", () => {
    it("lists issues with a saved token and filters pull requests", async () => {
        const fetchMock = vi.fn<GitHubFetch>().mockResolvedValue(
            jsonResponse(
                [
                    rawIssue({ number: 1, title: "Real issue" }),
                    {
                        ...rawIssue({ number: 2, title: "PR issue shell" }),
                        pull_request: {},
                    },
                ],
                {
                    headers: {
                        link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next"',
                    },
                },
            ),
        );
        const service = createService(fetchMock);

        const result = await service.listIssues({
            repository,
            state: "open",
        });

        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]?.number).toBe(1);
        expect(result.nextCursor).toBe("2");
        const firstFetchCall = fetchMock.mock.calls[0];
        if (!firstFetchCall) {
            throw new Error("Expected GitHub fetch to be called.");
        }
        const [url, init] = firstFetchCall;
        if (!(url instanceof URL)) {
            throw new Error("Expected GitHub fetch URL object.");
        }
        if (
            !init?.headers ||
            init.headers instanceof Headers ||
            Array.isArray(init.headers)
        ) {
            throw new Error("Expected GitHub fetch headers record.");
        }
        expect(url.href).toBe(
            "https://api.github.com/repos/octocat/hello-world/issues?per_page=30&state=open",
        );
        expect(init.headers.Authorization).toBe("Bearer ghp_test");
    });

    it("reports authenticated token capabilities from classic token scopes", async () => {
        const fetchMock = vi.fn<GitHubFetch>().mockResolvedValue(
            jsonResponse(rawUser(), {
                headers: {
                    "x-oauth-scopes": "repo, workflow",
                },
            }),
        );
        const service = createService(fetchMock);

        const status = await service.getAuthStatus({ host: "github.com" });

        expect(status.state).toBe("authenticated");
        expect(status.canWriteIssues).toBe(true);
        expect(status.canWritePullRequests).toBe(true);
        expect(status.canReadActions).toBe(true);
        expect(status.canWriteActions).toBe(true);
        expect(status.readOnly).toBe(false);
    });

    it("does not disable writes for fine-grained tokens with empty scope headers", async () => {
        const fetchMock = vi.fn<GitHubFetch>().mockResolvedValue(
            jsonResponse(rawUser(), {
                headers: {
                    "x-oauth-scopes": "",
                },
            }),
        );
        const service = createService(fetchMock);

        const status = await service.getAuthStatus({ host: "github.com" });

        expect(status.state).toBe("authenticated");
        expect(status.canWriteIssues).toBe(true);
        expect(status.canWritePullRequests).toBe(true);
        expect(status.canReadActions).toBe(true);
        expect(status.canWriteActions).toBe(true);
        expect(status.readOnly).toBe(false);
    });

    it("waits for the token to be persisted before reporting it saved", async () => {
        let persisted = false;
        const fetchMock = vi.fn<GitHubFetch>().mockResolvedValue(
            jsonResponse(rawUser(), {
                headers: {
                    "x-oauth-scopes": "",
                },
            }),
        );
        const service = new GitHubService({
            fetch: fetchMock,
            secretStore: {
                loadSecret: () => (persisted ? "github_pat_saved" : null),
                saveSecret: async () => {
                    await Promise.resolve();
                    persisted = true;
                },
            },
        });

        const status = await service.saveToken({
            host: "github.com",
            token: "github_pat_saved",
        });

        expect(status.state).toBe("authenticated");
        expect(persisted).toBe(true);
        const [, init] = fetchMock.mock.calls[0] ?? [];
        if (
            !init?.headers ||
            init.headers instanceof Headers ||
            Array.isArray(init.headers)
        ) {
            throw new Error("Expected GitHub fetch headers record.");
        }
        expect(init.headers.Authorization).toBe("Bearer github_pat_saved");
    });

    it("returns missing auth status without exposing a token", async () => {
        const service = createService(vi.fn<GitHubFetch>(), {
            token: null,
        });

        await expect(
            service.listIssues({
                repository,
            }),
        ).rejects.toMatchObject({
            code: "missing_auth",
        });

        await expect(service.getAuthStatus({})).resolves.toMatchObject({
            errorCode: "missing_auth",
            state: "missing",
        });
    });

    it("maps forbidden responses distinctly from rate limits", async () => {
        const forbiddenService = createService(
            vi.fn<GitHubFetch>().mockResolvedValue(
                jsonResponse({ message: "Resource not accessible by token" }, {
                    status: 403,
                }),
            ),
        );
        const rateLimitedService = createService(
            vi.fn<GitHubFetch>().mockResolvedValue(
                jsonResponse({ message: "API rate limit exceeded" }, {
                    headers: {
                        "x-ratelimit-remaining": "0",
                    },
                    status: 403,
                }),
            ),
        );

        await expect(
            forbiddenService.listIssues({ repository }),
        ).rejects.toMatchObject({
            code: "forbidden",
        });
        await expect(
            rateLimitedService.listIssues({ repository }),
        ).rejects.toMatchObject({
            code: "rate_limited",
        });
    });

    it("surfaces write-denied errors when creating issues", async () => {
        const service = createService(
            vi.fn<GitHubFetch>().mockResolvedValue(
                jsonResponse({ message: "Resource not accessible by token" }, {
                    status: 403,
                }),
            ),
        );

        await expect(
            service.createIssue({
                repository,
                title: "Write attempt",
            }),
        ).rejects.toMatchObject({
            code: "forbidden",
        });
    });

    it("lists pull request checks from commit statuses and check runs", async () => {
        const fetchMock = vi
            .fn<GitHubFetch>()
            .mockResolvedValueOnce(
                jsonResponse({
                    state: "failure",
                    statuses: [
                        {
                            context: "lint",
                            created_at: "2026-05-07T00:00:00Z",
                            id: 3,
                            state: "success",
                            target_url:
                                "https://github.com/octocat/hello-world/status/lint",
                            updated_at: "2026-05-07T00:05:00Z",
                        },
                    ],
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    check_runs: [
                        {
                            completed_at: "2026-05-07T00:10:00Z",
                            conclusion: "failure",
                            details_url:
                                "https://github.com/octocat/hello-world/actions/runs/1",
                            id: 1,
                            name: "CI",
                            started_at: "2026-05-07T00:00:00Z",
                            status: "completed",
                        },
                    ],
                    total_count: 1,
                }),
            );
        const service = createService(fetchMock);

        const result = await service.listPullRequestChecks({
            headSha: "abc1234",
            pullRequestNumber: 5,
            repository,
        });

        expect(result.state).toBe("failure");
        expect(result.checks).toHaveLength(2);
        expect(result.url).toBe(
            "https://github.com/octocat/hello-world/pull/5/checks",
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                href: "https://api.github.com/repos/octocat/hello-world/commits/abc1234/status",
            }),
            expect.objectContaining({
                method: "GET",
            }),
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                href: "https://api.github.com/repos/octocat/hello-world/commits/abc1234/check-runs?per_page=50",
            }),
            expect.objectContaining({
                method: "GET",
            }),
        );
    });

    it("deduplicates repeated issue creation while a client request is pending", async () => {
        const resolveFetchCalls: Array<(response: Response) => void> = [];
        const fetchMock = vi.fn<GitHubFetch>().mockReturnValue(
            new Promise<Response>((resolve) => {
                resolveFetchCalls.push(resolve);
            }),
        );
        const service = createService(fetchMock);
        const input = {
            clientRequestId: "same-click",
            repository,
            title: "Deduped issue",
        };

        const first = service.createIssue(input);
        const second = service.createIssue(input);
        const resolveFetch = resolveFetchCalls[0];
        if (!resolveFetch) {
            throw new Error("Fetch resolver was not captured.");
        }
        resolveFetch(jsonResponse(rawIssue({ number: 7 })));

        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(firstResult.number).toBe(7);
        expect(secondResult.number).toBe(7);
    });

    it("updates issue titles and descriptions", async () => {
        const fetchMock = vi
            .fn<GitHubFetch>()
            .mockResolvedValueOnce(jsonResponse(rawIssue({ number: 5 })))
            .mockResolvedValueOnce(
                jsonResponse(
                    rawIssue({
                        body: "Updated body",
                        number: 5,
                        title: "Updated title",
                    }),
                ),
            )
            .mockResolvedValueOnce(jsonResponse([]));
        const service = createService(fetchMock);

        const result = await service.updateIssue({
            body: "Updated body",
            clientRequestId: "update-issue",
            labels: [],
            number: 5,
            repository,
            title: "Updated title",
        });

        expect(result.body).toBe("Updated body");
        expect(result.title).toBe("Updated title");
        const requestInit = fetchMock.mock.calls[0]?.[1];
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                href: "https://api.github.com/repos/octocat/hello-world/issues/5",
            }),
            expect.objectContaining({
                method: "PATCH",
            }),
        );
        const body = requestInit?.body;
        if (typeof body !== "string") {
            throw new Error("Expected request body to be JSON.");
        }
        expect(JSON.parse(body)).toEqual({
            body: "Updated body",
            labels: [],
            title: "Updated title",
        });
    });

    it("creates pull requests and comments on PR conversations", async () => {
        const fetchMock = vi
            .fn<GitHubFetch>()
            .mockResolvedValueOnce(jsonResponse(rawPullRequest({ number: 5 })))
            .mockResolvedValueOnce(
                jsonResponse(rawComment({ body: "Looks good" })),
            );
        const service = createService(fetchMock);

        const pullRequest = await service.createPullRequest({
            base: "main",
            head: "feature/demo",
            repository,
            title: "Demo PR",
        });
        const comment = await service.commentPullRequest({
            body: "Looks good",
            number: 5,
            repository,
        });

        expect(pullRequest.number).toBe(5);
        expect(comment.body).toBe("Looks good");
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                href: "https://api.github.com/repos/octocat/hello-world/issues/5/comments",
            }),
            expect.objectContaining({
                method: "POST",
            }),
        );
    });

    it("updates issue and pull request comments", async () => {
        const fetchMock = vi
            .fn<GitHubFetch>()
            .mockResolvedValueOnce(
                jsonResponse(rawComment({ body: "Edited comment" })),
            );
        const service = createService(fetchMock);

        const result = await service.updateComment({
            body: "Edited comment",
            clientRequestId: "update-comment",
            commentId: 10,
            repository,
        });

        expect(result.body).toBe("Edited comment");
        const requestInit = fetchMock.mock.calls[0]?.[1];
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                href: "https://api.github.com/repos/octocat/hello-world/issues/comments/10",
            }),
            expect.objectContaining({
                method: "PATCH",
            }),
        );
        const body = requestInit?.body;
        if (typeof body !== "string") {
            throw new Error("Expected request body to be JSON.");
        }
        expect(JSON.parse(body)).toEqual({
            body: "Edited comment",
        });
    });

    it("updates pull request titles and descriptions", async () => {
        const fetchMock = vi
            .fn<GitHubFetch>()
            .mockResolvedValueOnce(jsonResponse(rawPullRequest({ number: 5 })))
            .mockResolvedValueOnce(
                jsonResponse(
                    rawPullRequest({
                        body: "Updated body",
                        number: 5,
                        title: "Updated title",
                    }),
                ),
            )
            .mockResolvedValueOnce(jsonResponse([]))
            .mockResolvedValueOnce(jsonResponse([]));
        const service = createService(fetchMock);

        const result = await service.updatePullRequest({
            body: "Updated body",
            clientRequestId: "update-pr",
            number: 5,
            repository,
            title: "Updated title",
        });

        expect(result.body).toBe("Updated body");
        expect(result.title).toBe("Updated title");
        const requestInit = fetchMock.mock.calls[0]?.[1];
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                href: "https://api.github.com/repos/octocat/hello-world/pulls/5",
            }),
            expect.objectContaining({
                method: "PATCH",
            }),
        );
        const body = requestInit?.body;
        if (typeof body !== "string") {
            throw new Error("Expected request body to be JSON.");
        }
        expect(JSON.parse(body)).toEqual({
            body: "Updated body",
            title: "Updated title",
        });
    });

    it("requests pull request reviewers with explicit reviewer lists", async () => {
        const fetchMock = vi
            .fn<GitHubFetch>()
            .mockResolvedValueOnce(jsonResponse(rawPullRequest({ number: 5 })))
            .mockResolvedValueOnce(jsonResponse(rawPullRequest({ number: 5 })))
            .mockResolvedValueOnce(jsonResponse([]))
            .mockResolvedValueOnce(jsonResponse([]));
        const service = createService(fetchMock);

        const result = await service.requestPullRequestReviewers({
            clientRequestId: "review-request",
            number: 5,
            repository,
            reviewers: ["monalisa"],
            teamReviewers: ["frontend"],
        });

        expect(result.number).toBe(5);
        const requestInit = fetchMock.mock.calls[0]?.[1];
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                href: "https://api.github.com/repos/octocat/hello-world/pulls/5/requested_reviewers",
            }),
            expect.objectContaining({
                method: "POST",
            }),
        );
        const body = requestInit?.body;
        if (typeof body !== "string") {
            throw new Error("Expected request body to be JSON.");
        }
        expect(JSON.parse(body)).toEqual({
            reviewers: ["monalisa"],
            team_reviewers: ["frontend"],
        });
    });

    it("loads workflow runs, jobs, logs, artifacts, and annotations", async () => {
        const fetchMock = vi
            .fn<GitHubFetch>()
            .mockResolvedValueOnce(
                jsonResponse({
                    total_count: 1,
                    workflow_runs: [rawWorkflowRun()],
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    jobs: [rawWorkflowJob()],
                    total_count: 1,
                }),
            )
            .mockResolvedValueOnce(new Response("job logs"))
            .mockResolvedValueOnce(
                jsonResponse({
                    artifacts: [rawArtifact()],
                    total_count: 1,
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse([
                    {
                        annotation_level: "failure",
                        message: "Lint failed",
                        path: "src/app.ts",
                        start_line: 12,
                    },
                ]),
            );
        const service = createService(fetchMock);

        const runs = await service.listWorkflowRuns({
            headSha: "abc1234",
            repository,
        });
        const jobs = await service.listWorkflowRunJobs({
            repository,
            runId: 101,
        });
        const logs = await service.getWorkflowJobLogs({
            jobId: 202,
            repository,
        });
        const artifacts = await service.listWorkflowRunArtifacts({
            repository,
            runId: 101,
        });
        const annotations = await service.listCheckRunAnnotations({
            checkRunId: 303,
            repository,
        });

        expect(runs.runs[0]?.id).toBe(101);
        expect(jobs.jobs[0]?.checkRunId).toBe(303);
        expect(logs.logs).toBe("job logs");
        expect(artifacts.artifacts[0]?.name).toBe("test-results");
        expect(annotations.annotations[0]?.path).toBe("src/app.ts");
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                href: "https://api.github.com/repos/octocat/hello-world/actions/runs?head_sha=abc1234&per_page=30",
            }),
            expect.objectContaining({ method: "GET" }),
        );
    });

    it("blocks Actions write mutations when token lacks Actions write scope", async () => {
        const fetchMock = vi.fn<GitHubFetch>().mockResolvedValue(
            jsonResponse(rawUser(), {
                headers: {
                    "x-oauth-scopes": "actions:read",
                },
            }),
        );
        const service = createService(fetchMock);

        await expect(
            service.rerunWorkflowRunFailedJobs({
                clientRequestId: "rerun",
                repository,
                runId: 101,
            }),
        ).rejects.toMatchObject({
            code: "forbidden",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("loads notifications, releases, release notes, and milestones", async () => {
        const fetchMock = vi
            .fn<GitHubFetch>()
            .mockResolvedValueOnce(jsonResponse([rawNotification()]))
            .mockResolvedValueOnce(jsonResponse([rawRelease({ draft: true })]))
            .mockResolvedValueOnce(
                jsonResponse({ body: "Generated notes", name: "v1.0.0" }),
            )
            .mockResolvedValueOnce(jsonResponse(rawRelease({ draft: true })))
            .mockResolvedValueOnce(jsonResponse(rawRelease({ draft: false })))
            .mockResolvedValueOnce(jsonResponse([rawLabel()]))
            .mockResolvedValueOnce(jsonResponse([rawMilestone()]));
        const service = createService(fetchMock);

        const notifications = await service.listNotifications({
            host: "github.com",
        });
        const releases = await service.listReleases({ repository });
        const notes = await service.generateReleaseNotes({
            repository,
            tagName: "v1.0.0",
        });
        const draft = await service.createRelease({
            clientRequestId: "release-create",
            draft: true,
            repository,
            tagName: "v1.0.0",
        });
        const published = await service.publishRelease({
            clientRequestId: "release-publish",
            releaseId: 99,
            repository,
        });
        const labels = await service.listLabels({ repository });
        const milestones = await service.listMilestones({
            repository,
            state: "all",
        });

        expect(notifications.notifications[0]?.subject.title).toBe(
            "Review requested",
        );
        expect(releases.releases[0]?.draft).toBe(true);
        expect(notes.body).toBe("Generated notes");
        expect(draft.draft).toBe(true);
        expect(published.draft).toBe(false);
        expect(labels.labels[0]?.name).toBe("bug");
        expect(milestones.milestones[0]?.title).toBe("MVP");
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                href: "https://api.github.com/repos/octocat/hello-world/releases/generate-notes",
            }),
            expect.objectContaining({ method: "POST" }),
        );
    });
});

function createService(
    fetchMock: GitHubFetch,
    options: { readonly token?: string | null } = {},
): GitHubService {
    return new GitHubService({
        fetch: fetchMock,
        secretStore: createSecretStore(
            Object.hasOwn(options, "token") ? options.token ?? null : "ghp_test",
        ),
    });
}

function createSecretStore(token: string | null): SecretStoreGateway {
    const values = new Map<string, string | null>([["secret.github.token", token]]);

    return {
        loadSecret(namespace: string, secretId: string) {
            return values.get(`secret.${namespace}.${secretId}`) ?? null;
        },
        saveSecret(namespace: string, secretId: string, value: string | null) {
            values.set(`secret.${namespace}.${secretId}`, value);
        },
    };
}

function jsonResponse(
    body: unknown,
    options: {
        readonly headers?: HeadersInit;
        readonly status?: number;
    } = {},
): Response {
    return new Response(JSON.stringify(body), {
        headers: {
            "content-type": "application/json",
            ...headersToRecord(options.headers),
        },
        status: options.status ?? 200,
    });
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers) {
        return {};
    }
    if (headers instanceof Headers) {
        return Object.fromEntries(headers.entries());
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
    }

    return headers;
}

function rawUser() {
    return {
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/octocat",
        id: 1,
        login: "octocat",
    };
}

function rawIssue(
    overrides: Partial<{
        readonly body: string;
        readonly labels: readonly ReturnType<typeof rawLabel>[];
        readonly number: number;
        readonly title: string;
    }> = {},
) {
    return {
        body: overrides.body ?? "",
        closed_at: null,
        comments: 0,
        created_at: "2026-05-07T00:00:00Z",
        html_url: `https://github.com/octocat/hello-world/issues/${
            overrides.number ?? 1
        }`,
        id: overrides.number ?? 1,
        labels: overrides.labels ?? [],
        locked: false,
        node_id: `ISSUE_${overrides.number ?? 1}`,
        number: overrides.number ?? 1,
        state: "open",
        state_reason: null,
        title: overrides.title ?? "Issue",
        updated_at: "2026-05-07T00:00:00Z",
        user: rawUser(),
    };
}

function rawLabel() {
    return {
        color: "d73a4a",
        description: "Something is not working",
        id: 208045946,
        name: "bug",
    };
}

function rawPullRequest(
    overrides: Partial<{
        readonly body: string;
        readonly number: number;
        readonly title: string;
    }> = {},
) {
    return {
        base: rawPullRequestRef("main"),
        body: overrides.body ?? "",
        closed_at: null,
        comments: 0,
        created_at: "2026-05-07T00:00:00Z",
        draft: false,
        head: rawPullRequestRef("feature/demo"),
        html_url: `https://github.com/octocat/hello-world/pull/${
            overrides.number ?? 1
        }`,
        id: overrides.number ?? 1,
        labels: [],
        mergeable: true,
        merged_at: null,
        node_id: `PR_${overrides.number ?? 1}`,
        number: overrides.number ?? 1,
        state: "open",
        title: overrides.title ?? "Pull request",
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

function rawComment(overrides: { readonly body: string }) {
    return {
        body: overrides.body,
        created_at: "2026-05-07T00:00:00Z",
        html_url: "https://github.com/octocat/hello-world/issues/5#comment",
        id: 10,
        updated_at: "2026-05-07T00:00:00Z",
        user: rawUser(),
    };
}

function rawNotification() {
    return {
        id: "notification-1",
        last_read_at: null,
        reason: "review_requested",
        repository: {
            full_name: "octocat/hello-world",
            name: "hello-world",
            owner: rawUser(),
        },
        subject: {
            latest_comment_url:
                "https://api.github.com/repos/octocat/hello-world/issues/comments/1",
            title: "Review requested",
            type: "PullRequest",
            url: "https://api.github.com/repos/octocat/hello-world/pulls/5",
        },
        unread: true,
        updated_at: "2026-05-07T00:00:00Z",
        url: "https://api.github.com/notifications/threads/1",
    };
}

function rawRelease(overrides: { readonly draft: boolean }) {
    return {
        author: rawUser(),
        body: "Release notes",
        created_at: "2026-05-07T00:00:00Z",
        draft: overrides.draft,
        html_url: "https://github.com/octocat/hello-world/releases/tag/v1.0.0",
        id: 99,
        name: "v1.0.0",
        prerelease: false,
        published_at: overrides.draft ? null : "2026-05-07T00:10:00Z",
        tag_name: "v1.0.0",
        target_commitish: "main",
        updated_at: "2026-05-07T00:00:00Z",
    };
}

function rawMilestone() {
    return {
        due_on: "2026-06-01T00:00:00Z",
        id: 1,
        number: 1,
        state: "open",
        title: "MVP",
    };
}

function rawWorkflowRun() {
    return {
        check_suite_id: 404,
        conclusion: "failure",
        created_at: "2026-05-07T00:00:00Z",
        event: "pull_request",
        head_branch: "feature/demo",
        head_sha: "abc1234",
        html_url: "https://github.com/octocat/hello-world/actions/runs/101",
        id: 101,
        name: "CI",
        run_attempt: 1,
        run_number: 7,
        status: "completed",
        updated_at: "2026-05-07T00:10:00Z",
        workflow_id: 1,
    };
}

function rawWorkflowJob() {
    return {
        check_run_url:
            "https://api.github.com/repos/octocat/hello-world/check-runs/303",
        completed_at: "2026-05-07T00:10:00Z",
        conclusion: "failure",
        html_url: "https://github.com/octocat/hello-world/actions/runs/101/job/202",
        id: 202,
        name: "lint",
        runner_name: "GitHub Actions 1",
        started_at: "2026-05-07T00:00:00Z",
        status: "completed",
        steps: [
            {
                completed_at: "2026-05-07T00:05:00Z",
                conclusion: "failure",
                name: "Run lint",
                number: 1,
                started_at: "2026-05-07T00:00:00Z",
                status: "completed",
            },
        ],
    };
}

function rawArtifact() {
    return {
        archive_download_url:
            "https://api.github.com/repos/octocat/hello-world/actions/artifacts/1/zip",
        created_at: "2026-05-07T00:00:00Z",
        expired: false,
        expires_at: "2026-06-07T00:00:00Z",
        id: 1,
        name: "test-results",
        size_in_bytes: 2048,
        updated_at: "2026-05-07T00:00:00Z",
        url: "https://api.github.com/repos/octocat/hello-world/actions/artifacts/1",
    };
}
