use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::error::FsError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopedPathIntent {
    ReadExisting,
    WriteExisting,
    CreateTarget,
    CreateDirectoryTarget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProjectPath {
    pub absolute_path: PathBuf,
    pub relative_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoundaryPathMode {
    Canonical,
    LexicalFallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BoundaryPath {
    path: PathBuf,
    mode: BoundaryPathMode,
}

pub fn resolve_scoped_path(
    root: &Path,
    raw_relative_path: Option<&str>,
    allow_root: bool,
    intent: ScopedPathIntent,
) -> Result<ResolvedProjectPath, FsError> {
    let validated = validate_untrusted_relative_path(raw_relative_path.unwrap_or(""), allow_root)?;
    let relative_path = path_to_portable_string(&validated);
    let candidate = if validated.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        root.join(&validated)
    };

    let resolved_root = canonicalize_existing_path_for_boundary(root)
        .map_err(|error| map_boundary_io_error(error, FsError::PathEscape))?;
    let nearest_existing_ancestor = nearest_existing_ancestor(&candidate)?;
    let resolved_ancestor = canonicalize_existing_path_for_boundary(&nearest_existing_ancestor)
        .map_err(|error| map_boundary_io_error(error, FsError::PathEscape))?;

    if !boundary_path_starts_with(&resolved_ancestor, &resolved_root) {
        return Err(FsError::PathEscape);
    }

    reject_forbidden_existing_components(root, &validated)?;

    if matches!(
        intent,
        ScopedPathIntent::ReadExisting | ScopedPathIntent::WriteExisting
    ) && !candidate.exists()
    {
        return Err(FsError::NotFound);
    }

    Ok(ResolvedProjectPath {
        absolute_path: candidate,
        relative_path: (!relative_path.is_empty()).then_some(relative_path),
    })
}

pub fn validate_untrusted_relative_path(raw: &str, allow_root: bool) -> Result<PathBuf, FsError> {
    if raw.is_empty() {
        return if allow_root {
            Ok(PathBuf::new())
        } else {
            Err(FsError::InvalidPath)
        };
    }

    if raw.contains('\\') || raw.split('/').any(str::is_empty) {
        return Err(FsError::InvalidPath);
    }

    let mut normalized = PathBuf::new();
    let mut has_component = false;

    for component in Path::new(raw).components() {
        match component {
            Component::Normal(value) => {
                let value = value.to_str().ok_or(FsError::InvalidPath)?;
                if value == "." || value == ".." || looks_like_windows_prefix(value) {
                    return Err(FsError::InvalidPath);
                }
                normalized.push(value);
                has_component = true;
            }
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => return Err(FsError::InvalidPath),
        }
    }

    if !has_component && !allow_root {
        return Err(FsError::InvalidPath);
    }

    Ok(normalized)
}

pub fn validate_entry_name(name: &str) -> Result<String, FsError> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err(FsError::InvalidPath);
    }

    if looks_like_windows_prefix(trimmed) {
        return Err(FsError::InvalidPath);
    }

    Ok(trimmed.to_string())
}

pub fn normalize_relative_path(path: impl AsRef<Path>) -> String {
    path_to_portable_string(path)
}

pub fn parent_relative_path(relative_path: &str) -> Option<String> {
    let parent = Path::new(relative_path).parent()?;
    let portable = path_to_portable_string(parent);
    (!portable.is_empty()).then_some(portable)
}

pub fn is_same_or_child_path(candidate_path: &Path, parent_path: &Path) -> bool {
    let candidate = normalize_lexically(candidate_path);
    let parent = normalize_lexically(parent_path);
    candidate == parent || candidate.starts_with(parent)
}

pub fn is_child_path(candidate_path: &Path, parent_path: &Path) -> bool {
    let candidate = normalize_lexically(candidate_path);
    let parent = normalize_lexically(parent_path);
    candidate != parent && candidate.starts_with(parent)
}

fn reject_forbidden_existing_components(root: &Path, relative_path: &Path) -> Result<(), FsError> {
    let mut current = root.to_path_buf();
    for component in relative_path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata_has_forbidden_link_behavior(&metadata) {
                    return Err(FsError::PathEscape);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return Err(FsError::PermissionDenied);
            }
            Err(error) => return Err(FsError::Io(error)),
        }
    }

    Ok(())
}

