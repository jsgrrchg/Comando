use serde::{Deserialize, Serialize};

use crate::action_log::TextRangePatch;
use crate::hunks::{
    AiDiffHunk, AiDiffLineType, compute_diff_hunks, dominant_line_ending, normalize_review_text,
    split_review_lines,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewTrackedFileStatus {
    Pending,
    Kept,
    Rejected,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewTrackedFileKind {
    Create,
    Delete,
    Move,
    Update,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewDecision {
    Keep,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTrackedFile {
    pub identity_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_text: Option<String>,
    pub hunks: Vec<AiDiffHunk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hunks_are_anchored: Option<bool>,
    pub is_text: bool,
    pub kind: ReviewTrackedFileKind,
    pub new_text: Option<String>,
    pub old_text: Option<String>,
    pub path: String,
    pub previous_path: Option<String>,
    pub review_state: ReviewTrackedFileStatus,
    pub reversible: bool,
    pub session_id: String,
    pub tool_call_id: Option<String>,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spans: Option<TextRangePatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_disk_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_disk_modified_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_content_hash: Option<String>,
}

pub fn compute_tracked_file_patch(
    session_id: &str,
    path: &str,
    previous_path: Option<String>,
    old_text: Option<String>,
    new_text: Option<String>,
    updated_at: String,
) -> Option<ReviewTrackedFile> {
    if previous_path.is_none() && old_text == new_text {
        return None;
    }
    let kind = infer_kind(
        previous_path.as_deref(),
        old_text.as_deref(),
        new_text.as_deref(),
    );
    let reversible = old_text.is_some() || matches!(kind, ReviewTrackedFileKind::Create);
    let diff_base = old_text.clone().unwrap_or_default();
    let current_text = new_text.clone().unwrap_or_default();
    let hunks = compute_diff_hunks(&diff_base, &current_text, path);
    if hunks.is_empty() && previous_path.is_none() {
        return None;
    }

    Some(ReviewTrackedFile {
        identity_key: format!(
            "native:{session_id}:{}:{path}",
            previous_path.clone().unwrap_or_default()
        ),
        diff_base: Some(diff_base),
        current_text: Some(current_text),
        hunks,
        hunks_are_anchored: None,
        is_text: true,
        kind,
        new_text,
        old_text: old_text.clone(),
        path: path.to_string(),
        previous_path,
        review_state: ReviewTrackedFileStatus::Pending,
        reversible,
        session_id: session_id.to_string(),
        tool_call_id: None,
        updated_at,
        version: Some(1),
        spans: None,
        conflict: None,
        expected_disk_hash: None,
        expected_disk_modified_at_ms: None,
        current_content_hash: None,
    })
}

pub fn sync_tracked_file(file: &ReviewTrackedFile) -> ReviewTrackedFile {
    let mut next = file.clone();
    let diff_base = tracked_diff_base(file);
    let current_text = tracked_current_text(file);
    next.hunks = compute_diff_hunks(&diff_base, &current_text, &file.path);
    next.diff_base = Some(diff_base);
    next.current_text = Some(current_text);
    next
}

pub fn resolve_tracked_file_hunks(
    tracked_file: &ReviewTrackedFile,
    hunk_ids: &[String],
    decision: ReviewDecision,
    updated_at: String,
) -> Option<ReviewTrackedFile> {
    let synced = sync_tracked_file(tracked_file);
    if hunk_ids.is_empty() || !synced.is_text || synced.hunks.is_empty() {
        return Some(synced);
    }

    let selected_ids = hunk_ids.iter().collect::<std::collections::HashSet<_>>();
    let selected_hunks = synced
        .hunks
        .iter()
        .filter(|hunk| selected_ids.contains(&hunk.id))
        .cloned()
        .collect::<Vec<_>>();
    if selected_hunks.is_empty() {
        return Some(synced);
    }
    let remaining_hunks = synced
        .hunks
        .iter()
        .filter(|hunk| !selected_ids.contains(&hunk.id))
        .cloned()
        .collect::<Vec<_>>();

    let base_old_text = tracked_diff_base(&synced);
    let base_new_text = tracked_current_text(&synced);
    let next_diff_base = match decision {
        ReviewDecision::Keep => apply_hunks_to_base(&base_old_text, &selected_hunks),
        ReviewDecision::Reject => base_old_text.clone(),
    };
    let next_current_text = match decision {
        ReviewDecision::Keep => base_new_text,
        ReviewDecision::Reject => apply_hunks_to_base(&base_old_text, &remaining_hunks),
    };

    if normalize_review_text(&next_diff_base) == normalize_review_text(&next_current_text)
        && synced.previous_path.is_none()
    {
        return None;
    }

    let next_old_text = finalize_text_side(synced.old_text.as_ref(), &next_diff_base);
    let next_new_text = finalize_text_side(synced.new_text.as_ref(), &next_current_text);
    let mut next = synced;
    next.diff_base = Some(next_diff_base);
    next.current_text = Some(next_current_text);
    next.old_text = next_old_text.clone();
    next.new_text = next_new_text.clone();
    next.kind = infer_kind(
        next.previous_path.as_deref(),
        next_old_text.as_deref(),
        next_new_text.as_deref(),
    );
    next.hunks = compute_diff_hunks(
        next.diff_base.as_deref().unwrap_or_default(),
        next.current_text.as_deref().unwrap_or_default(),
        &next.path,
    );
    next.hunks_are_anchored = None;
    next.updated_at = updated_at;
    next.version = Some(next.version.unwrap_or(1).saturating_add(1));
    Some(next)
}

pub fn apply_hunks_to_base(base_text: &str, hunks: &[AiDiffHunk]) -> String {
    let base_lines = split_review_lines(base_text);
    let line_ending = dominant_line_ending(base_text);
    let mut output = Vec::new();
    let mut cursor = 0usize;
    let mut sorted = hunks.to_vec();
    sorted.sort_by_key(|hunk| hunk.old_start);

    for hunk in sorted {
        let start_index = hunk.old_start.saturating_sub(1) as usize;
        let start_index = start_index.max(cursor);
        output.extend(
            base_lines[cursor.min(base_lines.len())..start_index.min(base_lines.len())]
                .iter()
                .cloned(),
        );
        let mut local_cursor = start_index;
        for line in hunk.lines {
            match line.line_type {
                AiDiffLineType::Context => {
                    if local_cursor < base_lines.len() {
                        output.push(base_lines[local_cursor].clone());
                        local_cursor += 1;
                    }
                }
                AiDiffLineType::Remove => {
                    local_cursor += 1;
                }
                AiDiffLineType::Add => output.push(line.text),
            }
        }
        cursor = cursor.max(local_cursor);
    }

    output.extend(base_lines[cursor.min(base_lines.len())..].iter().cloned());
    output.join(line_ending)
}

pub fn tracked_diff_base(file: &ReviewTrackedFile) -> String {
    file.diff_base
        .clone()
        .unwrap_or_else(|| file.old_text.clone().unwrap_or_default())
}

pub fn tracked_current_text(file: &ReviewTrackedFile) -> String {
    file.current_text
        .clone()
        .unwrap_or_else(|| file.new_text.clone().unwrap_or_default())
}

pub fn infer_kind(
    previous_path: Option<&str>,
    old_text: Option<&str>,
    new_text: Option<&str>,
) -> ReviewTrackedFileKind {
    if previous_path.is_some() {
        return ReviewTrackedFileKind::Move;
    }
    if old_text.is_none() {
        return ReviewTrackedFileKind::Create;
    }
    if new_text.is_none() {
        return ReviewTrackedFileKind::Delete;
    }
    ReviewTrackedFileKind::Update
}

fn finalize_text_side(original_value: Option<&String>, next_value: &str) -> Option<String> {
    if original_value.is_none() && next_value.is_empty() {
        None
    } else {
        Some(next_value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracked() -> ReviewTrackedFile {
        compute_tracked_file_patch(
            "s1",
            "src/main.rs",
            None,
            Some("one\ntwo\n".to_string()),
            Some("one\nTWO\n".to_string()),
            "2026-06-21T00:00:00Z".to_string(),
        )
        .expect("tracked")
    }

    #[test]
    fn keep_selected_hunk_advances_diff_base() {
        let file = tracked();
        let next = resolve_tracked_file_hunks(
            &file,
            &[file.hunks[0].id.clone()],
            ReviewDecision::Keep,
            "2026-06-21T00:00:01Z".to_string(),
        );
        assert!(next.is_none());
    }

    #[test]
    fn reject_selected_hunk_restores_base_when_all_selected() {
        let file = tracked();
        let next = resolve_tracked_file_hunks(
            &file,
            &[file.hunks[0].id.clone()],
            ReviewDecision::Reject,
            "2026-06-21T00:00:01Z".to_string(),
        );
        assert!(next.is_none());
    }

    #[test]
    fn reject_one_of_two_hunks_leaves_remaining_diff() {
        let file = compute_tracked_file_patch(
            "s1",
            "src/main.rs",
            None,
            Some("a\nb\nc\nd\n".to_string()),
            Some("A\nb\nc\nD\n".to_string()),
            "2026-06-21T00:00:00Z".to_string(),
        )
        .expect("tracked");
        assert_eq!(file.hunks.len(), 2);
        let next = resolve_tracked_file_hunks(
            &file,
            &[file.hunks[0].id.clone()],
            ReviewDecision::Reject,
            "2026-06-21T00:00:01Z".to_string(),
        )
        .expect("remaining diff");
        assert_eq!(next.current_text.as_deref(), Some("a\nb\nc\nD\n"));
    }
}
