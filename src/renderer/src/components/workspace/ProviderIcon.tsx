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

function resolveProviderRuntimeId(runtimeId: AiRuntimeId): ActiveAiRuntimeId {
    return PROVIDER_ICON_RUNTIME_IDS.includes(runtimeId as ActiveAiRuntimeId)
        ? (runtimeId as ActiveAiRuntimeId)
        : "codex";
}

export function ProviderIcon({
    className = "shrink-0",
    opacity = 0.55,
    runtimeId,
    size = 12,
}: ProviderIconProps) {
    const resolvedRuntimeId = resolveProviderRuntimeId(runtimeId);
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
                stroke="currentColor"
                strokeLinecap="round"
                style={{ opacity }}
                viewBox="0 0 16 16"
                width={size}
            >
                <line
                    strokeWidth="1.35"
                    x1="8"
                    x2="8"
                    y1="2"
                    y2="14"
                />
                <line
                    strokeWidth="1.35"
                    x1="2"
                    x2="14"
                    y1="8"
                    y2="8"
                />
                <line
                    strokeWidth="1.35"
                    x1="3.75"
                    x2="12.25"
                    y1="3.75"
                    y2="12.25"
                />
                <line
                    strokeWidth="1.35"
                    x1="12.25"
                    x2="3.75"
                    y1="3.75"
                    y2="12.25"
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
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity }}
                viewBox="0 0 16 16"
                width={size}
            >
                <path
                    d="M3.25 8a4.75 4.75 0 1 1 4.75 4.75"
                    strokeWidth="1.1"
                />
                <path d="M8 3.25v4.75h4.75" strokeWidth="1.1" />
                <path d="M4.4 11.6 11.6 4.4" strokeWidth="1" />
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
                style={{ opacity }}
                viewBox="0 0 300 300"
                width={size}
            >
                <path
                    d="M210 240H90V120H210V240Z"
                    fill="currentColor"
                    opacity="0.38"
                />
                <path
                    d="M210 60H90V240H210V60ZM270 300H30V0H270V300Z"
                    fill="currentColor"
                />
            </svg>
        );
    }

    if (resolvedRuntimeId === "codex") {
        return (
            <svg
                aria-label={label}
                className={className}
                data-provider-icon={resolvedRuntimeId}
                fill="none"
                height={size}
                role="img"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity }}
                viewBox="0 0 16 16"
                width={size}
            >
                <polygon
                    points="8,2.3 13.4,5.4 13.4,10.6 8,13.7 2.6,10.6 2.6,5.4"
                    strokeWidth="1.1"
                />
                <line
                    strokeWidth="1"
                    x1="8"
                    x2="8"
                    y1="2.3"
                    y2="13.7"
                />
                <line
                    strokeWidth="1"
                    x1="2.6"
                    x2="13.4"
                    y1="5.4"
                    y2="10.6"
                />
                <line
                    strokeWidth="1"
                    x1="13.4"
                    x2="2.6"
                    y1="5.4"
                    y2="10.6"
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
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity }}
            viewBox="0 0 16 16"
            width={size}
        >
            <line
                strokeWidth="1.5"
                x1="4.75"
                x2="4.75"
                y1="2.75"
                y2="13.25"
            />
            <line
                strokeWidth="1.5"
                x1="4.75"
                x2="11.25"
                y1="8"
                y2="2.75"
            />
            <line
                strokeWidth="1.5"
                x1="4.75"
                x2="11.25"
                y1="8"
                y2="13.25"
            />
        </svg>
    );
}
