use serde::{Deserialize, Serialize};

use crate::hunks::{compute_line_diff, normalize_review_text};
use crate::review::{ReviewTrackedFile, tracked_current_text, tracked_diff_base};

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

fn empty_text_range_patch() -> TextRangePatch {
    TextRangePatch { spans: Vec::new() }
}

fn merge_overlapping_line_edits(edits: Vec<LineEdit>) -> Vec<LineEdit> {
    if edits.len() <= 1 {
        return edits;
    }

    let mut sorted = edits;
    sorted.sort_by(|left, right| {
        left.new_start
            .cmp(&right.new_start)
            .then(left.new_end.cmp(&right.new_end))
            .then(left.old_start.cmp(&right.old_start))
            .then(left.old_end.cmp(&right.old_end))
    });

    let mut merged = vec![sorted[0].clone()];
    for edit in sorted.into_iter().skip(1) {
        let previous = merged.last_mut().expect("merged contains first edit");
        let overlaps_old = ranges_overlap(
            previous.old_start,
            previous.old_end,
            edit.old_start,
            edit.old_end,
        );
        let overlaps_new = ranges_overlap(
            previous.new_start,
            previous.new_end,
            edit.new_start,
            edit.new_end,
        );

        if overlaps_old || overlaps_new {
            previous.old_start = previous.old_start.min(edit.old_start);
            previous.old_end = previous.old_end.max(edit.old_end);
            previous.new_start = previous.new_start.min(edit.new_start);
            previous.new_end = previous.new_end.max(edit.new_end);
        } else {
            merged.push(edit);
        }
    }
    merged
}

pub fn build_text_range_patch_from_texts(
    old_text: &str,
    new_text: &str,
    line_patch: Option<&LinePatch>,
) -> TextRangePatch {
    if normalize_review_text(old_text) == normalize_review_text(new_text) {
        return empty_text_range_patch();
    }

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
            let old_range = span_part_to_line_range(
                base_text,
                &base_line_starts,
                span.base_from,
                span.base_to,
                current_text,
                span.current_from,
                span.current_to,
            );
            let new_range = span_part_to_line_range(
                current_text,
                &current_line_starts,
                span.current_from,
                span.current_to,
                base_text,
                span.base_from,
                span.base_to,
            );
            LineEdit {
                old_start: old_range.start,
                old_end: old_range.end,
                new_start: new_range.start,
                new_end: new_range.end,
            }
        })
        .collect();
    LinePatch {
        edits: merge_overlapping_line_edits(edits),
    }
}

pub fn sync_derived_line_patch(file: &ReviewTrackedFile) -> ReviewTrackedFile {
    let mut next = file.clone();
    let base = tracked_diff_base(file);
    let current = tracked_current_text(file);
    let spans = file
        .spans
        .clone()
        .unwrap_or_else(|| build_text_range_patch_from_texts(&base, &current, None));
    next.hunks = crate::hunks::compute_diff_hunks(&base, &current, &file.path);
    next.diff_base = Some(base);
    next.current_text = Some(current);
    next.spans = Some(spans);
    next
}

pub fn keep_exact_spans(
    file: &ReviewTrackedFile,
    selected_spans: &[AgentTextSpan],
) -> Option<ReviewTrackedFile> {
    let synced = sync_derived_line_patch(file);
    let base = tracked_diff_base(&synced);
    let current = tracked_current_text(&synced);
    let current_spans = synced
        .spans
        .clone()
        .unwrap_or_else(empty_text_range_patch)
        .spans;
    let (_, remaining_spans) = partition_spans_by_exact(&current_spans, selected_spans);
    let next_base = rebuild_diff_base_from_pending_spans(&base, &current, &remaining_spans);
    let next_spans = if remaining_spans.is_empty() {
        empty_text_range_patch()
    } else {
        build_text_range_patch_from_texts(&next_base, &current, None)
    };
    refresh_review_file(&synced, next_base, current, Some(next_spans))
}

