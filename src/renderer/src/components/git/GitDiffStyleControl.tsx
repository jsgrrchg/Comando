import type { ReactNode } from "react";

import type { GitDiffStyle } from "./types";

const DIFF_STYLE_OPTIONS: readonly {
    readonly ariaLabel: string;
    readonly icon: ReactNode;
    readonly title: string;
    readonly value: GitDiffStyle;
}[] = [
    {
        ariaLabel: "Unified layout",
        // Single-pane rows: one column of changes.
        icon: (
            <svg
                aria-hidden="true"
                fill="none"
                height="13"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.75"
                viewBox="0 0 24 24"
                width="13"
            >
                <rect height="16" rx="2" width="16" x="4" y="4" />
                <path d="M8 9h8" />
                <path d="M8 12h8" />
                <path d="M8 15h5" />
            </svg>
        ),
        title: "Unified — one column",
        value: "unified",
    },
    {
        ariaLabel: "Side by side layout",
        // Split panes: old left, new right.
        icon: (
            <svg
                aria-hidden="true"
                fill="none"
                height="13"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.75"
                viewBox="0 0 24 24"
                width="13"
            >
                <rect height="16" rx="2" width="16" x="4" y="4" />
                <path d="M12 4v16" />
                <path d="M7 9h2" />
                <path d="M7 12h2" />
                <path d="M15 9h2" />
                <path d="M15 12h2" />
            </svg>
        ),
        title: "Side by side — two columns",
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
            className="flex overflow-hidden rounded-[3px] border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)]"
            role="group"
        >
            {DIFF_STYLE_OPTIONS.map((option) => {
                const selected = option.value === value;

                return (
                    <button
                        aria-label={option.ariaLabel}
                        aria-pressed={selected}
                        className={[
                            "flex h-[22px] w-[22px] items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                            selected
                                ? "bg-bg-tertiary text-text-primary"
                                : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary",
                        ].join(" ")}
                        key={option.value}
                        onClick={() => onChange(option.value)}
                        title={option.title}
                        type="button"
                    >
                        {option.icon}
                    </button>
                );
            })}
        </div>
    );
}
