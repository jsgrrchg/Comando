use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use comando_types::fs::{NativeFsEntry, NativeFsEntryKind, NativeFsEntryStatus};
use comando_types::projects::{NativeProjectListEntriesResult, NativeProjectTreeEntry};

use crate::error::FsError;
use crate::path::{
    ScopedPathIntent, normalize_relative_path, parent_relative_path, resolve_scoped_path,
};
use crate::policy::{
    is_special_no_expand_directory, should_expand_directory_by_default, tree_visibility_for_entry,
};
use crate::registry::ProjectRoot;
use crate::system_time_to_millis;

const DEFAULT_LIST_ENTRIES_LIMIT: usize = 5_000;
const GIT_CHECK_IGNORE_CHUNK_SIZE: usize = 256;

#[derive(Debug, Clone)]
struct DirectoryEntry {
    absolute_path: PathBuf,
    file_type: fs::FileType,
    name: String,
    relative_path: String,
}

pub fn list_tree_children(
    root: &ProjectRoot,
    parent_relative_path: Option<&str>,
) -> Result<Vec<NativeProjectTreeEntry>, FsError> {
    let resolved = resolve_scoped_path(
        &root.root_path,
        parent_relative_path,
        true,
        ScopedPathIntent::ReadExisting,
    )?;
    let metadata = fs::metadata(&resolved.absolute_path)?;
    if !metadata.is_dir() {
        return Err(FsError::NotDirectory);
    }

    let mut entries = match read_directory_entries(&root.root_path, &resolved.absolute_path) {
        Ok(entries) => entries,
        Err(FsError::NotFound) | Err(FsError::NotDirectory) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    sort_directory_entries(&mut entries);
    let ignored_paths = check_git_ignored_paths(
        &root.root_path,
        entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>()
            .as_slice(),
    );

    Ok(entries
        .into_iter()
        .map(|entry| tree_entry_from_directory_entry(root, entry, &ignored_paths))
        .collect())
}

pub fn list_entries(
    root: &ProjectRoot,
    limit: Option<usize>,
) -> Result<NativeProjectListEntriesResult, FsError> {
    let limit = limit.unwrap_or(DEFAULT_LIST_ENTRIES_LIMIT).max(1);
    let resolved =
        resolve_scoped_path(&root.root_path, None, true, ScopedPathIntent::ReadExisting)?;
    let mut queue = VecDeque::from([resolved.absolute_path]);
    let mut entries = Vec::new();
    let mut truncated = false;

    while let Some(directory) = queue.pop_front() {
        let mut children = match read_directory_entries(&root.root_path, &directory) {
            Ok(children) => children,
            Err(_) => continue,
        };
        sort_directory_entries(&mut children);

        for child in children {
            if entries.len() >= limit {
                truncated = true;
                break;
            }

            if child.file_type.is_dir() && !is_special_no_expand_directory(&child.absolute_path) {
                queue.push_back(child.absolute_path.clone());
            }

            entries.push(child);
        }

        if truncated {
            break;
        }
    }

    let ignored_paths = check_git_ignored_paths(
        &root.root_path,
        entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>()
            .as_slice(),
    );

    Ok(NativeProjectListEntriesResult {
        entries: entries
            .into_iter()
            .map(|entry| tree_entry_from_directory_entry(root, entry, &ignored_paths))
            .collect(),
        truncated,
    })
}

pub fn fs_entry_for_path(
    root: &ProjectRoot,
    absolute_path: &Path,
) -> Result<NativeFsEntry, FsError> {
    let metadata = fs::symlink_metadata(absolute_path)?;
    let relative_path = normalize_relative_path(
        absolute_path
            .strip_prefix(&root.root_path)
            .map_err(|_| FsError::PathEscape)?,
    );
    let kind = fs_entry_kind(&metadata);

    Ok(NativeFsEntry {
        path: absolute_path.to_string_lossy().to_string(),
        relative_path: relative_path.into(),
        project_id: root.project_id.clone(),
        worktree_id: root.worktree_id.clone(),
        kind,
        is_directory: metadata.is_dir(),
        is_symlink: metadata.file_type().is_symlink(),
        is_binary: false,
        is_too_large: false,
        size_bytes: Some(metadata.len()),
        mtime_ms: metadata.modified().ok().map(system_time_to_millis),
        content_hash: None,
        status: NativeFsEntryStatus::Clean,
        visibility: absolute_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| tree_visibility_for_entry(name, metadata.is_dir())),
    })
}

fn read_directory_entries(
    root_path: &Path,
    directory: &Path,
) -> Result<Vec<DirectoryEntry>, FsError> {
    let read_dir = fs::read_dir(directory).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => FsError::NotFound,
        std::io::ErrorKind::NotADirectory => FsError::NotDirectory,
        std::io::ErrorKind::PermissionDenied => FsError::PermissionDenied,
        _ => FsError::Io(error),
    })?;

    let mut entries = Vec::new();
    for entry_result in read_dir {
        let entry = entry_result?;
        let absolute_path = entry.path();
        let file_type = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().to_string();
        let relative_path = normalize_relative_path(
            absolute_path
                .strip_prefix(root_path)
                .map_err(|_| FsError::PathEscape)?,
        );

        entries.push(DirectoryEntry {
            absolute_path,
            file_type,
            name,
            relative_path,
        });
    }

    Ok(entries)
}

