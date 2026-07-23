use std::fs;
use std::path::Path;

use crate::error::FsError;
use crate::origin::WriteTracker;
use crate::path::{
    ScopedPathIntent, normalize_relative_path, parent_relative_path, resolve_scoped_path,
    validate_entry_name,
};
use crate::registry::ProjectRoot;
use crate::tree::fs_entry_for_path;
use comando_types::fs::{
    NativeFsCreateEntryInput, NativeFsDeleteEntryInput, NativeFsEntryKind,
    NativeFsEntryMutationResult, NativeFsRenameEntryInput,
};

pub fn create_file(
    root: &ProjectRoot,
    input: &NativeFsCreateEntryInput,
    write_tracker: &WriteTracker,
) -> Result<NativeFsEntryMutationResult, FsError> {
    create_entry(root, input, NativeFsEntryKind::File, write_tracker)
}

pub fn create_directory(
    root: &ProjectRoot,
    input: &NativeFsCreateEntryInput,
    write_tracker: &WriteTracker,
) -> Result<NativeFsEntryMutationResult, FsError> {
    create_entry(root, input, NativeFsEntryKind::Directory, write_tracker)
}

pub fn rename_entry(
    root: &ProjectRoot,
    input: &NativeFsRenameEntryInput,
    write_tracker: &WriteTracker,
) -> Result<NativeFsEntryMutationResult, FsError> {
    let current = resolve_scoped_path(
        &root.root_path,
        Some(input.relative_path.0.as_str()),
        false,
        ScopedPathIntent::WriteExisting,
    )?;
    let current_metadata = fs::metadata(&current.absolute_path)?;
    let next_name = validate_entry_name(&input.next_name)?;
    let current_relative_path = current.relative_path.clone().ok_or(FsError::InvalidPath)?;
    let next_parent_relative_path = input
        .next_parent_relative_path
        .as_ref()
        .map(|path| path.0.as_str())
        .map(str::to_string)
        .or_else(|| parent_relative_path(&current_relative_path));

    if current_metadata.is_dir()
        && let Some(parent) = next_parent_relative_path.as_deref()
        && (parent == current_relative_path
            || parent.starts_with(&format!("{current_relative_path}/")))
    {
        return Err(FsError::DirectoryIntoItself);
    }

    let parent = resolve_scoped_path(
        &root.root_path,
        next_parent_relative_path.as_deref(),
        true,
        ScopedPathIntent::ReadExisting,
    )?;
    if !fs::metadata(&parent.absolute_path)?.is_dir() {
        return Err(FsError::NotDirectory);
    }

    let next_absolute_path = parent.absolute_path.join(&next_name);
    let next_relative_path = normalize_relative_path(
        next_absolute_path
            .strip_prefix(&root.root_path)
            .map_err(|_| FsError::PathEscape)?,
    );
    resolve_scoped_path(
        &root.root_path,
        Some(&next_relative_path),
        false,
        ScopedPathIntent::CreateTarget,
    )?;

    if current.absolute_path != next_absolute_path
        && destination_exists_as_different_entry(&current.absolute_path, &next_absolute_path)
    {
        return Err(FsError::AlreadyExists);
    }

    if current.absolute_path != next_absolute_path {
        write_tracker.track_any(current.absolute_path.clone());
        write_tracker.track_any(next_absolute_path.clone());
        if let Err(error) = fs::rename(&current.absolute_path, &next_absolute_path) {
            write_tracker.forget(&current.absolute_path);
            write_tracker.forget(&next_absolute_path);
            return Err(error.into());
        }
    }

    mutation_result_for_path(root, &next_absolute_path, Some(next_parent_relative_path))
}

pub fn delete_entry(
    root: &ProjectRoot,
    input: &NativeFsDeleteEntryInput,
    write_tracker: &WriteTracker,
) -> Result<NativeFsEntryMutationResult, FsError> {
    if input.relative_path.0.is_empty() {
        return Err(FsError::InvalidPath);
    }

    let resolved = resolve_scoped_path(
        &root.root_path,
        Some(input.relative_path.0.as_str()),
        false,
        ScopedPathIntent::WriteExisting,
    )?;
    let result = mutation_result_for_path(root, &resolved.absolute_path, None)?;
    let metadata = fs::metadata(&resolved.absolute_path)?;
    write_tracker.track_any(resolved.absolute_path.clone());
    let deletion_result = if metadata.is_dir() {
        fs::remove_dir_all(&resolved.absolute_path)
    } else {
        fs::remove_file(&resolved.absolute_path)
    };
    if let Err(error) = deletion_result {
        write_tracker.forget(&resolved.absolute_path);
        return Err(error.into());
    }

    Ok(result)
}

pub fn mutation_result_for_path(
    root: &ProjectRoot,
    absolute_path: &Path,
    explicit_parent_relative_path: Option<Option<String>>,
) -> Result<NativeFsEntryMutationResult, FsError> {
    let metadata = fs::metadata(absolute_path)?;
    let relative_path = normalize_relative_path(
        absolute_path
            .strip_prefix(&root.root_path)
            .map_err(|_| FsError::PathEscape)?,
    );
    let name = absolute_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(FsError::InvalidPath)?
        .to_string();
    let parent =
        explicit_parent_relative_path.unwrap_or_else(|| parent_relative_path(&relative_path));
    let kind = if metadata.is_dir() {
        NativeFsEntryKind::Directory
    } else {
        NativeFsEntryKind::File
    };

    Ok(NativeFsEntryMutationResult {
        kind,
        name,
        parent_relative_path: parent.map(Into::into),
        relative_path: relative_path.into(),
        entry: Some(fs_entry_for_path(root, absolute_path)?),
    })
}

