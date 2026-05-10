interface DesktopTopBarProps {
    readonly title: string;
}

export function DesktopTopBar({ title }: DesktopTopBarProps) {
    return (
        <div
            aria-hidden
            className="app-drag desktop-titlebar relative flex shrink-0 items-center justify-center select-none"
            style={{
                height: "var(--desktop-titlebar-height, 40px)",
                paddingLeft: 12,
                paddingRight: "var(--titlebar-controls-width, 138px)",
            }}
        >
            <span
                className="text-[12px] font-medium tracking-[0.01em] text-text-secondary"
                style={{
                    fontFamily: "var(--font-sans)",
                }}
            >
                {title}
            </span>
        </div>
    );
}
