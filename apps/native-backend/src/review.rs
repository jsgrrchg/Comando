use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use comando_ai::history::AiHistoryStore;
use comando_ai::session::NativeAiSession;
use comando_diff::review::{sync_tracked_file, tracked_diff_base};
use comando_diff::{
    ReviewDecision, ReviewTrackedFile, ReviewTrackedFileKind, ReviewTrackedFileStatus,
    compute_tracked_file_patch, resolve_tracked_file_hunks, tracked_current_text,
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
    baselines: HashMap<String, NativeReviewBaseline>,
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
pub struct NativeReviewImportStateInput {
    pub session_id: SessionId,
    pub tracked_files: Vec<ReviewTrackedFile>,
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
struct NativeReviewBaseline {
    cwd: PathBuf,
    files: HashMap<String, Option<String>>,
    unsupported_files: HashMap<String, UnsupportedReviewBaseline>,
}

#[derive(Debug, Clone)]
struct UnsupportedReviewBaseline {
    reason: String,
    fingerprint: Option<String>,
}

#[derive(Debug, Clone)]
struct NativeGitStatusEntry {
    code: String,
    path: String,
    previous_path: Option<String>,
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

    pub fn capture_baseline(
        &mut self,
        session: &NativeAiSession,
    ) -> Result<NativeReviewCaptureOutput, NativeError> {
        let updated_at = now();
        let entries = match list_git_status_entries(Path::new(&session.scope.cwd)) {
            Ok(entries) => entries,
            Err(_) => {
                self.baselines.remove(&session.session_id.0);
                return Ok(NativeReviewCaptureOutput {
                    captured: false,
                    session_id: session.session_id.clone(),
                    updated_at,
                });
            }
        };
        let mut files = HashMap::new();
        let mut unsupported_files = HashMap::new();
        for entry in entries {
            if !files.contains_key(&entry.path) {
                match self.read_working_tree_text(session, &entry.path) {
                    Ok(text) => {
                        files.insert(entry.path.clone(), text);
                    }
                    Err(error) if is_review_content_error(&error) => {
                        unsupported_files.insert(
                            entry.path.clone(),
                            UnsupportedReviewBaseline {
                                reason: content_error_reason(&error).to_string(),
                                fingerprint: self
                                    .read_working_tree_fingerprint(session, &entry.path)
                                    .ok()
                                    .flatten(),
                            },
                        );
                    }
                    Err(error) => return Err(error),
                }
            }
            if let Some(previous_path) = entry.previous_path
                && !files.contains_key(&previous_path)
            {
                match self.read_working_tree_text(session, &previous_path) {
                    Ok(text) => {
                        files.insert(previous_path.clone(), text);
                    }
                    Err(error) if is_review_content_error(&error) => {
                        unsupported_files.insert(
                            previous_path.clone(),
                            UnsupportedReviewBaseline {
                                reason: content_error_reason(&error).to_string(),
                                fingerprint: self
                                    .read_working_tree_fingerprint(session, &previous_path)
                                    .ok()
                                    .flatten(),
                            },
                        );
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        self.baselines.insert(
            session.session_id.0.clone(),
            NativeReviewBaseline {
                cwd: PathBuf::from(&session.scope.cwd),
                files,
                unsupported_files,
            },
        );
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
        let Some(baseline) = self.baselines.remove(&session.session_id.0) else {
            let loaded = self.load_or_empty_state_entry(session)?;
            let state = loaded.state;
            return Ok(command_output(
                session.session_id.clone(),
                state.tracked_files,
                Vec::new(),
                state.conflicts,
                now(),
                loaded.found,
                Vec::new(),
            ));
        };

        let status_entries = list_git_status_entries(&baseline.cwd)?;
        let status_entries = merge_candidate_entries(status_entries, &baseline);
        let updated_at = now();
        let loaded = self.load_or_empty_state_entry(session)?;
        let mut tracked_files = loaded.state.tracked_files;
        let mut conflicts = loaded.state.conflicts;
        let mut tracked_file_events = Vec::new();

        for entry in status_entries {
            let baseline_text = baseline_text_for_entry(&baseline, &entry);
            let unsupported_baseline = unsupported_baseline_for_entry(&baseline, &entry);
            let deleted = is_git_deleted(&entry);
            let current_text = if deleted {
                None
            } else {
                match self.read_working_tree_text(session, &entry.path) {
                    Ok(text) => text,
                    Err(error) if is_review_content_error(&error) => {
                        if let Some(unsupported) = unsupported_baseline
                            && self
                                .read_working_tree_fingerprint(session, &entry.path)
                                .ok()
                                .flatten()
                                == unsupported.fingerprint
                        {
                            if find_tracked_file_index(&tracked_files, &entry.path).is_some() {
                                record_review_conflict(
                                    &mut tracked_files,
                                    &mut conflicts,
                                    NativeReviewConflict {
                                        path: entry.path.clone(),
                                        reason: unsupported.reason.clone(),
                                        external_change_hash: None,
                                    },
                                );
                            }
                            continue;
                        }
                        record_review_conflict(
                            &mut tracked_files,
                            &mut conflicts,
                            conflict_for_content_error(&entry.path, &error),
                        );
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            };
            if let Some(unsupported) = unsupported_baseline {
                record_review_conflict(
                    &mut tracked_files,
                    &mut conflicts,
                    NativeReviewConflict {
                        path: entry.path.clone(),
                        reason: unsupported.reason.clone(),
                        external_change_hash: None,
                    },
                );
                continue;
            }
            if !deleted && current_text.is_none() && !baseline_text.known {
                continue;
            }

            let old_text = if baseline_text.known {
                baseline_text.text
            } else {
                match read_head_text(
                    &session.scope.cwd,
                    entry.previous_path.as_deref().unwrap_or(&entry.path),
                ) {
                    Ok(text) => text,
                    Err(error) if is_review_content_error(&error) => {
                        record_review_conflict(
                            &mut tracked_files,
                            &mut conflicts,
                            conflict_for_content_error(&entry.path, &error),
                        );
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            };
            let previous_path = entry
                .previous_path
                .filter(|previous_path| previous_path != &entry.path);

            if old_text.is_none() && current_text.is_none() && previous_path.is_none() {
                continue;
            }
            if previous_path.is_none()
                && old_text.is_some()
                && current_text.is_some()
                && old_text == current_text
            {
                continue;
            }

            let Some(mut tracked_file) = compute_tracked_file_patch(
                &session.session_id.0,
                &entry.path,
                previous_path,
                old_text,
                current_text.clone(),
                updated_at.clone(),
            ) else {
                continue;
            };
            tracked_file.current_content_hash = current_text
                .as_ref()
                .map(|text| hash_content_bytes(text.as_bytes()));
            tracked_file.expected_disk_hash = tracked_file.current_content_hash.clone();

            upsert_tracked_file(&mut tracked_files, tracked_file.clone());
            tracked_file_events.push(NativeTrackedFileUpdatedPayload {
                session_id: session.session_id.clone(),
                tracked_file,
                mutation: "updated".to_string(),
                updated_at: updated_at.clone(),
            });
        }

        let state = self.replace_state(session, tracked_files, conflicts, updated_at.clone())?;
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

    pub fn import_state_if_missing(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewImportStateInput,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        let loaded = self.load_or_empty_state_entry(session)?;
        if input.tracked_files.is_empty() {
            let state = loaded.state;
            return Ok(command_output(
                session.session_id.clone(),
                state.tracked_files,
                Vec::new(),
                state.conflicts,
                state.updated_at,
                loaded.found,
                Vec::new(),
            ));
        }

        let session_id = session.session_id.0.clone();
        let mut tracked_files = loaded.state.tracked_files;
        for mut file in input.tracked_files {
            normalize_imported_tracked_file_paths(session, &mut file)?;
            // Legacy snapshots may omit the session id on old review entries.
            if file.session_id.trim().is_empty() {
                file.session_id = session_id.clone();
            }
            upsert_tracked_file(&mut tracked_files, file);
        }
        let updated_at = now();
        let state = self.replace_state(
            session,
            tracked_files,
            loaded.state.conflicts,
            updated_at.clone(),
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

    pub fn keep_file(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewFileMutationInput,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        let mut state = self.load_or_empty_state(session)?;
        let index = find_tracked_file_index_for_input(session, &state.tracked_files, &input.path)?
            .ok_or_else(|| review_not_found(&input.path))?;
        validate_version(&state.tracked_files[index], input.expected_version)?;
        self.assert_current_matches(session, &state.tracked_files[index])?;
        let mut tracked_file = state.tracked_files.remove(index);
        tracked_file.review_state = ReviewTrackedFileStatus::Kept;
        tracked_file.updated_at = now();
        let updated_at = tracked_file.updated_at.clone();
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
        let index = find_tracked_file_index_for_input(session, &state.tracked_files, &input.path)?
            .ok_or_else(|| review_not_found(&input.path))?;
        validate_version(&state.tracked_files[index], input.expected_version)?;
        let tracked_file = state.tracked_files.remove(index);
        let changed_files = self.revert_tracked_file(session, &tracked_file, write_tracker)?;
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
        for tracked_file in &state.tracked_files {
            self.assert_current_matches(session, tracked_file)?;
        }
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
            self.assert_current_matches(session, tracked_file)?;
            self.assert_move_previous_path_available(session, tracked_file)?;
        }
        let backups = self.create_rollback_backups(session, &state.tracked_files)?;
        let tracked_files = state.tracked_files.clone();
        let mut changed_files = Vec::new();
        if let Err(error) = tracked_files.iter().try_for_each(|tracked_file| {
            self.revert_tracked_file(session, tracked_file, write_tracker)
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
        let index = find_tracked_file_index_for_input(session, &state.tracked_files, &input.path)?
            .ok_or_else(|| review_not_found(&input.path))?;
        validate_version(&state.tracked_files[index], input.expected_version)?;
        let tracked_file = state.tracked_files[index].clone();
        self.assert_current_matches(session, &tracked_file)?;
        let updated_at = now();
        let hunk_ids = normalize_review_hunk_ids(session, &input.hunk_ids, &tracked_file.path);
        let next = resolve_tracked_file_hunks(
            &tracked_file,
            &hunk_ids,
            decision.clone(),
            updated_at.clone(),
        );
        let mut changed_files = Vec::new();
        match decision {
            ReviewDecision::Keep => {
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
    ) -> Result<NativeReviewSessionState, NativeError> {
        let mut state = empty_state(session, updated_at.clone());
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
        review_path: &str,
    ) -> Result<Option<String>, NativeError> {
        let resolved =
            match resolve_review_path(session, review_path, ScopedPathIntent::ReadExisting) {
                Ok(path) => path,
                Err(error) if error.code == NativeErrorCode::NotFound => return Ok(None),
                Err(error) => return Err(error),
            };
        if let Some(buffer) = self.open_buffers.get(&resolved) {
            return ensure_review_text(buffer.clone(), review_path);
        }
        read_text_file_for_review(&resolved, review_path)
    }

    fn read_working_tree_fingerprint(
        &self,
        session: &NativeAiSession,
        review_path: &str,
    ) -> Result<Option<String>, NativeError> {
        let resolved =
            match resolve_review_path(session, review_path, ScopedPathIntent::ReadExisting) {
                Ok(path) => path,
                Err(error) if error.code == NativeErrorCode::NotFound => return Ok(None),
                Err(error) => return Err(error),
            };
        if let Some(buffer) = self.open_buffers.get(&resolved) {
            return Ok(Some(format!(
                "buffer:{}:{}",
                buffer.len(),
                hash_content_bytes(buffer.as_bytes())
            )));
        }
        let metadata = fs::metadata(&resolved)
            .map_err(|error| review_io("read review file metadata", &resolved, error))?;
        if !metadata.is_file() {
            return Ok(None);
        }
        if metadata.len() <= MAX_REVIEW_TEXT_BYTES {
            let bytes = fs::read(&resolved)
                .map_err(|error| review_io("read review file", &resolved, error))?;
            return Ok(Some(format!(
                "file-bytes:{}:{}",
                bytes.len(),
                hash_content_bytes(&bytes)
            )));
        }
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        Ok(Some(format!("file:{}:{modified_ms}", metadata.len())))
    }

    fn assert_current_matches(
        &self,
        session: &NativeAiSession,
        tracked_file: &ReviewTrackedFile,
    ) -> Result<(), NativeError> {
        let expected = match tracked_file.kind {
            ReviewTrackedFileKind::Delete => None,
            _ => Some(tracked_current_text(tracked_file)),
        };
        let current = self.read_working_tree_text(session, &tracked_file.path)?;
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
        tracked_file: &ReviewTrackedFile,
    ) -> Result<(), NativeError> {
        if tracked_file.kind != ReviewTrackedFileKind::Move {
            return Ok(());
        }
        let Some(previous_path) = tracked_file.previous_path.as_deref() else {
            return Ok(());
        };
        if self
            .read_working_tree_text(session, previous_path)?
            .is_some()
        {
            return Err(review_conflict(previous_path, "path_exists", None));
        }
        Ok(())
    }

    fn revert_tracked_file(
        &mut self,
        session: &NativeAiSession,
        tracked_file: &ReviewTrackedFile,
        write_tracker: &WriteTracker,
    ) -> Result<Vec<String>, NativeError> {
        self.assert_current_matches(session, tracked_file)?;
        self.assert_move_previous_path_available(session, tracked_file)?;
        let mut changed = Vec::new();
        match tracked_file.kind {
            ReviewTrackedFileKind::Create => {
                self.remove_review_file(session, &tracked_file.path, write_tracker)?;
                changed.push(tracked_file.path.clone());
            }
            ReviewTrackedFileKind::Delete | ReviewTrackedFileKind::Update => {
                let old_text = tracked_file
                    .old_text
                    .as_deref()
                    .ok_or_else(|| review_conflict(&tracked_file.path, "not_reversible", None))?;
                self.write_review_text(session, &tracked_file.path, old_text, write_tracker)?;
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
                self.remove_review_file(session, &tracked_file.path, write_tracker)?;
                self.write_review_text(session, previous_path, old_text, write_tracker)?;
                changed.push(tracked_file.path.clone());
                changed.push(previous_path.to_string());
            }
        }
        Ok(changed)
    }

    fn write_review_text(
        &mut self,
        session: &NativeAiSession,
        relative_path: &str,
        text: &str,
        write_tracker: &WriteTracker,
    ) -> Result<(), NativeError> {
        let resolved = resolve_review_path(session, relative_path, ScopedPathIntent::CreateTarget)?;
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
        relative_path: &str,
        write_tracker: &WriteTracker,
    ) -> Result<(), NativeError> {
        let resolved = resolve_review_path(session, relative_path, ScopedPathIntent::ReadExisting)?;
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
        tracked_files: &[ReviewTrackedFile],
    ) -> Result<Vec<RollbackBackup>, NativeError> {
        let mut paths = HashSet::new();
        let mut backups = Vec::new();
        for tracked_file in tracked_files {
            for relative_path in revert_paths(tracked_file) {
                let resolved =
                    resolve_review_path(session, &relative_path, ScopedPathIntent::CreateTarget)?;
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

fn record_review_conflict(
    tracked_files: &mut Vec<ReviewTrackedFile>,
    conflicts: &mut Vec<NativeReviewConflict>,
    conflict: NativeReviewConflict,
) {
    if let Some(index) = find_tracked_file_index(tracked_files, &conflict.path) {
        tracked_files.remove(index);
    }
    if !conflicts.iter().any(|entry| entry.path == conflict.path) {
        conflicts.push(conflict);
    }
}

fn merge_candidate_entries(
    status_entries: Vec<NativeGitStatusEntry>,
    baseline: &NativeReviewBaseline,
) -> Vec<NativeGitStatusEntry> {
    let mut covered_paths = HashSet::new();
    for entry in &status_entries {
        covered_paths.insert(entry.path.clone());
        if let Some(previous_path) = &entry.previous_path {
            covered_paths.insert(previous_path.clone());
        }
    }
    let mut entries = status_entries;
    for baseline_path in baseline.files.keys() {
        if !covered_paths.contains(baseline_path) {
            entries.push(NativeGitStatusEntry {
                code: "  ".to_string(),
                path: baseline_path.clone(),
                previous_path: None,
            });
        }
    }
    entries
}

struct BaselineText {
    known: bool,
    text: Option<String>,
}

fn baseline_text_for_entry(
    baseline: &NativeReviewBaseline,
    entry: &NativeGitStatusEntry,
) -> BaselineText {
    if let Some(text) = baseline.files.get(&entry.path) {
        return BaselineText {
            known: true,
            text: text.clone(),
        };
    }
    if let Some(previous_path) = &entry.previous_path
        && let Some(text) = baseline.files.get(previous_path)
    {
        return BaselineText {
            known: true,
            text: text.clone(),
        };
    }
    BaselineText {
        known: false,
        text: None,
    }
}

fn unsupported_baseline_for_entry<'a>(
    baseline: &'a NativeReviewBaseline,
    entry: &NativeGitStatusEntry,
) -> Option<&'a UnsupportedReviewBaseline> {
    baseline.unsupported_files.get(&entry.path).or_else(|| {
        entry
            .previous_path
            .as_ref()
            .and_then(|previous_path| baseline.unsupported_files.get(previous_path))
    })
}

fn list_git_status_entries(cwd: &Path) -> Result<Vec<NativeGitStatusEntry>, NativeError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .arg("status")
        .arg("--porcelain=v1")
        .arg("-z")
        .arg("--untracked-files=all")
        .output()
        .map_err(|error| review_io("run git status", cwd, error))?;
    if !output.status.success() {
        return Err(NativeError::new(
            NativeErrorCode::NotSupported,
            "Native review requires a Git working tree for reconciliation.",
        ));
    }
    Ok(parse_git_status_output(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn parse_git_status_output(output: &str) -> Vec<NativeGitStatusEntry> {
    let tokens = output.split('\0').collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        if token.len() < 4 || token.as_bytes().get(2) != Some(&b' ') {
            continue;
        }
        let code = token[..2].to_string();
        if code == "!!" {
            continue;
        }
        let mut path = token[3..].to_string();
        let mut previous_path = None;
        if code.contains('R') || code.contains('C') {
            if let Some(next) = tokens.get(index).filter(|value| !value.is_empty()) {
                previous_path = Some((*next).to_string());
                index += 1;
            } else if let Some(arrow_index) = path.find(" -> ") {
                previous_path = Some(path[..arrow_index].to_string());
                path = path[arrow_index + 4..].to_string();
            }
        }
        if !path.is_empty() {
            entries.push(NativeGitStatusEntry {
                code,
                path,
                previous_path,
            });
        }
    }
    entries
}

fn read_head_text(cwd: &str, relative_path: &str) -> Result<Option<String>, NativeError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .arg("show")
        .arg(format!("HEAD:{relative_path}"))
        .output()
        .map_err(|error| review_io("run git show", Path::new(cwd), error))?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8(output.stdout).map_err(|_| {
        NativeError::new(
            NativeErrorCode::NotSupported,
            "Cannot review this file because its encoding is unsupported.",
        )
        .with_details(json!({ "path": relative_path }))
    })?;
    ensure_review_text(text, relative_path)
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

fn is_git_deleted(entry: &NativeGitStatusEntry) -> bool {
    entry.code.as_bytes().first() == Some(&b'D') || entry.code.as_bytes().get(1) == Some(&b'D')
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
    files: &[ReviewTrackedFile],
    input_path: &str,
) -> Result<Option<usize>, NativeError> {
    if let Some(index) = find_tracked_file_index(files, input_path) {
        return Ok(Some(index));
    }

    let normalized =
        normalize_review_path(session, input_path, ScopedPathIntent::CreateTarget)?.state_path;
    Ok(find_tracked_file_index(files, &normalized))
}

fn normalize_review_hunk_ids(
    session: &NativeAiSession,
    hunk_ids: &[String],
    tracked_path: &str,
) -> Vec<String> {
    let mut normalized = Vec::with_capacity(hunk_ids.len() * 2);
    for hunk_id in hunk_ids {
        normalized.push(hunk_id.clone());
        if let Some(rewritten) = rewrite_review_hunk_id(session, hunk_id, tracked_path)
            && rewritten != *hunk_id
        {
            normalized.push(rewritten);
        }
    }
    normalized
}

fn rewrite_review_hunk_id(
    session: &NativeAiSession,
    hunk_id: &str,
    tracked_path: &str,
) -> Option<String> {
    let mut parts = hunk_id.rsplitn(4, ':');
    let hunk_index = parts.next()?;
    let new_start = parts.next()?;
    let old_start = parts.next()?;
    let seed = parts.next()?;
    let normalized_seed = normalize_review_path(session, seed, ScopedPathIntent::CreateTarget)
        .ok()?
        .state_path;
    if normalized_seed != tracked_path {
        return None;
    }
    Some(format!(
        "{tracked_path}:{old_start}:{new_start}:{hunk_index}"
    ))
}

fn upsert_tracked_file(files: &mut Vec<ReviewTrackedFile>, file: ReviewTrackedFile) {
    if let Some(index) = find_tracked_file_index(files, &file.path) {
        let mut next = file;
        if files[index].previous_path.is_none()
            && next.previous_path.is_none()
            && tracked_diff_base(&files[index]) == tracked_current_text(&next)
        {
            files.remove(index);
            return;
        }
        next.version = Some(files[index].version.unwrap_or(1).saturating_add(1));
        files[index] = next;
    } else {
        files.push(file);
    }
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

fn content_error_reason(error: &NativeError) -> &'static str {
    match error.code {
        NativeErrorCode::TooLarge => "too_large",
        NativeErrorCode::BinaryFile => "binary_file",
        NativeErrorCode::NotSupported => "encoding_unsupported",
        _ => "unsupported",
    }
}

fn conflict_for_content_error(path: &str, error: &NativeError) -> NativeReviewConflict {
    NativeReviewConflict {
        path: path.to_string(),
        reason: content_error_reason(error).to_string(),
        external_change_hash: None,
    }
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

fn resolve_review_path(
    session: &NativeAiSession,
    review_path: &str,
    intent: ScopedPathIntent,
) -> Result<PathBuf, NativeError> {
    normalize_review_path(session, review_path, intent).map(|resolved| resolved.absolute_path)
}

fn normalize_imported_tracked_file_paths(
    session: &NativeAiSession,
    tracked_file: &mut ReviewTrackedFile,
) -> Result<(), NativeError> {
    normalize_tracked_file_paths(session, tracked_file).map(|_| ())
}

fn normalize_review_state(
    session: &NativeAiSession,
    mut state: NativeReviewSessionState,
) -> Result<(NativeReviewSessionState, bool), NativeError> {
    let mut migrated = false;
    for tracked_file in &mut state.tracked_files {
        migrated |= normalize_tracked_file_paths(session, tracked_file)?;
    }
    for conflict in &mut state.conflicts {
        let normalized =
            normalize_review_path(session, &conflict.path, ScopedPathIntent::CreateTarget)?;
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
    tracked_file: &mut ReviewTrackedFile,
) -> Result<bool, NativeError> {
    let original_path = tracked_file.path.clone();
    let normalized =
        normalize_review_path(session, &original_path, ScopedPathIntent::CreateTarget)?;
    let mut changed = original_path != normalized.state_path;
    tracked_file.path = normalized.state_path;

    if let Some(previous_path) = tracked_file.previous_path.as_deref() {
        let original_previous_path = previous_path.to_string();
        let normalized_previous_path = normalize_review_path(
            session,
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
    fn parses_renamed_git_status_entries() {
        let entries = parse_git_status_output("R  old.txt\0new.txt\0 M src/main.rs\0");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "old.txt");
        assert_eq!(entries[0].previous_path.as_deref(), Some("new.txt"));
    }

    #[test]
    fn upserts_by_path() {
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
            Some("a\n".to_string()),
            Some("c\n".to_string()),
            now(),
        )
        .expect("second");
        upsert_tracked_file(&mut files, first);
        upsert_tracked_file(&mut files, second);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].version, Some(2));
    }

    #[test]
    fn parses_untracked_git_status_entries() {
        let entries = parse_git_status_output("?? new.txt\0!! ignored.log\0");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].code, "??");
        assert_eq!(entries[0].path, "new.txt");
        assert_eq!(entries[0].previous_path, None);
    }

    #[test]
    fn reconciles_untracked_create_and_reject_deletes_it() {
        let repo = tempfile::tempdir().expect("tempdir");
        init_git_repo(repo.path());
        let session = test_session(repo.path(), "s-create");
        let mut service = service_with_app_data(repo.path());
        service.capture_baseline(&session).expect("baseline");

        let file_path = repo.path().join("new.txt");
        fs::write(&file_path, "new file\n").expect("write new file");

        let output = service
            .reconcile_tracked_files(&session)
            .expect("reconcile");
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
    fn reconcile_keeps_text_review_when_binary_file_conflicts() {
        let repo = tempfile::tempdir().expect("tempdir");
        init_git_repo(repo.path());
        fs::write(repo.path().join("a.txt"), "one\n").expect("write text");
        fs::write(repo.path().join("binary.bin"), b"plain\n").expect("write binary baseline");
        git(repo.path(), &["add", "."]);
        git(repo.path(), &["commit", "-m", "initial"]);

        let session = test_session(repo.path(), "s-binary");
        let mut service = service_with_app_data(repo.path());
        service.capture_baseline(&session).expect("baseline");

        fs::write(repo.path().join("a.txt"), "two\n").expect("modify text");
        fs::write(repo.path().join("binary.bin"), b"\0not text").expect("modify binary");

        let output = service
            .reconcile_tracked_files(&session)
            .expect("reconcile");

        assert_eq!(output.tracked_files.len(), 1);
        assert_eq!(output.tracked_files[0].path, "a.txt");
        assert_eq!(output.conflicts.len(), 1);
        assert_eq!(output.conflicts[0].path, "binary.bin");
        assert_eq!(output.conflicts[0].reason, "binary_file");
    }

    #[test]
    fn baseline_allows_preexisting_dirty_binary_file() {
        let repo = tempfile::tempdir().expect("tempdir");
        init_git_repo(repo.path());
        fs::write(repo.path().join("binary.bin"), b"plain\n").expect("write baseline");
        git(repo.path(), &["add", "."]);
        git(repo.path(), &["commit", "-m", "initial"]);
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
    fn reconcile_replaces_stale_pending_file_with_conflict() {
        let repo = tempfile::tempdir().expect("tempdir");
        init_git_repo(repo.path());
        fs::write(repo.path().join("a.txt"), "base\n").expect("write text");
        git(repo.path(), &["add", "."]);
        git(repo.path(), &["commit", "-m", "initial"]);

        let session = test_session(repo.path(), "s-stale-conflict");
        let mut service = service_with_app_data(repo.path());
        service.capture_baseline(&session).expect("baseline");
        fs::write(repo.path().join("a.txt"), "agent change\n").expect("modify text");
        let first = service
            .reconcile_tracked_files(&session)
            .expect("first reconcile");
        assert_eq!(first.tracked_files.len(), 1);
        assert_eq!(
            first.tracked_files[0].review_state,
            ReviewTrackedFileStatus::Pending
        );

        service.capture_baseline(&session).expect("second baseline");
        fs::write(repo.path().join("a.txt"), b"\0not text").expect("make binary");
        let second = service
            .reconcile_tracked_files(&session)
            .expect("second reconcile");

        assert!(second.tracked_files.is_empty());
        assert_eq!(second.conflicts.len(), 1);
        assert_eq!(second.conflicts[0].path, "a.txt");
        assert_eq!(second.conflicts[0].reason, "binary_file");
    }

    #[test]
    fn reconcile_removes_pending_file_when_later_turn_restores_base() {
        let repo = tempfile::tempdir().expect("tempdir");
        init_git_repo(repo.path());
        fs::write(repo.path().join("a.txt"), "base\n").expect("write text");
        git(repo.path(), &["add", "."]);
        git(repo.path(), &["commit", "-m", "initial"]);

        let session = test_session(repo.path(), "s-net-zero");
        let mut service = service_with_app_data(repo.path());
        service.capture_baseline(&session).expect("baseline");
        fs::write(repo.path().join("a.txt"), "agent\n").expect("modify text");
        let first = service
            .reconcile_tracked_files(&session)
            .expect("first reconcile");
        assert_eq!(first.tracked_files.len(), 1);
        assert_eq!(first.tracked_files[0].old_text.as_deref(), Some("base\n"));
        assert_eq!(first.tracked_files[0].new_text.as_deref(), Some("agent\n"));

        service.capture_baseline(&session).expect("second baseline");
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
        init_git_repo(repo.path());
        fs::write(repo.path().join("a.txt"), "base\n").expect("write text");
        git(repo.path(), &["add", "."]);
        git(repo.path(), &["commit", "-m", "initial"]);

        let session = test_session(repo.path(), "s-preserve-pending");
        let mut service = service_with_app_data(repo.path());
        service.capture_baseline(&session).expect("baseline");
        fs::write(repo.path().join("a.txt"), "agent\n").expect("modify text");
        let first = service
            .reconcile_tracked_files(&session)
            .expect("first reconcile");
        assert_eq!(first.tracked_files.len(), 1);

        service.capture_baseline(&session).expect("second baseline");
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
    fn imported_legacy_review_state_survives_empty_later_reconcile() {
        let repo = tempfile::tempdir().expect("tempdir");
        init_git_repo(repo.path());
        fs::write(repo.path().join("a.txt"), "base\n").expect("write text");
        git(repo.path(), &["add", "."]);
        git(repo.path(), &["commit", "-m", "initial"]);
        fs::write(repo.path().join("a.txt"), "agent\n").expect("modify text");

        let session = test_session(repo.path(), "s-imported-legacy");
        let mut service = service_with_app_data(repo.path());
        let tracked_file = compute_tracked_file_patch(
            &session.session_id.0,
            "a.txt",
            None,
            Some("base\n".to_string()),
            Some("agent\n".to_string()),
            now(),
        )
        .expect("tracked file");
        let imported = service
            .import_state_if_missing(
                &session,
                NativeReviewImportStateInput {
                    session_id: session.session_id.clone(),
                    tracked_files: vec![tracked_file],
                },
            )
            .expect("import review state");
        assert_eq!(imported.tracked_files.len(), 1);
        assert!(imported.state_found);

        service.capture_baseline(&session).expect("baseline");
        let reconciled = service
            .reconcile_tracked_files(&session)
            .expect("reconcile imported state");

        assert_eq!(reconciled.tracked_files.len(), 1);
        assert_eq!(reconciled.tracked_files[0].path, "a.txt");
        assert_eq!(
            reconciled.tracked_files[0].review_state,
            ReviewTrackedFileStatus::Pending
        );
        assert!(reconciled.conflicts.is_empty());
        assert!(reconciled.state_found);
    }

    #[test]
    fn import_review_state_normalizes_absolute_paths_before_keep_all() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "agent\n").expect("write text");

        let session = test_session(repo.path(), "s-import-absolute");
        let mut service = service_with_app_data(repo.path());
        let absolute_path = repo.path().join("a.txt").to_string_lossy().to_string();
        let tracked_file = compute_tracked_file_patch(
            &session.session_id.0,
            &absolute_path,
            None,
            Some("base\n".to_string()),
            Some("agent\n".to_string()),
            now(),
        )
        .expect("tracked file");
        let imported = service
            .import_state_if_missing(
                &session,
                NativeReviewImportStateInput {
                    session_id: session.session_id.clone(),
                    tracked_files: vec![tracked_file],
                },
            )
            .expect("import review state");
        assert_eq!(imported.tracked_files.len(), 1);
        assert_eq!(imported.tracked_files[0].path, "a.txt");

        let kept = service.keep_all(&session).expect("keep all");
        assert!(kept.tracked_files.is_empty());
        assert_eq!(kept.tracked_file_events.len(), 1);
        assert_eq!(kept.tracked_file_events[0].tracked_file.path, "a.txt");
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

    #[test]
    fn absolute_additional_root_review_state_rejects_hunk() {
        let repo = tempfile::tempdir().expect("tempdir");
        let external = tempfile::tempdir().expect("external tempdir");
        let file_path = external.path().join("external.txt");
        fs::write(&file_path, "agent\n").expect("write text");

        let session = test_session_with_additional_roots(
            repo.path(),
            "s-additional-root-hunk",
            vec![external.path().to_string_lossy().to_string()],
        );
        let mut service = service_with_app_data(repo.path());
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
        let hunk_id = tracked_file.hunks[0].id.clone();
        let imported = service
            .import_state_if_missing(
                &session,
                NativeReviewImportStateInput {
                    session_id: session.session_id.clone(),
                    tracked_files: vec![tracked_file],
                },
            )
            .expect("import review state");
        assert_eq!(imported.tracked_files[0].path, absolute_path);

        let tracker = WriteTracker::new();
        let rejected = service
            .reject_hunks(
                &session,
                NativeReviewHunkMutationInput {
                    session_id: session.session_id.clone(),
                    path: absolute_path,
                    hunk_ids: vec![hunk_id],
                    tracked_file_id: None,
                    expected_version: None,
                },
                &tracker,
            )
            .expect("reject additional root hunk");

        assert!(rejected.tracked_files.is_empty());
        assert_eq!(fs::read_to_string(file_path).expect("read text"), "base\n");
    }

    #[test]
    fn reconcile_reports_invalid_head_utf8_as_conflict() {
        let repo = tempfile::tempdir().expect("tempdir");
        init_git_repo(repo.path());
        fs::write(repo.path().join("latin1.txt"), [0xff, b'\n']).expect("write invalid utf8");
        git(repo.path(), &["add", "."]);
        git(repo.path(), &["commit", "-m", "initial"]);

        let session = test_session(repo.path(), "s-encoding");
        let mut service = service_with_app_data(repo.path());
        service.capture_baseline(&session).expect("baseline");

        fs::write(repo.path().join("latin1.txt"), "valid now\n").expect("modify text");

        let output = service
            .reconcile_tracked_files(&session)
            .expect("reconcile");

        assert!(output.tracked_files.is_empty());
        assert_eq!(output.conflicts.len(), 1);
        assert_eq!(output.conflicts[0].path, "latin1.txt");
        assert_eq!(output.conflicts[0].reason, "encoding_unsupported");
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

    fn init_git_repo(repo_path: &Path) {
        git(repo_path, &["init"]);
        git(repo_path, &["config", "user.email", "review@example.com"]);
        git(repo_path, &["config", "user.name", "Review Test"]);
    }

    fn git(repo_path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
