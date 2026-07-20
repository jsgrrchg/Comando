use codex_thread_store::StoredThread;
use unicode_segmentation::UnicodeSegmentation;

const SESSION_TITLE_MAX_GRAPHEMES: usize = 120;

pub(crate) fn stored_session_title(thread: &StoredThread) -> Option<String> {
    resolve_session_title(thread.name.as_deref(), &thread.preview)
}

fn resolve_session_title(name: Option<&str>, preview: &str) -> Option<String> {
    [name, Some(preview)]
        .into_iter()
        .flatten()
        .find_map(format_session_title)
}

fn format_session_title(message: &str) -> Option<String> {
    let normalized = message.replace(['\r', '\n'], " ");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(truncate_graphemes(trimmed, SESSION_TITLE_MAX_GRAPHEMES))
    }
}

fn truncate_graphemes(text: &str, max_graphemes: usize) -> String {
    let mut graphemes = text.grapheme_indices(true);

    if let Some((byte_index, _)) = graphemes.nth(max_graphemes) {
        if max_graphemes >= 3 {
            let mut truncate_graphemes = text.grapheme_indices(true);
            if let Some((truncate_byte_index, _)) = truncate_graphemes.nth(max_graphemes - 3) {
                let truncated = &text[..truncate_byte_index];
                format!("{truncated}...")
            } else {
                text.to_string()
            }
        } else {
            let truncated = &text[..byte_index];
            truncated.to_string()
        }
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_a_non_empty_thread_name_over_preview() {
        assert_eq!(
            resolve_session_title(Some("renamed"), "preview"),
            Some("renamed".to_string())
        );
    }

    #[test]
    fn falls_back_to_preview_when_name_is_missing_or_blank() {
        assert_eq!(
            resolve_session_title(None, "preview"),
            Some("preview".to_string())
        );
        assert_eq!(
            resolve_session_title(Some("  "), "preview"),
            Some("preview".to_string())
        );
        assert_eq!(resolve_session_title(Some("  "), "\n\r"), None);
    }

    #[test]
    fn normalizes_line_breaks_and_outer_whitespace() {
        assert_eq!(
            resolve_session_title(None, "  first line\r\nsecond line  "),
            Some("first line  second line".to_string())
        );
    }

    #[test]
    fn truncates_composed_graphemes_without_splitting_them() {
        let grapheme = "e\u{301}";
        let title = format_session_title(&grapheme.repeat(121)).expect("title should be present");

        assert!(title.ends_with("..."));
        assert_eq!(title.graphemes(true).count(), SESSION_TITLE_MAX_GRAPHEMES);
        assert_eq!(
            title.strip_suffix("..."),
            Some(grapheme.repeat(117).as_str())
        );
    }
}
