import { useEffect, useState } from "react";

import { getGitAuthorInitials } from "@renderer/app/git/history-presentation";

async function sha256Hex(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const buffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

const gravatarHashCache = new Map<string, string>();

function buildGravatarUrl(hash: string, size: number): string {
    return `https://www.gravatar.com/avatar/${hash}?d=404&s=${size}`;
}

function useGravatarUrl(email: string, size: number): string | null {
    const normalized = email.trim().toLowerCase();
    const cachedHash = gravatarHashCache.get(normalized);

    const [asyncResult, setAsyncResult] = useState<{
        normalized: string;
        hash: string;
    } | null>(null);

    useEffect(() => {
        if (gravatarHashCache.has(normalized)) return;

        let cancelled = false;
        void sha256Hex(normalized).then((hash) => {
            if (cancelled) return;
            gravatarHashCache.set(normalized, hash);
            setAsyncResult({ normalized, hash });
        });

        return () => {
            cancelled = true;
        };
    }, [normalized]);

    const hash =
        cachedHash ??
        (asyncResult?.normalized === normalized ? asyncResult.hash : null);
    return hash ? buildGravatarUrl(hash, size) : null;
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
    const [imgFailed, setImgFailed] = useState(false);
    const gravatarUrl = useGravatarUrl(email, size * 2);
    const initials = getGitAuthorInitials(name);
    const px = `${size}px`;
    const fontSize = Math.max(10, Math.round(size * 0.35));

    if (gravatarUrl && !imgFailed) {
        return (
            <img
                alt={initials}
                className="shrink-0 rounded-full border border-border"
                height={size}
                onError={() => setImgFailed(true)}
                src={gravatarUrl}
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
