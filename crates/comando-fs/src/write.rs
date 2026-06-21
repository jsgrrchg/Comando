use std::fs;

use comando_types::fs::{NativeFsConflict, NativeFsWriteFileInput, NativeFsWriteFileResult};

use crate::error::FsError;
use crate::origin::WriteTracker;
use crate::path::{ScopedPathIntent, resolve_scoped_path};
use crate::read::{hash_content_bytes, read_file};
use crate::registry::ProjectRoot;
use crate::system_time_to_millis;
use crate::tree::fs_entry_for_path;

pub fn write_file(
    root: &ProjectRoot,
    input: &NativeFsWriteFileInput,
    write_tracker: &WriteTracker,
) -> Result<NativeFsWriteFileResult, FsError> {
    let resolved = resolve_scoped_path(
        &root.root_path,
        Some(input.relative_path.0.as_str()),
        false,
        ScopedPathIntent::WriteExisting,
    )?;
    let metadata = fs::metadata(&resolved.absolute_path)?;
    if metadata.is_dir() {
        return Err(FsError::IsDirectory);
    }

    let current_bytes = fs::read(&resolved.absolute_path)?;
    let current_hash = hash_content_bytes(&current_bytes);
    let current_mtime_ms = metadata.modified().ok().map(system_time_to_millis);

    let hash_conflict = input
        .expected_content_hash
        .as_ref()
        .is_some_and(|expected| expected != &current_hash);
    let mtime_conflict = input
        .expected_modified_at_ms
        .zip(current_mtime_ms)
        .is_some_and(|(expected, current)| (expected - current as f64).abs() > 1.0);

    if hash_conflict || mtime_conflict {
        return Ok(NativeFsWriteFileResult {
            entry: fs_entry_for_path(root, &resolved.absolute_path)?,
            conflict: Some(NativeFsConflict {
                reason: if hash_conflict {
                    "content_hash_mismatch".to_string()
                } else {
                    "modified_time_mismatch".to_string()
                },
                current_content_hash: Some(current_hash),
                external_mtime_ms: current_mtime_ms,
            }),
            file: None,
        });
    }

    let content = preserve_line_ending_if_needed(&current_bytes, &input.content);
    fs::write(&resolved.absolute_path, content.as_bytes())?;
    write_tracker.track_content(resolved.absolute_path.clone(), &content);

    let read_input = comando_types::fs::NativeFsReadFileInput {
        project_id: input.project_id.clone(),
        worktree_id: input.worktree_id.clone(),
        relative_path: input.relative_path.clone(),
        max_bytes: None,
    };
    let file = read_file(root, &read_input)?;

    Ok(NativeFsWriteFileResult {
        entry: fs_entry_for_path(root, &resolved.absolute_path)?,
        conflict: None,
        file: Some(file),
    })
}

fn preserve_line_ending_if_needed(existing_bytes: &[u8], next_content: &str) -> String {
    let existing = String::from_utf8_lossy(existing_bytes);
    if existing.contains("\r\n") && !next_content.contains("\r\n") {
        next_content.replace('\n', "\r\n")
    } else {
        next_content.to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::thread;
    use std::time::Duration;

    use comando_types::fs::{NativeFsMutationOrigin, NativeFsWriteFileInput};
    use tempfile::TempDir;

    use super::*;
    use crate::read::read_file;
    use crate::test_support::project_root;

    #[test]
    fn writes_file_and_returns_updated_document() {
        let temp = TempDir::new().expect("temp");
        fs::write(temp.path().join("main.rs"), "old\n").expect("file");
        let root = project_root(temp.path());
        let before = read_file(
            &root,
            &comando_types::fs::NativeFsReadFileInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: "main.rs".into(),
                max_bytes: None,
            },
        )
        .expect("before");

        let result = write_file(
            &root,
            &NativeFsWriteFileInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: "main.rs".into(),
                content: "new\n".to_string(),
                expected_content_hash: before.content_hash,
                expected_modified_at_ms: None,
                origin: NativeFsMutationOrigin::User,
            },
            &WriteTracker::new(),
        )
        .expect("write");

        assert!(result.conflict.is_none());
        assert_eq!(
            result.file.and_then(|file| file.content).as_deref(),
            Some("new\n")
        );
    }

    #[test]
    fn returns_conflict_without_writing_stale_content() {
        let temp = TempDir::new().expect("temp");
        fs::write(temp.path().join("main.rs"), "old\n").expect("file");
        let root = project_root(temp.path());
        let before = read_file(
            &root,
            &comando_types::fs::NativeFsReadFileInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: "main.rs".into(),
                max_bytes: None,
            },
        )
        .expect("before");
        thread::sleep(Duration::from_millis(2));
        fs::write(temp.path().join("main.rs"), "external\n").expect("external");

        let result = write_file(
            &root,
            &NativeFsWriteFileInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: "main.rs".into(),
                content: "new\n".to_string(),
                expected_content_hash: before.content_hash,
                expected_modified_at_ms: None,
                origin: NativeFsMutationOrigin::User,
            },
            &WriteTracker::new(),
        )
        .expect("write");

        assert_eq!(
            result.conflict.map(|conflict| conflict.reason),
            Some("content_hash_mismatch".to_string())
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("main.rs")).unwrap(),
            "external\n"
        );
    }
}
