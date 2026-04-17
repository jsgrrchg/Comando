import { Fragment, memo, useState, type ReactNode } from "react";

import type { AiImageAttachment, AiSessionSnapshot } from "@shared/ipc";

import type { ResolvedProjectFileReference } from "@renderer/app/workspace/tree";

import { MarkdownContent } from "../MarkdownContent";
import { areMessagesEquivalent } from "./chatTimelineModel";

interface ChatMessageRowProps {
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly highlightQuery?: string;
    readonly message: AiSessionSnapshot["messages"][number];
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
    readonly resolveFileReference: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}

export const ChatMessageRow = memo(function ChatMessageRow({
    chatFontFamily,
    chatFontSize,
    highlightQuery,
    message,
    onOpenFile,
    onOpenImage,
    resolveFileReference,
}: ChatMessageRowProps) {
    if (message.kind === "user")
        return (
            <UserMessage
                attachments={message.attachments}
                chatFontFamily={chatFontFamily}
                chatFontSize={chatFontSize}
                content={message.content}
                highlightQuery={highlightQuery}
                onOpenFile={onOpenFile}
                onOpenImage={onOpenImage}
                resolveFileReference={resolveFileReference}
            />
        );
    if (message.kind === "user_input_request") {
        return (
            <UserInputRequestMessage
                chatFontFamily={chatFontFamily}
                chatFontSize={chatFontSize}
                content={message.content}
                highlightQuery={highlightQuery}
                onOpenFile={onOpenFile}
                resolveFileReference={resolveFileReference}
            />
        );
    }
    if (message.kind === "thinking")
        return (
            <ThinkingMessage
                chatFontFamily={chatFontFamily}
                chatFontSize={chatFontSize}
                content={message.content}
                highlightQuery={highlightQuery}
                inProgress={message.status === "streaming"}
                onOpenFile={onOpenFile}
                resolveFileReference={resolveFileReference}
            />
        );
    return (
        <AssistantMessage
            attachments={message.attachments}
            chatFontFamily={chatFontFamily}
            chatFontSize={chatFontSize}
            content={message.content}
            highlightQuery={highlightQuery}
            onOpenFile={onOpenFile}
            onOpenImage={onOpenImage}
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
        previous.chatFontSize === next.chatFontSize &&
        previous.highlightQuery === next.highlightQuery &&
        previous.onOpenFile === next.onOpenFile &&
        previous.onOpenImage === next.onOpenImage &&
        previous.resolveFileReference === next.resolveFileReference &&
        areMessagesEquivalent(previous.message, next.message)
    );
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
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly content: string;
    readonly highlightQuery?: string;
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
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
            chatFontFamily={params.chatFontFamily}
            chatFontSize={params.chatFontSize}
            content={params.content}
            onOpenFile={params.onOpenFile}
            resolveFileReference={params.resolveFileReference}
        />
    );
}

function UserMessage(props: {
    readonly attachments: readonly AiImageAttachment[];
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly content: string;
    readonly highlightQuery?: string;
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
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
                      content: props.content,
                      highlightQuery: props.highlightQuery,
                      onOpenFile: props.onOpenFile,
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
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly content: string;
    readonly highlightQuery?: string;
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
    readonly onOpenImage: (attachment: AiImageAttachment) => Promise<void>;
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
                      content: props.content,
                      highlightQuery: props.highlightQuery,
                      onOpenFile: props.onOpenFile,
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
    chatFontFamily,
    chatFontSize,
    content,
    highlightQuery,
    onOpenFile,
    resolveFileReference,
}: {
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly content: string;
    readonly highlightQuery?: string;
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
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
                    content,
                    highlightQuery,
                    onOpenFile,
                    resolveFileReference,
                })}
            </div>
        </div>
    );
}

function ThinkingMessage({
    chatFontFamily,
    chatFontSize,
    content,
    highlightQuery,
    inProgress,
    onOpenFile,
    resolveFileReference,
}: {
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly content: string;
    readonly highlightQuery?: string;
    readonly inProgress: boolean;
    readonly onOpenFile: (reference: ResolvedProjectFileReference) => void;
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
                        content,
                        highlightQuery,
                        onOpenFile,
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
