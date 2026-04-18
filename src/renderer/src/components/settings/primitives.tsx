import {
    useState,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

// Static style fragments hoisted out of render so memoized children and
// DevTools-based reference equality checks don't churn on every parent render.
const TOGGLE_TRACK_BASE: CSSProperties = {
    width: 36,
    height: 20,
    borderRadius: 10,
    border: "none",
    position: "relative",
    flexShrink: 0,
    transition:
        "background-color 150ms, filter 100ms ease, box-shadow 100ms ease",
};

const TOGGLE_THUMB_BASE: CSSProperties = {
    position: "absolute",
    top: 2,
    width: 16,
    height: 16,
    borderRadius: "50%",
    backgroundColor: "#fff",
    boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
    transition: "left 150ms",
};

export function Toggle({
    value,
    onChange,
    disabled,
}: {
    value: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
}) {
    const trackStyle = useMemo<CSSProperties>(
        () => ({
            ...TOGGLE_TRACK_BASE,
            cursor: disabled ? "not-allowed" : "pointer",
            backgroundColor: value
                ? "var(--color-accent)"
                : "var(--color-bg-tertiary)",
            opacity: disabled ? 0.4 : 1,
        }),
        [value, disabled],
    );
    const thumbStyle = useMemo<CSSProperties>(
        () => ({ ...TOGGLE_THUMB_BASE, left: value ? 18 : 2 }),
        [value],
    );
    return (
        <button
            role="switch"
            aria-checked={value}
            onClick={() => !disabled && onChange(!value)}
            onMouseEnter={(e) => {
                if (!disabled) {
                    e.currentTarget.style.filter = "brightness(1.15)";
                    e.currentTarget.style.boxShadow =
                        "0 0 0 2px rgba(255,255,255,0.06)";
                }
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.filter = "brightness(1)";
                e.currentTarget.style.boxShadow = "none";
            }}
            style={trackStyle}
        >
            <span style={thumbStyle} />
        </button>
    );
}

export function SegmentedControl<T extends string | number>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
}) {
    return (
        <div
            style={{
                display: "inline-flex",
                backgroundColor: "var(--color-bg-tertiary)",
                borderRadius: 7,
                padding: 2,
                gap: 1,
            }}
        >
            {options.map((opt) => {
                const active = opt.value === value;
                return (
                    <button
                        key={String(opt.value)}
                        onClick={() => onChange(opt.value)}
                        onMouseEnter={(e) => {
                            if (!active) {
                                e.currentTarget.style.backgroundColor =
                                    "var(--color-bg-secondary)";
                                e.currentTarget.style.color =
                                    "var(--color-text-primary)";
                            }
                        }}
                        onMouseLeave={(e) => {
                            if (!active) {
                                e.currentTarget.style.backgroundColor =
                                    "transparent";
                                e.currentTarget.style.color =
                                    "var(--color-text-secondary)";
                            }
                        }}
                        style={{
                            backgroundColor: active
                                ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                                : "transparent",
                            border: "none",
                            borderRadius: 5,
                            color: active
                                ? "var(--color-text-primary)"
                                : "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontFamily: "inherit",
                            fontSize: 12,
                            fontWeight: active ? 500 : 400,
                            padding: "3px 10px",
                            transition: "all 100ms",
                        }}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}

type SelectFieldOption<T extends string | number | null> = {
    value: T;
    label: string;
    group?: string;
    disabled?: boolean;
};

function getViewportSafePosition(
    x: number,
    y: number,
    width: number,
    height: number,
) {
    const pad = 8;
    return {
        x: Math.max(pad, Math.min(x, window.innerWidth - width - pad)),
        y: Math.max(pad, Math.min(y, window.innerHeight - height - pad)),
    };
}

export function SelectField<T extends string | number | null>({
    value,
    options,
    onChange,
    disabled,
}: {
    value: T;
    options: SelectFieldOption<T>[];
    onChange: (v: T) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [menuPosition, setMenuPosition] = useState<{
        x: number;
        y: number;
        minWidth: number;
    } | null>(null);
    const currentLabel =
        options.find((o) => o.value === value)?.label ?? String(value);

    useLayoutEffect(() => {
        if (!open) return;
        const anchor = ref.current;
        const menu = menuRef.current;
        if (!anchor || !menu) return;

        const computePosition = () => {
            const gap = 4;
            const anchorRect = anchor.getBoundingClientRect();
            const menuRect = menu.getBoundingClientRect();
            const shouldOpenAbove =
                anchorRect.bottom + gap + menuRect.height >
                    window.innerHeight - 8 &&
                anchorRect.top - gap - menuRect.height >= 8;
            const rawY = shouldOpenAbove
                ? anchorRect.top - gap - menuRect.height
                : anchorRect.bottom + gap;
            const safe = getViewportSafePosition(
                anchorRect.right - menuRect.width,
                rawY,
                menuRect.width,
                menuRect.height,
            );

            setMenuPosition({
                x: safe.x,
                y: safe.y,
                minWidth: anchorRect.width,
            });
        };

        computePosition();

        // Recompute when the menu itself resizes (font loading, dynamic labels,
        // etc.); `options.length` was a fragile proxy that missed these cases.
        const observer = new ResizeObserver(computePosition);
        observer.observe(menu);
        return () => observer.disconnect();
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const handleDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (ref.current?.contains(target)) return;
            if (menuRef.current?.contains(target)) return;
            setOpen(false);
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        const handleResize = () => setOpen(false);
        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        window.addEventListener("resize", handleResize);
        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
            window.removeEventListener("resize", handleResize);
        };
    }, [open]);

    return (
        <div
            ref={ref}
            style={{ position: "relative", display: "inline-block" }}
        >
            <button
                type="button"
                disabled={disabled}
                onClick={() => setOpen((v) => !v)}
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    backgroundColor: "var(--color-bg-tertiary)",
                    color: "var(--color-text-primary)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    padding: "3px 8px",
                    fontSize: 12,
                    fontFamily: "inherit",
                    cursor: disabled ? "not-allowed" : "pointer",
                    outline: "none",
                    opacity: disabled ? 0.4 : 1,
                    whiteSpace: "nowrap",
                }}
            >
                {currentLabel}
                <svg
                    width="9"
                    height="9"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                        color: "var(--color-text-secondary)",
                        opacity: 0.7,
                        transform: open ? "rotate(180deg)" : "none",
                        transition: "transform 0.12s ease",
                        flexShrink: 0,
                    }}
                >
                    <path d="M2.5 4L5 6.5L7.5 4" />
                </svg>
            </button>

            {open &&
                createPortal(
                    <div
                        ref={menuRef}
                        style={{
                            position: "fixed",
                            left: menuPosition?.x ?? 8,
                            top: menuPosition?.y ?? 8,
                            zIndex: 10010,
                            minWidth: menuPosition?.minWidth ?? 0,
                            padding: 4,
                            borderRadius: 8,
                            backgroundColor: "var(--color-bg-secondary)",
                            border: "1px solid var(--color-border)",
                            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
                            maxHeight: 280,
                            overflowY: "auto",
                        }}
                    >
                        {options.map((opt, index) => {
                            const previousGroup = options[index - 1]?.group;
                            const showGroupLabel =
                                opt.group != null &&
                                opt.group !== previousGroup;

                            return (
                                <div key={String(opt.value)}>
                                    {showGroupLabel ? (
                                        <div
                                            style={{
                                                padding:
                                                    index === 0
                                                        ? "3px 10px 4px"
                                                        : "9px 10px 4px",
                                                fontSize: 10,
                                                fontWeight: 700,
                                                letterSpacing: "0.08em",
                                                textTransform: "uppercase",
                                                color: "var(--color-text-secondary)",
                                            }}
                                        >
                                            {opt.group}
                                        </div>
                                    ) : null}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (opt.disabled) {
                                                return;
                                            }

                                            onChange(opt.value);
                                            setOpen(false);
                                        }}
                                        style={{
                                            display: "block",
                                            width: "100%",
                                            textAlign: "left",
                                            padding: "5px 10px",
                                            fontSize: 12,
                                            fontFamily: "inherit",
                                            borderRadius: 6,
                                            border: "none",
                                            color: opt.disabled
                                                ? "var(--color-text-secondary)"
                                                : opt.value === value
                                                  ? "var(--color-accent)"
                                                  : "var(--color-text-primary)",
                                            backgroundColor: "transparent",
                                            cursor: opt.disabled
                                                ? "not-allowed"
                                                : "pointer",
                                            opacity: opt.disabled ? 0.6 : 1,
                                            transition:
                                                "background-color 100ms ease",
                                            whiteSpace: "nowrap",
                                        }}
                                        onMouseEnter={(e) => {
                                            if (opt.disabled) {
                                                return;
                                            }

                                            e.currentTarget.style.backgroundColor =
                                                "var(--color-bg-tertiary)";
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.backgroundColor =
                                                "transparent";
                                        }}
                                    >
                                        {opt.label}
                                    </button>
                                </div>
                            );
                        })}
                    </div>,
                    document.body,
                )}
        </div>
    );
}

