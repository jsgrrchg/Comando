use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use comando_types::fs::{
    NativeFsCopyEntriesInput, NativeFsCopyExternalEntriesInput, NativeFsEntryKind,
    NativeFsEntryMutationResult,
};

use crate::error::FsError;
use crate::mutations::mutation_result_for_path;
use crate::origin::WriteTracker;
use crate::path::{
    ScopedPathIntent, is_child_path, is_same_or_child_path, normalize_relative_path,
    resolve_scoped_path, validate_entry_name,
};
use crate::registry::ProjectRoot;

#[derive(Debug, Clone)]
struct CopySourceEntry {
    absolute_path: PathBuf,
    kind: NativeFsEntryKind,
    name: String,
    relative_path: String,
}

pub fn copy_entries(
    root: &ProjectRoot,
    input: &NativeFsCopyEntriesInput,
    write_tracker: &WriteTracker,
) -> Result<Vec<NativeFsEntryMutationResult>, FsError> {
    let destination_parent = resolve_destination_parent(
        root,
        input
            .destination_parent_relative_path
            .as_ref()
            .map(|path| path.0.as_str()),
    )?;
    let source_entries = resolve_internal_copy_sources(root, input)?;
    let source_entries = compact_sources_by_ancestor(source_entries);
    let mut reserved_names = reserved_child_names(&destination_parent)?;
    let mut copied = Vec::new();

    for source in source_entries {
        if source.kind == NativeFsEntryKind::Directory
            && input
                .destination_parent_relative_path
                .as_ref()
                .is_some_and(|parent| {
                    parent.0 == source.relative_path
                        || parent.0.starts_with(&format!("{}/", source.relative_path))
                })
        {
            return Err(FsError::DirectoryIntoItself);
        }

        let destination_name =
            resolve_copy_destination_name(&source.name, source.kind, &mut reserved_names);
        let destination_path = destination_parent.join(destination_name);
        copy_source_to_destination(&source.absolute_path, &destination_path, source.kind)?;
        write_tracker.track_any(destination_path.clone());
        copied.push(mutation_result_for_path(root, &destination_path, None)?);
    }

    Ok(copied)
}

pub fn copy_external_entries(
    root: &ProjectRoot,
    input: &NativeFsCopyExternalEntriesInput,
    write_tracker: &WriteTracker,
) -> Result<Vec<NativeFsEntryMutationResult>, FsError> {
    let destination_parent = resolve_destination_parent(
        root,
        input
            .destination_parent_relative_path
            .as_ref()
            .map(|path| path.0.as_str()),
    )?;
    let source_entries =
        compact_sources_by_absolute_ancestor(resolve_external_copy_sources(input)?);
    let mut reserved_names = reserved_child_names(&destination_parent)?;
    let mut copied = Vec::new();

    for source in source_entries {
        if source.kind == NativeFsEntryKind::Directory
            && is_same_or_child_path(&destination_parent, &source.absolute_path)
        {
            return Err(FsError::DirectoryIntoItself);
        }

        let destination_name =
            resolve_copy_destination_name(&source.name, source.kind, &mut reserved_names);
        let destination_path = destination_parent.join(destination_name);
        copy_source_to_destination(&source.absolute_path, &destination_path, source.kind)?;
        write_tracker.track_any(destination_path.clone());
        copied.push(mutation_result_for_path(root, &destination_path, None)?);
    }

    Ok(copied)
}

fn resolve_destination_parent(
    root: &ProjectRoot,
    relative_path: Option<&str>,
) -> Result<PathBuf, FsError> {
    let resolved = resolve_scoped_path(
        &root.root_path,
        relative_path,
        true,
        ScopedPathIntent::ReadExisting,
    )?;
    if !fs::metadata(&resolved.absolute_path)?.is_dir() {
        return Err(FsError::NotDirectory);
    }
    Ok(resolved.absolute_path)
}

fn resolve_internal_copy_sources(
    root: &ProjectRoot,
    input: &NativeFsCopyEntriesInput,
) -> Result<Vec<CopySourceEntry>, FsError> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();

    for relative_path in &input.source_relative_paths {
        let normalized = normalize_relative_path(relative_path.0.as_str());
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }
        let resolved = resolve_scoped_path(
            &root.root_path,
            Some(&normalized),
            false,
            ScopedPathIntent::ReadExisting,
        )?;
        let metadata = fs::symlink_metadata(&resolved.absolute_path)?;
        reject_symlink_metadata(&metadata)?;
        entries.push(CopySourceEntry {
            name: resolved
                .absolute_path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or(FsError::InvalidPath)?
                .to_string(),
            kind: if metadata.is_dir() {
                NativeFsEntryKind::Directory
            } else {
                NativeFsEntryKind::File
            },
            absolute_path: resolved.absolute_path,
            relative_path: normalized,
        });
    }

    Ok(entries)
}

fn resolve_external_copy_sources(
    input: &NativeFsCopyExternalEntriesInput,
) -> Result<Vec<CopySourceEntry>, FsError> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();

    for source_path in &input.source_paths {
        let absolute_path = PathBuf::from(source_path);
        let absolute_path =
            fs::canonicalize(&absolute_path).map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => FsError::NotFound,
                std::io::ErrorKind::PermissionDenied => FsError::PermissionDenied,
                _ => FsError::Io(error),
            })?;
        let normalized = normalize_relative_path(&absolute_path);
        if !seen.insert(normalized.clone()) {
            continue;
        }
        let metadata = fs::symlink_metadata(&absolute_path)?;
        reject_symlink_metadata(&metadata)?;
        let name = validate_entry_name(
            absolute_path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or(FsError::InvalidPath)?,
        )?;

        entries.push(CopySourceEntry {
            absolute_path,
            kind: if metadata.is_dir() {
                NativeFsEntryKind::Directory
            } else {
                NativeFsEntryKind::File
            },
            name,
            relative_path: normalized,
        });
    }

    Ok(entries)
}

