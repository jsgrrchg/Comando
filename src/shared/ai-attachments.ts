export const MAX_IMAGE_ATTACHMENTS = 12;
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function getImageAttachmentLimitMessage(): string {
    return `You can attach up to ${MAX_IMAGE_ATTACHMENTS} images per message.`;
}
