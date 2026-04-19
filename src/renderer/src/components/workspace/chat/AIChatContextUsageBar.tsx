import type { AiTokenUsage } from "@shared/ipc";

const WARNING_THRESHOLD = 0.85;
const EXCEEDED_THRESHOLD = 1;
const BAR_HEIGHT = 2;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function formatPercent(ratio: number): string {
    const percent = Math.round(clamp(ratio, 0, 2) * 100);
    return `${percent}%`;
}

function formatCompactTokenCount(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
        return "0";
    }
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
    }
    return String(Math.round(value));
}

function formatCost(amount: number, currency: string): string {
    const formatter = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: (currency || "USD").toUpperCase(),
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
    });
    try {
        return formatter.format(amount);
    } catch {
        return `${amount.toFixed(4)} ${currency}`;
    }
}

function getTone(ratio: number): string {
    if (ratio >= EXCEEDED_THRESHOLD) return "#dc2626";
    if (ratio >= WARNING_THRESHOLD) return "#d97706";
    return "var(--color-accent)";
}

interface AIChatContextUsageBarProps {
    readonly usage: AiTokenUsage | null;
}

export function AIChatContextUsageBar({ usage }: AIChatContextUsageBarProps) {
    if (!usage || usage.size <= 0) {
        return null;
    }

    const rawRatio = usage.used / usage.size;
    const ratio = clamp(rawRatio, 0, 1);
    const percent = formatPercent(rawRatio);
    const usedTokens = formatCompactTokenCount(usage.used);
    const sizeTokens = formatCompactTokenCount(usage.size);
    const tone = getTone(rawRatio);

    const tooltipLines: string[] = [
        `Context window: ${percent} used`,
        `${usedTokens} / ${sizeTokens} tokens`,
    ];
    if (usage.cost) {
        tooltipLines.push(
            `Estimated cost: ${formatCost(
                usage.cost.amount,
                usage.cost.currency,
            )}`,
        );
    }

    const showGlow = rawRatio >= WARNING_THRESHOLD;

    return (
        <div
            aria-label={`Context window ${percent} used (${usedTokens} of ${sizeTokens} tokens)`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(ratio * 100)}
            className="pointer-events-none absolute bottom-0 left-0 right-0"
            role="progressbar"
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--color-border) 60%, transparent)",
                height: BAR_HEIGHT,
                overflow: "hidden",
            }}
            title={tooltipLines.join("\n")}
        >
            <div
                style={{
                    backgroundColor: tone,
                    boxShadow: showGlow
                        ? `0 0 8px ${tone}, 0 0 2px ${tone}`
                        : "none",
                    height: "100%",
                    transition:
                        "width 220ms ease, background-color 160ms ease, box-shadow 160ms ease",
                    width: `${ratio * 100}%`,
                }}
            />
        </div>
    );
}
