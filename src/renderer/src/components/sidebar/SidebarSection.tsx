import { Children, type PropsWithChildren, type ReactNode } from "react";

interface SidebarSectionProps extends PropsWithChildren {
    readonly action?: ReactNode;
    readonly className?: string;
    readonly count?: number;
    readonly emptyState?: ReactNode;
    readonly isExpanded?: boolean;
    readonly onToggleExpanded?: () => void;
    readonly title: string;
}

export function SidebarSection({
    action,
    children,
    className,
    count,
    emptyState,
    isExpanded = true,
    onToggleExpanded,
    title,
}: SidebarSectionProps) {
    return (
        <section className={["space-y-1.5", className].filter(Boolean).join(" ")}>
            <div className="flex items-center justify-between gap-2 px-2">
                <div className="flex min-w-0 items-center gap-1.5">
                    {onToggleExpanded ? (
                        <button
                            aria-expanded={isExpanded}
                            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${title}`}
                            className="app-no-drag sidebar-tool-button h-5 w-5 shrink-0"
                            onClick={onToggleExpanded}
                            type="button"
                        >
                            <ChevronIcon isExpanded={isExpanded} />
                        </button>
                    ) : null}

                    <p className="truncate text-[11px] font-medium uppercase tracking-[0.16em] text-text-secondary">
                        {title}
                    </p>

                    {typeof count === "number" ? (
                        <span className="rounded-full border border-border bg-bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                            {count}
                        </span>
                    ) : null}
                </div>

                {action ? <div className="app-no-drag">{action}</div> : null}
            </div>

            {isExpanded ? (
                <div className="space-y-0.5">
                    {Children.count(children) > 0 ? (
                        children
                    ) : emptyState ? (
                        <div className="px-2 py-1.5 text-xs text-text-secondary">
                            {emptyState}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}

function ChevronIcon({ isExpanded }: { readonly isExpanded: boolean }) {
    return (
        <svg
            aria-hidden="true"
            className={[
                "h-3 w-3 transition-transform duration-150",
                isExpanded ? "rotate-90" : "",
            ].join(" ")}
            fill="none"
            viewBox="0 0 16 16"
        >
            <path
                d="M6 4L10 8L6 12"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.4"
            />
        </svg>
    );
}
