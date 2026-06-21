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
    base_text: &str,
    current_text: &str,
    edit: &LineEdit,
    max_lines: u32,
    max_chars: u32,
) -> HunkWordDiffs {
    compute_word_diffs_for_hunk_inner(base_text, current_text, edit, max_lines, max_chars)
        .unwrap_or_default()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WordTokenKind {
    Whitespace,
    Word,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WordDiffToken {
    units: Vec<u16>,
    from: u32,
    to: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Utf16Range {
    from: u32,
    to: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TokenEdit {
    old_start: usize,
    old_end: usize,
    new_start: usize,
    new_end: usize,
}

fn is_word_unit(unit: u16) -> bool {
    (b'0' as u16 <= unit && unit <= b'9' as u16)
        || (b'A' as u16 <= unit && unit <= b'Z' as u16)
        || (b'a' as u16 <= unit && unit <= b'z' as u16)
        || unit == b'_' as u16
}

fn is_whitespace_unit(unit: u16) -> bool {
    char::from_u32(unit as u32)
        .map(char::is_whitespace)
        .unwrap_or(false)
}

fn classify_word_unit(unit: u16) -> WordTokenKind {
    if is_whitespace_unit(unit) {
        WordTokenKind::Whitespace
    } else if is_word_unit(unit) {
        WordTokenKind::Word
    } else {
        WordTokenKind::Other
    }
}

fn tokenize_word_diff_text(units: &[u16], absolute_offset: u32) -> Vec<WordDiffToken> {
    if units.is_empty() {
        return Vec::new();
    }

    let mut tokens = Vec::new();
    let mut start = 0usize;
    while start < units.len() {
        let kind = classify_word_unit(units[start]);
        let mut end = start + 1;
        while end < units.len() && classify_word_unit(units[end]) == kind {
            end += 1;
        }
        tokens.push(WordDiffToken {
            units: units[start..end].to_vec(),
            from: absolute_offset + start as u32,
            to: absolute_offset + end as u32,
        });
        start = end;
    }
    tokens
}

fn build_token_diff_edits(
    old_tokens: &[WordDiffToken],
    new_tokens: &[WordDiffToken],
) -> Vec<TokenEdit> {
    let rows = old_tokens.len() + 1;
    let cols = new_tokens.len() + 1;
    let mut table = vec![vec![0usize; cols]; rows];

    for row in 1..rows {
        for col in 1..cols {
            table[row][col] = if old_tokens[row - 1].units == new_tokens[col - 1].units {
                table[row - 1][col - 1] + 1
            } else {
                table[row - 1][col].max(table[row][col - 1])
            };
        }
    }

    let mut edits = Vec::new();
    let mut old_index = old_tokens.len();
    let mut new_index = new_tokens.len();
    let mut current_edit: Option<TokenEdit> = None;

    while old_index > 0 || new_index > 0 {
        if old_index > 0
            && new_index > 0
            && old_tokens[old_index - 1].units == new_tokens[new_index - 1].units
        {
            if let Some(edit) = current_edit.take() {
                edits.push(edit);
            }
            old_index -= 1;
            new_index -= 1;
        } else if new_index > 0
            && (old_index == 0
                || table[old_index][new_index - 1] >= table[old_index - 1][new_index])
        {
            if let Some(edit) = &mut current_edit {
                edit.new_start = new_index - 1;
            } else {
                current_edit = Some(TokenEdit {
                    old_start: old_index,
                    old_end: old_index,
                    new_start: new_index - 1,
                    new_end: new_index,
                });
            }
            new_index -= 1;
        } else {
            if let Some(edit) = &mut current_edit {
                edit.old_start = old_index - 1;
            } else {
                current_edit = Some(TokenEdit {
                    old_start: old_index - 1,
                    old_end: old_index,
                    new_start: new_index,
                    new_end: new_index,
                });
            }
            old_index -= 1;
        }
    }

    if let Some(edit) = current_edit {
        edits.push(edit);
    }
    edits.reverse();
    edits
}

fn token_boundary_offset(
    tokens: &[WordDiffToken],
    token_index: usize,
    line_start: u32,
    line_end: u32,
) -> u32 {
    if token_index == 0 {
        return line_start;
    }
    if token_index >= tokens.len() {
        return line_end;
    }
    tokens[token_index].from
}

fn trim_whitespace_range(units: &[u16], from: u32, to: u32) -> Utf16Range {
    let mut start = from as usize;
    let mut end = to as usize;
    while start < end && is_whitespace_unit(units[start]) {
        start += 1;
    }
    while end > start && is_whitespace_unit(units[end - 1]) {
        end -= 1;
    }
    Utf16Range {
        from: start as u32,
        to: end as u32,
    }
}

fn merge_word_diff_ranges(
    ranges: &[crate::action_log::WordDiffRange],
) -> Vec<crate::action_log::WordDiffRange> {
    if ranges.len() <= 1 {
        return ranges.to_vec();
    }

    let mut sorted = ranges.to_vec();
    sorted.sort_by_key(|range| range.from);

    let mut merged = vec![sorted[0].clone()];
    for range in sorted.into_iter().skip(1) {
        let previous = merged.last_mut().expect("merged contains first range");
        if range.from <= previous.to && range.base_from <= previous.base_to {
            previous.to = previous.to.max(range.to);
            previous.base_to = previous.base_to.max(range.base_to);
        } else {
            merged.push(range);
        }
    }
    merged
}

fn build_line_start_offsets_utf16(units: &[u16]) -> Vec<u32> {
    let mut offsets = vec![0];
    for (index, unit) in units.iter().enumerate() {
        if *unit == b'\n' as u16 {
            offsets.push((index + 1).try_into().unwrap_or(u32::MAX));
        }
    }
    offsets
}

fn line_index_to_offset(line_starts: &[u32], text_len: u32, line: u32) -> u32 {
    if line == 0 {
        return 0;
    }
    line_starts.get(line as usize).copied().unwrap_or(text_len)
}

fn line_content_range(line_starts: &[u32], text_len: u32, line_index: u32) -> Utf16Range {
    let from = line_index_to_offset(line_starts, text_len, line_index);
    if line_index + 1 >= line_starts.len() as u32 {
        return Utf16Range { from, to: text_len };
    }
    Utf16Range {
        from,
        to: line_starts[(line_index + 1) as usize].saturating_sub(1),
    }
}

fn compute_word_diffs_for_line(
    base_units: &[u16],
    current_units: &[u16],
    base_range: Utf16Range,
    current_range: Utf16Range,
) -> Option<HunkWordDiffs> {
    let base_line = &base_units[base_range.from as usize..base_range.to as usize];
    let current_line = &current_units[current_range.from as usize..current_range.to as usize];
    if base_line == current_line {
        return None;
    }

    let old_tokens = tokenize_word_diff_text(base_line, base_range.from);
    let new_tokens = tokenize_word_diff_text(current_line, current_range.from);
    let token_edits = build_token_diff_edits(&old_tokens, &new_tokens);
    if token_edits.is_empty() {
        return None;
    }

    let mut buffer_ranges = Vec::new();
    let mut base_ranges = Vec::new();
    for edit in token_edits {
        let base_from =
            token_boundary_offset(&old_tokens, edit.old_start, base_range.from, base_range.to);
        let base_to =
            token_boundary_offset(&old_tokens, edit.old_end, base_range.from, base_range.to);
        let current_from = token_boundary_offset(
            &new_tokens,
            edit.new_start,
            current_range.from,
            current_range.to,
        );
        let current_to = token_boundary_offset(
            &new_tokens,
            edit.new_end,
            current_range.from,
            current_range.to,
        );

        let trimmed_base = trim_whitespace_range(base_units, base_from, base_to);
        let trimmed_current = trim_whitespace_range(current_units, current_from, current_to);
        if trimmed_current.from < trimmed_current.to {
            buffer_ranges.push(crate::action_log::WordDiffRange {
                from: trimmed_current.from,
                to: trimmed_current.to,
                base_from: trimmed_base.from,
                base_to: trimmed_base.to,
            });
        }
        if trimmed_base.from < trimmed_base.to {
            base_ranges.push(crate::action_log::WordDiffRange {
                from: trimmed_base.from,
                to: trimmed_base.to,
                base_from: trimmed_base.from,
                base_to: trimmed_base.to,
            });
        }
    }

    if buffer_ranges.is_empty() && base_ranges.is_empty() {
        return None;
    }
    Some(HunkWordDiffs {
        buffer_ranges: merge_word_diff_ranges(&buffer_ranges),
        base_ranges: merge_word_diff_ranges(&base_ranges),
    })
}

fn compute_word_diffs_for_hunk_inner(
    base_text: &str,
    current_text: &str,
    edit: &LineEdit,
    max_lines: u32,
    max_chars: u32,
) -> Option<HunkWordDiffs> {
    let old_line_count = edit.old_end.saturating_sub(edit.old_start);
    let new_line_count = edit.new_end.saturating_sub(edit.new_start);
    if old_line_count == 0 || new_line_count == 0 {
        return None;
    }
    if old_line_count != new_line_count || old_line_count > max_lines {
        return None;
    }

    let base_text = normalize_review_text(base_text);
    let current_text = normalize_review_text(current_text);
    let base_units: Vec<u16> = base_text.encode_utf16().collect();
    let current_units: Vec<u16> = current_text.encode_utf16().collect();
    let base_line_starts = build_line_start_offsets_utf16(&base_units);
    let current_line_starts = build_line_start_offsets_utf16(&current_units);

    let base_window_start =
        line_index_to_offset(&base_line_starts, base_units.len() as u32, edit.old_start);
    let base_window_end =
        line_index_to_offset(&base_line_starts, base_units.len() as u32, edit.old_end);
    let current_window_start = line_index_to_offset(
        &current_line_starts,
        current_units.len() as u32,
        edit.new_start,
    );
    let current_window_end = line_index_to_offset(
        &current_line_starts,
        current_units.len() as u32,
        edit.new_end,
    );
    if (base_window_end - base_window_start).max(current_window_end - current_window_start)
        > max_chars
    {
        return None;
    }

    let mut buffer_ranges = Vec::new();
    let mut base_ranges = Vec::new();
    for line_offset in 0..old_line_count {
        let base_range = line_content_range(
            &base_line_starts,
            base_units.len() as u32,
            edit.old_start + line_offset,
        );
        let current_range = line_content_range(
            &current_line_starts,
            current_units.len() as u32,
            edit.new_start + line_offset,
        );
        if let Some(line_diff) =
            compute_word_diffs_for_line(&base_units, &current_units, base_range, current_range)
        {
            buffer_ranges.extend(line_diff.buffer_ranges);
            base_ranges.extend(line_diff.base_ranges);
        }
    }

    if buffer_ranges.is_empty() && base_ranges.is_empty() {
        return None;
    }
    Some(HunkWordDiffs {
        buffer_ranges: merge_word_diff_ranges(&buffer_ranges),
        base_ranges: merge_word_diff_ranges(&base_ranges),
    })
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

    #[test]
    fn computes_word_diff_ranges_for_single_line_hunk() {
        let edit = LineEdit {
            old_start: 0,
            old_end: 1,
            new_start: 0,
            new_end: 1,
        };

        let ranges = compute_word_diffs_for_hunk(
            "let name = old_value;\n",
            "let name = new_value;\n",
            &edit,
            4,
            200,
        );

        assert_eq!(ranges.base_ranges.len(), 1);
        assert_eq!(ranges.buffer_ranges.len(), 1);
        assert_eq!(ranges.base_ranges[0].from, 11);
        assert_eq!(ranges.buffer_ranges[0].from, 11);
    }
}
