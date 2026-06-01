import { useEffect, useState } from "react";

import {
    getGitHubAvatarUrl,
    subscribeGitHubAvatars,
} from "@renderer/app/git/github-avatar-cache";
import { getGitAuthorInitials } from "@renderer/app/git/history-presentation";

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
    const initials = getGitAuthorInitials(name);
    const px = `${size}px`;
    const fontSize = Math.max(10, Math.round(size * 0.35));

    const avatarUrl = gitHubUrl && !failedUrls.has(gitHubUrl) ? gitHubUrl : null;

    if (avatarUrl) {
        return (
            <img
                alt={initials}
                className="shrink-0 rounded-full border border-border"
                height={size}
                onError={() =>
                    setFailedUrls((prev) => {
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
