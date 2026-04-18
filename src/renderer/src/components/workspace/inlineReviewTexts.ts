import type { AiTrackedFile } from "@shared/ipc";

export interface InlineReviewTexts {
    readonly modified: string;
    readonly original: string;
    // True when we had to splice a snippet into the full file. Backend hunk
    // line anchors reference the snippet (not the whole file), so overlays and
    // gutter decorations keyed on those hunks should be hidden to avoid
    // pointing at the wrong spot.
    readonly wasReconstructed: boolean;
}

/**
 * Agents may report a diff as a small snippet (tool-level `edit_text_file`
 * replaces) rather than whole-file contents. Passing those snippets to Monaco's
 * DiffEditor as-is makes the editor render only the snippet, hiding the rest of
 * the file. When the snippet is unambiguous inside the current file we splice
 * it back in so the inline review shows the complete file with the pending
 * change highlighted.
 *
 * Returns `null` when reconstruction is not safe (missing content, ambiguous
 * snippet, mismatched base). The caller should fall back to the plain editor
 * in that case.
 */
export function buildInlineReviewTexts(
    trackedFile: AiTrackedFile,
    currentFileContent: string | null,
): InlineReviewTexts | null {
    const snippetOld = trackedFile.oldText ?? "";
    const snippetNew = trackedFile.newText ?? "";

    if (currentFileContent === null) {
        return snippetOld && snippetNew
            ? {
                  modified: snippetNew,
                  original: snippetOld,
                  wasReconstructed: false,
              }
            : null;
    }

    // Whole-file diff: nothing to reconstruct.
    if (snippetOld === currentFileContent) {
        return {
            modified: snippetNew,
            original: snippetOld,
            wasReconstructed: false,
        };
    }
    if (snippetNew === currentFileContent && snippetOld.length > 0) {
        return {
            modified: snippetNew,
            original: snippetOld,
            wasReconstructed: false,
        };
    }

    if (snippetOld.length === 0) {
        return null;
    }

    const first = currentFileContent.indexOf(snippetOld);
    if (first === -1 || first !== currentFileContent.lastIndexOf(snippetOld)) {
        return null;
    }

    const modified =
        currentFileContent.slice(0, first) +
        snippetNew +
        currentFileContent.slice(first + snippetOld.length);

    return { modified, original: currentFileContent, wasReconstructed: true };
}
