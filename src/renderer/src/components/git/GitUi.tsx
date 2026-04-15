import type { PropsWithChildren } from "react";

import type { GitActionTone, GitStatusTone } from "./types";
import type { GitAction } from "./types";

function toneClasses(tone: GitStatusTone): string {
    switch (tone) {
        case "accent":
            return "border-[color-mix(in_srgb,var(--color-accent)_30%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg-secondary))] text-[color-mix(in_srgb,var(--color-accent)_82%,var(--color-text-primary))]";
        case "danger":
            return "border-[color-mix(in_srgb,var(--diff-remove)_25%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-remove)_10%,transparent)] text-[var(--diff-remove)]";
        case "success":
            return "border-[color-mix(in_srgb,var(--diff-add)_25%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-add)_10%,transparent)] text-[var(--diff-add)]";
        case "warning":
            return "border-[color-mix(in_srgb,var(--diff-warn)_25%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-warn)_10%,transparent)] text-[var(--diff-warn)]";
        case "neutral":
        default:
            return "border-border bg-bg-secondary text-text-secondary";
    }
}

function actionToneClasses(tone: GitActionTone): string {
    switch (tone) {
        case "accent":
            return "border-[color-mix(in_srgb,var(--color-accent)_32%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_14%,var(--color-bg-elevated))] text-text-primary";
        case "danger":
            return "border-[color-mix(in_srgb,var(--diff-remove)_30%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-remove)_12%,transparent)] text-[var(--diff-remove)]";
        case "success":
            return "border-[color-mix(in_srgb,var(--diff-add)_30%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-add)_12%,transparent)] text-[var(--diff-add)]";
        case "warning":
            return "border-[color-mix(in_srgb,var(--diff-warn)_30%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-warn)_12%,transparent)] text-[var(--diff-warn)]";
        case "neutral":
        default:
            return "border-border bg-bg-elevated text-text-primary";
    }
}

export function GitBadge({
    children,
    className,
    tone = "neutral",
}: PropsWithChildren<{
    readonly className?: string;
    readonly tone?: GitStatusTone;
}>) {
    return (
        <span
            className={[
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
                toneClasses(tone),
                className,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {children}
        </span>
    );
}

export function GitActionButton({
    action,
    className,
}: {
    readonly action: GitAction;
    readonly className?: string;
}) {
    return (
        <button
            aria-label={action.ariaLabel ?? action.label}
            className={[
                "inline-flex items-center justify-center rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                actionToneClasses(action.tone ?? "neutral"),
                action.disabled || action.busy
                    ? "cursor-default opacity-60"
                    : "hover:border-[color-mix(in_srgb,var(--color-accent)_26%,var(--color-border))] hover:bg-[color-mix(in_srgb,var(--color-accent)_7%,var(--color-bg-elevated))]",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
            disabled={action.disabled || action.busy}
            onClick={action.onClick}
            type="button"
        >
            {action.busy ? <span className="mr-1">⋯</span> : null}
            {action.label}
        </button>
    );
}

export function GitEmptyState({
    children,
    className,
}: PropsWithChildren<{ readonly className?: string }>) {
    return (
        <div
            className={[
                "rounded-xl border border-dashed border-border bg-bg-secondary px-3 py-4 text-sm text-text-secondary",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {children}
        </div>
    );
}
