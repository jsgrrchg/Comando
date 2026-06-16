import { Fragment, memo, useState, type ReactNode } from "react";

import type { AiImageAttachment, AiSessionSnapshot } from "@shared/ipc";

import {
    buildCodexGeneratedImagePreviewUrl,
    isCodexGeneratedImagePath,
} from "@renderer/app/utils/filePreviewUrl";
import type { ResolvedProjectFileReference } from "../projectFileReferences";

import { MarkdownContent } from "../MarkdownContent";
import { areMessagesEquivalent } from "./chatTimelineModel";

interface ChatMessageRowProps {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly highlightQuery?: string;
    readonly message: AiSessionSnapshot["messages"][number];
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onRevealFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}

export const ChatMessageRow = memo(function ChatMessageRow({
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    highlightQuery,
    message,
    onAddFileReferenceToChat,
    onOpenFile,
    onOpenImage,
    onRevealFileReference,
    resolveFileReference,
}: ChatMessageRowProps) {
    if (message.kind === "user")
        return (
            <UserMessage
                attachments={message.attachments}
                canRenderFileReference={canRenderFileReference}
                chatFontFamily={chatFontFamily}
                chatFontSize={chatFontSize}
                content={message.content}
                highlightQuery={highlightQuery}
                onAddFileReferenceToChat={onAddFileReferenceToChat}
                onOpenFile={onOpenFile}
                onOpenImage={onOpenImage}
                onRevealFileReference={onRevealFileReference}
                resolveFileReference={resolveFileReference}
            />
        );
    if (message.kind === "user_input_request") {
        return (
            <UserInputRequestMessage
                chatFontFamily={chatFontFamily}
                chatFontSize={chatFontSize}
                canRenderFileReference={canRenderFileReference}
                content={message.content}
                highlightQuery={highlightQuery}
                onAddFileReferenceToChat={onAddFileReferenceToChat}
                onOpenFile={onOpenFile}
                onRevealFileReference={onRevealFileReference}
                resolveFileReference={resolveFileReference}
            />
        );
    }
    if (message.kind === "thinking")
        return (
            <ThinkingMessage
                chatFontFamily={chatFontFamily}
                chatFontSize={chatFontSize}
                canRenderFileReference={canRenderFileReference}
                content={message.content}
                highlightQuery={highlightQuery}
                inProgress={message.status === "streaming"}
                onAddFileReferenceToChat={onAddFileReferenceToChat}
                onOpenFile={onOpenFile}
                onRevealFileReference={onRevealFileReference}
                resolveFileReference={resolveFileReference}
            />
        );
    if (message.kind === "image") {
        return (
            <GeneratedImageMessage
                chatFontSize={chatFontSize}
                message={message}
            />
        );
    }
    return (
        <AssistantMessage
            attachments={message.attachments}
            canRenderFileReference={canRenderFileReference}
            chatFontFamily={chatFontFamily}
            chatFontSize={chatFontSize}
            content={message.content}
            highlightQuery={highlightQuery}
            onAddFileReferenceToChat={onAddFileReferenceToChat}
            onOpenFile={onOpenFile}
            onOpenImage={onOpenImage}
            onRevealFileReference={onRevealFileReference}
            resolveFileReference={resolveFileReference}
        />
    );
}, areChatMessageRowPropsEqual);

ChatMessageRow.displayName = "ChatMessageRow";

function areChatMessageRowPropsEqual(
    previous: Readonly<ChatMessageRowProps>,
    next: Readonly<ChatMessageRowProps>,
) {
    return (
        previous.chatFontFamily === next.chatFontFamily &&
        previous.canRenderFileReference === next.canRenderFileReference &&
        previous.chatFontSize === next.chatFontSize &&
        previous.highlightQuery === next.highlightQuery &&
        previous.onAddFileReferenceToChat === next.onAddFileReferenceToChat &&
        previous.onOpenFile === next.onOpenFile &&
        previous.onOpenImage === next.onOpenImage &&
        previous.onRevealFileReference === next.onRevealFileReference &&
        previous.resolveFileReference === next.resolveFileReference &&
        areMessagesEquivalent(previous.message, next.message)
    );
}

