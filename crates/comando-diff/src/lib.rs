pub mod action_log;
pub mod hunks;
pub mod review;

#[cfg(target_arch = "wasm32")]
pub mod wasm_bindings;

pub use action_log::{
    AgentTextSpan, HunkWordDiffs, LineEdit, LinePatch, LineRange, TextEdit, TextRangePatch,
    TrackedFilePatches, WordDiffRange, apply_non_conflicting_edits,
    build_text_range_patch_from_texts, compute_text_range_patch,
    derive_line_patch_from_text_ranges, keep_exact_spans, map_agent_span_through_text_edits,
    map_text_position_through_edits, partition_spans_by_overlap,
    rebuild_diff_base_from_pending_spans, reject_all_edits, reject_exact_spans,
    sync_derived_line_patch,
};
pub use hunks::{
    AiDiffHunk, AiDiffHunkLine, AiDiffLineType, compute_diff_hunks, compute_line_diff,
    compute_word_diffs_for_hunk, normalize_review_text,
};
pub use review::{
    ReviewDecision, ReviewTrackedFile, ReviewTrackedFileKind, ReviewTrackedFileStatus,
    compute_tracked_file_patch, resolve_tracked_file_hunks, sync_tracked_file,
    tracked_current_text,
};
