use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use comando_ai::session::NativeAiSession;
use comando_diff::{
    ReviewDecision, ReviewTrackedFile, ReviewTrackedFileKind, resolve_tracked_file_hunks,
    sync_tracked_file, tracked_current_text,
};
use comando_fs::WriteTracker;
use comando_fs::path::{ScopedPathIntent, normalize_relative_path, resolve_scoped_path};
use comando_fs::read::hash_content_bytes;
use comando_types::error::{NativeError, NativeErrorCode};
use comando_types::ids::SessionId;
use serde::{Deserialize, Serialize};
use serde_json::json;

const MAX_REVIEW_TEXT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct NativeReviewService {
    open_buffers: HashMap<PathBuf, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewSessionInput {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewFileBufferInput {
    pub absolute_path: String,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewFileMutationInput {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_root: Option<String>,
    pub tracked_file: ReviewTrackedFile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewHunkMutationInput {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_root: Option<String>,
    pub tracked_file: ReviewTrackedFile,
    pub hunk_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewRejectAllInput {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_root: Option<String>,
    #[serde(default)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewConflict {
    pub path: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_change_hash: Option<String>,
}

#[derive(Debug, Clone)]
struct RollbackBackup {
    path: PathBuf,
    content: Option<Vec<u8>>,
    had_open_buffer: bool,
    open_buffer_content: Option<String>,
}

impl NativeReviewService {
    pub fn set_app_data_dir(&mut self, _app_data_dir: impl Into<PathBuf>) {}

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
        Ok(NativeReviewCaptureOutput {
            captured: true,
            session_id: session.session_id.clone(),
            updated_at: now(),
        })
    }

    pub fn reject_file(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewFileMutationInput,
        write_tracker: &WriteTracker,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        let updated_at = now();
        let review_root = normalize_review_root(session, input.review_root.as_deref())?;
        let tracked_file = self.prepare_tracked_file(
            session,
            review_root.as_deref(),
            input.tracked_file,
            input.expected_version,
        )?;
        let changed_files = self.revert_tracked_file(
            session,
            review_root.as_deref(),
            &tracked_file,
            write_tracker,
        )?;
        Ok(command_output(
            session.session_id.clone(),
            changed_files,
            updated_at,
        ))
    }

    pub fn reject_hunks(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewHunkMutationInput,
        write_tracker: &WriteTracker,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        let updated_at = now();
        let review_root = normalize_review_root(session, input.review_root.as_deref())?;
        let tracked_file = self.prepare_tracked_file(
            session,
            review_root.as_deref(),
            input.tracked_file,
            input.expected_version,
        )?;
        self.assert_current_matches(session, review_root.as_deref(), &tracked_file)?;

        let hunk_ids = normalize_review_hunk_ids(
            session,
            review_root.as_deref(),
            &input.hunk_ids,
            &tracked_file.path,
        );
        let next = resolve_tracked_file_hunks(
            &tracked_file,
            &hunk_ids,
            ReviewDecision::Reject,
            updated_at.clone(),
        );

        let mut changed_files = Vec::new();
        if let Some(next_file) = next {
            let current = tracked_current_text(&tracked_file);
            let next_text = tracked_current_text(&next_file);
            if current != next_text {
                self.write_review_text(
                    session,
                    review_root.as_deref(),
                    &next_file.path,
                    &next_text,
                    write_tracker,
                )?;
                changed_files.push(next_file.path.clone());
            }
        } else {
            changed_files.extend(self.revert_tracked_file(
                session,
                review_root.as_deref(),
                &tracked_file,
                write_tracker,
            )?);
        }

        Ok(command_output(
            session.session_id.clone(),
            changed_files,
            updated_at,
        ))
    }

    pub fn reject_all(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewRejectAllInput,
        write_tracker: &WriteTracker,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        let updated_at = now();
        let review_root = normalize_review_root(session, input.review_root.as_deref())?;
        let tracked_files = input
            .tracked_files
            .into_iter()
            .map(|tracked_file| {
                self.prepare_tracked_file(session, review_root.as_deref(), tracked_file, None)
            })
            .collect::<Result<Vec<_>, _>>()?;

        for tracked_file in &tracked_files {
            self.assert_current_matches(session, review_root.as_deref(), tracked_file)?;
            self.assert_move_previous_path_available(
                session,
                review_root.as_deref(),
                tracked_file,
            )?;
        }

        let backups =
            self.create_rollback_backups(session, review_root.as_deref(), &tracked_files)?;
        let mut changed_files = Vec::new();
        if let Err(error) = tracked_files.iter().try_for_each(|tracked_file| {
            self.revert_tracked_file(session, review_root.as_deref(), tracked_file, write_tracker)
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

        Ok(command_output(
            session.session_id.clone(),
            changed_files,
            updated_at,
        ))
    }

    fn prepare_tracked_file(
        &self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        tracked_file: ReviewTrackedFile,
        expected_version: Option<u32>,
    ) -> Result<ReviewTrackedFile, NativeError> {
        if tracked_file.session_id != session.session_id.0 {
            return Err(NativeError::new(
                NativeErrorCode::InvalidArgs,
                "Cannot safely apply this review change because the session does not match.",
            ));
        }
        validate_version(&tracked_file, expected_version)?;

        let mut normalized = tracked_file;
        normalize_tracked_file_paths(session, review_root, &mut normalized)?;
        Ok(sync_tracked_file(&normalized))
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

fn command_output(
    session_id: SessionId,
    changed_files: Vec<String>,
    updated_at: String,
) -> NativeReviewCommandOutput {
    NativeReviewCommandOutput {
        session_id,
        tracked_files: Vec::new(),
        changed_files,
        conflicts: Vec::new(),
        updated_at,
        state_found: false,
    }
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

fn now() -> String {
    comando_persistence::store::now_rfc3339()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use comando_ai::scope::SessionScope;
    use comando_ai::session::NativeAiSession;
    use comando_diff::compute_tracked_file_patch;
    use comando_fs::WriteTracker;
    use comando_types::ai::NativeAiSessionStatus;
    use comando_types::ids::{RuntimeId, SessionId};

    use super::*;

    #[test]
    fn reject_file_reverts_update_from_tracked_file() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "agent\n").expect("write agent");
        let session = test_session(repo.path(), "s-reject-file");
        let mut service = NativeReviewService::default();
        let tracker = WriteTracker::new();
        let tracked_file = tracked_file(&session, "a.txt", "base\n", "agent\n");

        let output = service
            .reject_file(
                &session,
                NativeReviewFileMutationInput {
                    session_id: session.session_id.clone(),
                    review_root: None,
                    tracked_file,
                    expected_version: None,
                },
                &tracker,
            )
            .expect("reject file");

        assert_eq!(output.changed_files, vec!["a.txt"]);
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).expect("read file"),
            "base\n"
        );
    }

    #[test]
    fn reject_file_blocks_external_drift() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "agent + user\n").expect("write drift");
        let session = test_session(repo.path(), "s-reject-drift");
        let mut service = NativeReviewService::default();
        let tracker = WriteTracker::new();
        let tracked_file = tracked_file(&session, "a.txt", "base\n", "agent\n");

        let error = service
            .reject_file(
                &session,
                NativeReviewFileMutationInput {
                    session_id: session.session_id.clone(),
                    review_root: None,
                    tracked_file,
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
    }

    #[test]
    fn reject_all_blocks_drift_without_partial_writes() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "agent a\n").expect("write a");
        fs::write(repo.path().join("b.txt"), "agent b + user\n").expect("write b");
        let session = test_session(repo.path(), "s-reject-all");
        let mut service = NativeReviewService::default();
        let tracker = WriteTracker::new();

        let error = service
            .reject_all(
                &session,
                NativeReviewRejectAllInput {
                    session_id: session.session_id.clone(),
                    review_root: None,
                    tracked_files: vec![
                        tracked_file(&session, "a.txt", "base a\n", "agent a\n"),
                        tracked_file(&session, "b.txt", "base b\n", "agent b\n"),
                    ],
                },
                &tracker,
            )
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
    }

    #[test]
    fn reject_hunks_writes_partially_reverted_text() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "ONE\ntwo\nTHREE\nfour\n").expect("write");
        let session = test_session(repo.path(), "s-reject-hunks");
        let mut service = NativeReviewService::default();
        let tracker = WriteTracker::new();
        let tracked_file = tracked_file(
            &session,
            "a.txt",
            "one\ntwo\nthree\nfour\n",
            "ONE\ntwo\nTHREE\nfour\n",
        );
        let hunk_id = tracked_file.hunks[0].id.clone();

        let output = service
            .reject_hunks(
                &session,
                NativeReviewHunkMutationInput {
                    session_id: session.session_id.clone(),
                    review_root: None,
                    tracked_file,
                    hunk_ids: vec![hunk_id],
                    expected_version: None,
                },
                &tracker,
            )
            .expect("reject hunk");

        assert_eq!(output.changed_files, vec!["a.txt"]);
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).expect("read file"),
            "one\ntwo\nTHREE\nfour\n"
        );
    }

    #[test]
    fn reject_file_uses_review_root_for_project_relative_paths() {
        let repo = tempfile::tempdir().expect("tempdir");
        let cwd = repo.path().join("packages").join("app");
        fs::create_dir_all(&cwd).expect("create cwd");
        fs::create_dir_all(repo.path().join("src")).expect("create src");
        fs::write(repo.path().join("src").join("foo.ts"), "agent\n").expect("write");
        let session = test_session(&cwd, "s-review-root");
        let mut service = NativeReviewService::default();
        let tracker = WriteTracker::new();
        let tracked_file = tracked_file(&session, "src/foo.ts", "base\n", "agent\n");

        service
            .reject_file(
                &session,
                NativeReviewFileMutationInput {
                    session_id: session.session_id.clone(),
                    review_root: Some(repo.path().to_string_lossy().to_string()),
                    tracked_file,
                    expected_version: None,
                },
                &tracker,
            )
            .expect("reject with review root");

        assert_eq!(
            fs::read_to_string(repo.path().join("src").join("foo.ts")).expect("read"),
            "base\n"
        );
        assert!(!cwd.join("src").join("foo.ts").exists());
    }

    fn test_session(cwd: &Path, session_id: &str) -> NativeAiSession {
        NativeAiSession {
            owner_window_id: "window-1".to_string(),
            runtime_id: RuntimeId("opencode".to_string()),
            runtime_session_id: None,
            scope: SessionScope {
                additional_roots: Vec::new(),
                cwd: cwd.to_string_lossy().to_string(),
                project_id: None,
                worktree_id: None,
            },
            session_id: SessionId(session_id.to_string()),
            status: NativeAiSessionStatus::Idle,
            title: "Test".to_string(),
            updated_at: now(),
        }
    }

    fn tracked_file(
        session: &NativeAiSession,
        path: &str,
        old_text: &str,
        new_text: &str,
    ) -> ReviewTrackedFile {
        compute_tracked_file_patch(
            &session.session_id.0,
            path,
            None,
            Some(old_text.to_string()),
            Some(new_text.to_string()),
            now(),
        )
        .expect("tracked file")
    }
}
