export const CHAT_TITLE_TAB_MAX_CHARS = 28;
export const CHAT_TITLE_HISTORY_MAX_CHARS = 70;
export const CHAT_TITLE_STORED_MAX_CHARS = 100;

export const DEFAULT_CHAT_TITLE_PATTERN =
    /^(Claude|Grok|Codex|Kilo|OpenCode|Agent) \d+$/;
const GENERIC_CHAT_TITLES = new Set(["AI Session", "Chat"]);
const REVIEW_TITLE_PREFIX = "Review · ";

const PILL_OPEN = "\u200B\u00AB";
const PILL_CLOSE = "\u00BB\u200B";
const MAX_TITLE_WORDS = 12;
const ELLIPSIS = "\u2026";

export function isDefaultChatTitle(
    title: string,
    runtimeDisplayName?: string | null,
): boolean {
    const trimmedTitle = title.trim();
    if (DEFAULT_CHAT_TITLE_PATTERN.test(trimmedTitle)) {
        return true;
    }

    const trimmedDisplayName = runtimeDisplayName?.trim();
    if (!trimmedDisplayName) {
        return false;
    }

    const defaultTitlePrefix = `${trimmedDisplayName} `;
    return (
        trimmedTitle.startsWith(defaultTitlePrefix) &&
        /^\d+$/.test(trimmedTitle.slice(defaultTitlePrefix.length))
    );
}

export function truncateChatTitle(title: string, maxChars: number): string {
    const trimmed = title.trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }

    const budget = Math.max(1, maxChars - 1);
    // Slice by grapheme cluster so emoji / surrogate pairs / combining marks
    // are never split in half (which would render as U+FFFD or broken glyphs).
    const head = segmentChatTitle(trimmed).slice(0, budget).join("");
    const lastSpace = head.lastIndexOf(" ");
    // Only snap to the last whitespace when it leaves at least a short word
    // behind — otherwise we'd render "A…" for long single tokens.
    if (lastSpace > Math.floor(budget * 0.6)) {
        return head.slice(0, lastSpace).trimEnd() + ELLIPSIS;
    }
    return head + ELLIPSIS;
}

function segmentChatTitle(text: string): string[] {
    const globalIntl =
        typeof Intl !== "undefined"
            ? (Intl as typeof Intl & { Segmenter?: typeof Intl.Segmenter })
            : undefined;
    if (globalIntl?.Segmenter) {
        const segmenter = new globalIntl.Segmenter(undefined, {
            granularity: "grapheme",
        });
        return Array.from(segmenter.segment(text), (s) => s.segment);
    }
    // Fallback: iterate by Unicode code points (still guards surrogate pairs,
    // though it will split ZWJ emoji sequences and combining marks).
    return Array.from(text);
}

export function inferChatTitleFromPrompt(serializedContent: string): string {
    if (!serializedContent) return "";

    let text = serializedContent
        .replaceAll(PILL_OPEN, "")
        .replaceAll(PILL_CLOSE, "");

    // Drop tokens that add noise to a title.
    text = text.replace(/(^|\s)@fetch(?=\s|$)/g, "$1");
    text = text.replace(/(^|\s)\/plan(?=\s|$)/g, "$1");

    // Unwrap @mentions: "@auth/session.ts" → basename "session.ts"; plain
    // "@word" → "word". Keep emails intact (only match at token start).
    text = text.replace(/(^|\s)@([^\s]+)/g, (_, lead: string, body: string) => {
        const slashIndex = Math.max(
            body.lastIndexOf("/"),
            body.lastIndexOf("\\"),
        );
        const label = slashIndex >= 0 ? body.slice(slashIndex + 1) : body;
        return `${lead}${label}`;
    });

    // Attachments serialize with a 📎 prefix — drop the icon.
    text = text.replaceAll("\u{1F4CE}", "");

    // Collapse whitespace and newlines.
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return "";

    const words = text.split(" ").filter(Boolean).slice(0, MAX_TITLE_WORDS);
    const joined = words.join(" ");
    return truncateChatTitle(joined, CHAT_TITLE_STORED_MAX_CHARS);
}

type ChatTitleMessage = {
    readonly content: string;
    readonly kind: string;
};

export function getChatDisplayTitle(input: {
    readonly manualTitle?: string | null;
    readonly messages?: readonly ChatTitleMessage[];
    readonly runtimeDisplayName?: string | null;
    readonly title: string;
}): string {
    const manualTitle = input.manualTitle?.trim();
    if (manualTitle) {
        return manualTitle;
    }

    const storedTitle = input.title.trim();
    if (
        !isDefaultChatTitle(storedTitle, input.runtimeDisplayName) &&
        !GENERIC_CHAT_TITLES.has(storedTitle)
    ) {
        return storedTitle || "Chat";
    }

    const firstUserMessage = input.messages?.find(
        (message) => message.kind === "user" && message.content.trim(),
    );
    // The prompt label is a display-only fallback. It must never become a
    // competing persisted title while the runtime is still naming the session.
    return inferChatTitleFromPrompt(firstUserMessage?.content ?? "") || storedTitle || "Chat";
}

export function getReviewChatDisplayTitle(input: {
    readonly manualTitle?: string | null;
    readonly messages?: readonly ChatTitleMessage[];
    readonly runtimeDisplayName?: string | null;
    readonly title: string;
}): string {
    const title = input.title.startsWith(REVIEW_TITLE_PREFIX)
        ? input.title.slice(REVIEW_TITLE_PREFIX.length)
        : input.title;
    return `${REVIEW_TITLE_PREFIX}${getChatDisplayTitle({ ...input, title })}`;
}
