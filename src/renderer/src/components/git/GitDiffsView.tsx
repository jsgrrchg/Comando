import { GitBadge, GitEmptyState } from "./GitUi";
import type { GitDiffFile, GitDiffLine, GitDiffsViewProps } from "./types";

export function GitDiffsView({
    activeFileId = null,
    className,
    emptyState,
    files,
    onSelectFile,
}: GitDiffsViewProps) {
    if (files.length === 0) {
        return (
            <GitEmptyState className={className}>
                {emptyState ?? "Pick a change to inspect its diff."}
            </GitEmptyState>
        );
    }

    const activeFile =
        files.find((file) => file.id === activeFileId) ?? files[0] ?? null;

    if (!activeFile) {
        return (
            <GitEmptyState className={className}>
                {emptyState ?? "No diff selected."}
            </GitEmptyState>
        );
    }

    return (
        <div
            className={[
                "shell-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            <div className="mb-3 flex flex-wrap items-center gap-2">
                {files.map((file) => (
                    <button
                        aria-pressed={file.id === activeFile.id}
                        className={[
                            "inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1 text-left text-[11px] transition-colors",
                            file.id === activeFile.id
                                ? "border-[color-mix(in_srgb,var(--color-accent)_34%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-bg-secondary))] text-text-primary"
                                : "border-border bg-bg-secondary text-text-secondary hover:text-text-primary",
                        ].join(" ")}
                        key={file.id}
                        onClick={() => onSelectFile?.(file)}
                        type="button"
                    >
                        <GitBadge tone={diffTone(file.kind)}>
                            {file.statusLabel ?? file.kind}
                        </GitBadge>
                        <span className="truncate font-mono">{file.path}</span>
                    </button>
                ))}
            </div>

            <DiffFileSurface file={activeFile} />
        </div>
    );
}

function DiffFileSurface({ file }: { readonly file: GitDiffFile }) {
    return (
        <section className="overflow-hidden rounded-xl border border-border bg-bg-secondary">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-[12px] font-medium text-text-primary">
                            {file.path}
                        </span>
                        <GitBadge tone={diffTone(file.kind)}>
                            {file.statusLabel ?? file.kind}
                        </GitBadge>
                        {file.reversible ? (
                            <GitBadge tone="neutral">reversible</GitBadge>
                        ) : null}
                    </div>
                    {file.previousPath ? (
                        <p className="mt-1 truncate text-[11px] text-text-secondary">
                            Previous path: {file.previousPath}
                        </p>
                    ) : null}
                </div>

                {file.summary ? (
                    <p className="text-[11px] text-text-secondary">
                        {file.summary}
                    </p>
                ) : null}
            </div>

            {!file.isText ? (
                <div className="p-3">
                    <GitEmptyState>
                        This file is binary, so Comando can show metadata but not
                        a textual diff.
                    </GitEmptyState>
                </div>
            ) : file.hunks.length > 0 ? (
                <div className="space-y-3 p-3">
                    {file.hunks.map((hunk) => (
                        <section
                            className="overflow-hidden rounded-lg border border-border bg-bg-primary"
                            key={hunk.id}
                        >
                            <div className="border-b border-border px-3 py-2 font-mono text-[11px] text-text-secondary">
                                {hunk.header}
                            </div>
                            <div className="overflow-x-auto">
                                <div className="min-w-[640px]">
                                    {hunk.lines.map((line) => (
                                        <DiffLineRow
                                            key={line.id}
                                            line={line}
                                        />
                                    ))}
                                </div>
                            </div>
                        </section>
                    ))}
                </div>
            ) : (
                <div className="p-3">
                    <GitEmptyState>No hunks were produced for this file.</GitEmptyState>
                </div>
            )}
        </section>
    );
}

function DiffLineRow({ line }: { readonly line: GitDiffLine }) {
    return (
        <div
            className={[
                "grid grid-cols-[auto_auto_1fr] gap-2 px-3 py-1 font-mono text-[12px] leading-5",
                diffLineClass(line.kind),
            ].join(" ")}
        >
            <span className="w-10 shrink-0 text-right text-text-secondary">
                {line.oldLineNumber ?? ""}
            </span>
            <span className="w-10 shrink-0 text-right text-text-secondary">
                {line.newLineNumber ?? ""}
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-words">
                {line.kind === "add"
                    ? `+ ${line.text}`
                    : line.kind === "remove"
                      ? `- ${line.text}`
                      : `  ${line.text}`}
            </span>
        </div>
    );
}

function diffTone(kind: GitDiffFile["kind"]) {
    switch (kind) {
        case "create":
            return "success";
        case "delete":
            return "danger";
        case "move":
            return "accent";
        case "update":
        default:
            return "warning";
    }
}

function diffLineClass(kind: GitDiffLine["kind"]) {
    switch (kind) {
        case "add":
            return "bg-emerald-500/8 text-emerald-700 dark:text-emerald-300";
        case "remove":
            return "bg-red-500/8 text-red-700 dark:text-red-300";
        case "context":
        default:
            return "bg-transparent text-text-primary";
    }
}
