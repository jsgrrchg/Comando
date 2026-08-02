import type { GitFileDiff, GitOriginalFile } from "@shared/ipc";

export interface GitGutterDiffSource {
    readonly base: GitOriginalFile | null;
    readonly diff: GitFileDiff | null;
    readonly key: string;
}

type GitGutterControllerInput = {
    readonly key: string;
    readonly load: () => Promise<Omit<GitGutterDiffSource, "key">>;
    readonly revision: string | null;
    readonly shouldLoad: boolean;
};

type GitGutterControllerOptions = {
    readonly onSourceChange: (source: GitGutterDiffSource | null) => void;
};

// Keeps Monaco's decorations stable while Git refreshes the backing diff.
// Responses are accepted only for the latest file/worktree/repository revision.
export class GitGutterController {
    private disposed = false;
    private generation = 0;
    private key: string | null = null;
    private requestRevision: string | null = null;

    constructor(private readonly options: GitGutterControllerOptions) {}

    update(input: GitGutterControllerInput): void {
        const hadKey = this.key !== null;
        const keyChanged = this.key !== input.key;
        const requestRevision = input.shouldLoad ? input.revision : null;
        if (
            !keyChanged &&
            this.requestRevision === requestRevision
        ) {
            return;
        }

        this.key = input.key;
        this.requestRevision = requestRevision;
        const generation = ++this.generation;

        if (!input.shouldLoad) {
            this.options.onSourceChange(null);
            return;
        }

        if (keyChanged && hadKey) {
            // A decoration from another file/worktree must never remain visible.
            this.options.onSourceChange(null);
        }

        void input
            .load()
            .then((source) => {
                if (
                    this.disposed ||
                    generation !== this.generation ||
                    this.key !== input.key ||
                    this.requestRevision !== requestRevision ||
                    !hasGitGutterSource(source)
                ) {
                    return;
                }

                this.options.onSourceChange({ ...source, key: input.key });
            })
            .catch(() => {
                // Keep the last valid decorations when Git reads during a write.
            });
    }

    dispose(): void {
        this.disposed = true;
        this.generation += 1;
    }
}

function hasGitGutterSource(
    source: Omit<GitGutterDiffSource, "key">,
): boolean {
    return source.base !== null || source.diff !== null;
}