function GeneratedImageMessage({
    chatFontSize,
    message,
}: {
    readonly chatFontSize?: number;
    readonly message: AiSessionSnapshot["messages"][number];
}) {
    const image = message.generatedImage ?? null;
    const imagePath = image?.path?.trim() || null;
    const previewUrl =
        imagePath && isCodexGeneratedImagePath(imagePath)
            ? buildCodexGeneratedImagePreviewUrl(imagePath)
            : null;
    const [loadFailed, setLoadFailed] = useState(false);
    const [copied, setCopied] = useState(false);
    const status = (image?.status ?? "").toLowerCase();
    const isActive =
        message.status === "streaming" ||
        status === "pending" ||
        status === "in_progress" ||
        status === "running";
    const isFailed =
        Boolean(image?.error) ||
        status === "failed" ||
        status === "error" ||
        status === "cancelled" ||
        status === "canceled";
    const subtitle = image?.revisedPrompt ?? image?.result ?? "";
    const title = image?.title ?? imageMessageTitle(isActive, isFailed);

    const copyPath = async () => {
        if (!imagePath) {
            return;
        }

        await window.comando.writeClipboardText(imagePath);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
    };
    const openImage = async () => {
        if (imagePath) {
            await window.comando.openGeneratedImage(imagePath);
        }
    };
    const revealImage = async () => {
        if (imagePath) {
            await window.comando.revealGeneratedImage(imagePath);
        }
    };

    if (isActive) {
        return (
            <div
                className="min-w-0 max-w-full rounded-xl px-3 py-2"
                style={{
                    border: "1px solid color-mix(in srgb, var(--color-accent) 25%, var(--color-border))",
                    backgroundColor:
                        "color-mix(in srgb, var(--color-accent) 5%, var(--color-bg-panel))",
                    fontSize: chatFontSize,
                }}
            >
                <div
                    className="flex items-center gap-2"
                    style={{ color: "var(--color-text-primary)" }}
                >
                    <GeneratedImageIcon stroke="var(--color-accent)" />
                    <span
                        className="font-medium"
                        style={{ fontSize: "0.84em" }}
                    >
                        Generating image...
                    </span>
                </div>
            </div>
        );
    }

    const unavailable = !previewUrl || loadFailed;
    const accent = isFailed ? "#ef4444" : "var(--color-accent)";

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-xl"
            style={{
                maxWidth: "min(520px, 100%)",
                border: `1px solid color-mix(in srgb, ${accent} 22%, var(--color-border))`,
                backgroundColor: `color-mix(in srgb, ${accent} 3%, var(--color-bg-panel))`,
                color: "var(--color-text-primary)",
                fontSize: chatFontSize,
            }}
        >
            <div
                className="flex items-center gap-2 px-3 py-2"
                style={{
                    borderBottom: `1px solid color-mix(in srgb, ${accent} 14%, var(--color-border))`,
                }}
            >
                <GeneratedImageIcon stroke={accent} />
                <div className="min-w-0 flex-1">
                    <div
                        className="font-medium"
                        style={{
                            color: isFailed
                                ? "#f87171"
                                : "var(--color-text-primary)",
                            fontSize: "0.84em",
                        }}
                    >
                        {title}
                    </div>
                    {subtitle ? (
                        <div
                            className="truncate"
                            title={imagePath ?? subtitle}
                            style={{
                                color: "var(--color-text-secondary)",
                                fontSize: "0.74em",
                                opacity: 0.85,
                            }}
                        >
                            {subtitle}
                        </div>
                    ) : null}
                </div>
            </div>

            {unavailable || isFailed ? (
                <div className="px-3 py-3">
                    <div
                        style={{
                            color: isFailed
                                ? "#f87171"
                                : "var(--color-text-secondary)",
                            fontSize: "0.84em",
                        }}
                    >
                        {isFailed
                            ? (image?.error ??
                              message.content ??
                              "Image generation failed")
                            : previewUrl
                              ? "Image file could not be loaded"
                              : "Image path is unavailable"}
                    </div>
                    {!isFailed ? (
                        <div
                            className="mt-1"
                            style={{
                                color: "var(--color-text-secondary)",
                                fontSize: "0.76em",
                                opacity: 0.7,
                            }}
                        >
                            This generated image may have been moved or deleted.
                        </div>
                    ) : null}
                </div>
            ) : (
                <div style={{ backgroundColor: "var(--color-bg-primary)" }}>
                    <img
                        alt={subtitle || "Generated image"}
                        className="block w-full"
                        onError={() => setLoadFailed(true)}
                        src={previewUrl ?? undefined}
                        style={{
                            backgroundColor: "var(--color-bg-primary)",
                            maxHeight: 420,
                            objectFit: "contain",
                        }}
                        title={imagePath ?? undefined}
                    />
                </div>
            )}

            {imagePath ? (
                <div
                    className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5"
                    style={{
                        borderTop: `1px solid color-mix(in srgb, ${accent} 12%, var(--color-border))`,
                    }}
                >
                    <ImageActionButton
                        icon="open"
                        onClick={() => {
                            void openImage();
                        }}
                    >
                        Open Externally
                    </ImageActionButton>
                    <ImageActionButton
                        icon="reveal"
                        onClick={() => {
                            void revealImage();
                        }}
                    >
                        {revealGeneratedImageLabel()}
                    </ImageActionButton>
                    <ImageActionButton
                        icon={copied ? "check" : "copy"}
                        onClick={() => {
                            void copyPath();
                        }}
                    >
                        {copied ? "Copied" : "Copy Path"}
                    </ImageActionButton>
                </div>
            ) : null}
        </div>
    );
}

