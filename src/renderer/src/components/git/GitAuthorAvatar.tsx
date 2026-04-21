import { useEffect, useState } from "react";

import {
    getGitHubAvatarUrl,
    subscribeGitHubAvatars,
} from "@renderer/app/git/github-avatar-cache";
import { getGitAuthorInitials } from "@renderer/app/git/history-presentation";

async function sha256Hex(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const buffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

const gravatarHashCache = new Map<string, string>();
const gravatarAvailabilityCache = new Map<string, "available" | "missing">();
const gravatarProbeCache = new Map<
    string,
    Promise<"available" | "missing">
>();

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function buildGravatarUrl(hash: string, size: number): string {
    return `https://www.gravatar.com/avatar/${hash}?d=404&s=${size}`;
}

async function probeGravatar(hash: string, size: number): Promise<boolean> {
    const response = await fetch(buildGravatarUrl(hash, size), {
        method: "HEAD",
    });
    return response.ok;
}

function resolveGravatarAvailability(
    normalized: string,
    hash: string,
    size: number,
): Promise<"available" | "missing"> {
    const cachedAvailability = gravatarAvailabilityCache.get(normalized);
    if (cachedAvailability) return Promise.resolve(cachedAvailability);

    const pendingProbe = gravatarProbeCache.get(normalized);
    if (pendingProbe) return pendingProbe;

    const probe = probeGravatar(hash, size)
        .then((available) => (available ? "available" : "missing"))
        .catch(() => "missing" as const)
        .then((availability) => {
            gravatarAvailabilityCache.set(normalized, availability);
            gravatarProbeCache.delete(normalized);
            return availability;
        });

    gravatarProbeCache.set(normalized, probe);
    return probe;
}

function useGravatarUrl(email: string, size: number): string | null {
    const normalized = normalizeEmail(email);
    const cachedHash = gravatarHashCache.get(normalized);
    const cachedAvailability = gravatarAvailabilityCache.get(normalized);

    const [asyncResult, setAsyncResult] = useState<{
        availability: "available" | "missing";
        normalized: string;
        hash: string;
    } | null>(null);

    useEffect(() => {
        if (!normalized) return;
        if (gravatarAvailabilityCache.has(normalized)) return;

        let cancelled = false;
        void (async () => {
            const hash =
                gravatarHashCache.get(normalized) ?? (await sha256Hex(normalized));

            if (cancelled) return;
            gravatarHashCache.set(normalized, hash);

            const availability = await resolveGravatarAvailability(
                normalized,
                hash,
                size,
            );

            if (cancelled) return;
            setAsyncResult({ availability, normalized, hash });
        })();

        return () => {
            cancelled = true;
        };
    }, [normalized, size]);

    const hash =
        cachedHash ??
        (asyncResult?.normalized === normalized ? asyncResult.hash : null);
    const availability =
        cachedAvailability ??
        (asyncResult?.normalized === normalized
            ? asyncResult.availability
            : null);

    return hash && availability === "available"
        ? buildGravatarUrl(hash, size)
        : null;
}

function markGravatarMissing(email: string): void {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    gravatarAvailabilityCache.set(normalized, "missing");
}

function useGitHubAvatarUrl(email: string): string | null {
    const [url, setUrl] = useState(() => getGitHubAvatarUrl(email));

    useEffect(() => {
        setUrl(getGitHubAvatarUrl(email));
        return subscribeGitHubAvatars(() => {
            setUrl(getGitHubAvatarUrl(email));
        });
    }, [email]);

    return url;
}

export function GitAuthorAvatar({
    email,
    name,
    size = 32,
}: {
    readonly email: string;
    readonly name: string;
    readonly size?: number;
}) {
    const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(
        new Set(),
    );
    const gitHubUrl = useGitHubAvatarUrl(email);
    const gravatarUrl = useGravatarUrl(email, size * 2);
    const initials = getGitAuthorInitials(name);
    const px = `${size}px`;
    const fontSize = Math.max(10, Math.round(size * 0.35));

    const avatarUrl =
        (gitHubUrl && !failedUrls.has(gitHubUrl) ? gitHubUrl : null) ??
        (gravatarUrl && !failedUrls.has(gravatarUrl) ? gravatarUrl : null);

    if (avatarUrl) {
        return (
            <img
                alt={initials}
                className="shrink-0 rounded-full border border-border"
                height={size}
                onError={() =>
                    setFailedUrls((prev) => {
                        if (avatarUrl === gravatarUrl) {
                            markGravatarMissing(email);
                        }
                        return new Set(prev).add(avatarUrl);
                    })
                }
                src={avatarUrl}
                style={{ width: px, height: px }}
                width={size}
            />
        );
    }

    return (
        <div
            className="flex shrink-0 items-center justify-center rounded-full border border-border bg-bg-secondary font-semibold text-text-primary"
            style={{ width: px, height: px, fontSize }}
        >
            {initials}
        </div>
    );
}
