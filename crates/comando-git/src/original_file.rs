use std::path::Path;
use std::time::Duration;

use comando_types::git::NativeGitOriginalFile;

use crate::diff::validate_relative_path;
use crate::error::{GitError, GitResult};
use crate::runner::{GitRunOptions, GitRunner};

const SHOW_TEXT_TIMEOUT: Duration = Duration::from_secs(10);
const SHOW_TEXT_MAX_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitFileTextReference {
    Head,
    Index,
}

pub fn get_original_file(
    runner: &GitRunner,
    root_path: impl AsRef<Path>,
    relative_path: &str,
    previous_path: Option<&str>,
    kind: &str,
    scope: &str,
) -> GitResult<NativeGitOriginalFile> {
    let path = validate_relative_path(relative_path)?;
    let previous_path = previous_path.map(validate_relative_path).transpose()?;
    let resolved_scope = if scope == "auto" { "unstaged" } else { scope };

    if resolved_scope == "untracked" {
        return Ok(original_file(
            path,
            previous_path,
            kind,
            resolved_scope,
            Some(String::new()),
            true,
        ));
    }

    let reference = if resolved_scope == "staged" {
        GitFileTextReference::Head
    } else {
        GitFileTextReference::Index
    };
    let base_path = original_base_path(&path, previous_path.as_deref(), resolved_scope);
    let base_text = get_file_text(runner, root_path, &base_path, reference)?;
    let base_text = match base_text {
        Some(text) => Some(text),
        None if kind == "added" || kind == "untracked" => Some(String::new()),
        None => None,
    };
    let is_text = base_text.is_some();

    Ok(original_file(
        path,
        previous_path,
        kind,
        resolved_scope,
        base_text,
        is_text,
    ))
}

pub fn get_file_text(
    runner: &GitRunner,
    root_path: impl AsRef<Path>,
    relative_path: &str,
    reference: GitFileTextReference,
) -> GitResult<Option<String>> {
    let path = validate_relative_path(relative_path)?;
    let object_name = match reference {
        GitFileTextReference::Head => format!("HEAD:{path}"),
        GitFileTextReference::Index => format!(":{path}"),
    };
    let options = GitRunOptions {
        timeout: SHOW_TEXT_TIMEOUT,
        max_stdout_bytes: SHOW_TEXT_MAX_BYTES,
        ..GitRunOptions::read_only()
    };

    match runner.run(
        root_path,
        &["show", "--textconv", object_name.as_str()],
        options,
    ) {
        Ok(output) => Ok(Some(output.stdout)),
        Err(GitError::CommandFailed { .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

fn original_file(
    path: String,
    previous_path: Option<String>,
    kind: &str,
    scope: &str,
    base_text: Option<String>,
    is_text: bool,
) -> NativeGitOriginalFile {
    NativeGitOriginalFile {
        base_text,
        is_text,
        kind: kind.to_string(),
        path,
        previous_path,
        scope: scope.to_string(),
    }
}

fn original_base_path(path: &str, previous_path: Option<&str>, scope: &str) -> String {
    if scope == "staged" {
        return previous_path.unwrap_or(path).to_string();
    }

    path.to_string()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use crate::runner::GitRunner;
    use crate::test_support::run_git_fixture;

    use super::{GitFileTextReference, get_file_text, get_original_file};

    #[test]
    fn reads_head_and_index_file_text() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        fs::write(temp.path().join("tracked.txt"), "index\n").expect("index");
        run_git_fixture(temp.path(), &["add", "tracked.txt"]);
        fs::write(temp.path().join("tracked.txt"), "worktree\n").expect("worktree");

        let head = get_file_text(
            &GitRunner::new(),
            temp.path(),
            "tracked.txt",
            GitFileTextReference::Head,
        )
        .expect("head");
        let index = get_file_text(
            &GitRunner::new(),
            temp.path(),
            "tracked.txt",
            GitFileTextReference::Index,
        )
        .expect("index");

        assert_eq!(head.as_deref(), Some("base\n"));
        assert_eq!(index.as_deref(), Some("index\n"));
    }

    #[test]
    fn returns_empty_base_for_untracked_file() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        fs::write(temp.path().join("new.txt"), "new\n").expect("new");

        let original = get_original_file(
            &GitRunner::new(),
            temp.path(),
            "new.txt",
            None,
            "untracked",
            "untracked",
        )
        .expect("original");

        assert_eq!(original.base_text.as_deref(), Some(""));
        assert!(original.is_text);
    }

    #[test]
    fn returns_none_for_missing_head_blob() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);

        let text = get_file_text(
            &GitRunner::new(),
            temp.path(),
            "missing.txt",
            GitFileTextReference::Head,
        )
        .expect("missing");

        assert_eq!(text, None);
    }

    fn init_repo(temp: &TempDir) {
        run_git_fixture(temp.path(), &["init", "-b", "main"]);
        run_git_fixture(temp.path(), &["config", "user.name", "Test User"]);
        run_git_fixture(
            temp.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        fs::write(temp.path().join("tracked.txt"), "base\n").expect("base");
        run_git_fixture(temp.path(), &["add", "tracked.txt"]);
        run_git_fixture(temp.path(), &["commit", "-m", "initial"]);
    }
}
