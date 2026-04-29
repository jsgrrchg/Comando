import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protocol } from "electron";

import {
    CODEX_GENERATED_IMAGE_PREVIEW_HOST,
    CODEX_GENERATED_IMAGE_PREVIEW_SCOPE,
    COMANDO_FILE_PREVIEW_SCHEME,
    inferCodexGeneratedImageMimeType,
} from "@shared/file-preview";

export interface ResolvedCodexGeneratedImagePath {
    readonly filePath: string;
    readonly mimeType: string;
    readonly status: 200;
}

export type CodexGeneratedImagePathResolution =
    | ResolvedCodexGeneratedImagePath
    | {
          readonly filePath: null;
          readonly mimeType: null;
          readonly status: 404 | 415;
      };

interface ResolveCodexGeneratedImagePathOptions {
    readonly allowedRoots?: readonly string[];
}

export function registerFilePreviewSchemes(): void {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: COMANDO_FILE_PREVIEW_SCHEME,
            privileges: {
                corsEnabled: true,
                secure: true,
                standard: true,
                supportFetchAPI: true,
            },
        },
    ]);
}

export function installFilePreviewProtocol(): void {
    protocol.handle(
        COMANDO_FILE_PREVIEW_SCHEME,
        registerFilePreviewProtocolHandler(),
    );
}

export function registerFilePreviewProtocolHandler() {
    return async (request: Request): Promise<Response> => {
        try {
            const encodedPath = extractCodexGeneratedImagePathSegment(
                request.url,
            );
            if (!encodedPath) {
                return new Response("Not found", { status: 404 });
            }

            const resolved =
                await resolveCodexGeneratedImagePreviewPath(encodedPath);
            if (resolved.status !== 200) {
                return resolved.status === 415
                    ? new Response("Unsupported media type", { status: 415 })
                    : new Response("Not found", { status: 404 });
            }

            const data = await fs.readFile(resolved.filePath);
            return new Response(new Uint8Array(data), {
                headers: {
                    "cache-control": "no-store",
                    "content-type": resolved.mimeType,
                },
            });
        } catch {
            return new Response("Not found", { status: 404 });
        }
    };
}

export async function resolveCodexGeneratedImagePreviewPath(
    encodedPath: string,
    options: ResolveCodexGeneratedImagePathOptions = {},
): Promise<CodexGeneratedImagePathResolution> {
    const requestedPath = normalizeGeneratedImageInputPath(
        decodeBase64UrlSegment(encodedPath),
    );
    if (!path.isAbsolute(requestedPath)) {
        return notFoundResolution();
    }

    const realFilePath = await fs.realpath(requestedPath).catch(() => null);
    if (!realFilePath) {
        return notFoundResolution();
    }

    const allowedRoots = options.allowedRoots ?? generatedImageRootCandidates();
    const isAllowed = await isInsideAnyAllowedRoot(realFilePath, allowedRoots);
    if (!isAllowed) {
        return notFoundResolution();
    }

    const stats = await fs.stat(realFilePath).catch(() => null);
    if (!stats?.isFile()) {
        return notFoundResolution();
    }

    const mimeType = inferCodexGeneratedImageMimeType(realFilePath);
    if (!mimeType) {
        return {
            filePath: null,
            mimeType: null,
            status: 415,
        };
    }

    return {
        filePath: realFilePath,
        mimeType,
        status: 200,
    };
}

export async function resolveCodexGeneratedImageFilePath(
    candidatePath: string,
): Promise<string | null> {
    const encodedPath = encodeBase64UrlSegment(candidatePath);
    const resolved = await resolveCodexGeneratedImagePreviewPath(encodedPath);
    return resolved.status === 200 ? resolved.filePath : null;
}

function extractCodexGeneratedImagePathSegment(urlString: string): string | null {
    const url = new URL(urlString);
    if (
        url.protocol !== `${COMANDO_FILE_PREVIEW_SCHEME}:` ||
        url.hostname !== CODEX_GENERATED_IMAGE_PREVIEW_HOST
    ) {
        return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (
        segments.length !== 2 ||
        segments[0] !== CODEX_GENERATED_IMAGE_PREVIEW_SCOPE
    ) {
        return null;
    }

    return segments[1] ?? null;
}

function normalizeGeneratedImageInputPath(value: string): string {
    if (value.startsWith("file://")) {
        return fileURLToPath(value);
    }

    return value;
}

function generatedImageRootCandidates(): readonly string[] {
    const roots = [path.join(os.homedir(), ".codex", "generated_images")];
    const codexHome = process.env.CODEX_HOME?.trim();
    if (codexHome) {
        roots.unshift(path.join(codexHome, "generated_images"));
    }

    return [...new Set(roots)];
}

async function isInsideAnyAllowedRoot(
    realFilePath: string,
    allowedRoots: readonly string[],
): Promise<boolean> {
    for (const root of allowedRoots) {
        const realRoot = await fs.realpath(root).catch(() => null);
        if (realRoot && isPathInside(realRoot, realFilePath)) {
            return true;
        }
    }

    return false;
}

function isPathInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
}

function decodeBase64UrlSegment(value: string): string {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    return Buffer.from(`${base64}${padding}`, "base64").toString("utf8");
}

function encodeBase64UrlSegment(value: string): string {
    return Buffer.from(value, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function notFoundResolution(): CodexGeneratedImagePathResolution {
    return {
        filePath: null,
        mimeType: null,
        status: 404,
    };
}
