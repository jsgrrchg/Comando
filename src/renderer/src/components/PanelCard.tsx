import type { PropsWithChildren, ReactNode } from "react";

interface PanelCardProps extends PropsWithChildren {
    readonly title: string;
    readonly eyebrow?: string;
    readonly aside?: ReactNode;
    readonly className?: string;
}

export function PanelCard({
    aside,
    children,
    className,
    eyebrow,
    title,
}: PanelCardProps) {
    return (
        <section
            className={[
                "rounded-lg border border-border bg-bg-secondary p-5",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            <div className="mb-4 flex items-start justify-between gap-3">
                <div className="space-y-1">
                    {eyebrow ? (
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-secondary">
                            {eyebrow}
                        </p>
                    ) : null}
                    <h2 className="text-lg font-semibold text-text-primary">
                        {title}
                    </h2>
                </div>
                {aside}
            </div>
            {children}
        </section>
    );
}
