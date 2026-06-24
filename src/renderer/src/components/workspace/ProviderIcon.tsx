import type { CSSProperties } from "react";

import {
    ACTIVE_AI_RUNTIME_IDS,
    getAiRuntimeDisplayName,
    type ActiveAiRuntimeId,
} from "@shared/ai-runtimes";
import type { AiRuntimeId } from "@shared/ipc";

export const PROVIDER_ICON_RUNTIME_IDS = ACTIVE_AI_RUNTIME_IDS;

type ProviderIconProps = {
    readonly className?: string;
    readonly opacity?: number;
    readonly runtimeId: AiRuntimeId;
    readonly size?: number;
};

const PROVIDER_ICON_ACCENTS: Record<ActiveAiRuntimeId, string> = {
    claude: "#d97757",
    codex: "#38bdf8",
    grok: "#f8fafc",
    kilo: "#a78bfa",
    opencode: "#22c55e",
};

function resolveProviderRuntimeId(runtimeId: AiRuntimeId): ActiveAiRuntimeId {
    return PROVIDER_ICON_RUNTIME_IDS.includes(runtimeId as ActiveAiRuntimeId)
        ? (runtimeId as ActiveAiRuntimeId)
        : "codex";
}

export function ProviderIcon({
    className = "shrink-0",
    opacity = 0.9,
    runtimeId,
    size = 12,
}: ProviderIconProps) {
    const resolvedRuntimeId = resolveProviderRuntimeId(runtimeId);
    const accent = PROVIDER_ICON_ACCENTS[resolvedRuntimeId];
    const style: CSSProperties = {
        "--provider-icon-accent": accent,
        opacity,
    } as CSSProperties;
    const label = `${getAiRuntimeDisplayName(resolvedRuntimeId)} provider`;

    if (resolvedRuntimeId === "claude") {
        return (
            <svg
                aria-label={label}
                className={className}
                data-provider-icon={resolvedRuntimeId}
                fill="none"
                height={size}
                role="img"
                style={style}
                viewBox="0 0 16 16"
                width={size}
            >
                <circle
                    cx="8"
                    cy="8"
                    fill="color-mix(in srgb, var(--provider-icon-accent) 18%, transparent)"
                    r="5.8"
                />
                <path
                    d="M8 2.15v11.7M2.15 8h11.7M3.85 3.85l8.3 8.3M12.15 3.85l-8.3 8.3"
                    stroke="var(--provider-icon-accent)"
                    strokeLinecap="round"
                    strokeWidth="1.25"
                />
            </svg>
        );
    }

    if (resolvedRuntimeId === "grok") {
        return (
            <svg
                aria-label={label}
                className={className}
                data-provider-icon={resolvedRuntimeId}
                fill="none"
                height={size}
                role="img"
                style={style}
                viewBox="0 0 16 16"
                width={size}
            >
                <circle
                    cx="8"
                    cy="8"
                    fill="color-mix(in srgb, var(--provider-icon-accent) 10%, transparent)"
                    r="5.4"
                    stroke="var(--provider-icon-accent)"
                    strokeWidth="1"
                />
                <path
                    d="M11.7 4.3 4.3 11.7M5.1 4.7h5.45c.4 0 .72.32.72.72v5.45"
                    stroke="var(--provider-icon-accent)"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.25"
                />
            </svg>
        );
    }

    if (resolvedRuntimeId === "kilo") {
        return (
            <svg
                aria-label={label}
                className={className}
                data-provider-icon={resolvedRuntimeId}
                fill="none"
                height={size}
                role="img"
                style={style}
                viewBox="0 0 16 16"
                width={size}
            >
                <rect
                    fill="color-mix(in srgb, var(--provider-icon-accent) 14%, transparent)"
                    height="11"
                    rx="2.2"
                    stroke="var(--provider-icon-accent)"
                    strokeWidth="1"
                    width="11"
                    x="2.5"
                    y="2.5"
                />
                <path
                    d="M5.35 4.75v6.5M5.45 8l5.2-3.25M5.45 8l5.2 3.25"
                    stroke="var(--provider-icon-accent)"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.35"
                />
            </svg>
        );
    }

    if (resolvedRuntimeId === "opencode") {
        return (
            <svg
                aria-label={label}
                className={className}
                data-provider-icon={resolvedRuntimeId}
                fill="none"
                height={size}
                role="img"
                style={style}
                viewBox="0 0 16 16"
                width={size}
            >
                <circle
                    cx="8"
                    cy="8"
                    fill="color-mix(in srgb, var(--provider-icon-accent) 12%, transparent)"
                    r="5.4"
                    stroke="var(--provider-icon-accent)"
                    strokeWidth="1"
                />
                <path
                    d="M5.1 6.35 3.45 8l1.65 1.65M10.9 6.35 12.55 8l-1.65 1.65M9 4.85 7 11.15"
                    stroke="var(--provider-icon-accent)"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.15"
                />
            </svg>
        );
    }

    return (
        <svg
            aria-label={label}
            className={className}
            data-provider-icon={resolvedRuntimeId}
            fill="none"
            height={size}
            role="img"
            style={style}
            viewBox="0 0 16 16"
            width={size}
        >
            <path
                d="M8 2.2 13.2 5.2v5.6L8 13.8 2.8 10.8V5.2L8 2.2Z"
                fill="color-mix(in srgb, var(--provider-icon-accent) 14%, transparent)"
                stroke="var(--provider-icon-accent)"
                strokeLinejoin="round"
                strokeWidth="1.05"
            />
            <path
                d="M8 2.2v11.6M2.8 5.2l10.4 5.6M13.2 5.2 2.8 10.8"
                stroke="var(--provider-icon-accent)"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="0.9"
            />
            <circle cx="8" cy="8" fill="var(--provider-icon-accent)" r="1.05" />
        </svg>
    );
}