export function NumberStepper({
    value,
    min,
    max,
    inputWidth,
    onChange,
}: {
    value: number;
    min: number;
    max: number;
    inputWidth?: number;
    onChange: (v: number) => void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [local, setLocal] = useState(String(value));
    const [isEditing, setIsEditing] = useState(false);

    const commit = (raw: string) => {
        const n = parseInt(raw, 10);
        if (!isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
        setLocal(String(!isNaN(n) ? Math.max(min, Math.min(max, n)) : value));
    };

    return (
        <div
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                backgroundColor: "var(--color-bg-tertiary)",
                border: "1px solid var(--color-border)",
                borderRadius: 6,
                overflow: "hidden",
            }}
        >
            <button
                onClick={() => onChange(Math.max(min, value - 1))}
                disabled={value <= min}
                onMouseEnter={(e) => {
                    if (value > min) {
                        e.currentTarget.style.backgroundColor =
                            "var(--color-bg-secondary)";
                        e.currentTarget.style.color =
                            "var(--color-text-primary)";
                    }
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.color = "var(--color-text-secondary)";
                }}
                style={{
                    width: 24,
                    height: 26,
                    border: "none",
                    background: "transparent",
                    cursor: value <= min ? "not-allowed" : "pointer",
                    color: "var(--color-text-secondary)",
                    fontSize: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: value <= min ? 0.4 : 1,
                    transition: "background-color 100ms ease, color 100ms ease",
                }}
            >
                −
            </button>
            <input
                ref={inputRef}
                value={isEditing ? local : String(value)}
                onFocus={() => {
                    setLocal(String(value));
                    setIsEditing(true);
                }}
                onChange={(e) => setLocal(e.target.value)}
                onBlur={() => {
                    commit(local);
                    setIsEditing(false);
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        commit(local);
                        setIsEditing(false);
                        inputRef.current?.blur();
                    }
                    if (e.key === "Escape") {
                        setLocal(String(value));
                        setIsEditing(false);
                        inputRef.current?.blur();
                    }
                }}
                style={{
                    width: inputWidth ?? 34,
                    textAlign: "center",
                    border: "none",
                    background: "transparent",
                    color: "var(--color-text-primary)",
                    fontSize: 12,
                    fontFamily: "inherit",
                    outline: "none",
                }}
            />
            <button
                onClick={() => onChange(Math.min(max, value + 1))}
                disabled={value >= max}
                onMouseEnter={(e) => {
                    if (value < max) {
                        e.currentTarget.style.backgroundColor =
                            "var(--color-bg-secondary)";
                        e.currentTarget.style.color =
                            "var(--color-text-primary)";
                    }
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.color = "var(--color-text-secondary)";
                }}
                style={{
                    width: 24,
                    height: 26,
                    border: "none",
                    background: "transparent",
                    cursor: value >= max ? "not-allowed" : "pointer",
                    color: "var(--color-text-secondary)",
                    fontSize: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: value >= max ? 0.4 : 1,
                    transition: "background-color 100ms ease, color 100ms ease",
                }}
            >
                +
            </button>
        </div>
    );
}

