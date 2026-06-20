use std::path::{Path, PathBuf};
use std::time::Duration;

use comando_types::git::{
    NativeGitDiffHunk, NativeGitDiffLine, NativeGitDiffStatRecord, NativeGitFileDiff,
    NativeGitFileDiffSummary,
};

use crate::error::{GitError, GitResult};
use crate::runner::{GitRunOptions, GitRunner};

const FILE_DIFF_TIMEOUT: Duration = Duration::from_secs(20);
const UNTRACKED_DIFF_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitFileDiffRequest {
    pub relative_path: String,
    pub previous_path: Option<String>,
    pub change_kind: Option<String>,
    pub scope: String,
    pub staged: bool,
}

pub fn get_diff_stats(
    runner: &GitRunner,
    root_path: impl AsRef<Path>,
) -> Vec<NativeGitDiffStatRecord> {
    let mut stats = Vec::new();
    collect_diff_stats(
        runner,
        root_path.as_ref(),
        "unstaged",
        &["diff", "--numstat"],
        &mut stats,
    );
    collect_diff_stats(
        runner,
        root_path.as_ref(),
        "staged",
        &["diff", "--cached", "--numstat"],
        &mut stats,
    );
    stats
}

pub fn get_file_diff(
    runner: &GitRunner,
    root_path: impl AsRef<Path>,
    request: &GitFileDiffRequest,
) -> GitResult<NativeGitFileDiff> {
    let path = validate_relative_path(&request.relative_path)?;
    let previous_path = request
        .previous_path
        .as_deref()
        .map(validate_relative_path)
        .transpose()?;
    let args = build_diff_args(
        &path,
        previous_path.as_deref(),
        &request.scope,
        request.staged,
    );
    let options = diff_run_options(&request.scope);
    let output = runner.run(root_path, &args, options)?;
    let parsed = parse_unified_diff(&output.stdout, &path);

    Ok(NativeGitFileDiff {
        path,
        previous_path,
        kind: file_diff_kind(request.change_kind.as_deref()),
        staged: request.staged || request.scope == "staged",
        is_binary: parsed.is_binary,
        is_text: !parsed.is_binary,
        is_too_large: false,
        old_text: None,
        new_text: None,
        raw: output.stdout,
        summary: parsed.summary,
        hunks: parsed.hunks,
    })
}

