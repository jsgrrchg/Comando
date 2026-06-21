use std::str::Split;

use imara_diff::{Algorithm, Diff, InternedInput, TokenSource};
use serde::{Deserialize, Serialize};

use crate::action_log::{HunkWordDiffs, LineEdit, LinePatch};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiDiffLineType {
    Add,
    Context,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDiffHunkLine {
    pub id: String,
    pub text: String,
    #[serde(rename = "type")]
    pub line_type: AiDiffLineType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDiffHunk {
    pub id: String,
    pub lines: Vec<AiDiffHunkLine>,
    pub new_count: u32,
    pub new_start: u32,
    pub old_count: u32,
    pub old_start: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual_end_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual_start_line: Option<u32>,
}

#[derive(Clone, Copy, Debug)]
struct JsSplitLines<'a>(&'a str);

impl<'a> TokenSource for JsSplitLines<'a> {
    type Token = &'a str;
    type Tokenizer = Split<'a, char>;

    fn tokenize(&self) -> Self::Tokenizer {
        self.0.split('\n')
    }

    fn estimate_tokens(&self) -> u32 {
        self.0
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
            .saturating_add(1)
            .try_into()
            .unwrap_or(u32::MAX)
    }
}

pub fn normalize_review_text(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn split_review_lines(text: &str) -> Vec<String> {
    let normalized = normalize_review_text(text);
    if normalized.is_empty() {
        return Vec::new();
    }
    normalized.split('\n').map(str::to_string).collect()
}

pub fn dominant_line_ending(text: &str) -> &'static str {
    let crlf_count = text.matches("\r\n").count();
    let bytes = text.as_bytes();
    let lf_count = bytes
        .iter()
        .enumerate()
        .filter(|(index, byte)| **byte == b'\n' && (*index == 0 || bytes[index - 1] != b'\r'))
        .count();

    if crlf_count > lf_count { "\r\n" } else { "\n" }
}

pub fn compute_line_diff(old_text: &str, new_text: &str) -> LinePatch {
    let old_text = normalize_review_text(old_text);
    let new_text = normalize_review_text(new_text);
    let input = InternedInput::new(JsSplitLines(&old_text), JsSplitLines(&new_text));
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_lines(&input);

    LinePatch {
        edits: diff
            .hunks()
            .map(|hunk| LineEdit {
                old_start: hunk.before.start,
                old_end: hunk.before.end,
                new_start: hunk.after.start,
                new_end: hunk.after.end,
            })
            .collect(),
    }
}

pub fn compute_diff_hunks(old_text: &str, new_text: &str, seed: &str) -> Vec<AiDiffHunk> {
    let old_lines = split_review_lines(old_text);
    let new_lines = split_review_lines(new_text);
    let max_visual_line = new_lines.len().max(1) as u32;
    compute_line_diff(old_text, new_text)
        .edits
        .into_iter()
        .enumerate()
        .map(|(index, edit)| {
            hunk_from_edit(seed, index, edit, &old_lines, &new_lines, max_visual_line)
        })
        .collect()
}

fn hunk_from_edit(
    seed: &str,
    index: usize,
    edit: LineEdit,
    old_lines: &[String],
    new_lines: &[String],
    max_visual_line: u32,
) -> AiDiffHunk {
    let old_start = edit.old_start.saturating_add(1);
    let new_start = edit.new_start.saturating_add(1);
    let old_count = edit.old_end.saturating_sub(edit.old_start);
    let new_count = edit.new_end.saturating_sub(edit.new_start);
    let mut lines = Vec::with_capacity((old_count + new_count) as usize);

    for old_index in edit.old_start..edit.old_end {
        lines.push(AiDiffHunkLine {
            id: format!("line:{seed}:{old_start}:{new_start}:{}", lines.len()),
            text: old_lines
                .get(old_index as usize)
                .cloned()
                .unwrap_or_default(),
            line_type: AiDiffLineType::Remove,
        });
    }
    for new_index in edit.new_start..edit.new_end {
        lines.push(AiDiffHunkLine {
            id: format!("line:{seed}:{old_start}:{new_start}:{}", lines.len()),
            text: new_lines
                .get(new_index as usize)
                .cloned()
                .unwrap_or_default(),
            line_type: AiDiffLineType::Add,
        });
    }

    let (visual_start_line, visual_end_line) =
        build_visual_line_range(new_start, new_count, max_visual_line);

    AiDiffHunk {
        id: format!("{seed}:{old_start}:{new_start}:{index}"),
        lines,
        new_count,
        new_start,
        old_count,
        old_start,
        visual_end_line: Some(visual_end_line),
        visual_start_line: Some(visual_start_line),
    }
}

fn build_visual_line_range(start_line: u32, line_count: u32, max_line: u32) -> (u32, u32) {
    let normalized_max_line = max_line.max(1);
    let normalized_start_line = start_line.max(1).min(normalized_max_line);
    let normalized_line_count = line_count.max(1);
    let normalized_end_line = normalized_start_line
        .saturating_add(normalized_line_count)
        .saturating_sub(1)
        .min(normalized_max_line);
    (normalized_start_line, normalized_end_line)
}

pub fn compute_word_diffs_for_hunk(
    _base_text: &str,
    _current_text: &str,
    _edit: &LineEdit,
    _max_lines: u32,
    _max_chars: u32,
) -> HunkWordDiffs {
    HunkWordDiffs::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_create_hunk() {
        let hunks = compute_diff_hunks("", "one\ntwo\n", "file.rs");
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].new_count, 2);
        assert_eq!(hunks[0].old_count, 0);
        assert!(matches!(hunks[0].lines[0].line_type, AiDiffLineType::Add));
    }

    #[test]
    fn normalizes_crlf_for_visual_diff() {
        let hunks = compute_diff_hunks("a\r\nb\r\n", "a\r\nc\r\n", "file.rs");
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].old_start, 2);
        assert_eq!(hunks[0].new_start, 2);
    }

    #[test]
    fn repeated_lines_use_histogram_without_quadratic_lcs() {
        let old = ["same"; 1000].join("\n");
        let new = format!("{}\nchanged", ["same"; 1000].join("\n"));
        let hunks = compute_diff_hunks(&old, &new, "large.txt");
        assert_eq!(hunks.len(), 1);
    }
}