fn compact_sources_by_ancestor(entries: Vec<CopySourceEntry>) -> Vec<CopySourceEntry> {
    entries
        .iter()
        .filter(|entry| {
            !entries.iter().any(|candidate| {
                candidate.kind == NativeFsEntryKind::Directory
                    && candidate.relative_path != entry.relative_path
                    && entry
                        .relative_path
                        .starts_with(&format!("{}/", candidate.relative_path))
            })
        })
        .cloned()
        .collect()
}

fn compact_sources_by_absolute_ancestor(entries: Vec<CopySourceEntry>) -> Vec<CopySourceEntry> {
    entries
        .iter()
        .filter(|entry| {
            !entries.iter().any(|candidate| {
                candidate.kind == NativeFsEntryKind::Directory
                    && candidate.absolute_path != entry.absolute_path
                    && is_child_path(&entry.absolute_path, &candidate.absolute_path)
            })
        })
        .cloned()
        .collect()
}

fn reserved_child_names(destination_parent: &Path) -> Result<HashSet<String>, FsError> {
    Ok(fs::read_dir(destination_parent)?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
        .collect())
}

fn resolve_copy_destination_name(
    source_name: &str,
    kind: NativeFsEntryKind,
    reserved_names: &mut HashSet<String>,
) -> String {
    let source_key = source_name.to_lowercase();
    if !reserved_names.contains(&source_key) {
        reserved_names.insert(source_key);
        return source_name.to_string();
    }

    let source_path = Path::new(source_name);
    let extension = if kind == NativeFsEntryKind::File {
        source_path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!(".{extension}"))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let base_name = if extension.is_empty() {
        source_name.to_string()
    } else {
        source_name
            .strip_suffix(&extension)
            .unwrap_or(source_name)
            .to_string()
    };

    for copy_index in 1..usize::MAX {
        let suffix = if copy_index == 1 {
            " copy".to_string()
        } else {
            format!(" copy {copy_index}")
        };
        let candidate = format!("{base_name}{suffix}{extension}");
        let candidate_key = candidate.to_lowercase();
        if !reserved_names.contains(&candidate_key) {
            reserved_names.insert(candidate_key);
            return candidate;
        }
    }

    unreachable!("usize::MAX copy names exhausted")
}

fn copy_source_to_destination(
    source: &Path,
    destination: &Path,
    kind: NativeFsEntryKind,
) -> Result<(), FsError> {
    match kind {
        NativeFsEntryKind::File => {
            fs::copy(source, destination)?;
        }
        NativeFsEntryKind::Directory => {
            fs::create_dir(destination)?;
            copy_dir_recursive(source, destination)?;
        }
        _ => return Err(FsError::InvalidPath),
    }
    Ok(())
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), FsError> {
    for entry_result in fs::read_dir(source)? {
        let entry = entry_result?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)?;
        reject_symlink_metadata(&metadata)?;
        if metadata.is_dir() {
            fs::create_dir(&destination_path)?;
            copy_dir_recursive(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

fn reject_symlink_metadata(metadata: &fs::Metadata) -> Result<(), FsError> {
    if metadata.file_type().is_symlink() {
        return Err(FsError::PathEscape);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use comando_types::fs::{
        NativeFsCopyEntriesInput, NativeFsCopyExternalEntriesInput, NativeFsMutationOrigin,
    };
    use tempfile::TempDir;

    use super::*;
    use crate::test_support::project_root;

    #[test]
    fn copies_internal_file_and_deduplicates_name() {
        let temp = TempDir::new().expect("temp");
        fs::write(temp.path().join("a.txt"), "a").expect("a");
        let root = project_root(temp.path());

        let copied = copy_entries(
            &root,
            &NativeFsCopyEntriesInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                source_relative_paths: vec!["a.txt".into()],
                destination_parent_relative_path: None,
                origin: NativeFsMutationOrigin::User,
            },
            &WriteTracker::new(),
        )
        .expect("copy");

        assert_eq!(copied[0].relative_path.0, "a copy.txt");
        assert_eq!(
            fs::read_to_string(temp.path().join("a copy.txt")).unwrap(),
            "a"
        );
    }

    #[test]
    fn copies_external_directory() {
        let temp = TempDir::new().expect("temp");
        let external = TempDir::new().expect("external");
        fs::create_dir(external.path().join("pkg")).expect("pkg");
        fs::write(external.path().join("pkg/lib.rs"), "lib").expect("lib");
        let root = project_root(temp.path());

        let copied = copy_external_entries(
            &root,
            &NativeFsCopyExternalEntriesInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                source_paths: vec![external.path().join("pkg").to_string_lossy().to_string()],
                destination_parent_relative_path: None,
                origin: NativeFsMutationOrigin::User,
            },
            &WriteTracker::new(),
        )
        .expect("copy");

        assert_eq!(copied[0].relative_path.0, "pkg");
        assert_eq!(
            fs::read_to_string(temp.path().join("pkg/lib.rs")).unwrap(),
            "lib"
        );
    }

    #[test]
    fn rejects_copying_folder_into_itself() {
        let temp = TempDir::new().expect("temp");
        fs::create_dir_all(temp.path().join("src/nested")).expect("dirs");
        let root = project_root(temp.path());

        let result = copy_entries(
            &root,
            &NativeFsCopyEntriesInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                source_relative_paths: vec!["src".into()],
                destination_parent_relative_path: Some("src/nested".into()),
                origin: NativeFsMutationOrigin::User,
            },
            &WriteTracker::new(),
        );

        assert!(matches!(result, Err(FsError::DirectoryIntoItself)));
    }
}