pub fn reject_exact_spans(
    file: &ReviewTrackedFile,
    selected_spans: &[AgentTextSpan],
) -> Option<ReviewTrackedFile> {
    let synced = sync_derived_line_patch(file);
    let base = tracked_diff_base(&synced);
    let current = tracked_current_text(&synced);
    let current_spans = synced
        .spans
        .clone()
        .unwrap_or_else(empty_text_range_patch)
        .spans;
    let (rejected_spans, remaining_spans) =
        partition_spans_by_exact(&current_spans, selected_spans);
    let next_current = rebuild_diff_base_from_pending_spans(&base, &current, &rejected_spans);
    let next_spans = if remaining_spans.is_empty() {
        empty_text_range_patch()
    } else {
        build_text_range_patch_from_texts(&base, &next_current, None)
    };
    refresh_review_file(&synced, base, next_current, Some(next_spans))
}

pub fn reject_all_edits(file: &ReviewTrackedFile) -> Option<ReviewTrackedFile> {
    let synced = sync_derived_line_patch(file);
    let base = tracked_diff_base(&synced);
    refresh_review_file(&synced, base.clone(), base, Some(empty_text_range_patch()))
}

pub fn apply_non_conflicting_edits(
    file: &ReviewTrackedFile,
    user_edits: &[TextEdit],
    new_full_text: &str,
) -> Result<ReviewTrackedFile, String> {
    let synced = sync_derived_line_patch(file);
    let spans = synced
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

    let base = tracked_diff_base(&synced);
    let surviving_spans = spans
        .iter()
        .map(|span| map_agent_span_through_text_edits(span, user_edits))
        .collect::<Result<Vec<_>, _>>()?;
    let next_base = if surviving_spans.is_empty() {
        new_full_text.to_string()
    } else {
        rebuild_diff_base_from_pending_spans(&base, new_full_text, &surviving_spans)
    };
    let next_spans = if surviving_spans.is_empty() {
        empty_text_range_patch()
    } else {
        build_text_range_patch_from_texts(&next_base, new_full_text, None)
    };

    Ok(refresh_review_file(
        &synced,
        next_base,
        new_full_text.to_string(),
        Some(next_spans),
    )
    .unwrap_or_else(|| {
        let mut next = synced.clone();
        next.diff_base = Some(new_full_text.to_string());
        next.current_text = Some(new_full_text.to_string());
        next.new_text = Some(new_full_text.to_string());
        next.hunks.clear();
        next.spans = Some(empty_text_range_patch());
        next.version = Some(next.version.unwrap_or(1).saturating_add(1));
        next
    }))
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
        current_from: map_text_position_through_edits(span.current_from, edits, 1),
        current_to: map_text_position_through_edits(span.current_to, edits, -1),
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

    let original_units = utf16_units(original_diff_base);
    let current_units = utf16_units(current_text);
    let mut sorted_spans = spans.to_vec();
    sorted_spans.sort_by_key(|span| span.current_from);

    let mut parts = Vec::new();
    let mut cursor = 0u32;
    for span in sorted_spans {
        let cur_from = (cursor as usize).min(current_units.len());
        let cur_to = (span.current_from as usize).min(current_units.len());
        if cur_from < cur_to {
            parts.extend_from_slice(&current_units[cur_from..cur_to]);
        }

        let base_from = (span.base_from as usize).min(original_units.len());
        let base_to = (span.base_to as usize).min(original_units.len());
        if base_from < base_to {
            parts.extend_from_slice(&original_units[base_from..base_to]);
        }
        cursor = span.current_to;
    }

    let tail_start = (cursor as usize).min(current_units.len());
    parts.extend_from_slice(&current_units[tail_start..]);
    String::from_utf16_lossy(&parts)
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
        let line_range = span_part_to_line_range(
            base_text,
            &base_line_starts,
            span.base_from,
            span.base_to,
            _current_text,
            span.current_from,
            span.current_to,
        );
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

fn partition_spans_by_exact(
    spans: &[AgentTextSpan],
    selected_spans: &[AgentTextSpan],
) -> (Vec<AgentTextSpan>, Vec<AgentTextSpan>) {
    if spans.is_empty() {
        return (Vec::new(), Vec::new());
    }
    if selected_spans.is_empty() {
        return (Vec::new(), spans.to_vec());
    }

    let mut selected = Vec::new();
    let mut remaining = Vec::new();
    for span in spans.iter().cloned() {
        if selected_spans.contains(&span) {
            selected.push(span);
        } else {
            remaining.push(span);
        }
    }
    (selected, remaining)
}

fn refresh_review_file(
    file: &ReviewTrackedFile,
    diff_base: String,
    current_text: String,
    spans: Option<TextRangePatch>,
) -> Option<ReviewTrackedFile> {
    if normalize_review_text(&diff_base) == normalize_review_text(&current_text)
        && file.previous_path.is_none()
    {
        return None;
    }

    let old_text = finalize_text_side(file.old_text.as_ref(), &diff_base);
    let new_text = finalize_text_side(file.new_text.as_ref(), &current_text);
    let mut next = file.clone();
    next.diff_base = Some(diff_base);
    next.current_text = Some(current_text);
    next.old_text = old_text.clone();
    next.new_text = new_text.clone();
    next.kind = crate::review::infer_kind(
        next.previous_path.as_deref(),
        old_text.as_deref(),
        new_text.as_deref(),
    );
    next.hunks = crate::hunks::compute_diff_hunks(
        next.diff_base.as_deref().unwrap_or_default(),
        next.current_text.as_deref().unwrap_or_default(),
        &next.path,
    );
    next.hunks_are_anchored = None;
    next.spans = spans.or_else(|| {
        Some(build_text_range_patch_from_texts(
            next.diff_base.as_deref().unwrap_or_default(),
            next.current_text.as_deref().unwrap_or_default(),
            None,
        ))
    });
    next.version = Some(next.version.unwrap_or(1).saturating_add(1));
    Some(next)
}

fn finalize_text_side(original_value: Option<&String>, next_value: &str) -> Option<String> {
    if original_value.is_none() && next_value.is_empty() {
        None
    } else {
        Some(next_value.to_string())
    }
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

fn insertion_line_index_at_offset(line_starts: &[u32], offset: u32) -> u32 {
    let mut low = 0usize;
    let mut high = line_starts.len();
    while low < high {
        let mid = (low + high) / 2;
        if line_starts[mid] < offset {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    low as u32
}

fn contains_newline(text: &str, from: u32, to: u32) -> bool {
    let units = utf16_units(text);
    let start = (from as usize).min(units.len());
    let end = (to as usize).min(units.len());
    if start >= end {
        return false;
    }
    units[start..end].contains(&(b'\n' as u16))
}

fn is_line_boundary(text: &str, offset: u32) -> bool {
    let units = utf16_units(text);
    if offset == 0 || offset >= units.len() as u32 {
        return true;
    }
    units[offset as usize - 1] == b'\n' as u16
}

fn is_single_line_text_range(line_starts: &[u32], from: u32, to: u32) -> bool {
    if from >= to {
        return true;
    }
    line_index_at_offset(line_starts, from) == line_index_at_offset(line_starts, to - 1)
}

fn span_part_to_line_range(
    text: &str,
    line_starts: &[u32],
    from: u32,
    to: u32,
    counterpart_text: &str,
    counterpart_from: u32,
    counterpart_to: u32,
) -> LineRange {
    if from == to && counterpart_from == counterpart_to {
        let line = insertion_line_index_at_offset(line_starts, from);
        return LineRange {
            start: line,
            end: line,
        };
    }

    if from == to {
        let inline_single_line_insert =
            !contains_newline(counterpart_text, counterpart_from, counterpart_to)
                && !is_line_boundary(text, from)
                && !is_line_boundary(counterpart_text, counterpart_from);

        if inline_single_line_insert {
            let line = line_index_at_offset(line_starts, from.saturating_sub(1));
            return LineRange {
                start: line,
                end: line + 1,
            };
        }

        let point = insertion_line_index_at_offset(line_starts, from);
        return LineRange {
            start: point,
            end: point,
        };
    }

    let inline_single_line_change = !contains_newline(text, from, to)
        && !contains_newline(counterpart_text, counterpart_from, counterpart_to)
        && is_single_line_text_range(line_starts, from, to);

    if inline_single_line_change {
        let line = line_index_at_offset(line_starts, from);
        return LineRange {
            start: line,
            end: line + 1,
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
    use crate::review::compute_tracked_file_patch;

    fn tracked_file(diff_base: &str, current_text: &str) -> ReviewTrackedFile {
        compute_tracked_file_patch(
            "s1",
            "test.rs",
            None,
            Some(diff_base.to_string()),
            Some(current_text.to_string()),
            "2026-06-21T00:00:00Z".to_string(),
        )
        .expect("tracked file")
    }

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

    #[test]
    fn rebuilds_diff_base_from_pending_spans() {
        let rebuilt = rebuild_diff_base_from_pending_spans(
            "foo bar baz",
            "FOO bar BAZ",
            &[AgentTextSpan {
                base_from: 8,
                base_to: 11,
                current_from: 8,
                current_to: 11,
            }],
        );

        assert_eq!(rebuilt, "FOO bar baz");
    }

    #[test]
    fn keep_exact_spans_does_not_absorb_neighbor_on_same_line() {
        let mut file = tracked_file("foo bar baz", "FOO bar BAZ");
        file.spans = Some(TextRangePatch {
            spans: vec![
                AgentTextSpan {
                    base_from: 0,
                    base_to: 3,
                    current_from: 0,
                    current_to: 3,
                },
                AgentTextSpan {
                    base_from: 8,
                    base_to: 11,
                    current_from: 8,
                    current_to: 11,
                },
            ],
        });

        let kept = keep_exact_spans(
            &file,
            &[AgentTextSpan {
                base_from: 0,
                base_to: 3,
                current_from: 0,
                current_to: 3,
            }],
        )
        .expect("remaining review");

        assert_eq!(kept.diff_base.as_deref(), Some("FOO bar baz"));
        assert_eq!(kept.current_text.as_deref(), Some("FOO bar BAZ"));
        assert_eq!(
            kept.spans,
            Some(TextRangePatch {
                spans: vec![AgentTextSpan {
                    base_from: 8,
                    base_to: 11,
                    current_from: 8,
                    current_to: 11,
                }],
            })
        );
    }

    #[test]
    fn reject_exact_spans_does_not_revert_neighbor_on_same_line() {
        let mut file = tracked_file("foo bar baz", "FOO bar BAZ");
        file.spans = Some(TextRangePatch {
            spans: vec![
                AgentTextSpan {
                    base_from: 0,
                    base_to: 3,
                    current_from: 0,
                    current_to: 3,
                },
                AgentTextSpan {
                    base_from: 8,
                    base_to: 11,
                    current_from: 8,
                    current_to: 11,
                },
            ],
        });

        let rejected = reject_exact_spans(
            &file,
            &[AgentTextSpan {
                base_from: 0,
                base_to: 3,
                current_from: 0,
                current_to: 3,
            }],
        )
        .expect("remaining review");

        assert_eq!(rejected.diff_base.as_deref(), Some("foo bar baz"));
        assert_eq!(rejected.current_text.as_deref(), Some("foo bar BAZ"));
        assert_eq!(
            rejected.spans,
            Some(TextRangePatch {
                spans: vec![AgentTextSpan {
                    base_from: 8,
                    base_to: 11,
                    current_from: 8,
                    current_to: 11,
                }],
            })
        );
    }

    #[test]
    fn reject_all_edits_clears_completed_review() {
        let file = tracked_file("one\ntwo\n", "one\nTWO\n");

        assert!(reject_all_edits(&file).is_none());
    }
}