export function SliderField({
    value,
    min,
    max,
    step = 1,
    onChange,
    formatValue,
}: {
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (v: number) => void;
    formatValue?: (value: number) => string;
}) {
    const progress = ((value - min) / (max - min)) * 100;

    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                minWidth: 220,
            }}
        >
            <input
                className="settings-range-slider"
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                style={{
                    width: 160,
                    cursor: "pointer",
                    ["--slider-progress" as string]: `${progress}%`,
                }}
            />
            <span
                style={{
                    minWidth: 42,
                    textAlign: "right",
                    fontSize: 12,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--color-text-secondary)",
                }}
            >
                {formatValue ? formatValue(value) : value}
            </span>
        </div>
    );
}

export function ThemePicker({
    value,
    presets,
    onChange,
}: {
    value: string;
    presets: readonly {
        readonly id: string;
        readonly label: string;
        readonly swatches?: readonly [string, string, string];
    }[];
    onChange: (id: string) => void;
}) {
    return (
        <div
            style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 10,
                padding: "8px 0",
            }}
        >
            {presets.map((preset) => {
                const active = preset.id === value;
                const [light, dark, accent] = preset.swatches ?? [
                    "#ffffff",
                    "#1c1c1c",
                    "#6366f1",
                ];
                return (
                    <button
                        key={preset.id}
                        onClick={() => onChange(preset.id)}
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 6,
                            padding: 8,
                            borderRadius: 8,
                            border: active
                                ? "2px solid var(--color-accent)"
                                : "2px solid var(--color-border)",
                            background: "var(--color-bg-secondary)",
                            cursor: "pointer",
                            transition: "border-color 150ms",
                        }}
                    >
                        <div
                            style={{
                                width: "100%",
                                height: 32,
                                borderRadius: 4,
                                overflow: "hidden",
                                display: "flex",
                            }}
                        >
                            <div style={{ flex: 1, backgroundColor: light }} />
                            <div style={{ flex: 1, backgroundColor: dark }} />
                            <div
                                style={{ width: 8, backgroundColor: accent }}
                            />
                        </div>
                        <span
                            style={{
                                fontSize: 11,
                                fontWeight: active ? 600 : 400,
                                color: active
                                    ? "var(--color-accent)"
                                    : "var(--color-text-secondary)",
                            }}
                        >
                            {preset.label}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

export function Row({
    label,
    description,
    control,
    disabled,
}: {
    label: string;
    description?: string;
    control: React.ReactNode;
    disabled?: boolean;
}) {
    return (
        <div
            style={{
                alignItems: "center",
                borderBottom:
                    "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                display: "flex",
                gap: 24,
                justifyContent: "space-between",
                opacity: disabled ? 0.45 : 1,
                padding: "11px 0",
            }}
        >
            <div style={{ minWidth: 0 }}>
                <div
                    style={{
                        fontSize: 13,
                        fontWeight: 500,
                        color: "var(--color-text-primary)",
                        lineHeight: 1.3,
                    }}
                >
                    {label}
                </div>
                {description && (
                    <div
                        style={{
                            fontSize: 11,
                            color: "var(--color-text-secondary)",
                            marginTop: 2,
                            lineHeight: 1.4,
                        }}
                    >
                        {description}
                    </div>
                )}
            </div>
            <div style={{ flexShrink: 0 }}>{control}</div>
        </div>
    );
}

export function SectionLabel({ children }: { children: string }) {
    return (
        <div
            style={{
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                paddingBottom: 4,
                paddingTop: 20,
                textTransform: "uppercase",
            }}
        >
            {children}
        </div>
    );
}
