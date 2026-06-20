use std::path::{Path, PathBuf};
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
    if !input_path.is_dir() {
        return Err(ProjectRegistryError::DirectoryNotFound(
            input_path.to_path_buf(),
        ));
    }

    let resolved_path = canonicalize_path(input_path)?;
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
    let canonical_root_path = canonicalize_path(canonical_root_path)?;
    let worktree_root_path = canonicalize_path(worktree_root_path)?;
    let name = canonical_root_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Project")
        .to_string();

    Ok(ProjectPathMetadata {
        canonical_root_path: path_to_string(canonical_root_path),
        name,
        worktree_root_path: path_to_string(worktree_root_path),
    })
}

fn canonicalize_path(path: impl AsRef<Path>) -> Result<PathBuf, ProjectRegistryError> {
    let path = path.as_ref();
    path.canonicalize()
        .map_err(|source| ProjectRegistryError::CanonicalizePath {
            path: path.to_path_buf(),
            source,
        })
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

    Some(PathBuf::from(trimmed))
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}
