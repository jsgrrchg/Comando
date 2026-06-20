use std::path::{Component, Path, PathBuf};
use std::process::Command;

use crate::error::ProjectRegistryError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectPathMetadata {
    pub canonical_root_path: String,
    pub name: String,
    pub worktree_root_path: String,
}

pub fn resolve_project_path_metadata(
    project_path: impl AsRef<Path>,
) -> Result<ProjectPathMetadata, ProjectRegistryError> {
    let input_path = project_path.as_ref();
    let resolved_path = resolve_lexical_path(input_path)?;
    if !resolved_path.is_dir() {
        return Err(ProjectRegistryError::DirectoryNotFound(
            resolved_path.to_path_buf(),
        ));
    }

    let worktree_root_path =
        git_path(&resolved_path, &["rev-parse", "--show-toplevel"]).unwrap_or(resolved_path);
    let common_dir = git_path(
        &worktree_root_path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    let canonical_root_path = common_dir
        .as_deref()
        .filter(|path| path.file_name().and_then(|value| value.to_str()) == Some(".git"))
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| worktree_root_path.clone());
    let canonical_root_path = normalize_lexical_path(canonical_root_path);
    let worktree_root_path = normalize_lexical_path(worktree_root_path);
    let name = canonical_root_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Project")
        .to_string();

    Ok(ProjectPathMetadata {
        canonical_root_path: path_to_storage_string(canonical_root_path),
        name,
        worktree_root_path: path_to_storage_string(worktree_root_path),
    })
}

fn resolve_lexical_path(path: impl AsRef<Path>) -> Result<PathBuf, ProjectRegistryError> {
    let path = path.as_ref();
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|source| ProjectRegistryError::ResolvePath {
                path: path.to_path_buf(),
                source,
            })?
            .join(path)
    };

    Ok(normalize_lexical_path(absolute))
}

fn normalize_lexical_path(path: impl AsRef<Path>) -> PathBuf {
    let mut normalized = PathBuf::new();

    for component in path.as_ref().components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
        }
    }

    normalized
}

fn git_path(cwd: &Path, args: &[&str]) -> Option<PathBuf> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(normalize_lexical_path(PathBuf::from(trimmed)))
}

fn path_to_storage_string(path: PathBuf) -> String {
    strip_windows_verbatim_prefix(&path.to_string_lossy())
}

fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(stripped) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{stripped}");
    }

    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn resolves_existing_paths_without_following_symlink_targets() {
        let temp_dir = TempDir::new().expect("temp dir");
        let real_dir = temp_dir.path().join("real");
        let linked_dir = temp_dir.path().join("linked");
        fs::create_dir_all(&real_dir).expect("real dir");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real_dir, &linked_dir).expect("symlink");
            let metadata = resolve_project_path_metadata(&linked_dir).expect("metadata");

            assert_eq!(
                metadata.canonical_root_path,
                normalize_lexical_path(&linked_dir).to_string_lossy()
            );
            assert_ne!(metadata.canonical_root_path, real_dir.to_string_lossy());
        }
    }

    #[test]
    fn strips_windows_verbatim_prefixes_before_storage() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Users\Project"),
            r"C:\Users\Project"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\Project"),
            r"\\server\share\Project"
        );
    }
}