fn tree_entry_from_directory_entry(
    root: &ProjectRoot,
    entry: DirectoryEntry,
    ignored_paths: &HashSet<String>,
) -> NativeProjectTreeEntry {
    let is_directory = entry.file_type.is_dir();
    let visibility = tree_visibility_for_entry(&entry.name, is_directory);
    let has_children = is_directory
        && should_expand_directory_by_default(&entry.name, visibility)
        && directory_has_children(&entry.absolute_path);
    let extension = if is_directory {
        None
    } else {
        Path::new(&entry.name)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_string)
            .filter(|extension| !extension.is_empty())
    };
    let is_git_ignored = ignored_paths.contains(&git_ignore_match_key(&entry.relative_path));

    NativeProjectTreeEntry {
        id: format!("{}:{}", root.project_id.0, entry.relative_path),
        project_id: root.project_id.clone(),
        worktree_id: root.worktree_id.clone(),
        name: entry.name,
        parent_relative_path: parent_relative_path(&entry.relative_path),
        relative_path: entry.relative_path,
        kind: if is_directory { "directory" } else { "file" }.to_string(),
        extension,
        has_children,
        is_git_ignored,
        git_status: None,
        absolute_path: Some(entry.absolute_path.to_string_lossy().to_string()),
        visibility: Some(visibility),
    }
}

fn check_git_ignored_paths(root_path: &Path, relative_paths: &[&str]) -> HashSet<String> {
    let mut ignored_paths = HashSet::new();

    for chunk in relative_paths.chunks(GIT_CHECK_IGNORE_CHUNK_SIZE) {
        if chunk.is_empty() {
            continue;
        }

        let mut child = match Command::new("git")
            .current_dir(root_path)
            .args([
                "-c",
                "core.quotePath=false",
                "check-ignore",
                "-z",
                "--stdin",
            ])
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => continue,
        };

        if let Some(stdin) = child.stdin.as_mut() {
            for relative_path in chunk {
                let _ = stdin.write_all(relative_path.as_bytes());
                let _ = stdin.write_all(&[0]);
            }
        }
        drop(child.stdin.take());

        let output = match child.wait_with_output() {
            Ok(output) if output.status.success() => output,
            _ => continue,
        };

        for path in output.stdout.split(|byte| *byte == 0) {
            if path.is_empty() {
                continue;
            }
            let relative_path = String::from_utf8_lossy(path).to_string();
            ignored_paths.insert(git_ignore_match_key(&relative_path));
        }
    }

    ignored_paths
}

fn git_ignore_match_key(relative_path: &str) -> String {
    relative_path.replace('\\', "/")
}

fn directory_has_children(directory: &Path) -> bool {
    match fs::read_dir(directory) {
        Ok(mut entries) => entries.next().is_some(),
        Err(_) => false,
    }
}

fn sort_directory_entries(entries: &mut [DirectoryEntry]) {
    entries.sort_by(
        |left, right| match (left.file_type.is_dir(), right.file_type.is_dir()) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
        },
    );
}

fn fs_entry_kind(metadata: &fs::Metadata) -> NativeFsEntryKind {
    if metadata.file_type().is_symlink() {
        NativeFsEntryKind::Symlink
    } else if metadata.is_dir() {
        NativeFsEntryKind::Directory
    } else if metadata.is_file() {
        NativeFsEntryKind::File
    } else {
        NativeFsEntryKind::Other
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;
    use crate::test_support::project_root;

    #[test]
    fn lists_folders_first_and_keeps_dotfiles_visible() {
        let temp = TempDir::new().expect("temp");
        fs::create_dir(temp.path().join("src")).expect("src");
        fs::write(temp.path().join(".env"), "APP=1").expect("env");
        fs::write(temp.path().join("README.md"), "# Readme").expect("readme");
        let root = project_root(temp.path());

        let entries = list_tree_children(&root, None).expect("entries");
        let names = entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["src", ".env", "README.md"]);
        assert!(entries.iter().any(|entry| entry.name == ".env"));
    }

    #[test]
    fn marks_noisy_and_special_directories_without_hiding_them() {
        let temp = TempDir::new().expect("temp");
        fs::create_dir(temp.path().join("node_modules")).expect("node_modules");
        fs::create_dir(temp.path().join(".git")).expect(".git");
        let root = project_root(temp.path());

        let entries = list_tree_children(&root, None).expect("entries");

        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.name == "node_modules")
                .and_then(|entry| entry.visibility),
            Some(comando_types::fs::NativeFsVisibilityPolicy::Noisy)
        );
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.name == ".git")
                .and_then(|entry| entry.visibility),
            Some(comando_types::fs::NativeFsVisibilityPolicy::Special)
        );
    }

    #[test]
    fn marks_git_ignored_entries() {
        let temp = TempDir::new().expect("temp");
        run_git(temp.path(), &["init"]);
        fs::write(temp.path().join(".gitignore"), "local.env\nlogs/\n").expect("gitignore");
        fs::write(temp.path().join("local.env"), "SECRET=1").expect("ignored file");
        fs::write(temp.path().join("tracked.env"), "PUBLIC=1").expect("tracked file");
        fs::create_dir(temp.path().join("logs")).expect("logs");
        fs::write(temp.path().join("logs/app.log"), "log").expect("log file");
        let root = project_root(temp.path());

        let entries = list_tree_children(&root, None).expect("entries");
        assert!(find_entry(&entries, "local.env").is_git_ignored);
        assert!(find_entry(&entries, "logs").is_git_ignored);
        assert!(!find_entry(&entries, "tracked.env").is_git_ignored);

        let all_entries = list_entries(&root, None).expect("all entries").entries;
        assert!(find_entry(&all_entries, "logs/app.log").is_git_ignored);
    }

    fn find_entry<'a>(
        entries: &'a [NativeProjectTreeEntry],
        relative_path: &str,
    ) -> &'a NativeProjectTreeEntry {
        entries
            .iter()
            .find(|entry| entry.relative_path == relative_path)
            .expect("entry")
    }

    fn run_git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(root)
            .args(args)
            .status()
            .expect("git command should start");
        assert!(status.success(), "git command failed: {args:?}");
    }
}