fn create_entry(
    root: &ProjectRoot,
    input: &NativeFsCreateEntryInput,
    kind: NativeFsEntryKind,
    write_tracker: &WriteTracker,
) -> Result<NativeFsEntryMutationResult, FsError> {
    let name = validate_entry_name(&input.name)?;
    let parent = resolve_scoped_path(
        &root.root_path,
        input
            .parent_relative_path
            .as_ref()
            .map(|path| path.0.as_str()),
        true,
        ScopedPathIntent::ReadExisting,
    )?;
    if !fs::metadata(&parent.absolute_path)?.is_dir() {
        return Err(FsError::NotDirectory);
    }

    let absolute_path = parent.absolute_path.join(name);
    let relative_path = normalize_relative_path(
        absolute_path
            .strip_prefix(&root.root_path)
            .map_err(|_| FsError::PathEscape)?,
    );
    resolve_scoped_path(
        &root.root_path,
        Some(&relative_path),
        false,
        ScopedPathIntent::CreateTarget,
    )?;

    if absolute_path.exists() {
        return Err(FsError::AlreadyExists);
    }

    let creation_result = match kind {
        NativeFsEntryKind::Directory => {
            write_tracker.track_any(absolute_path.clone());
            fs::create_dir(&absolute_path)
        }
        NativeFsEntryKind::File => {
            write_tracker.track_content(absolute_path.clone(), "");
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&absolute_path)
                .map(|_| ())
        }
        _ => return Err(FsError::InvalidPath),
    };
    if let Err(error) = creation_result {
        write_tracker.forget(&absolute_path);
        return Err(error.into());
    }

    mutation_result_for_path(
        root,
        &absolute_path,
        Some(
            input
                .parent_relative_path
                .as_ref()
                .map(|path| path.0.clone()),
        ),
    )
}

fn destination_exists_as_different_entry(current_path: &Path, next_path: &Path) -> bool {
    if !next_path.exists() {
        return false;
    }

    match (fs::canonicalize(current_path), fs::canonicalize(next_path)) {
        (Ok(current), Ok(next)) => current != next,
        _ => current_path != next_path,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use comando_types::fs::{
        NativeFsCreateEntryInput, NativeFsDeleteEntryInput, NativeFsEntryKind,
        NativeFsMutationOrigin, NativeFsRenameEntryInput,
    };
    use tempfile::TempDir;

    use super::*;
    use crate::test_support::project_root;

    #[test]
    fn creates_renames_and_deletes_entries() {
        let temp = TempDir::new().expect("temp");
        fs::create_dir(temp.path().join("src")).expect("src");
        let root = project_root(temp.path());
        let tracker = WriteTracker::new();

        let created = create_file(
            &root,
            &NativeFsCreateEntryInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                parent_relative_path: Some("src".into()),
                name: "main.rs".to_string(),
                kind: NativeFsEntryKind::File,
                origin: NativeFsMutationOrigin::User,
            },
            &tracker,
        )
        .expect("create");
        assert_eq!(created.relative_path.0, "src/main.rs");

        let renamed = rename_entry(
            &root,
            &NativeFsRenameEntryInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: "src/main.rs".into(),
                next_name: "lib.rs".to_string(),
                next_parent_relative_path: None,
                origin: NativeFsMutationOrigin::User,
            },
            &tracker,
        )
        .expect("rename");
        assert_eq!(renamed.relative_path.0, "src/lib.rs");

        delete_entry(
            &root,
            &NativeFsDeleteEntryInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: "src/lib.rs".into(),
                origin: NativeFsMutationOrigin::User,
            },
            &tracker,
        )
        .expect("delete");
        assert!(!temp.path().join("src/lib.rs").exists());
    }

    #[test]
    fn rejects_moving_directory_inside_itself() {
        let temp = TempDir::new().expect("temp");
        fs::create_dir_all(temp.path().join("src/nested")).expect("dirs");
        let root = project_root(temp.path());

        let result = rename_entry(
            &root,
            &NativeFsRenameEntryInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: "src".into(),
                next_name: "src".to_string(),
                next_parent_relative_path: Some("src/nested".into()),
                origin: NativeFsMutationOrigin::User,
            },
            &WriteTracker::new(),
        );

        assert!(matches!(result, Err(FsError::DirectoryIntoItself)));
    }

    #[test]
    fn rejects_delete_root() {
        let temp = TempDir::new().expect("temp");
        let root = project_root(temp.path());

        let result = delete_entry(
            &root,
            &NativeFsDeleteEntryInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: "".into(),
                origin: NativeFsMutationOrigin::User,
            },
            &WriteTracker::new(),
        );

        assert!(matches!(result, Err(FsError::InvalidPath)));
    }

    #[test]
    fn rejects_case_only_rename_over_distinct_existing_file() {
        let temp = TempDir::new().expect("temp");
        fs::write(temp.path().join("foo.ts"), "foo").expect("foo");
        fs::write(temp.path().join("Foo.ts"), "capital").expect("capital");
        if fs::read_to_string(temp.path().join("foo.ts")).expect("foo content") != "foo" {
            return;
        }
        let root = project_root(temp.path());

        let result = rename_entry(
            &root,
            &NativeFsRenameEntryInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: "foo.ts".into(),
                next_name: "Foo.ts".to_string(),
                next_parent_relative_path: None,
                origin: NativeFsMutationOrigin::User,
            },
            &WriteTracker::new(),
        );

        assert!(matches!(result, Err(FsError::AlreadyExists)));
    }
}