function GeneratedImageIcon({ stroke = "currentColor" }: { stroke?: string }) {
    return (
        <svg
            aria-hidden="true"
            className="shrink-0"
            fill="none"
            height="13"
            stroke={stroke}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.4"
            viewBox="0 0 14 14"
            width="13"
        >
            <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" />
            <circle cx="5" cy="5.75" r="0.9" />
            <path d="M2 10l3-3 2.2 2.2L9.5 7l2.5 2.5" />
        </svg>
    );
}

type ImageActionIcon = "open" | "reveal" | "copy" | "check";

function ImageActionGlyph({ icon }: { icon: ImageActionIcon }) {
    const common = {
        fill: "none",
        height: 12,
        stroke: "currentColor",
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
        strokeWidth: 1.4,
        viewBox: "0 0 12 12",
        width: 12,
    };
    if (icon === "open") {
        return (
            <svg {...common} aria-hidden="true">
                <path d="M7 2h3v3" />
                <path d="M10 2L5.5 6.5" />
                <path d="M9 7v2.5a.5.5 0 0 1-.5.5h-6a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5H5" />
            </svg>
        );
    }
    if (icon === "reveal") {
        return (
            <svg {...common} aria-hidden="true">
                <path d="M1.5 4.2a.7.7 0 0 1 .7-.7h2.3l1 1.2h4.8a.7.7 0 0 1 .7.7v3.9a.7.7 0 0 1-.7.7H2.2a.7.7 0 0 1-.7-.7Z" />
            </svg>
        );
    }
    if (icon === "check") {
        return (
            <svg {...common} aria-hidden="true">
                <path d="M2.5 6.4L4.7 8.6L9.5 3.8" />
            </svg>
        );
    }
    return (
        <svg {...common} aria-hidden="true">
            <rect x="3.5" y="3.5" width="6" height="7" rx="1" />
            <path d="M5 3.5V2.4a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V3.5" />
        </svg>
    );
}

function ImageActionButton({
    children,
    icon,
    onClick,
}: {
    readonly children: ReactNode;
    readonly icon: ImageActionIcon;
    readonly onClick: () => void;
}) {
    const [hovered, setHovered] = useState(false);
    return (
        <button
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-colors"
            onClick={onClick}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                backgroundColor: hovered
                    ? "color-mix(in srgb, var(--color-text-primary) 6%, var(--color-bg-panel))"
                    : "transparent",
                border: `1px solid color-mix(in srgb, var(--color-border) ${
                    hovered ? "100%" : "70%"
                }, transparent)`,
                color: hovered
                    ? "var(--color-text-primary)"
                    : "var(--color-text-secondary)",
                fontSize: "0.74em",
            }}
            type="button"
        >
            <ImageActionGlyph icon={icon} />
            {children}
        </button>
    );
}

function imageMessageTitle(isActive: boolean, isFailed: boolean): string {
    if (isActive) {
        return "Generating image...";
    }

    return isFailed ? "Image generation failed" : "Generated image";
}

function revealGeneratedImageLabel(): string {
    if (typeof navigator === "undefined") {
        return "Reveal in Folder";
    }

    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes("mac")) {
        return "Reveal in Finder";
    }
    if (userAgent.includes("windows")) {
        return "Reveal in Explorer";
    }

    return "Reveal in Folder";
}