fn nearest_existing_ancestor(path: &Path) -> Result<PathBuf, FsError> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match fs::symlink_metadata(candidate) {
            Ok(_) => return Ok(candidate.to_path_buf()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                current = candidate.parent();
            }
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return Err(FsError::PermissionDenied);
            }
            Err(error) => return Err(FsError::Io(error)),
        }
    }

    Err(FsError::NotFound)
}

fn canonicalize_existing_path_for_boundary(path: &Path) -> io::Result<BoundaryPath> {
    canonicalize_existing_path_with(
        path,
        |path| fs::canonicalize(path),
        is_virtual_fs_canonicalize_error,
    )
}

fn canonicalize_existing_path_with(
    path: &Path,
    canonicalize: impl FnOnce(&Path) -> io::Result<PathBuf>,
    is_virtual_fs_error: impl FnOnce(&io::Error) -> bool,
) -> io::Result<BoundaryPath> {
    match canonicalize(path) {
        Ok(path) => Ok(BoundaryPath {
            path,
            mode: BoundaryPathMode::Canonical,
        }),
        Err(error) => {
            if !is_virtual_fs_error(&error) {
                return Err(error);
            }
            fs::metadata(path)?;
            Ok(BoundaryPath {
                path: normalize_lexically(path),
                mode: BoundaryPathMode::LexicalFallback,
            })
        }
    }
}

#[cfg(windows)]
fn is_virtual_fs_canonicalize_error(error: &io::Error) -> bool {
    error.raw_os_error() == Some(1005)
}

#[cfg(not(windows))]
fn is_virtual_fs_canonicalize_error(_error: &io::Error) -> bool {
    false
}

fn boundary_path_starts_with(child: &BoundaryPath, parent: &BoundaryPath) -> bool {
    if child.mode == BoundaryPathMode::Canonical && parent.mode == BoundaryPathMode::Canonical {
        return child.path.starts_with(&parent.path);
    }

    normalize_lexically(&child.path).starts_with(normalize_lexically(&parent.path))
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = if path.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::new())
    };

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
        }
    }

    normalized
}

fn metadata_has_forbidden_link_behavior(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || metadata_is_windows_reparse_point(metadata)
}

#[cfg(windows)]
fn metadata_is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_windows_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn looks_like_windows_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn path_to_portable_string(path: impl AsRef<Path>) -> String {
    let value = path.as_ref().to_string_lossy().replace('\\', "/");
    if value == "." { String::new() } else { value }
}

fn map_boundary_io_error(error: io::Error, default_error: FsError) -> FsError {
    match error.kind() {
        io::ErrorKind::NotFound => FsError::NotFound,
        io::ErrorKind::PermissionDenied => FsError::PermissionDenied,
        _ => default_error,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn rejects_path_traversal_and_windows_prefixes() {
        assert!(validate_untrusted_relative_path("../secret", false).is_err());
        assert!(validate_untrusted_relative_path("..\\secret", false).is_err());
        assert!(validate_untrusted_relative_path("src//main.rs", false).is_err());
        assert!(validate_untrusted_relative_path("C:/secret", false).is_err());
    }

    #[test]
    fn resolves_normal_paths_inside_root() {
        let temp = TempDir::new().expect("temp");
        fs::create_dir_all(temp.path().join("src")).expect("dir");
        fs::write(temp.path().join("src/main.rs"), "fn main() {}\n").expect("file");

        let resolved = resolve_scoped_path(
            temp.path(),
            Some("src/main.rs"),
            false,
            ScopedPathIntent::ReadExisting,
        )
        .expect("resolved");

        assert!(resolved.absolute_path.ends_with("src/main.rs"));
        assert_eq!(resolved.relative_path.as_deref(), Some("src/main.rs"));
    }

    #[test]
    fn rejects_delete_or_read_root_when_root_not_allowed() {
        let temp = TempDir::new().expect("temp");
        assert!(resolve_scoped_path(temp.path(), Some(""), false, ScopedPathIntent::ReadExisting).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().expect("temp");
        let outside = TempDir::new().expect("outside");
        fs::write(outside.path().join("secret.txt"), "secret").expect("secret");
        symlink(outside.path().join("secret.txt"), temp.path().join("linked.txt"))
            .expect("symlink");

        let result = resolve_scoped_path(
            temp.path(),
            Some("linked.txt"),
            false,
            ScopedPathIntent::ReadExisting,
        );

        assert!(matches!(result, Err(FsError::PathEscape)));
    }
}
