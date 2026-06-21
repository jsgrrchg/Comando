use serde::{Deserialize, Serialize};

use crate::hunks::{compute_line_diff, normalize_review_text};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEdit {
    pub old_start: u32,
    pub old_end: u32,
    pub new_start: u32,
    pub new_end: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinePatch {
    pub edits: Vec<LineEdit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub old_from: u32,
    pub old_to: u32,
    pub new_from: u32,
    pub new_to: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTextSpan {
    pub base_from: u32,
    pub base_to: u32,
    pub current_from: u32,
    pub current_to: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextRangePatch {
    pub spans: Vec<AgentTextSpan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackedFilePatches {
    pub line_patch: LinePatch,
    pub text_range_patch: TextRangePatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordDiffRange {
    pub from: u32,
    pub to: u32,
    pub base_from: u32,
    pub base_to: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HunkWordDiffs {
    pub buffer_ranges: Vec<WordDiffRange>,
    pub base_ranges: Vec<WordDiffRange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

pub fn build_text_range_patch_from_texts(
    old_text: &str,
    new_text: &str,
    line_patch: Option<&LinePatch>,
) -> TextRangePatch {
    let owned_patch;
    let patch = match line_patch {
        Some(patch) => patch,
        None => {
            owned_patch = compute_line_diff(old_text, new_text);
            &owned_patch
        }
    };
    compute_text_range_patch(old_text, new_text, patch)
}

pub fn compute_text_range_patch(
    old_text: &str,
    new_text: &str,
    line_patch: &LinePatch,
) -> TextRangePatch {
    if line_patch.edits.is_empty() {
        return TextRangePatch::default();
    }

    let old_text = normalize_review_text(old_text);
    let new_text = normalize_review_text(new_text);
    let old_units = utf16_units(&old_text);
    let new_units = utf16_units(&new_text);
    let old_line_starts = build_line_start_offsets_from_units(&old_units);
    let new_line_starts = build_line_start_offsets_from_units(&new_units);

    let spans = line_patch
        .edits
        .iter()
        .filter_map(|edit| {
            let base_window_start =
                line_index_to_offset(&old_line_starts, old_units.len() as u32, edit.old_start)
                    as usize;
            let base_window_end =
                line_index_to_offset(&old_line_starts, old_units.len() as u32, edit.old_end)
                    as usize;
            let current_window_start =
                line_index_to_offset(&new_line_starts, new_units.len() as u32, edit.new_start)
                    as usize;
            let current_window_end =
                line_index_to_offset(&new_line_starts, new_units.len() as u32, edit.new_end)
                    as usize;

            let base_window = &old_units[base_window_start..base_window_end];
            let current_window = &new_units[current_window_start..current_window_end];
            if base_window == current_window {
                return None;
            }

            let prefix_length = common_prefix_length_utf16(base_window, current_window);
            let suffix_length =
                common_suffix_length_utf16(base_window, current_window, prefix_length);

            Some(AgentTextSpan {
                base_from: base_window_start as u32 + prefix_length,
                base_to: base_window_end as u32 - suffix_length,
                current_from: current_window_start as u32 + prefix_length,
                current_to: current_window_end as u32 - suffix_length,
            })
        })
        .collect();

    TextRangePatch { spans }
}

pub fn derive_line_patch_from_text_ranges(
    base_text: &str,
    current_text: &str,
    spans: &[AgentTextSpan],
) -> LinePatch {
    let base_line_starts = build_line_start_offsets(base_text);
    let current_line_starts = build_line_start_offsets(current_text);
    let edits = spans
        .iter()
        .map(|span| {
            let old_range =
                span_part_to_line_range(&base_line_starts, span.base_from, span.base_to);
            let new_range =
                span_part_to_line_range(&current_line_starts, span.current_from, span.current_to);
            LineEdit {
                old_start: old_range.start,
                old_end: old_range.end,
                new_start: new_range.start,
                new_end: new_range.end,
            }
        })
        .collect();
    LinePatch { edits }
}

pub fn sync_derived_line_patch(
    file: &crate::review::ReviewTrackedFile,
) -> crate::review::ReviewTrackedFile {
    let mut next = file.clone();
    let base = file
        .diff_base
        .as_deref()
        .unwrap_or(file.old_text.as_deref().unwrap_or(""));
    let current = file
        .current_text
        .as_deref()
        .unwrap_or(file.new_text.as_deref().unwrap_or(""));
    next.hunks = crate::hunks::compute_diff_hunks(base, current, &file.path);
    next
}

pub fn keep_exact_spans(
    file: &crate::review::ReviewTrackedFile,
    _spans: &[AgentTextSpan],
) -> Option<crate::review::ReviewTrackedFile> {
    Some(sync_derived_line_patch(file))
}

pub fn reject_exact_spans(
    file: &crate::review::ReviewTrackedFile,
    _spans: &[AgentTextSpan],
) -> Option<crate::review::ReviewTrackedFile> {
    Some(sync_derived_line_patch(file))
}

pub fn reject_all_edits(
    file: &crate::review::ReviewTrackedFile,
) -> Option<crate::review::ReviewTrackedFile> {
    let mut next = file.clone();
    let base = file
        .diff_base
        .as_deref()
        .unwrap_or(file.old_text.as_deref().unwrap_or(""));
    next.current_text = Some(base.to_string());
    next.new_text = if file.old_text.is_none() && base.is_empty() {
        None
    } else {
        Some(base.to_string())
    };
    next.hunks.clear();
    None
}

pub fn apply_non_conflicting_edits(
    file: &crate::review::ReviewTrackedFile,
    user_edits: &[TextEdit],
    new_full_text: &str,
) -> Result<crate::review::ReviewTrackedFile, String> {
    let spans = file
        .spans
        .as_ref()
        .map(|patch| patch.spans.as_slice())
        .unwrap_or(&[]);
    if spans.iter().any(|span| {
        user_edits.iter().any(|edit| {
            ranges_overlap(
                span.current_from,
                span.current_to,
                edit.old_from,
                edit.old_to,
            )
        })
    }) {
        return Err("unsafe_rebase".to_string());
    }

    let mut next = file.clone();
    next.current_text = Some(new_full_text.to_string());
    next.hunks = crate::hunks::compute_diff_hunks(
        next.diff_base.as_deref().unwrap_or_default(),
        new_full_text,
        &next.path,
    );
    Ok(next)
}

pub fn map_text_position_through_edits(position: u32, edits: &[TextEdit], assoc: i32) -> u32 {
    let mut mapped = position as i64;
    for edit in edits {
        if position < edit.old_from {
            continue;
        }
        if position > edit.old_to || (position == edit.old_to && assoc >= 0) {
            mapped += (edit.new_to as i64 - edit.new_from as i64)
                - (edit.old_to as i64 - edit.old_from as i64);
            continue;
        }
        mapped = if assoc < 0 {
            edit.new_from as i64
        } else {
            edit.new_to as i64
        };
    }
    mapped.max(0).try_into().unwrap_or(u32::MAX)
}

pub fn map_agent_span_through_text_edits(
    span: &AgentTextSpan,
    edits: &[TextEdit],
) -> Result<AgentTextSpan, String> {
    if edits.iter().any(|edit| {
        ranges_overlap(
            span.current_from,
            span.current_to,
            edit.old_from,
            edit.old_to,
        )
    }) {
        return Err("unsafe_rebase".to_string());
    }
    Ok(AgentTextSpan {
        base_from: span.base_from,
        base_to: span.base_to,
        current_from: map_text_position_through_edits(span.current_from, edits, -1),
        current_to: map_text_position_through_edits(span.current_to, edits, 1),
    })
}

pub fn rebuild_diff_base_from_pending_spans(
    original_diff_base: &str,
    current_text: &str,
    spans: &[AgentTextSpan],
) -> String {
    if spans.is_empty() {
        return current_text.to_string();
    }
    original_diff_base.to_string()
}

pub fn partition_spans_by_overlap(
    spans: &[AgentTextSpan],
    ranges: &[LineRange],
    base_text: &str,
    _current_text: &str,
) -> (Vec<AgentTextSpan>, Vec<AgentTextSpan>) {
    let base_line_starts = build_line_start_offsets(base_text);
    let mut overlapping = Vec::new();
    let mut non_overlapping = Vec::new();
    for span in spans {
        let line_range = span_part_to_line_range(&base_line_starts, span.base_from, span.base_to);
        if ranges
            .iter()
            .any(|range| ranges_overlap(line_range.start, line_range.end, range.start, range.end))
        {
            overlapping.push(span.clone());
        } else {
            non_overlapping.push(span.clone());
        }
    }
    (overlapping, non_overlapping)
}

fn ranges_overlap(a_start: u32, a_end: u32, b_start: u32, b_end: u32) -> bool {
    if a_start == a_end && b_start == b_end {
        return a_start == b_start;
    }
    a_start < b_end && b_start < a_end
}

fn utf16_units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn build_line_start_offsets(text: &str) -> Vec<u32> {
    build_line_start_offsets_from_units(&utf16_units(text))
}

fn build_line_start_offsets_from_units(units: &[u16]) -> Vec<u32> {
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

fn line_index_at_offset(line_starts: &[u32], offset: u32) -> u32 {
    let mut best = 0;
    for (index, start) in line_starts.iter().enumerate() {
        if *start <= offset {
            best = index as u32;
        } else {
            break;
        }
    }
    best
}

fn span_part_to_line_range(line_starts: &[u32], from: u32, to: u32) -> LineRange {
    if from == to {
        let line = line_index_at_offset(line_starts, from);
        return LineRange {
            start: line,
            end: line,
        };
    }
    LineRange {
        start: line_index_at_offset(line_starts, from),
        end: line_index_at_offset(line_starts, to.saturating_sub(1)).saturating_add(1),
    }
}

fn common_prefix_length_utf16(left: &[u16], right: &[u16]) -> u32 {
    let limit = left.len().min(right.len());
    let mut index = 0;
    while index < limit && left[index] == right[index] {
        index += 1;
    }
    index.try_into().unwrap_or(u32::MAX)
}

fn common_suffix_length_utf16(left: &[u16], right: &[u16], prefix_length: u32) -> u32 {
    let max_suffix = left
        .len()
        .min(right.len())
        .saturating_sub(prefix_length as usize);
    let mut index = 0;
    while index < max_suffix && left[left.len() - 1 - index] == right[right.len() - 1 - index] {
        index += 1;
    }
    index.try_into().unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_utf16_span_for_emoji_edit() {
        let patch = compute_line_diff("a😀c\n", "a😀 changed\n");
        let spans = compute_text_range_patch("a😀c\n", "a😀 changed\n", &patch);
        assert_eq!(spans.spans.len(), 1);
        assert!(spans.spans[0].base_from >= 3);
    }

    #[test]
    fn maps_position_after_user_insert() {
        let edits = vec![TextEdit {
            old_from: 0,
            old_to: 0,
            new_from: 0,
            new_to: 3,
        }];
        assert_eq!(map_text_position_through_edits(10, &edits, 1), 13);
    }

    #[test]
    fn rejects_overlapping_rebase() {
        let span = AgentTextSpan {
            base_from: 4,
            base_to: 8,
            current_from: 4,
            current_to: 8,
        };
        let edits = vec![TextEdit {
            old_from: 6,
            old_to: 6,
            new_from: 6,
            new_to: 9,
        }];
        assert!(map_agent_span_through_text_edits(&span, &edits).is_err());
    }
}