function HighlightedPlainText({
    chatFontFamily,
    chatFontSize,
    content,
    query,
}: {
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly content: string;
    readonly query: string;
}) {
    const segments = splitContentByHighlightQuery(content, query);
    return (
        <div
            style={{
                fontFamily: chatFontFamily,
                fontSize: chatFontSize,
                lineHeight: 1.6,
                overflowWrap: "anywhere",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
            }}
        >
            {segments.map((segment, index) =>
                segment.match ? (
                    <mark
                        key={index}
                        style={{
                            backgroundColor:
                                "color-mix(in srgb, var(--color-accent) 35%, transparent)",
                            borderRadius: 2,
                            color: "inherit",
                            padding: "0 1px",
                        }}
                    >
                        {segment.text}
                    </mark>
                ) : (
                    <Fragment key={index}>{segment.text}</Fragment>
                ),
            )}
        </div>
    );
}

function splitContentByHighlightQuery(
    content: string,
    query: string,
): ReadonlyArray<{ readonly text: string; readonly match: boolean }> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
        return [{ match: false, text: content }];
    }

    const lowerContent = content.toLowerCase();
    const lowerQuery = trimmed.toLowerCase();
    const segments: { text: string; match: boolean }[] = [];
    let cursor = 0;

    while (cursor < content.length) {
        const index = lowerContent.indexOf(lowerQuery, cursor);
        if (index === -1) {
            segments.push({ match: false, text: content.slice(cursor) });
            break;
        }

        if (index > cursor) {
            segments.push({
                match: false,
                text: content.slice(cursor, index),
            });
        }
        segments.push({
            match: true,
            text: content.slice(index, index + trimmed.length),
        });
        cursor = index + trimmed.length;
    }

    if (segments.length === 0) {
        return [{ match: false, text: content }];
    }

    return segments;
}

function renderHighlightableMarkdown(params: {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly content: string;
    readonly highlightQuery?: string;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
    readonly onRevealFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}): ReactNode {
    const trimmedQuery = params.highlightQuery?.trim() ?? "";
    if (trimmedQuery.length > 0) {
        return (
            <HighlightedPlainText
                chatFontFamily={params.chatFontFamily}
                chatFontSize={params.chatFontSize}
                content={params.content}
                query={trimmedQuery}
            />
        );
    }

    return (
        <MarkdownContent
            canRenderFileReference={params.canRenderFileReference}
            chatFontFamily={params.chatFontFamily}
            chatFontSize={params.chatFontSize}
            content={params.content}
            onAddFileReferenceToChat={params.onAddFileReferenceToChat}
            onOpenFile={params.onOpenFile}
            onRevealFileReference={params.onRevealFileReference}
            resolveFileReference={params.resolveFileReference}
        />
    );
}

function UserMessage(props: {
    readonly attachments: readonly AiImageAttachment[];
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly content: string;
    readonly highlightQuery?: string;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onRevealFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}) {
    return (
        <div
            className="min-w-0 max-w-full whitespace-pre-wrap rounded-lg px-3 py-2"
            style={{
                backgroundColor: "var(--color-bg-tertiary)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-primary)",
                fontSize: props.chatFontSize,
                lineHeight: 1.6,
                overflowWrap: "anywhere",
                wordBreak: "break-word",
            }}
        >
            {props.content
                ? renderHighlightableMarkdown({
                      chatFontFamily: props.chatFontFamily,
                      chatFontSize: props.chatFontSize,
                      canRenderFileReference:
                          props.canRenderFileReference,
                      content: props.content,
                      highlightQuery: props.highlightQuery,
                      onAddFileReferenceToChat: props.onAddFileReferenceToChat,
                      onOpenFile: props.onOpenFile,
                      onRevealFileReference: props.onRevealFileReference,
                      resolveFileReference: props.resolveFileReference,
                  })
                : null}
            {props.attachments.length > 0 ? (
                <MessageImageGrid
                    attachments={props.attachments}
                    onOpenImage={props.onOpenImage}
                />
            ) : null}
        </div>
    );
}

function AssistantMessage(props: {
    readonly attachments: readonly AiImageAttachment[];
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly content: string;
    readonly highlightQuery?: string;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly onRevealFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}) {
    return (
        <div
            className="min-w-0 max-w-full"
            style={{
                color: "var(--color-text-primary)",
                fontSize: props.chatFontSize,
            }}
        >
            {props.content
                ? renderHighlightableMarkdown({
                      chatFontFamily: props.chatFontFamily,
                      chatFontSize: props.chatFontSize,
                      canRenderFileReference:
                          props.canRenderFileReference,
                      content: props.content,
                      highlightQuery: props.highlightQuery,
                      onAddFileReferenceToChat: props.onAddFileReferenceToChat,
                      onOpenFile: props.onOpenFile,
                      onRevealFileReference: props.onRevealFileReference,
                      resolveFileReference: props.resolveFileReference,
                  })
                : null}
            {props.attachments.length > 0 ? (
                <MessageImageGrid
                    attachments={props.attachments}
                    onOpenImage={props.onOpenImage}
                />
            ) : null}
        </div>
    );
}

