use std::fs;
use std::path::{Path, PathBuf};

use comando_types::git::NativeGitRepositoryResolution;
use comando_types::ids::RepositoryId;
use sha2::{Digest, Sha256};

use crate::error::{GitError, GitResult};
use crate::runner::{GitRunOptions, GitRunner};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRepositoryContext {
    pub repository_id: RepositoryId,
    pub resolution: NativeGitRepositoryResolution,
    pub root_path: PathBuf,
}

pub fn resolve_repository(
    runner: &GitRunner,
    input_path: impl AsRef<Path>,
) -> GitResult<NativeGitRepositoryResolution> {
    let input_path = input_path.as_ref();
    let normalized_path = normalize_input_path(input_path);

    let Ok(metadata) = fs::metadata(&normalized_path) else {
        return Ok(repository_resolution(
            &normalized_path,
            None,
            None,
            false,
            false,
            Some("The selected path does not exist.".to_string()),
            "missing",
        ));
    };

    if !metadata.is_dir() {
        return Ok(repository_resolution(
            &normalized_path,
            None,
            None,
            false,
            false,
            Some("The selected path is not a directory.".to_string()),
            "not_repo",
        ));
    }

    match runner.run(
        &normalized_path,
        &["rev-parse", "--show-toplevel"],
        GitRunOptions::read_only(),
    ) {
        Ok(output) => {
            let root_path = normalize_input_path(output.stdout.trim());
            let git_dir_path = resolve_git_dir(runner, &normalized_path)?;
            Ok(repository_resolution(
                &normalized_path,
                Some(root_path),
                Some(git_dir_path),
                false,
                true,
                None,
                "ready",
            ))
        }
        Err(error) => {
            if is_bare_repository(runner, &normalized_path)? {
                return Ok(repository_resolution(
                    &normalized_path,
                    Some(normalized_path.clone()),
                    Some(normalized_path.clone()),
                    true,
                    false,
                    None,
                    "bare",
                ));
            }

            Ok(repository_resolution(
                &normalized_path,
                None,
                None,
                false,
                false,
                Some(repository_error_message(error)),
                "not_repo",
            ))
        }
    }
}

pub fn repository_context(
    runner: &GitRunner,
    input_path: impl AsRef<Path>,
) -> GitResult<GitRepositoryContext> {
    let resolution = resolve_repository(runner, input_path)?;
    let Some(root_path) = resolution.canonical_root_path.as_ref() else {
        return Err(GitError::NotRepository);
    };

    Ok(GitRepositoryContext {
        repository_id: repository_id(root_path),
        root_path: PathBuf::from(root_path),
        resolution,
    })
}

pub fn repository_id(root_path: &str) -> RepositoryId {
    let mut hasher = Sha256::new();
    hasher.update(root_path.as_bytes());
    let digest = hasher.finalize();
    RepositoryId(format!("git:{}", hex_prefix(&digest, 16)))
}

fn resolve_git_dir(runner: &GitRunner, input_path: &Path) -> GitResult<PathBuf> {
    let output = runner.run(
        input_path,
        &["rev-parse", "--git-dir"],
        GitRunOptions::read_only(),
    )?;
    let trimmed = output.stdout.trim();
    let git_dir = PathBuf::from(trimmed);

    if git_dir.is_absolute() {
        return Ok(normalize_input_path(git_dir));
    }

    Ok(normalize_input_path(input_path.join(git_dir)))
}

fn is_bare_repository(runner: &GitRunner, input_path: &Path) -> GitResult<bool> {
    match runner.run(
        input_path,
        &["rev-parse", "--is-bare-repository"],
        GitRunOptions::read_only(),
    ) {
        Ok(output) => Ok(output.stdout.trim() == "true"),
        Err(GitError::CommandFailed { .. }) | Err(GitError::NotRepository) => Ok(false),
        Err(error) => Err(error),
    }
}

fn repository_resolution(
    input_path: &Path,
    canonical_root_path: Option<PathBuf>,
    git_dir_path: Option<PathBuf>,
    is_bare: bool,
    is_work_tree: bool,
    message: Option<String>,
    state: &str,
) -> NativeGitRepositoryResolution {
    NativeGitRepositoryResolution {
        input_path: input_path.to_string_lossy().to_string(),
        canonical_root_path: canonical_root_path.map(|path| path.to_string_lossy().to_string()),
        git_dir_path: git_dir_path.map(|path| path.to_string_lossy().to_string()),
        is_bare,
        is_work_tree,
        message,
        state: state.to_string(),
    }
}

fn normalize_input_path(path: impl AsRef<Path>) -> PathBuf {
    fs::canonicalize(path.as_ref()).unwrap_or_else(|_| path.as_ref().to_path_buf())
}

fn repository_error_message(error: GitError) -> String {
    match error {
        GitError::CommandFailed { stderr, .. } if !stderr.trim().is_empty() => stderr,
        _ => "The selected path is not a git repository.".to_string(),
    }
}

fn hex_prefix(bytes: &[u8], chars: usize) -> String {
    bytes
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .take(chars)
        .map(|nibble| char::from_digit(nibble.into(), 16).expect("hex digit"))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use crate::runner::GitRunner;
    use crate::test_support::run_git_fixture;

    use super::{repository_context, resolve_repository};

    #[test]
    fn resolves_repository_from_nested_path() {
        let temp = TempDir::new().expect("temp");
        run_git_fixture(temp.path(), &["init"]);
        fs::create_dir_all(temp.path().join("src/nested")).expect("nested");

        let resolution =
            resolve_repository(&GitRunner::new(), temp.path().join("src/nested")).expect("repo");
        let expected_root = fs::canonicalize(temp.path())
            .expect("canonical temp")
            .to_string_lossy()
            .to_string();

        assert_eq!(resolution.state, "ready");
        assert_eq!(
            resolution.canonical_root_path.as_deref(),
            Some(expected_root.as_str())
        );
        assert!(
            resolution
                .git_dir_path
                .as_deref()
                .is_some_and(|path| path.ends_with(".git"))
        );
        assert!(resolution.is_work_tree);
    }

    #[test]
    fn reports_missing_path_without_running_git() {
        let temp = TempDir::new().expect("temp");
        let resolution =
            resolve_repository(&GitRunner::new(), temp.path().join("missing")).expect("missing");

        assert_eq!(resolution.state, "missing");
        assert_eq!(resolution.canonical_root_path, None);
    }

    #[test]
    fn reports_not_repo_for_plain_directory() {
        let temp = TempDir::new().expect("temp");
        let resolution = resolve_repository(&GitRunner::new(), temp.path()).expect("not repo");

        assert_eq!(resolution.state, "not_repo");
        assert!(!resolution.is_work_tree);
    }

    #[test]
    fn reports_bare_repository() {
        let temp = TempDir::new().expect("temp");
        run_git_fixture(temp.path(), &["init", "--bare"]);

        let resolution = resolve_repository(&GitRunner::new(), temp.path()).expect("bare repo");

        assert_eq!(resolution.state, "bare");
        assert!(resolution.is_bare);
        assert!(!resolution.is_work_tree);
    }

    #[test]
    fn builds_stable_repository_context_id() {
        let temp = TempDir::new().expect("temp");
        run_git_fixture(temp.path(), &["init"]);

        let first = repository_context(&GitRunner::new(), temp.path()).expect("first");
        let second = repository_context(&GitRunner::new(), temp.path()).expect("second");

        assert_eq!(first.repository_id, second.repository_id);
        assert!(first.repository_id.0.starts_with("git:"));
    }
}
