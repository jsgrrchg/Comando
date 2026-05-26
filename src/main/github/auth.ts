import { spawn } from "node:child_process";

import type { SecretStoreGateway } from "@main/ai/secret-store";

export const DEFAULT_GITHUB_HOST = "github.com";
export const GITHUB_SECRET_NAMESPACE = "github";

const DEFAULT_GITHUB_TOKEN_SECRET_ID = "token";
const GH_CLI_TOKEN_TIMEOUT_MS = 5000;

export class GitHubAuthStore {
    readonly #secretStore: SecretStoreGateway;

    constructor(secretStore: SecretStoreGateway) {
        this.#secretStore = secretStore;
    }

    async clearToken(hostInput?: string | null): Promise<void> {
        await this.#secretStore.saveSecret(
            GITHUB_SECRET_NAMESPACE,
            buildGitHubTokenSecretId(normalizeGitHubHost(hostInput)),
            null,
        );
    }

    loadToken(hostInput?: string | null): string | null {
        return this.#secretStore.loadSecret(
            GITHUB_SECRET_NAMESPACE,
            buildGitHubTokenSecretId(normalizeGitHubHost(hostInput)),
        );
    }

    async saveToken(
        hostInput: string | null | undefined,
        token: string,
    ): Promise<void> {
        await this.#secretStore.saveSecret(
            GITHUB_SECRET_NAMESPACE,
            buildGitHubTokenSecretId(normalizeGitHubHost(hostInput)),
            token,
        );
    }
}

export async function loadGhCliToken(
    hostInput?: string | null,
): Promise<string | null> {
    const host = normalizeGitHubHost(hostInput);
    const args = ["auth", "token"];
    if (host !== DEFAULT_GITHUB_HOST) {
        args.push("--hostname", host);
    }

    return await new Promise((resolve) => {
        let stdout = "";
        let settled = false;
        let child: ReturnType<typeof spawn>;

        const finish = (token: string | null) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolve(token);
        };

        const timeout = setTimeout(() => {
            child?.kill();
            finish(null);
        }, GH_CLI_TOKEN_TIMEOUT_MS);

        try {
            child = spawn("gh", args, {
                stdio: ["ignore", "pipe", "ignore"],
            });
        } catch {
            finish(null);
            return;
        }

        if (!child.stdout) {
            finish(null);
            return;
        }

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.on("error", () => {
            finish(null);
        });
        child.on("close", (code) => {
            finish(code === 0 ? stdout.trim() || null : null);
        });
    });
}

export function buildGitHubApiBaseUrl(hostInput?: string | null): string {
    const host = normalizeGitHubHost(hostInput);
    if (host === DEFAULT_GITHUB_HOST) {
        return "https://api.github.com";
    }

    return `https://${host}/api/v3`;
}

export function buildGitHubGraphQlUrl(hostInput?: string | null): string {
    const host = normalizeGitHubHost(hostInput);
    if (host === DEFAULT_GITHUB_HOST) {
        return "https://api.github.com/graphql";
    }

    return `https://${host}/api/graphql`;
}

export function normalizeGitHubHost(hostInput?: string | null): string {
    const trimmed = (hostInput ?? DEFAULT_GITHUB_HOST).trim();
    if (!trimmed) {
        return DEFAULT_GITHUB_HOST;
    }

    try {
        const parsed = trimmed.includes("://")
            ? new URL(trimmed)
            : new URL(`https://${trimmed}`);
        return parsed.hostname.toLowerCase();
    } catch {
        return trimmed
            .replace(/^https?:\/\//iu, "")
            .replace(/\/.*$/u, "")
            .toLowerCase();
    }
}

function buildGitHubTokenSecretId(host: string): string {
    return host === DEFAULT_GITHUB_HOST
        ? DEFAULT_GITHUB_TOKEN_SECRET_ID
        : `${DEFAULT_GITHUB_TOKEN_SECRET_ID}.${host}`;
}