pub fn parse_unified_diff(raw: &str, path: &str) -> ParsedUnifiedDiff {
    let mut hunks = Vec::new();
    let mut current = None::<MutableHunk>;
    let mut old_line_number = 0;
    let mut new_line_number = 0;
    let mut insertions = 0;
    let mut deletions = 0;
    let mut is_binary = false;

    for line in raw.split('\n') {
        if line.starts_with("Binary files ") {
            is_binary = true;
            continue;
        }

        if let Some(header) = parse_hunk_header(line) {
            if let Some(hunk) = current.take() {
                hunks.push(hunk.into_hunk(path, hunks.len()));
            }
            old_line_number = header.old_start;
            new_line_number = header.new_start;
            current = Some(MutableHunk {
                header: line.to_string(),
                old_start: header.old_start,
                old_count: header.old_count,
                new_start: header.new_start,
                new_count: header.new_count,
                lines: Vec::new(),
            });
            continue;
        }

        let Some(hunk) = current.as_mut() else {
            continue;
        };

        if line.starts_with('+') && !line.starts_with("+++") {
            hunk.lines.push(NativeGitDiffLine {
                id: String::new(),
                line_type: "add".to_string(),
                text: line[1..].to_string(),
                old_line_number: None,
                new_line_number: Some(new_line_number),
            });
            insertions += 1;
            new_line_number += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            hunk.lines.push(NativeGitDiffLine {
                id: String::new(),
                line_type: "remove".to_string(),
                text: line[1..].to_string(),
                old_line_number: Some(old_line_number),
                new_line_number: None,
            });
            deletions += 1;
            old_line_number += 1;
        } else if let Some(text) = line.strip_prefix(' ') {
            hunk.lines.push(NativeGitDiffLine {
                id: String::new(),
                line_type: "context".to_string(),
                text: text.to_string(),
                old_line_number: Some(old_line_number),
                new_line_number: Some(new_line_number),
            });
            old_line_number += 1;
            new_line_number += 1;
        }
    }

    if let Some(hunk) = current {
        hunks.push(hunk.into_hunk(path, hunks.len()));
    }

    ParsedUnifiedDiff {
        hunks,
        is_binary,
        summary: NativeGitFileDiffSummary {
            insertions,
            deletions,
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedUnifiedDiff {
    pub hunks: Vec<NativeGitDiffHunk>,
    pub is_binary: bool,
    pub summary: NativeGitFileDiffSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HunkHeader {
    old_start: u32,
    old_count: u32,
    new_start: u32,
    new_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MutableHunk {
    header: String,
    old_start: u32,
    old_count: u32,
    new_start: u32,
    new_count: u32,
    lines: Vec<NativeGitDiffLine>,
}

impl MutableHunk {
    fn into_hunk(mut self, path: &str, hunk_index: usize) -> NativeGitDiffHunk {
        for (line_index, line) in self.lines.iter_mut().enumerate() {
            line.id = format!("{path}:{hunk_index}:{line_index}");
        }

        NativeGitDiffHunk {
            id: format!("{path}:{hunk_index}"),
            header: self.header,
            old_start: self.old_start,
            old_count: self.old_count,
            new_start: self.new_start,
            new_count: self.new_count,
            lines: self.lines,
        }
    }
}

fn collect_diff_stats(
    runner: &GitRunner,
    root_path: &Path,
    scope: &str,
    args: &[&str],
    stats: &mut Vec<NativeGitDiffStatRecord>,
) {
    let Ok(output) = runner.run(root_path, args, GitRunOptions::read_only()) else {
        return;
    };

    for line in output.stdout.lines() {
        let parts = line.split('\t').collect::<Vec<_>>();
        let [additions_raw, deletions_raw, path] = parts.as_slice() else {
            continue;
        };
        let Ok(additions) = additions_raw.parse::<i64>() else {
            continue;
        };
        let Ok(deletions) = deletions_raw.parse::<i64>() else {
            continue;
        };
        stats.push(NativeGitDiffStatRecord {
            additions,
            deletions,
            key: format!("{scope}:{path}"),
        });
    }
}

fn build_diff_args(
    path: &str,
    previous_path: Option<&str>,
    scope: &str,
    staged: bool,
) -> Vec<String> {
    if scope == "untracked" {
        return vec![
            "diff".to_string(),
            "--no-index".to_string(),
            "--no-color".to_string(),
            "--unified=3".to_string(),
            "--".to_string(),
            "/dev/null".to_string(),
            path.to_string(),
        ];
    }

    let mut args = vec!["diff".to_string()];
    if staged || scope == "staged" {
        args.push("--cached".to_string());
    }
    args.extend([
        "--find-renames".to_string(),
        "--find-copies".to_string(),
        "--no-color".to_string(),
        "--unified=3".to_string(),
        "--".to_string(),
    ]);
    if let Some(previous_path) = previous_path {
        args.push(previous_path.to_string());
    }
    args.push(path.to_string());
    args
}

fn diff_run_options(scope: &str) -> GitRunOptions {
    let timeout = if scope == "untracked" {
        UNTRACKED_DIFF_TIMEOUT
    } else {
        FILE_DIFF_TIMEOUT
    };
    let options = GitRunOptions {
        timeout,
        ..GitRunOptions::read_only()
    };

    if scope == "untracked" {
        options.allow_exit_code(1)
    } else {
        options
    }
}

pub(crate) fn validate_relative_path(path: &str) -> GitResult<String> {
    let normalized = path.replace('\\', "/");
    let path_buf = PathBuf::from(&normalized);

    if normalized.is_empty()
        || normalized == "."
        || normalized.starts_with('/')
        || path_buf.is_absolute()
        || normalized.split('/').any(|segment| segment == "..")
    {
        return Err(GitError::InvalidPath);
    }

    Ok(normalized)
}

fn file_diff_kind(change_kind: Option<&str>) -> String {
    match change_kind {
        Some("added") | Some("untracked") => "create",
        Some("deleted") => "delete",
        Some("renamed") => "move",
        _ => "update",
    }
    .to_string()
}

fn parse_hunk_header(line: &str) -> Option<HunkHeader> {
    let rest = line.strip_prefix("@@ -")?;
    let (old_part, rest) = rest.split_once(" +")?;
    let (new_part, _) = rest.split_once(" @@")?;
    let (old_start, old_count) = parse_range(old_part)?;
    let (new_start, new_count) = parse_range(new_part)?;

    Some(HunkHeader {
        old_start,
        old_count,
        new_start,
        new_count,
    })
}

fn parse_range(value: &str) -> Option<(u32, u32)> {
    if let Some((start, count)) = value.split_once(',') {
        return Some((start.parse().ok()?, count.parse().ok()?));
    }

    Some((value.parse().ok()?, 1))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use crate::runner::GitRunner;
    use crate::test_support::run_git_fixture;

    use super::{GitFileDiffRequest, get_diff_stats, get_file_diff, parse_unified_diff};

    #[test]
    fn parses_unified_diff_hunks() {
        let parsed = parse_unified_diff("@@ -1 +1 @@\n-old\n+new\n", "file.txt");

        assert_eq!(parsed.summary.insertions, 1);
        assert_eq!(parsed.summary.deletions, 1);
        assert_eq!(parsed.hunks[0].lines[0].line_type, "remove");
        assert_eq!(parsed.hunks[0].lines[1].new_line_number, Some(1));
    }

    #[test]
    fn gets_unstaged_file_diff() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        fs::write(temp.path().join("tracked.txt"), "changed\n").expect("change");

        let diff = get_file_diff(
            &GitRunner::new(),
            temp.path(),
            &request("tracked.txt", "unstaged", false),
        )
        .expect("diff");

        assert_eq!(diff.path, "tracked.txt");
        assert_eq!(diff.summary.insertions, 1);
        assert_eq!(diff.summary.deletions, 1);
        assert!(!diff.staged);
    }

    #[test]
    fn gets_staged_file_diff_and_stats() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        fs::write(temp.path().join("tracked.txt"), "changed\n").expect("change");
        run_git_fixture(temp.path(), &["add", "tracked.txt"]);

        let diff = get_file_diff(
            &GitRunner::new(),
            temp.path(),
            &request("tracked.txt", "staged", true),
        )
        .expect("diff");
        let stats = get_diff_stats(&GitRunner::new(), temp.path());

        assert!(diff.staged);
        assert!(stats.iter().any(|stat| stat.key == "staged:tracked.txt"));
    }

    #[test]
    fn gets_untracked_no_index_diff() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        fs::write(temp.path().join("new.txt"), "hello\n").expect("new");

        let diff = get_file_diff(
            &GitRunner::new(),
            temp.path(),
            &request("new.txt", "untracked", false),
        )
        .expect("diff");

        assert_eq!(diff.kind, "create");
        assert_eq!(diff.summary.insertions, 1);
    }

    #[test]
    fn rejects_paths_outside_repository() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        let error = get_file_diff(
            &GitRunner::new(),
            temp.path(),
            &request("../outside.txt", "unstaged", false),
        )
        .expect_err("invalid path");

        assert!(matches!(error, crate::error::GitError::InvalidPath));
    }

    #[test]
    fn allows_colon_path_segments_on_posix() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        fs::write(temp.path().join("a:b.txt"), "base\n").expect("colon");
        run_git_fixture(temp.path(), &["add", "a:b.txt"]);
        run_git_fixture(temp.path(), &["commit", "-m", "colon"]);
        fs::write(temp.path().join("a:b.txt"), "changed\n").expect("change");

        let diff = get_file_diff(
            &GitRunner::new(),
            temp.path(),
            &request("a:b.txt", "unstaged", false),
        )
        .expect("diff");

        assert_eq!(diff.path, "a:b.txt");
    }

    fn request(path: &str, scope: &str, staged: bool) -> GitFileDiffRequest {
        GitFileDiffRequest {
            relative_path: path.to_string(),
            previous_path: None,
            change_kind: (scope == "untracked").then(|| "untracked".to_string()),
            scope: scope.to_string(),
            staged,
        }
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
