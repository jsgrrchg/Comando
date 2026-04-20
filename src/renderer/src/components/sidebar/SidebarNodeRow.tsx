import { memo, type MouseEvent, type ReactNode } from "react";

export type SidebarBadgeTone =
    | "accent"
    | "danger"
    | "neutral"
    | "success"
    | "warning";

export interface SidebarBadge {
    readonly label: string;
    readonly tone?: SidebarBadgeTone;
}

export interface SidebarNodeRowAction {
    readonly danger?: boolean;
    readonly disabled?: boolean;
    readonly label: string;
    readonly onClick: () => void;
    readonly title?: string;
}

interface SidebarNodeRowProps {
    readonly actions?: readonly SidebarNodeRowAction[];
    readonly badges?: readonly SidebarBadge[];
    readonly className?: string;
    readonly depth?: number;
    readonly description?: ReactNode;
    readonly isActive?: boolean;
    readonly isSelected?: boolean;
    readonly leading?: ReactNode;
    readonly onClick?: () => void;
    readonly onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
    readonly title: string;
}

function SidebarNodeRowComponent({
    actions,
    badges,
    className,
    depth = 0,
    description,
    isActive = false,
    isSelected = false,
    leading,
    onClick,
    onContextMenu,
    title,
}: SidebarNodeRowProps) {
    const rowClasses = [
        "group flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5 transition-colors",
        isActive
            ? "bg-accent/12 text-accent-strong"
            : isSelected
              ? "bg-bg-secondary text-text-primary"
              : "hover:bg-bg-secondary/80",
        className,
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <div
            className={rowClasses}
            onContextMenu={onContextMenu}
            style={{ paddingInlineStart: 8 + depth * 14 }}
        >
            {onClick ? (
                <button
                    className="app-no-drag flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={onClick}
                    type="button"
                >
                    <RowContent
                        badges={badges}
                        description={description}
                        leading={leading}
                        title={title}
                    />
                </button>
            ) : (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <RowContent
                        badges={badges}
                        description={description}
                        leading={leading}
                        title={title}
                    />
                </div>
            )}

            {actions && actions.length > 0 ? (
                <div className="app-no-drag flex items-center gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                    {actions.map((action) => (
                        <button
                            className={[
                                "rounded-md px-1.5 py-0.5 text-[11px] transition",
                                action.disabled
                                    ? "cursor-not-allowed text-text-secondary/50"
                                    : action.danger
                                      ? "text-[var(--diff-remove)] hover:bg-[color-mix(in_srgb,var(--diff-remove)_10%,transparent)]"
                                      : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary",
                            ].join(" ")}
                            disabled={action.disabled}
                            key={action.label}
                            onClick={action.onClick}
                            title={action.title ?? action.label}
                            type="button"
                        >
                            {action.label}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

export const SidebarNodeRow = memo(SidebarNodeRowComponent);

function RowContent({
    badges,
    description,
    leading,
    title,
}: {
    readonly badges?: readonly SidebarBadge[];
    readonly description?: ReactNode;
    readonly leading?: ReactNode;
    readonly title: string;
}) {
    return (
        <>
            {leading ? (
                <div className="shrink-0 text-text-secondary">{leading}</div>
            ) : null}

            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-text-primary">
                        {title}
                    </span>
                    {badges && badges.length > 0 ? (
                        <div className="flex min-w-0 items-center gap-1">
                            {badges.map((badge, index) => (
                                <BadgePill
                                    badge={badge}
                                    key={`${badge.label}-${index}`}
                                />
                            ))}
                        </div>
                    ) : null}
                </div>

                {description ? (
                    <div className="truncate text-[11px] text-text-secondary">
                        {description}
                    </div>
                ) : null}
            </div>
        </>
    );
}

function BadgePill({ badge }: { readonly badge: SidebarBadge }) {
    const toneClasses = {
        accent: "border-accent/25 bg-accent/10 text-accent-strong",
        danger: "border-[color-mix(in_srgb,var(--diff-remove)_25%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-remove)_10%,transparent)] text-[var(--diff-remove)]",
        neutral: "border-border bg-bg-elevated text-text-secondary",
        success:
            "border-[color-mix(in_srgb,var(--diff-add)_25%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-add)_10%,transparent)] text-[var(--diff-add)]",
        warning:
            "border-[color-mix(in_srgb,var(--diff-warn)_25%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-warn)_10%,transparent)] text-[var(--diff-warn)]",
    } as const;

    return (
        <span
            className={[
                "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                toneClasses[badge.tone ?? "neutral"],
            ].join(" ")}
        >
            {badge.label}
        </span>
    );
}