function MessageImageGrid(props: {
    readonly attachments: readonly AiImageAttachment[];
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
}) {
    return (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {props.attachments.map((attachment) => (
                <button
                    className="block w-full appearance-none overflow-hidden rounded-xl border border-border bg-bg-panel p-0 text-left transition hover:brightness-105"
                    key={attachment.id}
                    onClick={() => {
                        void props.onOpenImage(attachment);
                    }}
                    style={{ cursor: "zoom-in" }}
                    type="button"
                >
                    <img
                        alt={attachment.name ?? "Chat image"}
                        className="h-48 w-full object-cover"
                        src={toAttachmentDataUrl(attachment)}
                    />
                </button>
            ))}
        </div>
    );
}

function UserInputRequestMessage({
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    content,
    highlightQuery,
    onAddFileReferenceToChat,
    onOpenFile,
    onRevealFileReference,
    resolveFileReference,
}: {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly content: string;
    readonly highlightQuery?: string;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
    readonly onRevealFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}) {
    return (
        <div
            className="max-w-full rounded-xl border px-3 py-2"
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--color-accent) 8%, var(--color-bg-panel))",
                borderColor:
                    "color-mix(in srgb, var(--color-accent) 22%, var(--color-border))",
                fontSize: chatFontSize,
            }}
        >
            <div
                style={{
                    color: "var(--color-text-secondary)",
                    fontSize: "0.7em",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                }}
            >
                Input Requested
            </div>
            <div
                className="mt-1"
                style={{
                    color: "var(--color-text-primary)",
                    fontSize: "0.84em",
                    lineHeight: 1.55,
                }}
            >
                {renderHighlightableMarkdown({
                    chatFontFamily,
                    chatFontSize: chatFontSize
                        ? chatFontSize * 0.84
                        : chatFontSize,
                    canRenderFileReference,
                    content,
                    highlightQuery,
                    onAddFileReferenceToChat,
                    onOpenFile,
                    onRevealFileReference,
                    resolveFileReference,
                })}
            </div>
        </div>
    );
}

function ThinkingMessage({
    canRenderFileReference,
    chatFontFamily,
    chatFontSize,
    content,
    highlightQuery,
    inProgress,
    onAddFileReferenceToChat,
    onOpenFile,
    onRevealFileReference,
    resolveFileReference,
}: {
    readonly canRenderFileReference?: (
        rawReference: string,
        reference: ResolvedProjectFileReference,
    ) => boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly content: string;
    readonly highlightQuery?: string;
    readonly inProgress: boolean;
    readonly onAddFileReferenceToChat?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
    readonly onRevealFileReference?: (
        reference: ResolvedProjectFileReference,
    ) => void;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}) {
    const [expanded, setExpanded] = useState(false);
    return (
        <div className="min-w-0 max-w-full">
            <button
                className="flex items-center gap-2 py-0.5"
                onClick={() => setExpanded(!expanded)}
                style={{
                    background: "none",
                    border: "none",
                    color: "var(--color-text-secondary)",
                    cursor: "pointer",
                    fontSize: chatFontSize,
                    opacity: 0.7,
                }}
                type="button"
            >
                <svg
                    fill="none"
                    height="12"
                    stroke="currentColor"
                    strokeWidth="2"
                    style={{
                        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                        transition: "transform 120ms ease",
                    }}
                    viewBox="0 0 24 24"
                    width="12"
                >
                    <polyline points="9 18 15 12 9 6" />
                </svg>
                <span>Thinking{inProgress ? "..." : ""}</span>
            </button>
            {expanded && content ? (
                <div
                    className="mt-1 pl-5 italic"
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: 13,
                        lineHeight: 1.6,
                        opacity: 0.7,
                    }}
                >
                    {renderHighlightableMarkdown({
                        chatFontFamily,
                        chatFontSize: 13,
                        canRenderFileReference,
                        content,
                        highlightQuery,
                        onAddFileReferenceToChat,
                        onOpenFile,
                        onRevealFileReference,
                        resolveFileReference,
                    })}
                </div>
            ) : null}
        </div>
    );
}

function toAttachmentDataUrl(attachment: AiImageAttachment): string {
    return `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
}
