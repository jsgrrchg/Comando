import type { GitDiffStyle } from "./types";

const DIFF_STYLE_OPTIONS: readonly {
    readonly label: string;
    readonly title: string;
    readonly value: GitDiffStyle;
}[] = [
    {
        label: "Unified",
        title: "Show changes in one column",
        value: "unified",
    },
    {
        label: "Side by side",
        title: "Show old and new code side by side",
        value: "split",
    },
];

export function GitDiffStyleControl({
    onChange,
    value,
}: {
    readonly onChange: (style: GitDiffStyle) => void;
    readonly value: GitDiffStyle;
}) {
    return (
        <div
            aria-label="Diff layout"
            className="flex overflow-hidden rounded border border-border"
            role="group"
        >
            {DIFF_STYLE_OPTIONS.map((option) => {
                const selected = option.value === value;

                return (
                    <button
                        aria-pressed={selected}
                        className={[
                            "h-6 px-2 font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                            selected
                                ? "bg-bg-tertiary text-text-primary"
                                : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary",
                        ].join(" ")}
                        key={option.value}
                        onClick={() => onChange(option.value)}
                        title={option.title}
                        type="button"
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}
