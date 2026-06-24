use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use comando_ai::history::AiHistoryStore;
use comando_ai::session::NativeAiSession;
use comando_diff::review::{sync_tracked_file, tracked_diff_base};
use comando_diff::{
    ReviewDecision, ReviewTrackedFile, ReviewTrackedFileKind, ReviewTrackedFileStatus,
    compute_tracked_file_patch, normalize_review_text, resolve_tracked_file_hunks,
    tracked_current_text,
};
use comando_fs::WriteTracker;
use comando_fs::path::{ScopedPathIntent, normalize_relative_path, resolve_scoped_path};
use comando_fs::read::hash_content_bytes;
use comando_types::error::{NativeError, NativeErrorCode};
use comando_types::ids::SessionId;
use serde::{Deserialize, Serialize};
use serde_json::json;

const REVIEW_STATE_FILE: &str = "review-state.json";
const REVIEW_SCHEMA_VERSION: u32 = 1;
const MAX_REVIEW_TEXT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct NativeReviewService {
    app_data_dir: Option<PathBuf>,
    baselines: HashSet<String>,
    open_buffers: HashMap<PathBuf, String>,
    states: HashMap<String, NativeReviewSessionState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewSessionInput {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewFileMutationInput {
    pub session_id: SessionId,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracked_file_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewHunkMutationInput {
    pub session_id: SessionId,
    pub path: String,
    pub hunk_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracked_file_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewFileBufferInput {
    pub absolute_path: String,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewRecordDiffsInput {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub diffs: Vec<NativeReviewExactDiffInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewExactDiffInput {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_text: Option<String>,
    #[serde(default = "default_true")]
    pub is_text: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewCaptureOutput {
    pub captured: bool,
    pub session_id: SessionId,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewCommandOutput {
    pub session_id: SessionId,
    pub tracked_files: Vec<ReviewTrackedFile>,
    pub changed_files: Vec<String>,
    pub conflicts: Vec<NativeReviewConflict>,
    pub updated_at: String,
    pub state_found: bool,
    #[serde(skip)]
    pub tracked_file_events: Vec<NativeTrackedFileUpdatedPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewUpdatedPayload {
    pub session_id: SessionId,
    pub runtime_id: comando_types::ids::RuntimeId,
    pub runtime_session_id: Option<comando_types::ids::RuntimeSessionId>,
    pub project_id: Option<comando_types::ids::ProjectId>,
    pub worktree_id: Option<comando_types::ids::WorktreeId>,
    pub tracked_files: Vec<ReviewTrackedFile>,
    pub conflicts: Vec<NativeReviewConflict>,
    pub pending_count: usize,
    pub conflict_count: usize,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTrackedFileUpdatedPayload {
    pub session_id: SessionId,
    pub tracked_file: ReviewTrackedFile,
    pub mutation: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewConflict {
    pub path: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_change_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewSessionState {
    pub version: u32,
    pub schema_version: u32,
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_root: Option<String>,
    pub project_id: Option<comando_types::ids::ProjectId>,
    pub worktree_id: Option<comando_types::ids::WorktreeId>,
    pub runtime_id: comando_types::ids::RuntimeId,
    pub runtime_session_id: Option<comando_types::ids::RuntimeSessionId>,
    pub updated_at: String,
    pub tracked_files: Vec<ReviewTrackedFile>,
    pub conflicts: Vec<NativeReviewConflict>,
    pub action_log: Vec<serde_json::Value>,
}

#[derive(Debug, Clone)]
struct RollbackBackup {
    path: PathBuf,
    content: Option<Vec<u8>>,
    had_open_buffer: bool,
    open_buffer_content: Option<String>,
}

#[derive(Debug, Clone)]
struct NativeReviewLoadedState {
    state: NativeReviewSessionState,
    found: bool,
}

impl NativeReviewService {
    pub fn set_app_data_dir(&mut self, app_data_dir: impl Into<PathBuf>) {
        self.app_data_dir = Some(app_data_dir.into());
    }

    pub fn notify_file_buffer(&mut self, input: NativeReviewFileBufferInput) {
        let path = PathBuf::from(input.absolute_path);
        if let Some(content) = input.content {
            self.open_buffers.insert(path, content);
        } else {
            self.open_buffers.remove(&path);
        }
    }

    pub fn record_diffs(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewRecordDiffsInput,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        let updated_at = input.updated_at.unwrap_or_else(now);
        let loaded = self.load_or_empty_state_entry(session)?;
        let review_root = normalize_review_root(session, input.review_root.as_deref())?
            .or(loaded.state.review_root.clone());
        let mut tracked_files = loaded.state.tracked_files;
        let conflicts = loaded.state.conflicts;
        let mut tracked_file_events = Vec::new();

        for diff in input.diffs {
            if !diff.is_text {
                continue;
            }

            let normalized = normalize_review_path_for_root(
                session,
                review_root.as_deref(),
                &diff.path,
                ScopedPathIntent::CreateTarget,
            )?;
            let previous_path = diff
                .previous_path
                .as_deref()
                .map(|path| {
                    normalize_review_path_for_root(
                        session,
                        review_root.as_deref(),
                        path,
                        ScopedPathIntent::CreateTarget,
                    )
                    .map(|normalized| normalized.state_path)
                })
                .transpose()?
                .filter(|previous_path| previous_path != &normalized.state_path);
            let old_text = validate_review_text_side(&normalized.state_path, diff.old_text)?;
            let new_text = validate_review_text_side(&normalized.state_path, diff.new_text)?;

            let Some(mut tracked_file) = compute_tracked_file_patch(
                &session.session_id.0,
                &normalized.state_path,
                previous_path,
                old_text,
                new_text.clone(),
                updated_at.clone(),
            ) else {
                continue;
            };
            tracked_file.tool_call_id = input.tool_call_id.clone();
            if let Some(tool_call_id) = &input.tool_call_id {
                tracked_file.identity_key = format!(
                    "tool:{}:{}:{}:{}",
                    session.session_id.0,
                    tool_call_id,
                    tracked_file.previous_path.clone().unwrap_or_default(),
                    tracked_file.path
                );
            }
            tracked_file.current_content_hash = new_text
                .as_ref()
                .map(|text| hash_content_bytes(text.as_bytes()));
            tracked_file.expected_disk_hash = tracked_file.current_content_hash.clone();

            let path = tracked_file.path.clone();
            if upsert_tracked_file(&mut tracked_files, tracked_file)
                && let Some(index) = find_tracked_file_index(&tracked_files, &path)
            {
                let event_file = tracked_files[index].clone();
                tracked_file_events.push(NativeTrackedFileUpdatedPayload {
                    session_id: session.session_id.clone(),
                    tracked_file: event_file,
                    mutation: "updated".to_string(),
                    updated_at: updated_at.clone(),
                });
            }
        }

        let state = self.replace_state(
            session,
            tracked_files,
            conflicts,
            updated_at.clone(),
            review_root,
        )?;
        Ok(command_output(
            session.session_id.clone(),
            state.tracked_files,
            Vec::new(),
            state.conflicts,
            updated_at,
            true,
            tracked_file_events,
        ))
    }

    pub fn capture_baseline(
        &mut self,
        session: &NativeAiSession,
    ) -> Result<NativeReviewCaptureOutput, NativeError> {
        let updated_at = now();
        self.baselines.insert(session.session_id.0.clone());
        Ok(NativeReviewCaptureOutput {
            captured: true,
            session_id: session.session_id.clone(),
            updated_at,
        })
    }

    pub fn reconcile_tracked_files(
        &mut self,
        session: &NativeAiSession,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        self.baselines.remove(&session.session_id.0);
        let updated_at = now();
        let loaded = self.load_or_empty_state_entry(session)?;
        let (tracked_files, changed) = self.reconcile_exact_tracked_files(
            session,
            loaded.state.review_root.as_deref(),
            loaded.state.tracked_files.clone(),
        )?;
        if !changed {
            let state = loaded.state;
            return Ok(command_output(
                session.session_id.clone(),
                state.tracked_files,
                Vec::new(),
                state.conflicts,
                updated_at,
                loaded.found,
                Vec::new(),
            ));
        }

        let state = self.replace_state(
            session,
            tracked_files,
            loaded.state.conflicts,
            updated_at.clone(),
            loaded.state.review_root,
        )?;
        Ok(command_output(
            session.session_id.clone(),
            state.tracked_files,
            Vec::new(),
            state.conflicts,
            updated_at,
            true,
            Vec::new(),
        ))
    }

    pub fn list_tracked_files(
        &mut self,
        session: &NativeAiSession,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        let loaded = self.load_or_empty_state_entry(session)?;
        let state = loaded.state;
        Ok(command_output(
            session.session_id.clone(),
            state.tracked_files,
            Vec::new(),
            state.conflicts,
            state.updated_at,
            loaded.found,
            Vec::new(),
        ))
    }

    pub fn keep_file(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewFileMutationInput,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        let mut state = self.load_or_empty_state(session)?;
        let Some(index) = find_tracked_file_index_for_input(
            session,
            state.review_root.as_deref(),
            &state.tracked_files,
            &input.path,
        )?
        else {
            let conflict_index = find_review_conflict_index_for_input(
                session,
                state.review_root.as_deref(),
                &state.conflicts,
                &input.path,
            )?
            .ok_or_else(|| review_not_found(&input.path))?;
            state.conflicts.remove(conflict_index);
            let updated_at = now();
            self.save_replaced_state(session, &mut state, updated_at.clone())?;
            return Ok(command_output(
                session.session_id.clone(),
                state.tracked_files,
                Vec::new(),
                state.conflicts,
                updated_at,
                true,
                Vec::new(),
            ));
        };
        validate_version(&state.tracked_files[index], input.expected_version)?;
        let mut tracked_file = state.tracked_files.remove(index);
        tracked_file.review_state = ReviewTrackedFileStatus::Kept;
        tracked_file.updated_at = now();
        let updated_at = tracked_file.updated_at.clone();
        let accepted_paths = revert_paths(&tracked_file);
        state
            .conflicts
            .retain(|conflict| !accepted_paths.contains(&conflict.path));
        let event_payload = NativeTrackedFileUpdatedPayload {
            session_id: session.session_id.clone(),
            tracked_file,
            mutation: "kept".to_string(),
            updated_at: updated_at.clone(),
        };
        self.save_replaced_state(session, &mut state, updated_at.clone())?;
        Ok(command_output(
            session.session_id.clone(),
            state.tracked_files,
            Vec::new(),
            state.conflicts,
            updated_at,
            true,
            vec![event_payload],
        ))
    }

    pub fn reject_file(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewFileMutationInput,
        write_tracker: &WriteTracker,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        let mut state = self.load_or_empty_state(session)?;
        let index = find_tracked_file_index_for_input(
            session,
            state.review_root.as_deref(),
            &state.tracked_files,
            &input.path,
        )?
        .ok_or_else(|| review_not_found(&input.path))?;
        validate_version(&state.tracked_files[index], input.expected_version)?;
        let tracked_file = state.tracked_files.remove(index);
        let changed_files = self.revert_tracked_file(
            session,
            state.review_root.as_deref(),
            &tracked_file,
            write_tracker,
        )?;
        let updated_at = now();
        let mut event_file = tracked_file;
        event_file.review_state = ReviewTrackedFileStatus::Rejected;
        event_file.updated_at = updated_at.clone();
        let event_payload = NativeTrackedFileUpdatedPayload {
            session_id: session.session_id.clone(),
            tracked_file: event_file,
            mutation: "rejected".to_string(),
            updated_at: updated_at.clone(),
        };
        self.save_replaced_state(session, &mut state, updated_at.clone())?;
        Ok(command_output(
            session.session_id.clone(),
            state.tracked_files,
            changed_files,
            state.conflicts,
            updated_at,
            true,
            vec![event_payload],
        ))
    }

    pub fn keep_hunks(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewHunkMutationInput,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        self.resolve_hunks(session, input, ReviewDecision::Keep, None)
    }

    pub fn reject_hunks(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewHunkMutationInput,
        write_tracker: &WriteTracker,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        self.resolve_hunks(session, input, ReviewDecision::Reject, Some(write_tracker))
    }

    pub fn keep_all(
        &mut self,
        session: &NativeAiSession,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        let mut state = self.load_or_empty_state(session)?;
        let updated_at = now();
        let events = state
            .tracked_files
            .iter()
            .cloned()
            .map(|mut tracked_file| {
                tracked_file.review_state = ReviewTrackedFileStatus::Kept;
                tracked_file.updated_at = updated_at.clone();
                NativeTrackedFileUpdatedPayload {
                    session_id: session.session_id.clone(),
                    tracked_file,
                    mutation: "kept".to_string(),
                    updated_at: updated_at.clone(),
                }
            })
            .collect::<Vec<_>>();
        state.tracked_files.clear();
        state.conflicts.clear();
        self.save_replaced_state(session, &mut state, updated_at.clone())?;
        Ok(command_output(
            session.session_id.clone(),
            state.tracked_files,
            Vec::new(),
            state.conflicts,
            updated_at,
            true,
            events,
        ))
    }

    pub fn reject_all(
        &mut self,
        session: &NativeAiSession,
        write_tracker: &WriteTracker,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        let mut state = self.load_or_empty_state(session)?;
        for tracked_file in &state.tracked_files {
            self.assert_current_matches(session, state.review_root.as_deref(), tracked_file)?;
            self.assert_move_previous_path_available(
                session,
                state.review_root.as_deref(),
                tracked_file,
            )?;
        }
        let backups = self.create_rollback_backups(
            session,
            state.review_root.as_deref(),
            &state.tracked_files,
        )?;
        let tracked_files = state.tracked_files.clone();
        let mut changed_files = Vec::new();
        if let Err(error) = tracked_files.iter().try_for_each(|tracked_file| {
            self.revert_tracked_file(
                session,
                state.review_root.as_deref(),
                tracked_file,
                write_tracker,
            )
            .map(|paths| changed_files.extend(paths))
        }) {
            if let Err(rollback_error) = self.restore_backups(backups, write_tracker) {
                return Err(NativeError::new(
                    NativeErrorCode::InternalError,
                    format!(
                        "Native review reject all failed and rollback could not be completed: {} Rollback error: {}",
                        error.message, rollback_error.message
                    ),
                )
                .with_details(json!({
                    "originalError": error,
                    "rollbackError": rollback_error
                })));
            }
            return Err(error);
        }
        let updated_at = now();
        let events = tracked_files
            .into_iter()
            .map(|mut tracked_file| {
                tracked_file.review_state = ReviewTrackedFileStatus::Rejected;
                tracked_file.updated_at = updated_at.clone();
                NativeTrackedFileUpdatedPayload {
                    session_id: session.session_id.clone(),
                    tracked_file,
                    mutation: "rejected".to_string(),
                    updated_at: updated_at.clone(),
                }
            })
            .collect::<Vec<_>>();
        state.tracked_files.clear();
        self.save_replaced_state(session, &mut state, updated_at.clone())?;
        Ok(command_output(
            session.session_id.clone(),
            state.tracked_files,
            changed_files,
            state.conflicts,
            updated_at,
            true,
            events,
        ))
    }

    pub fn review_updated_payload(
        &self,
        session: &NativeAiSession,
        output: &NativeReviewCommandOutput,
    ) -> NativeReviewUpdatedPayload {
        NativeReviewUpdatedPayload {
            session_id: session.session_id.clone(),
            runtime_id: session.runtime_id.clone(),
            runtime_session_id: session.runtime_session_id.clone(),
            project_id: session.scope.project_id.clone(),
            worktree_id: session.scope.worktree_id.clone(),
            pending_count: output
                .tracked_files
                .iter()
                .filter(|file| file.review_state == ReviewTrackedFileStatus::Pending)
                .count(),
            conflict_count: review_conflict_count(&output.tracked_files, &output.conflicts),
            tracked_files: output.tracked_files.clone(),
            conflicts: output.conflicts.clone(),
            updated_at: output.updated_at.clone(),
        }
    }

    fn resolve_hunks(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewHunkMutationInput,
        decision: ReviewDecision,
        write_tracker: Option<&WriteTracker>,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        let mut state = self.load_or_empty_state(session)?;
        let index = find_tracked_file_index_for_input(
            session,
            state.review_root.as_deref(),
            &state.tracked_files,
            &input.path,
        )?
        .ok_or_else(|| review_not_found(&input.path))?;
        validate_version(&state.tracked_files[index], input.expected_version)?;
        let tracked_file = state.tracked_files[index].clone();
        if decision == ReviewDecision::Reject {
            self.assert_current_matches(session, state.review_root.as_deref(), &tracked_file)?;
        }
        let updated_at = now();
        let hunk_ids = normalize_review_hunk_ids(
            session,
            state.review_root.as_deref(),
            &input.hunk_ids,
            &tracked_file.path,
        );
        let next = resolve_tracked_file_hunks(
            &tracked_file,
            &hunk_ids,
            decision.clone(),
            updated_at.clone(),
        );
        let mut changed_files = Vec::new();
        match decision {
            ReviewDecision::Keep => {
                if next.is_none() {
                    let accepted_paths = revert_paths(&tracked_file);
                    state
                        .conflicts
                        .retain(|conflict| !accepted_paths.contains(&conflict.path));
                }
                replace_or_remove_tracked_file(&mut state.tracked_files, index, next.clone());
            }
            ReviewDecision::Reject => {
                let write_tracker = write_tracker.expect("reject hunks provides write tracker");
                if let Some(next_file) = next.clone() {
                    let current = tracked_current_text(&tracked_file);
                    let next_text = tracked_current_text(&next_file);
                    if current != next_text {
                        self.write_review_text(
                            session,
                            state.review_root.as_deref(),
                            &next_file.path,
                            &next_text,
                            write_tracker,
                        )?;
                        changed_files.push(next_file.path.clone());
                    }
                    replace_or_remove_tracked_file(
                        &mut state.tracked_files,
                        index,
                        Some(next_file),
                    );
                } else {
                    changed_files.extend(self.revert_tracked_file(
                        session,
                        state.review_root.as_deref(),
                        &tracked_file,
                        write_tracker,
                    )?);
                    state.tracked_files.remove(index);
                }
            }
        }
        let event_payload = NativeTrackedFileUpdatedPayload {
            session_id: session.session_id.clone(),
            tracked_file: next.unwrap_or_else(|| tracked_file.clone()),
            mutation: match decision {
                ReviewDecision::Keep => "kept".to_string(),
                ReviewDecision::Reject => "rejected".to_string(),
            },
            updated_at: updated_at.clone(),
        };
        self.save_replaced_state(session, &mut state, updated_at.clone())?;
        Ok(command_output(
            session.session_id.clone(),
            state.tracked_files,
            changed_files,
            state.conflicts,
            updated_at,
            true,
            vec![event_payload],
        ))
    }

    fn load_or_empty_state(
        &mut self,
        session: &NativeAiSession,
    ) -> Result<NativeReviewSessionState, NativeError> {
        Ok(self.load_or_empty_state_entry(session)?.state)
    }

    fn load_or_empty_state_entry(
        &mut self,
        session: &NativeAiSession,
    ) -> Result<NativeReviewLoadedState, NativeError> {
        if let Some(state) = self.states.get(&session.session_id.0).cloned() {
            let (state, migrated) = normalize_review_state(session, state)?;
            if migrated {
                self.save_state(&state)?;
                self.states
                    .insert(session.session_id.0.clone(), state.clone());
            }
            return Ok(NativeReviewLoadedState { state, found: true });
        }
        if let Some(path) = self.review_state_path(&session.session_id)
            && path.exists()
        {
            let bytes =
                fs::read(&path).map_err(|error| review_io("read review state", &path, error))?;
            let state =
                serde_json::from_slice::<NativeReviewSessionState>(&bytes).map_err(|error| {
                    NativeError::new(
                        NativeErrorCode::InvalidJson,
                        format!("Native review state is invalid: {error}"),
                    )
                })?;
            let (state, migrated) = normalize_review_state(session, state)?;
            if migrated {
                self.save_state(&state)?;
            }
            self.states
                .insert(session.session_id.0.clone(), state.clone());
            return Ok(NativeReviewLoadedState { state, found: true });
        }
        Ok(NativeReviewLoadedState {
            state: empty_state(session, now()),
            found: false,
        })
    }

    fn replace_state(
        &mut self,
        session: &NativeAiSession,
        tracked_files: Vec<ReviewTrackedFile>,
        conflicts: Vec<NativeReviewConflict>,
        updated_at: String,
        review_root: Option<String>,
    ) -> Result<NativeReviewSessionState, NativeError> {
        let mut state = empty_state(session, updated_at.clone());
        state.review_root = review_root;
        state.tracked_files = tracked_files;
        state.conflicts = conflicts;
        self.save_state(&state)?;
        self.states
            .insert(session.session_id.0.clone(), state.clone());
        Ok(state)
    }

    fn save_replaced_state(
        &mut self,
        session: &NativeAiSession,
        state: &mut NativeReviewSessionState,
        updated_at: String,
    ) -> Result<(), NativeError> {
        state.updated_at = updated_at;
        state.version = state.version.saturating_add(1);
        self.save_state(state)?;
        self.states
            .insert(session.session_id.0.clone(), state.clone());
        Ok(())
    }

    fn save_state(&self, state: &NativeReviewSessionState) -> Result<(), NativeError> {
        let Some(path) = self.review_state_path(&state.session_id) else {
            return Ok(());
        };
        atomic_write_json(&path, state)
    }

    fn review_state_path(&self, session_id: &SessionId) -> Option<PathBuf> {
        self.app_data_dir.as_ref().map(|app_data_dir| {
            app_data_dir
                .join("ai")
                .join("sessions")
                .join(AiHistoryStore::storage_key(&session_id.0))
                .join(REVIEW_STATE_FILE)
        })
    }

    fn read_working_tree_text(
        &self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        review_path: &str,
    ) -> Result<Option<String>, NativeError> {
        let resolved = match resolve_review_path_for_root(
            session,
            review_root,
            review_path,
            ScopedPathIntent::ReadExisting,
        ) {
            Ok(path) => path,
            Err(error) if error.code == NativeErrorCode::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if let Some(buffer) = self.open_buffers.get(&resolved) {
            return ensure_review_text(buffer.clone(), review_path);
        }
        read_text_file_for_review(&resolved, review_path)
    }

    fn reconcile_exact_tracked_files(
        &self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        tracked_files: Vec<ReviewTrackedFile>,
    ) -> Result<(Vec<ReviewTrackedFile>, bool), NativeError> {
        if tracked_files.is_empty() {
            return Ok((tracked_files, false));
        }

        let mut next_tracked_files = Vec::with_capacity(tracked_files.len());
        let mut changed = false;
        for tracked_file in tracked_files {
            let synced = sync_tracked_file(&tracked_file);
            if synced.review_state != ReviewTrackedFileStatus::Pending || !synced.is_text {
                changed |= synced != tracked_file;
                next_tracked_files.push(synced);
                continue;
            }

            if synced.hunks.is_empty() {
                changed = true;
                continue;
            }

            match self.is_tracked_file_net_clean(session, review_root, &synced) {
                Ok(true) => {
                    changed = true;
                }
                Ok(false) => {
                    changed |= synced != tracked_file;
                    next_tracked_files.push(synced);
                }
                Err(error) if is_review_content_error(&error) => {
                    changed |= synced != tracked_file;
                    next_tracked_files.push(synced);
                }
                Err(error) => return Err(error),
            }
        }

        Ok((next_tracked_files, changed))
    }

    fn is_tracked_file_net_clean(
        &self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        tracked_file: &ReviewTrackedFile,
    ) -> Result<bool, NativeError> {
        let diff_base = tracked_diff_base(tracked_file);
        if let Some(previous_path) = tracked_file.previous_path.as_deref() {
            let current_text =
                self.read_working_tree_text(session, review_root, &tracked_file.path)?;
            let previous_text = self.read_working_tree_text(session, review_root, previous_path)?;
            return Ok(current_text
                .as_deref()
                .is_none_or(|text| review_texts_equal(text, &diff_base))
                && previous_text
                    .as_deref()
                    .is_some_and(|text| review_texts_equal(text, &diff_base)));
        }

        let current_text = self.read_working_tree_text(session, review_root, &tracked_file.path)?;
        if tracked_file.kind == ReviewTrackedFileKind::Create {
            return Ok(current_text
                .as_deref()
                .is_none_or(|text| review_texts_equal(text, &diff_base)));
        }

        Ok(current_text
            .as_deref()
            .is_some_and(|text| review_texts_equal(text, &diff_base)))
    }

    fn assert_current_matches(
        &self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        tracked_file: &ReviewTrackedFile,
    ) -> Result<(), NativeError> {
        let expected = match tracked_file.kind {
            ReviewTrackedFileKind::Delete => None,
            _ => Some(tracked_current_text(tracked_file)),
        };
        let current = self.read_working_tree_text(session, review_root, &tracked_file.path)?;
        match (expected, current) {
            (None, None) => Ok(()),
            (Some(expected), Some(current)) if expected == current => Ok(()),
            (Some(_), Some(current)) => Err(review_conflict(
                &tracked_file.path,
                "content_hash_mismatch",
                Some(hash_content_bytes(current.as_bytes())),
            )),
            (Some(_), None) => Err(review_conflict(&tracked_file.path, "missing_file", None)),
            (None, Some(current)) => Err(review_conflict(
                &tracked_file.path,
                "path_exists",
                Some(hash_content_bytes(current.as_bytes())),
            )),
        }
    }

    fn assert_move_previous_path_available(
        &self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        tracked_file: &ReviewTrackedFile,
    ) -> Result<(), NativeError> {
        if tracked_file.kind != ReviewTrackedFileKind::Move {
            return Ok(());
        }
        let Some(previous_path) = tracked_file.previous_path.as_deref() else {
            return Ok(());
        };
        if self
            .read_working_tree_text(session, review_root, previous_path)?
            .is_some()
        {
            return Err(review_conflict(previous_path, "path_exists", None));
        }
        Ok(())
    }

    fn revert_tracked_file(
        &mut self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        tracked_file: &ReviewTrackedFile,
        write_tracker: &WriteTracker,
    ) -> Result<Vec<String>, NativeError> {
        self.assert_current_matches(session, review_root, tracked_file)?;
        self.assert_move_previous_path_available(session, review_root, tracked_file)?;
        let mut changed = Vec::new();
        match tracked_file.kind {
            ReviewTrackedFileKind::Create => {
                self.remove_review_file(session, review_root, &tracked_file.path, write_tracker)?;
                changed.push(tracked_file.path.clone());
            }
            ReviewTrackedFileKind::Delete | ReviewTrackedFileKind::Update => {
                let old_text = tracked_file
                    .old_text
                    .as_deref()
                    .ok_or_else(|| review_conflict(&tracked_file.path, "not_reversible", None))?;
                self.write_review_text(
                    session,
                    review_root,
                    &tracked_file.path,
                    old_text,
                    write_tracker,
                )?;
                changed.push(tracked_file.path.clone());
            }
            ReviewTrackedFileKind::Move => {
                let old_text = tracked_file
                    .old_text
                    .as_deref()
                    .ok_or_else(|| review_conflict(&tracked_file.path, "not_reversible", None))?;
                let previous_path = tracked_file
                    .previous_path
                    .as_deref()
                    .ok_or_else(|| review_conflict(&tracked_file.path, "not_reversible", None))?;
                self.remove_review_file(session, review_root, &tracked_file.path, write_tracker)?;
                self.write_review_text(
                    session,
                    review_root,
                    previous_path,
                    old_text,
                    write_tracker,
                )?;
                changed.push(tracked_file.path.clone());
                changed.push(previous_path.to_string());
            }
        }
        Ok(changed)
    }

    fn write_review_text(
        &mut self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        relative_path: &str,
        text: &str,
        write_tracker: &WriteTracker,
    ) -> Result<(), NativeError> {
        let resolved = resolve_review_path_for_root(
            session,
            review_root,
            relative_path,
            ScopedPathIntent::CreateTarget,
        )?;
        if let Some(parent) = resolved.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| review_io("create review parent directory", parent, error))?;
        }
        fs::write(&resolved, text)
            .map_err(|error| review_io("write review file", &resolved, error))?;
        write_tracker.track_content(resolved.clone(), text);
        if let Some(buffer) = self.open_buffers.get_mut(&resolved) {
            *buffer = text.to_string();
        }
        Ok(())
    }

    fn remove_review_file(
        &mut self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        relative_path: &str,
        write_tracker: &WriteTracker,
    ) -> Result<(), NativeError> {
        let resolved = resolve_review_path_for_root(
            session,
            review_root,
            relative_path,
            ScopedPathIntent::ReadExisting,
        )?;
        match fs::remove_file(&resolved) {
            Ok(()) => {
                write_tracker.track_any(resolved.clone());
                self.open_buffers.remove(&resolved);
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(review_io("remove review file", &resolved, error)),
        }
    }

    fn create_rollback_backups(
        &self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        tracked_files: &[ReviewTrackedFile],
    ) -> Result<Vec<RollbackBackup>, NativeError> {
        let mut paths = HashSet::new();
        let mut backups = Vec::new();
        for tracked_file in tracked_files {
            for relative_path in revert_paths(tracked_file) {
                let resolved = resolve_review_path_for_root(
                    session,
                    review_root,
                    &relative_path,
                    ScopedPathIntent::CreateTarget,
                )?;
                if !paths.insert(resolved.clone()) {
                    continue;
                }
                let content = match fs::read(&resolved) {
                    Ok(content) => Some(content),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(review_io("backup review file", &resolved, error)),
                };
                let open_buffer_content = self.open_buffers.get(&resolved).cloned();
                backups.push(RollbackBackup {
                    path: resolved,
                    content,
                    had_open_buffer: open_buffer_content.is_some(),
                    open_buffer_content,
                });
            }
        }
        Ok(backups)
    }

    fn restore_backups(
        &mut self,
        backups: Vec<RollbackBackup>,
        write_tracker: &WriteTracker,
    ) -> Result<(), NativeError> {
        for backup in backups.into_iter().rev() {
            if let Some(content) = backup.content {
                if let Some(parent) = backup.path.parent() {
                    fs::create_dir_all(parent).map_err(|error| {
                        review_io("restore review parent directory", parent, error)
                    })?;
                }
                fs::write(&backup.path, &content)
                    .map_err(|error| review_io("restore review file", &backup.path, error))?;
                write_tracker.track_bytes(backup.path.clone(), &content);
            } else if let Err(error) = fs::remove_file(&backup.path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                return Err(review_io(
                    "remove restored review file",
                    &backup.path,
                    error,
                ));
            } else {
                write_tracker.track_any(backup.path.clone());
            }

            if backup.had_open_buffer {
                if let Some(content) = backup.open_buffer_content {
                    self.open_buffers.insert(backup.path, content);
                }
            } else {
                self.open_buffers.remove(&backup.path);
            }
        }
        Ok(())
    }
}

fn empty_state(session: &NativeAiSession, updated_at: String) -> NativeReviewSessionState {
    NativeReviewSessionState {
        version: 1,
        schema_version: REVIEW_SCHEMA_VERSION,
        session_id: session.session_id.clone(),
        review_root: None,
        project_id: session.scope.project_id.clone(),
        worktree_id: session.scope.worktree_id.clone(),
        runtime_id: session.runtime_id.clone(),
        runtime_session_id: session.runtime_session_id.clone(),
        updated_at,
        tracked_files: Vec::new(),
        conflicts: Vec::new(),
        action_log: Vec::new(),
    }
}

fn command_output(
    session_id: SessionId,
    tracked_files: Vec<ReviewTrackedFile>,
    changed_files: Vec<String>,
    conflicts: Vec<NativeReviewConflict>,
    updated_at: String,
    state_found: bool,
    tracked_file_events: Vec<NativeTrackedFileUpdatedPayload>,
) -> NativeReviewCommandOutput {
    NativeReviewCommandOutput {
        session_id,
        tracked_files,
        changed_files,
        conflicts,
        updated_at,
        state_found,
        tracked_file_events,
    }
}

fn review_conflict_count(
    tracked_files: &[ReviewTrackedFile],
    conflicts: &[NativeReviewConflict],
) -> usize {
    let mut paths = HashSet::new();
    for conflict in conflicts {
        paths.insert(conflict.path.as_str());
    }
    for file in tracked_files {
        if file.review_state == ReviewTrackedFileStatus::Conflict {
            paths.insert(file.path.as_str());
        }
    }
    paths.len()
}

fn read_text_file_for_review(
    path: &Path,
    display_path: &str,
) -> Result<Option<String>, NativeError> {
    let metadata =
        fs::metadata(path).map_err(|error| review_io("read review file metadata", path, error))?;
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() > MAX_REVIEW_TEXT_BYTES {
        return Err(NativeError::new(
            NativeErrorCode::TooLarge,
            "Cannot review this file because it is too large.",
        )
        .with_details(json!({ "path": display_path })));
    }
    let bytes = fs::read(path).map_err(|error| review_io("read review file", path, error))?;
    if bytes.contains(&0) {
        return Err(NativeError::new(
            NativeErrorCode::BinaryFile,
            "Cannot review binary files as text.",
        )
        .with_details(json!({ "path": display_path })));
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        NativeError::new(
            NativeErrorCode::NotSupported,
            "Cannot review this file because its encoding is unsupported.",
        )
        .with_details(json!({ "path": display_path }))
    })?;
    ensure_review_text(text, display_path)
}

fn ensure_review_text(text: String, display_path: &str) -> Result<Option<String>, NativeError> {
    if text.len() as u64 > MAX_REVIEW_TEXT_BYTES {
        return Err(NativeError::new(
            NativeErrorCode::TooLarge,
            "Cannot review this file because it is too large.",
        )
        .with_details(json!({ "path": display_path })));
    }
    if text.contains('\0') {
        return Err(NativeError::new(
            NativeErrorCode::BinaryFile,
            "Cannot review binary files as text.",
        )
        .with_details(json!({ "path": display_path })));
    }
    Ok(Some(text))
}

fn find_tracked_file_index(files: &[ReviewTrackedFile], path: &str) -> Option<usize> {
    files.iter().position(|file| {
        file.path == path
            || file.previous_path.as_deref() == Some(path)
            || file.identity_key == path
    })
}

fn find_tracked_file_index_for_input(
    session: &NativeAiSession,
    review_root: Option<&str>,
    files: &[ReviewTrackedFile],
    input_path: &str,
) -> Result<Option<usize>, NativeError> {
    if let Some(index) = find_tracked_file_index(files, input_path) {
        return Ok(Some(index));
    }

    let normalized = normalize_review_path_for_root(
        session,
        review_root,
        input_path,
        ScopedPathIntent::CreateTarget,
    )?
    .state_path;
    Ok(find_tracked_file_index(files, &normalized))
}

fn find_review_conflict_index_for_input(
    session: &NativeAiSession,
    review_root: Option<&str>,
    conflicts: &[NativeReviewConflict],
    input_path: &str,
) -> Result<Option<usize>, NativeError> {
    if let Some(index) = conflicts
        .iter()
        .position(|conflict| conflict.path == input_path)
    {
        return Ok(Some(index));
    }

    let normalized = normalize_review_path_for_root(
        session,
        review_root,
        input_path,
        ScopedPathIntent::CreateTarget,
    )?
    .state_path;
    Ok(conflicts
        .iter()
        .position(|conflict| conflict.path == normalized))
}

fn normalize_review_hunk_ids(
    session: &NativeAiSession,
    review_root: Option<&str>,
    hunk_ids: &[String],
    tracked_path: &str,
) -> Vec<String> {
    let mut normalized = Vec::with_capacity(hunk_ids.len() * 2);
    for hunk_id in hunk_ids {
        normalized.push(hunk_id.clone());
        if let Some(rewritten) = rewrite_review_hunk_id(session, review_root, hunk_id, tracked_path)
            && rewritten != *hunk_id
        {
            normalized.push(rewritten);
        }
    }
    normalized
}

fn rewrite_review_hunk_id(
    session: &NativeAiSession,
    review_root: Option<&str>,
    hunk_id: &str,
    tracked_path: &str,
) -> Option<String> {
    let mut parts = hunk_id.rsplitn(4, ':');
    let hunk_index = parts.next()?;
    let new_start = parts.next()?;
    let old_start = parts.next()?;
    let seed = parts.next()?;
    let normalized_seed =
        normalize_review_path_for_root(session, review_root, seed, ScopedPathIntent::CreateTarget)
            .ok()?
            .state_path;
    if normalized_seed != tracked_path {
        return None;
    }
    Some(format!(
        "{tracked_path}:{old_start}:{new_start}:{hunk_index}"
    ))
}

fn upsert_tracked_file(files: &mut Vec<ReviewTrackedFile>, file: ReviewTrackedFile) -> bool {
    if let Some(index) = find_tracked_file_index(files, &file.path) {
        if tracked_files_equivalent(&files[index], &file) {
            return false;
        }
        let Some(next) = merge_tracked_file(&files[index], file) else {
            files.remove(index);
            return true;
        };
        files[index] = next;
        true
    } else {
        files.push(file);
        true
    }
}

fn tracked_files_equivalent(left: &ReviewTrackedFile, right: &ReviewTrackedFile) -> bool {
    left.path == right.path
        && left.previous_path == right.previous_path
        && left.old_text == right.old_text
        && left.new_text == right.new_text
        && left.tool_call_id == right.tool_call_id
        && tracked_diff_base(left) == tracked_diff_base(right)
        && tracked_current_text(left) == tracked_current_text(right)
        && left.review_state == right.review_state
}

fn merge_tracked_file(
    existing: &ReviewTrackedFile,
    next: ReviewTrackedFile,
) -> Option<ReviewTrackedFile> {
    let existing = sync_tracked_file(existing);
    let next = sync_tracked_file(&next);
    if !can_merge_tracked_files(&existing, &next) {
        let mut replaced = next;
        replaced.version = Some(existing.version.unwrap_or(1).saturating_add(1));
        return Some(replaced);
    }

    let previous_path = existing
        .previous_path
        .clone()
        .or(next.previous_path.clone());
    let diff_base = tracked_diff_base(&existing);
    let existing_current = tracked_current_text(&existing);
    let next_old_text = next.old_text.clone().unwrap_or_default();
    let next_current = tracked_current_text(&next);
    let current_text =
        reconcile_current_text(&diff_base, &existing_current, &next_old_text, &next_current);
    let old_text = existing.old_text.clone();
    let new_text = if current_text != next_current {
        Some(current_text.clone())
    } else {
        next.new_text.clone()
    };
    let is_net_neutral_move = previous_path
        .as_deref()
        .is_some_and(|previous_path| previous_path == next.path);
    if review_texts_equal(&diff_base, &current_text)
        && (previous_path.is_none() || is_net_neutral_move)
    {
        return None;
    }

    let mut merged = next;
    merged.current_text = Some(current_text);
    merged.diff_base = Some(diff_base);
    merged.old_text = old_text;
    merged.new_text = new_text;
    merged.previous_path = previous_path;
    merged.identity_key = existing.identity_key;
    merged.version = Some(existing.version.unwrap_or(1).saturating_add(1));
    Some(sync_tracked_file(&merged))
}

fn can_merge_tracked_files(left: &ReviewTrackedFile, right: &ReviewTrackedFile) -> bool {
    if left.review_state != ReviewTrackedFileStatus::Pending
        || right.review_state != ReviewTrackedFileStatus::Pending
        || !left.is_text
        || !right.is_text
        || left.session_id != right.session_id
    {
        return false;
    }
    if left.kind != ReviewTrackedFileKind::Create && left.old_text.is_none() {
        return false;
    }
    if let (Some(left_previous), Some(right_previous)) = (
        left.previous_path.as_deref(),
        right.previous_path.as_deref(),
    ) && left_previous != right_previous
        && left.path != right_previous
    {
        return false;
    }
    true
}

fn reconcile_current_text(
    diff_base: &str,
    existing_current: &str,
    next_old_text: &str,
    next_current: &str,
) -> String {
    if next_old_text == existing_current || next_old_text == diff_base {
        return next_current.to_string();
    }
    if next_current == existing_current {
        return next_current.to_string();
    }
    if next_old_text.is_empty() {
        return next_current.to_string();
    }
    let Some(first) = existing_current.find(next_old_text) else {
        return next_current.to_string();
    };
    if existing_current.rfind(next_old_text) != Some(first) {
        return next_current.to_string();
    }
    format!(
        "{}{}{}",
        &existing_current[..first],
        next_current,
        &existing_current[first + next_old_text.len()..]
    )
}

fn replace_or_remove_tracked_file(
    files: &mut Vec<ReviewTrackedFile>,
    index: usize,
    next: Option<ReviewTrackedFile>,
) {
    if let Some(next) = next {
        files[index] = next;
    } else {
        files.remove(index);
    }
}

fn validate_version(
    tracked_file: &ReviewTrackedFile,
    expected_version: Option<u32>,
) -> Result<(), NativeError> {
    if let Some(expected_version) = expected_version
        && tracked_file.version.unwrap_or(1) != expected_version
    {
        return Err(review_conflict(
            &tracked_file.path,
            "stale_review_version",
            None,
        ));
    }
    Ok(())
}

fn is_review_content_error(error: &NativeError) -> bool {
    matches!(
        error.code,
        NativeErrorCode::TooLarge | NativeErrorCode::BinaryFile | NativeErrorCode::NotSupported
    )
}

fn validate_review_text_side(
    display_path: &str,
    text: Option<String>,
) -> Result<Option<String>, NativeError> {
    text.map(|text| {
        ensure_review_text(text, display_path).map(|validated| validated.unwrap_or_default())
    })
    .transpose()
}

fn review_texts_equal(left: &str, right: &str) -> bool {
    normalize_review_text(left) == normalize_review_text(right)
}

fn default_true() -> bool {
    true
}

fn revert_paths(tracked_file: &ReviewTrackedFile) -> Vec<String> {
    let mut paths = vec![tracked_file.path.clone()];
    if tracked_file.kind == ReviewTrackedFileKind::Move
        && let Some(previous_path) = &tracked_file.previous_path
    {
        paths.push(previous_path.clone());
    }
    paths
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NormalizedReviewPath {
    absolute_path: PathBuf,
    state_path: String,
}

fn resolve_review_path_for_root(
    session: &NativeAiSession,
    review_root: Option<&str>,
    review_path: &str,
    intent: ScopedPathIntent,
) -> Result<PathBuf, NativeError> {
    normalize_review_path_for_root(session, review_root, review_path, intent)
        .map(|resolved| resolved.absolute_path)
}

fn normalize_review_root(
    session: &NativeAiSession,
    review_root: Option<&str>,
) -> Result<Option<String>, NativeError> {
    let Some(review_root) = review_root.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    let root = Path::new(review_root);
    if !root.is_absolute() {
        return Err(invalid_review_path());
    }
    let cwd = Path::new(&session.scope.cwd);
    if cwd.strip_prefix(root).is_err() {
        return Err(NativeError::new(
            NativeErrorCode::PermissionDenied,
            "Cannot safely apply this review change because the review root is outside the session scope.",
        ));
    }
    Ok(Some(root.to_string_lossy().to_string()))
}

fn normalize_review_path_for_root(
    session: &NativeAiSession,
    review_root: Option<&str>,
    candidate: &str,
    intent: ScopedPathIntent,
) -> Result<NormalizedReviewPath, NativeError> {
    let Some(review_root) = review_root else {
        return normalize_review_path(session, candidate, intent);
    };
    let root = Path::new(review_root);
    let candidate_path = Path::new(candidate);
    if candidate_path.is_absolute() {
        if let Some(normalized) = normalize_absolute_path_inside_root(
            root,
            candidate_path,
            intent,
            AbsoluteReviewPathMode::ProjectRelative,
        )? {
            return Ok(normalized);
        }
        return normalize_absolute_review_path(session, candidate_path, candidate, intent);
    }

    let resolved =
        resolve_scoped_path(root, Some(candidate), false, intent).map_err(review_path_error)?;
    let Some(state_path) = resolved.relative_path else {
        return Err(invalid_review_path());
    };
    Ok(NormalizedReviewPath {
        absolute_path: resolved.absolute_path,
        state_path,
    })
}

fn normalize_review_state(
    session: &NativeAiSession,
    mut state: NativeReviewSessionState,
) -> Result<(NativeReviewSessionState, bool), NativeError> {
    let mut migrated = false;
    let review_root = state.review_root.clone();
    for tracked_file in &mut state.tracked_files {
        migrated |= normalize_tracked_file_paths(session, review_root.as_deref(), tracked_file)?;
    }
    for conflict in &mut state.conflicts {
        let normalized = normalize_review_path_for_root(
            session,
            review_root.as_deref(),
            &conflict.path,
            ScopedPathIntent::CreateTarget,
        )?;
        if conflict.path != normalized.state_path {
            conflict.path = normalized.state_path;
            migrated = true;
        }
    }
    if migrated {
        state.version = state.version.saturating_add(1);
        state.updated_at = now();
    }
    Ok((state, migrated))
}

fn normalize_tracked_file_paths(
    session: &NativeAiSession,
    review_root: Option<&str>,
    tracked_file: &mut ReviewTrackedFile,
) -> Result<bool, NativeError> {
    let original_path = tracked_file.path.clone();
    let normalized = normalize_review_path_for_root(
        session,
        review_root,
        &original_path,
        ScopedPathIntent::CreateTarget,
    )?;
    let mut changed = original_path != normalized.state_path;
    tracked_file.path = normalized.state_path;

    if let Some(previous_path) = tracked_file.previous_path.as_deref() {
        let original_previous_path = previous_path.to_string();
        let normalized_previous_path = normalize_review_path_for_root(
            session,
            review_root,
            &original_previous_path,
            ScopedPathIntent::CreateTarget,
        )?;
        changed |= original_previous_path != normalized_previous_path.state_path;
        tracked_file.previous_path = Some(normalized_previous_path.state_path);
    }

    if changed {
        *tracked_file = sync_tracked_file(tracked_file);
    }
    Ok(changed)
}

fn normalize_review_path(
    session: &NativeAiSession,
    candidate: &str,
    intent: ScopedPathIntent,
) -> Result<NormalizedReviewPath, NativeError> {
    let candidate_path = Path::new(candidate);
    if candidate_path.is_absolute() {
        return normalize_absolute_review_path(session, candidate_path, candidate, intent);
    }

    let resolved = resolve_scoped_path(
        Path::new(&session.scope.cwd),
        Some(candidate),
        false,
        intent,
    )
    .map_err(review_path_error)?;
    let Some(state_path) = resolved.relative_path else {
        return Err(invalid_review_path());
    };
    Ok(NormalizedReviewPath {
        absolute_path: resolved.absolute_path,
        state_path,
    })
}

fn normalize_absolute_review_path(
    session: &NativeAiSession,
    candidate_path: &Path,
    candidate_display: &str,
    intent: ScopedPathIntent,
) -> Result<NormalizedReviewPath, NativeError> {
    if let Some(normalized) = normalize_absolute_path_inside_root(
        Path::new(&session.scope.cwd),
        candidate_path,
        intent,
        AbsoluteReviewPathMode::ProjectRelative,
    )? {
        return Ok(normalized);
    }

    for root in &session.scope.additional_roots {
        if let Some(normalized) = normalize_absolute_path_inside_root(
            Path::new(root),
            candidate_path,
            intent,
            AbsoluteReviewPathMode::KeepAbsolute(candidate_display),
        )? {
            return Ok(normalized);
        }
    }

    Err(NativeError::new(
        NativeErrorCode::PermissionDenied,
        "Cannot safely apply this review change because the path is outside the project.",
    ))
}

#[derive(Debug, Clone, Copy)]
enum AbsoluteReviewPathMode<'a> {
    ProjectRelative,
    KeepAbsolute(&'a str),
}

fn normalize_absolute_path_inside_root(
    root: &Path,
    candidate_path: &Path,
    intent: ScopedPathIntent,
    mode: AbsoluteReviewPathMode<'_>,
) -> Result<Option<NormalizedReviewPath>, NativeError> {
    let Ok(relative) = candidate_path.strip_prefix(root) else {
        return Ok(None);
    };
    let relative_path = normalize_relative_path(relative);
    let resolved = resolve_scoped_path(root, Some(&relative_path), false, intent)
        .map_err(review_path_error)?;
    let Some(resolved_relative_path) = resolved.relative_path else {
        return Err(invalid_review_path());
    };
    let state_path = match mode {
        AbsoluteReviewPathMode::ProjectRelative => resolved_relative_path,
        AbsoluteReviewPathMode::KeepAbsolute(candidate_display) => candidate_display.to_string(),
    };
    Ok(Some(NormalizedReviewPath {
        absolute_path: resolved.absolute_path,
        state_path,
    }))
}

fn invalid_review_path() -> NativeError {
    NativeError::new(
        NativeErrorCode::InvalidArgs,
        "Cannot safely apply this review change because the path is invalid.",
    )
}

fn review_path_error(error: comando_fs::FsError) -> NativeError {
    match error {
        comando_fs::FsError::NotFound => {
            NativeError::new(NativeErrorCode::NotFound, "Review file was not found.")
        }
        comando_fs::FsError::PathEscape => NativeError::new(
            NativeErrorCode::PermissionDenied,
            "Cannot safely apply this review change because the path is outside the project.",
        ),
        comando_fs::FsError::InvalidPath => NativeError::new(
            NativeErrorCode::InvalidArgs,
            "Cannot safely apply this review change because the path is invalid.",
        ),
        _ => error.to_native_error(),
    }
}

fn review_not_found(path: &str) -> NativeError {
    NativeError::new(
        NativeErrorCode::NotFound,
        "The file to review was not found.",
    )
    .with_details(json!({ "path": path }))
}

fn review_conflict(path: &str, reason: &str, external_change_hash: Option<String>) -> NativeError {
    NativeError::new(
        NativeErrorCode::Conflict,
        "Cannot safely apply this review change because the file no longer matches the reviewed content.",
    )
    .with_details(json!({
        "conflict": {
            "externalChangeHash": external_change_hash,
            "path": path,
            "reason": reason
        }
    }))
}

fn review_io(action: &str, path: &Path, error: std::io::Error) -> NativeError {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => NativeErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => NativeErrorCode::PermissionDenied,
        _ => NativeErrorCode::InternalError,
    };
    NativeError::new(code, format!("Native review failed to {action}: {error}"))
        .with_details(json!({ "path": path.to_string_lossy() }))
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), NativeError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| review_io("create review state directory", parent, error))?;
    }
    let temp_path = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(value).map_err(|error| {
        NativeError::new(
            NativeErrorCode::InternalError,
            format!("Native review state serialization failed: {error}"),
        )
    })?;
    let mut file = fs::File::create(&temp_path)
        .map_err(|error| review_io("create review state temp file", &temp_path, error))?;
    file.write_all(&json)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|error| review_io("write review state temp file", &temp_path, error))?;
    fs::rename(&temp_path, path).map_err(|error| review_io("replace review state", path, error))
}

fn now() -> String {
    comando_persistence::store::now_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use comando_ai::scope::SessionScope;
    use comando_types::ai::NativeAiSessionStatus;

    #[test]
    fn upserts_by_path_accumulates_changes() {
        let mut files = Vec::new();
        let first = compute_tracked_file_patch(
            "s",
            "a.txt",
            None,
            Some("a\n".to_string()),
            Some("b\n".to_string()),
            now(),
        )
        .expect("first");
        let second = compute_tracked_file_patch(
            "s",
            "a.txt",
            None,
            Some("b\n".to_string()),
            Some("c\n".to_string()),
            now(),
        )
        .expect("second");
        upsert_tracked_file(&mut files, first);
        upsert_tracked_file(&mut files, second);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].version, Some(2));
        assert_eq!(files[0].old_text.as_deref(), Some("a\n"));
        assert_eq!(files[0].new_text.as_deref(), Some("c\n"));
    }

    #[test]
    fn record_diffs_is_idempotent_for_same_tool_call() {
        let repo = tempfile::tempdir().expect("tempdir");
        let session = test_session(repo.path(), "s-idempotent");
        let mut service = service_with_app_data(repo.path());
        fs::write(repo.path().join("a.txt"), "agent\n").expect("write agent");

        let first = record_file_change(&mut service, &session, "a.txt", "base\n", "agent\n");
        let second = record_file_change(&mut service, &session, "a.txt", "base\n", "agent\n");

        assert_eq!(first.tracked_files.len(), 1);
        assert_eq!(first.tracked_file_events.len(), 1);
        assert_eq!(second.tracked_files.len(), 1);
        assert!(second.tracked_file_events.is_empty());
        assert_eq!(second.tracked_files[0].version, Some(1));
    }

    #[test]
    fn record_diffs_create_and_reject_deletes_it() {
        let repo = tempfile::tempdir().expect("tempdir");
        let session = test_session(repo.path(), "s-create");
        let mut service = service_with_app_data(repo.path());

        let file_path = repo.path().join("new.txt");
        fs::write(&file_path, "new file\n").expect("write new file");
        let output = record_file_create(&mut service, &session, "new.txt", "new file\n");
        assert_eq!(output.tracked_files.len(), 1);
        assert_eq!(output.tracked_files[0].path, "new.txt");
        assert_eq!(output.tracked_files[0].kind, ReviewTrackedFileKind::Create);

        let tracker = WriteTracker::new();
        service
            .reject_file(
                &session,
                NativeReviewFileMutationInput {
                    session_id: session.session_id.clone(),
                    path: "new.txt".to_string(),
                    tracked_file_id: None,
                    expected_version: None,
                },
                &tracker,
            )
            .expect("reject create");
        assert!(!file_path.exists());
    }

    #[test]
    fn keep_file_accepts_drift_without_writing_disk() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "base\n").expect("write base");
        let session = test_session(repo.path(), "s-keep-drift");
        let mut service = service_with_app_data(repo.path());
        fs::write(repo.path().join("a.txt"), "agent\n").expect("write agent");
        let output = record_file_change(&mut service, &session, "a.txt", "base\n", "agent\n");
        assert_eq!(output.tracked_files.len(), 1);

        fs::write(repo.path().join("a.txt"), "agent + user\n").expect("write drift");
        let kept = service
            .keep_file(
                &session,
                NativeReviewFileMutationInput {
                    session_id: session.session_id.clone(),
                    path: "a.txt".to_string(),
                    tracked_file_id: None,
                    expected_version: None,
                },
            )
            .expect("keep drifted file");

        assert!(kept.tracked_files.is_empty());
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).expect("read file"),
            "agent + user\n"
        );
    }

    #[test]
    fn keep_all_accepts_drift_without_writing_disk() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "base a\n").expect("write base a");
        fs::write(repo.path().join("b.txt"), "base b\n").expect("write base b");
        let session = test_session(repo.path(), "s-keep-all-drift");
        let mut service = service_with_app_data(repo.path());
        fs::write(repo.path().join("a.txt"), "agent a\n").expect("write agent a");
        fs::write(repo.path().join("b.txt"), "agent b\n").expect("write agent b");
        record_file_change(&mut service, &session, "a.txt", "base a\n", "agent a\n");
        let output = record_file_change(&mut service, &session, "b.txt", "base b\n", "agent b\n");
        assert_eq!(output.tracked_files.len(), 2);

        fs::write(repo.path().join("a.txt"), "agent a + user\n").expect("write drift a");
        fs::write(repo.path().join("b.txt"), "agent b + user\n").expect("write drift b");
        let kept = service.keep_all(&session).expect("keep all drifted files");

        assert!(kept.tracked_files.is_empty());
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).expect("read a"),
            "agent a + user\n"
        );
        assert_eq!(
            fs::read_to_string(repo.path().join("b.txt")).expect("read b"),
            "agent b + user\n"
        );
    }

    #[test]
    fn keep_file_clears_standalone_conflict() {
        let repo = tempfile::tempdir().expect("tempdir");
        let session = test_session(repo.path(), "s-keep-conflict");
        let mut service = service_with_app_data(repo.path());
        service
            .replace_state(
                &session,
                Vec::new(),
                vec![NativeReviewConflict {
                    path: "a.txt".to_string(),
                    reason: "content_hash_mismatch".to_string(),
                    external_change_hash: None,
                }],
                now(),
                None,
            )
            .expect("seed conflict");

        let kept = service
            .keep_file(
                &session,
                NativeReviewFileMutationInput {
                    session_id: session.session_id.clone(),
                    path: "a.txt".to_string(),
                    tracked_file_id: None,
                    expected_version: None,
                },
            )
            .expect("keep standalone conflict");

        assert!(kept.tracked_files.is_empty());
        assert!(kept.conflicts.is_empty());
    }

    #[test]
    fn keep_all_clears_standalone_conflicts() {
        let repo = tempfile::tempdir().expect("tempdir");
        let session = test_session(repo.path(), "s-keep-all-conflicts");
        let mut service = service_with_app_data(repo.path());
        service
            .replace_state(
                &session,
                Vec::new(),
                vec![
                    NativeReviewConflict {
                        path: "a.txt".to_string(),
                        reason: "content_hash_mismatch".to_string(),
                        external_change_hash: None,
                    },
                    NativeReviewConflict {
                        path: "b.txt".to_string(),
                        reason: "binary_file".to_string(),
                        external_change_hash: None,
                    },
                ],
                now(),
                None,
            )
            .expect("seed conflicts");

        let kept = service.keep_all(&session).expect("keep all conflicts");

        assert!(kept.tracked_files.is_empty());
        assert!(kept.conflicts.is_empty());
    }

    #[test]
    fn keep_hunks_accepts_drift_without_writing_disk() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "base\n").expect("write base");
        let session = test_session(repo.path(), "s-keep-hunks-drift");
        let mut service = service_with_app_data(repo.path());
        fs::write(repo.path().join("a.txt"), "agent\n").expect("write agent");
        let output = record_file_change(&mut service, &session, "a.txt", "base\n", "agent\n");
        let hunk_id = output.tracked_files[0].hunks[0].id.clone();

        fs::write(repo.path().join("a.txt"), "agent + user\n").expect("write drift");
        let kept = service
            .keep_hunks(
                &session,
                NativeReviewHunkMutationInput {
                    session_id: session.session_id.clone(),
                    path: "a.txt".to_string(),
                    hunk_ids: vec![hunk_id],
                    tracked_file_id: None,
                    expected_version: None,
                },
            )
            .expect("keep drifted hunk");

        assert!(kept.tracked_files.is_empty());
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).expect("read file"),
            "agent + user\n"
        );
    }

    #[test]
    fn reject_file_still_blocks_drift() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "base\n").expect("write base");
        let session = test_session(repo.path(), "s-reject-drift");
        let mut service = service_with_app_data(repo.path());
        fs::write(repo.path().join("a.txt"), "agent\n").expect("write agent");
        let output = record_file_change(&mut service, &session, "a.txt", "base\n", "agent\n");
        assert_eq!(output.tracked_files.len(), 1);

        fs::write(repo.path().join("a.txt"), "agent + user\n").expect("write drift");
        let tracker = WriteTracker::new();
        let error = service
            .reject_file(
                &session,
                NativeReviewFileMutationInput {
                    session_id: session.session_id.clone(),
                    path: "a.txt".to_string(),
                    tracked_file_id: None,
                    expected_version: None,
                },
                &tracker,
            )
            .expect_err("reject should block drift");

        assert_eq!(error.code, NativeErrorCode::Conflict);
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).expect("read file"),
            "agent + user\n"
        );
        let loaded = service
            .list_tracked_files(&session)
            .expect("load state after reject conflict");
        assert_eq!(loaded.tracked_files.len(), 1);
    }

    #[test]
    fn reject_all_still_blocks_drift_without_partial_writes() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "base a\n").expect("write base a");
        fs::write(repo.path().join("b.txt"), "base b\n").expect("write base b");
        let session = test_session(repo.path(), "s-reject-all-drift");
        let mut service = service_with_app_data(repo.path());
        fs::write(repo.path().join("a.txt"), "agent a\n").expect("write agent a");
        fs::write(repo.path().join("b.txt"), "agent b\n").expect("write agent b");
        record_file_change(&mut service, &session, "a.txt", "base a\n", "agent a\n");
        let output = record_file_change(&mut service, &session, "b.txt", "base b\n", "agent b\n");
        assert_eq!(output.tracked_files.len(), 2);

        fs::write(repo.path().join("b.txt"), "agent b + user\n").expect("write drift b");
        let tracker = WriteTracker::new();
        let error = service
            .reject_all(&session, &tracker)
            .expect_err("reject all should block drift");

        assert_eq!(error.code, NativeErrorCode::Conflict);
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).expect("read a"),
            "agent a\n"
        );
        assert_eq!(
            fs::read_to_string(repo.path().join("b.txt")).expect("read b"),
            "agent b + user\n"
        );
        let loaded = service
            .list_tracked_files(&session)
            .expect("load state after reject all conflict");
        assert_eq!(loaded.tracked_files.len(), 2);
    }

    #[test]
    fn reject_hunks_still_blocks_drift() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "base\n").expect("write base");
        let session = test_session(repo.path(), "s-reject-hunks-drift");
        let mut service = service_with_app_data(repo.path());
        fs::write(repo.path().join("a.txt"), "agent\n").expect("write agent");
        let output = record_file_change(&mut service, &session, "a.txt", "base\n", "agent\n");
        let hunk_id = output.tracked_files[0].hunks[0].id.clone();

        fs::write(repo.path().join("a.txt"), "agent + user\n").expect("write drift");
        let tracker = WriteTracker::new();
        let error = service
            .reject_hunks(
                &session,
                NativeReviewHunkMutationInput {
                    session_id: session.session_id.clone(),
                    path: "a.txt".to_string(),
                    hunk_ids: vec![hunk_id],
                    tracked_file_id: None,
                    expected_version: None,
                },
                &tracker,
            )
            .expect_err("reject hunk should block drift");

        assert_eq!(error.code, NativeErrorCode::Conflict);
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).expect("read file"),
            "agent + user\n"
        );
        let loaded = service
            .list_tracked_files(&session)
            .expect("load state after reject hunk conflict");
        assert_eq!(loaded.tracked_files.len(), 1);
    }

    #[test]
    fn concurrent_baselines_do_not_import_new_peer_changes() {
        let repo = tempfile::tempdir().expect("tempdir");
        let session_a = test_session(repo.path(), "s-peer-a");
        let session_b = test_session(repo.path(), "s-peer-b");
        let mut service = service_with_app_data(repo.path());

        service.capture_baseline(&session_a).expect("baseline a");
        service.capture_baseline(&session_b).expect("baseline b");
        fs::write(repo.path().join("peer.txt"), "peer change\n").expect("write peer file");

        let output = service
            .reconcile_tracked_files(&session_b)
            .expect("reconcile b");

        assert!(output.tracked_files.is_empty());
        assert!(output.tracked_file_events.is_empty());
        assert!(output.conflicts.is_empty());
    }

    #[test]
    fn concurrent_sessions_keep_exact_changes_separate() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "base\n").expect("write base");
        let session_a = test_session(repo.path(), "s-existing-peer");
        let session_b = test_session(repo.path(), "s-existing-owner");
        let mut service = service_with_app_data(repo.path());

        let first = record_file_change(&mut service, &session_b, "a.txt", "base\n", "owned\n");
        let second = record_file_change(&mut service, &session_a, "a.txt", "base\n", "peer\n");

        assert_eq!(first.tracked_files[0].session_id, session_b.session_id.0);
        assert_eq!(first.tracked_files[0].new_text.as_deref(), Some("owned\n"));
        assert_eq!(second.tracked_files[0].session_id, session_a.session_id.0);
        assert_eq!(second.tracked_files[0].new_text.as_deref(), Some("peer\n"));
    }

    #[test]
    fn reconcile_preserves_pending_when_current_file_is_unsupported() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "agent\n").expect("write text");
        let session = test_session(repo.path(), "s-unsupported-current");
        let mut service = service_with_app_data(repo.path());
        record_file_change(&mut service, &session, "a.txt", "base\n", "agent\n");
        fs::write(repo.path().join("a.txt"), b"\0not text").expect("make binary");

        let output = service
            .reconcile_tracked_files(&session)
            .expect("reconcile");

        assert_eq!(output.tracked_files.len(), 1);
        assert_eq!(output.tracked_files[0].path, "a.txt");
        assert!(output.conflicts.is_empty());
    }

    #[test]
    fn baseline_allows_preexisting_dirty_binary_file() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("binary.bin"), b"\0already dirty").expect("dirty binary");

        let session = test_session(repo.path(), "s-preexisting-binary");
        let mut service = service_with_app_data(repo.path());
        let captured = service.capture_baseline(&session).expect("baseline");
        assert!(captured.captured);

        let output = service
            .reconcile_tracked_files(&session)
            .expect("reconcile");

        assert!(output.tracked_files.is_empty());
        assert!(output.conflicts.is_empty());
    }

    #[test]
    fn record_diffs_rejects_invalid_text_payload() {
        let repo = tempfile::tempdir().expect("tempdir");
        let session = test_session(repo.path(), "s-invalid-text");
        let mut service = service_with_app_data(repo.path());
        let error = service
            .record_diffs(
                &session,
                NativeReviewRecordDiffsInput {
                    session_id: session.session_id.clone(),
                    review_root: None,
                    tool_call_id: Some("tool-1".to_string()),
                    updated_at: Some(now()),
                    diffs: vec![NativeReviewExactDiffInput {
                        path: "a.txt".to_string(),
                        previous_path: None,
                        old_text: Some("base\n".to_string()),
                        new_text: Some("bad\0text".to_string()),
                        is_text: true,
                    }],
                },
            )
            .expect_err("invalid text should fail");

        assert_eq!(error.code, NativeErrorCode::BinaryFile);
    }

    #[test]
    fn record_diffs_uses_review_root_for_project_relative_paths() {
        let repo = tempfile::tempdir().expect("tempdir");
        let cwd = repo.path().join("packages").join("app");
        let source_dir = repo.path().join("src");
        fs::create_dir_all(&cwd).expect("create cwd");
        fs::create_dir_all(&source_dir).expect("create src");
        let file_path = source_dir.join("foo.ts");
        fs::write(&file_path, "agent\n").expect("write agent text");
        let wrong_cwd_path = cwd.join("src").join("foo.ts");
        let session = test_session(&cwd, "s-review-root");
        let mut service = service_with_app_data(repo.path());
        let review_root = repo.path().to_string_lossy().to_string();

        let first = service
            .record_diffs(
                &session,
                NativeReviewRecordDiffsInput {
                    session_id: session.session_id.clone(),
                    review_root: Some(review_root.clone()),
                    tool_call_id: Some("tool-1".to_string()),
                    updated_at: Some(now()),
                    diffs: vec![NativeReviewExactDiffInput {
                        path: "src/foo.ts".to_string(),
                        previous_path: None,
                        old_text: Some("base\n".to_string()),
                        new_text: Some("agent\n".to_string()),
                        is_text: true,
                    }],
                },
            )
            .expect("record project-root diff");
        assert_eq!(first.tracked_files[0].path, "src/foo.ts");

        fs::write(&file_path, "base\n").expect("restore root text");
        let reconciled = service
            .reconcile_tracked_files(&session)
            .expect("reconcile project-root diff");
        assert!(reconciled.tracked_files.is_empty());
        assert!(!wrong_cwd_path.exists());

        fs::write(&file_path, "agent\n").expect("write agent text again");
        service
            .record_diffs(
                &session,
                NativeReviewRecordDiffsInput {
                    session_id: session.session_id.clone(),
                    review_root: Some(review_root),
                    tool_call_id: Some("tool-2".to_string()),
                    updated_at: Some(now()),
                    diffs: vec![NativeReviewExactDiffInput {
                        path: "src/foo.ts".to_string(),
                        previous_path: None,
                        old_text: Some("base\n".to_string()),
                        new_text: Some("agent\n".to_string()),
                        is_text: true,
                    }],
                },
            )
            .expect("record project-root diff again");
        let tracker = WriteTracker::new();
        service
            .reject_file(
                &session,
                NativeReviewFileMutationInput {
                    session_id: session.session_id.clone(),
                    path: "src/foo.ts".to_string(),
                    tracked_file_id: None,
                    expected_version: None,
                },
                &tracker,
            )
            .expect("reject project-root diff");

        assert_eq!(
            fs::read_to_string(&file_path).expect("read project-root file"),
            "base\n"
        );
        assert!(!wrong_cwd_path.exists());
    }

    #[test]
    fn reconcile_removes_pending_file_when_later_turn_restores_base() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "base\n").expect("write text");
        let session = test_session(repo.path(), "s-net-zero");
        let mut service = service_with_app_data(repo.path());
        fs::write(repo.path().join("a.txt"), "agent\n").expect("modify text");
        let first = record_file_change(&mut service, &session, "a.txt", "base\n", "agent\n");
        assert_eq!(first.tracked_files.len(), 1);
        assert_eq!(first.tracked_files[0].old_text.as_deref(), Some("base\n"));
        assert_eq!(first.tracked_files[0].new_text.as_deref(), Some("agent\n"));

        fs::write(repo.path().join("a.txt"), "base\n").expect("restore text");
        let second = service
            .reconcile_tracked_files(&session)
            .expect("second reconcile");

        assert!(second.tracked_files.is_empty());
        assert!(second.conflicts.is_empty());
        assert!(second.state_found);
    }

    #[test]
    fn reconcile_preserves_pending_file_when_later_turn_leaves_it_unchanged() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "base\n").expect("write text");
        let session = test_session(repo.path(), "s-preserve-pending");
        let mut service = service_with_app_data(repo.path());
        fs::write(repo.path().join("a.txt"), "agent\n").expect("modify text");
        let first = record_file_change(&mut service, &session, "a.txt", "base\n", "agent\n");
        assert_eq!(first.tracked_files.len(), 1);

        let second = service
            .reconcile_tracked_files(&session)
            .expect("second reconcile");

        assert_eq!(second.tracked_files.len(), 1);
        assert_eq!(second.tracked_files[0].path, "a.txt");
        assert_eq!(second.tracked_files[0].old_text.as_deref(), Some("base\n"));
        assert_eq!(second.tracked_files[0].new_text.as_deref(), Some("agent\n"));
        assert!(second.conflicts.is_empty());
        assert!(second.state_found);
    }

    #[test]
    fn legacy_absolute_review_state_accepts_hunk_mutation_after_load() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("Fliege font.md"), "agent\n").expect("write text");

        let session = test_session(repo.path(), "s-legacy-absolute-hunk");
        let service = service_with_app_data(repo.path());
        let absolute_path = repo
            .path()
            .join("Fliege font.md")
            .to_string_lossy()
            .to_string();
        let tracked_file = compute_tracked_file_patch(
            &session.session_id.0,
            &absolute_path,
            None,
            Some("base\n".to_string()),
            Some("agent\n".to_string()),
            now(),
        )
        .expect("tracked file");
        let legacy_hunk_id = tracked_file.hunks[0].id.clone();
        let mut legacy_state = empty_state(&session, now());
        legacy_state.tracked_files = vec![tracked_file];
        let state_path = service
            .review_state_path(&session.session_id)
            .expect("state path");
        fs::create_dir_all(state_path.parent().expect("state parent"))
            .expect("create state parent");
        fs::write(
            &state_path,
            serde_json::to_vec_pretty(&legacy_state).expect("serialize state"),
        )
        .expect("write legacy state");

        let mut service = service_with_app_data(repo.path());
        let loaded = service
            .list_tracked_files(&session)
            .expect("load migrated state");
        assert_eq!(loaded.tracked_files.len(), 1);
        assert_eq!(loaded.tracked_files[0].path, "Fliege font.md");
        assert!(
            loaded.tracked_files[0].hunks[0]
                .id
                .starts_with("Fliege font.md:")
        );

        let kept = service
            .keep_hunks(
                &session,
                NativeReviewHunkMutationInput {
                    session_id: session.session_id.clone(),
                    path: absolute_path,
                    hunk_ids: vec![legacy_hunk_id],
                    tracked_file_id: None,
                    expected_version: None,
                },
            )
            .expect("keep legacy hunk");

        assert!(kept.tracked_files.is_empty());
    }

    #[test]
    fn legacy_absolute_review_state_rejects_hunk_after_load() {
        let repo = tempfile::tempdir().expect("tempdir");
        let file_path = repo.path().join("a.txt");
        fs::write(&file_path, "agent\n").expect("write text");

        let session = test_session(repo.path(), "s-legacy-absolute-reject-hunk");
        let service = service_with_app_data(repo.path());
        let absolute_path = file_path.to_string_lossy().to_string();
        let tracked_file = compute_tracked_file_patch(
            &session.session_id.0,
            &absolute_path,
            None,
            Some("base\n".to_string()),
            Some("agent\n".to_string()),
            now(),
        )
        .expect("tracked file");
        let legacy_hunk_id = tracked_file.hunks[0].id.clone();
        let mut legacy_state = empty_state(&session, now());
        legacy_state.tracked_files = vec![tracked_file];
        let state_path = service
            .review_state_path(&session.session_id)
            .expect("state path");
        fs::create_dir_all(state_path.parent().expect("state parent"))
            .expect("create state parent");
        fs::write(
            &state_path,
            serde_json::to_vec_pretty(&legacy_state).expect("serialize state"),
        )
        .expect("write legacy state");

        let mut service = service_with_app_data(repo.path());
        let tracker = WriteTracker::new();
        let rejected = service
            .reject_hunks(
                &session,
                NativeReviewHunkMutationInput {
                    session_id: session.session_id.clone(),
                    path: absolute_path,
                    hunk_ids: vec![legacy_hunk_id],
                    tracked_file_id: None,
                    expected_version: None,
                },
                &tracker,
            )
            .expect("reject legacy hunk");

        assert!(rejected.tracked_files.is_empty());
        assert_eq!(fs::read_to_string(file_path).expect("read text"), "base\n");
    }

    fn service_with_app_data(repo_path: &Path) -> NativeReviewService {
        let mut service = NativeReviewService::default();
        service.set_app_data_dir(repo_path.join(".app-data"));
        service
    }

    fn test_session(repo_path: &Path, session_id: &str) -> NativeAiSession {
        test_session_with_additional_roots(repo_path, session_id, Vec::new())
    }

    fn test_session_with_additional_roots(
        repo_path: &Path,
        session_id: &str,
        additional_roots: Vec<String>,
    ) -> NativeAiSession {
        NativeAiSession {
            owner_window_id: "window-1".to_string(),
            runtime_id: "codex".into(),
            runtime_session_id: None,
            scope: SessionScope::new(
                None,
                None,
                repo_path.to_string_lossy().to_string(),
                additional_roots,
            )
            .expect("scope"),
            session_id: session_id.into(),
            status: NativeAiSessionStatus::Idle,
            title: "Test session".to_string(),
            updated_at: now(),
        }
    }

    fn record_file_change(
        service: &mut NativeReviewService,
        session: &NativeAiSession,
        path: &str,
        old_text: &str,
        new_text: &str,
    ) -> NativeReviewCommandOutput {
        record_diff(
            service,
            session,
            NativeReviewExactDiffInput {
                path: path.to_string(),
                previous_path: None,
                old_text: Some(old_text.to_string()),
                new_text: Some(new_text.to_string()),
                is_text: true,
            },
        )
    }

    fn record_file_create(
        service: &mut NativeReviewService,
        session: &NativeAiSession,
        path: &str,
        new_text: &str,
    ) -> NativeReviewCommandOutput {
        record_diff(
            service,
            session,
            NativeReviewExactDiffInput {
                path: path.to_string(),
                previous_path: None,
                old_text: None,
                new_text: Some(new_text.to_string()),
                is_text: true,
            },
        )
    }

    fn record_diff(
        service: &mut NativeReviewService,
        session: &NativeAiSession,
        diff: NativeReviewExactDiffInput,
    ) -> NativeReviewCommandOutput {
        service
            .record_diffs(
                session,
                NativeReviewRecordDiffsInput {
                    session_id: session.session_id.clone(),
                    review_root: None,
                    tool_call_id: Some("tool-1".to_string()),
                    updated_at: Some(now()),
                    diffs: vec![diff],
                },
            )
            .expect("record diff")
    }
}
