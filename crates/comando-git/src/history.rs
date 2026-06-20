use std::path::Path;

use comando_types::git::{
    NativeGitCommitDetail, NativeGitCommitDiffFile, NativeGitCommitReference,
    NativeGitCommitSummary, NativeGitHistoryListResult,
};

use crate::diff::parse_unified_diff;
use crate::error::{GitError, GitResult};
use crate::runner::{GitRunOptions, GitRunner};

const FIELD_SEPARATOR: char = '\u{1f}';
const RECORD_SEPARATOR: char = '\u{1e}';
const DEFAULT_HISTORY_LIMIT: u32 = 200;

pub fn list_history(
    runner: &GitRunner,
    root_path: impl AsRef<Path>,
    query: Option<&str>,
    case_sensitive: bool,
    limit: Option<u32>,
) -> GitResult<NativeGitHistoryListResult> {
    let limit = normalize_limit(limit);
    let format = history_format();
    let query = query.map(str::trim).filter(|query| !query.is_empty());

    if let Some(query) = query {
        let output = match runner.run(
            root_path,
            &[
                "log",
                "--date-order",
                format!("--pretty=format:{format}").as_str(),
            ],
            GitRunOptions::read_only(),
        ) {
            Ok(output) => output,
            Err(error) if is_empty_history_error(&error) => return Ok(empty_history()),
            Err(error) => return Err(error),
        };
        let commits = parse_history(&output.stdout);
        let matches = commits
            .into_iter()
            .filter(|commit| matches_query(commit, query, case_sensitive))
            .collect::<Vec<_>>();
        let matched_count = matches.len().try_into().unwrap_or(u32::MAX);
        return Ok(NativeGitHistoryListResult {
            commits: matches.into_iter().take(limit as usize).collect(),
            matched_count,
            total_count: matched_count,
        });
    }

    let output = match runner.run(
        root_path.as_ref(),
        &[
            "log",
            "--date-order",
            format!("--max-count={limit}").as_str(),
            format!("--pretty=format:{format}").as_str(),
        ],
        GitRunOptions::read_only(),
    ) {
        Ok(output) => output,
        Err(error) if is_empty_history_error(&error) => return Ok(empty_history()),
        Err(error) => return Err(error),
    };
    let total_count = count_commits(runner, root_path)?;

    Ok(NativeGitHistoryListResult {
        commits: parse_history(&output.stdout),
        matched_count: total_count,
        total_count,
    })
}

pub fn get_commit_detail(
    runner: &GitRunner,
    root_path: impl AsRef<Path>,
    commit_sha: &str,
) -> GitResult<NativeGitCommitDetail> {
    let format = history_format();
    let metadata_output = runner.run(
        root_path.as_ref(),
        &[
            "show",
            "--no-patch",
            format!("--format={format}").as_str(),
            commit_sha,
        ],
        GitRunOptions::read_only(),
    )?;
    let summary = parse_history(&metadata_output.stdout)
        .into_iter()
        .next()
        .ok_or(GitError::NotRepository)?;
    let diff_args = commit_diff_args(&summary);
    let diff_output = runner.run(root_path, &diff_args, GitRunOptions::read_only())?;
    let files = parse_commit_diff_files(&diff_output.stdout);
    let insertions = files.iter().map(|file| file.additions.unwrap_or(0)).sum();
    let deletions = files.iter().map(|file| file.deletions.unwrap_or(0)).sum();

    Ok(NativeGitCommitDetail {
        changed_file_count: files.len().try_into().unwrap_or(u32::MAX),
        committed_at: summary.authored_at.clone(),
        committer_email: summary.author_email.clone(),
        committer_name: summary.author_name.clone(),
        deletions,
        files,
        insertions,
        summary,
    })
}

pub fn parse_history(raw: &str) -> Vec<NativeGitCommitSummary> {
    raw.split(RECORD_SEPARATOR)
        .map(str::trim)
        .filter(|record| !record.is_empty())
        .filter_map(parse_history_record)
        .collect()
}

pub fn parse_commit_diff_files(raw: &str) -> Vec<NativeGitCommitDiffFile> {
    let normalized = raw.replace("\r\n", "\n");
    let mut sections = Vec::<Vec<&str>>::new();
    let mut current = Vec::<&str>::new();

    for line in normalized.lines() {
        if line.starts_with("diff --git ") {
            if !current.is_empty() {
                sections.push(current);
            }
            current = vec![line];
        } else if !current.is_empty() {
            current.push(line);
        }
    }

    if !current.is_empty() {
        sections.push(current);
    }

    sections
        .into_iter()
        .enumerate()
        .map(|(index, section)| parse_commit_diff_file(section, index))
        .collect()
}

fn parse_history_record(record: &str) -> Option<NativeGitCommitSummary> {
    let fields = record.split(FIELD_SEPARATOR).collect::<Vec<_>>();
    let [
        sha,
        parent_shas,
        author_name,
        author_email,
        authored_at,
        subject,
        body,
        decorations,
    ] = fields.as_slice()
    else {
        return None;
    };

    Some(NativeGitCommitSummary {
        sha: (*sha).to_string(),
        short_sha: sha.chars().take(7).collect(),
        subject: (*subject).to_string(),
        body: body.trim().to_string(),
        author_name: (*author_name).to_string(),
        author_email: (*author_email).to_string(),
        authored_at: (*authored_at).to_string(),
        parent_shas: parent_shas
            .split_whitespace()
            .map(ToString::to_string)
            .collect(),
        refs: parse_commit_refs(decorations),
    })
}

fn parse_commit_refs(raw: &str) -> Vec<NativeGitCommitReference> {
    raw.split(',')
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(|label| NativeGitCommitReference {
            kind: reference_kind(label).to_string(),
            label: label.to_string(),
        })
        .collect()
}

fn reference_kind(label: &str) -> &'static str {
    if label.starts_with("HEAD") {
        "head"
    } else if label.starts_with("tag: ") {
        "tag"
    } else if label.contains('/') {
        "remote"
    } else if !label.is_empty() {
        "branch"
    } else {
        "other"
    }
}

fn matches_query(commit: &NativeGitCommitSummary, query: &str, case_sensitive: bool) -> bool {
    let haystack = [
        commit.sha.as_str(),
        commit.short_sha.as_str(),
        commit.subject.as_str(),
        commit.body.as_str(),
        commit.author_name.as_str(),
        commit.author_email.as_str(),
    ]
    .into_iter()
    .chain(commit.refs.iter().map(|reference| reference.label.as_str()))
    .collect::<Vec<_>>()
    .join("\n");

    if case_sensitive {
        haystack.contains(query)
    } else {
        haystack.to_lowercase().contains(&query.to_lowercase())
    }
}

fn count_commits(runner: &GitRunner, root_path: impl AsRef<Path>) -> GitResult<u32> {
    match runner.run(
        root_path,
        &["rev-list", "--count", "HEAD"],
        GitRunOptions::read_only(),
    ) {
        Ok(output) => Ok(output.stdout.trim().parse::<u32>().unwrap_or(0)),
        Err(error) if is_empty_history_error(&error) => Ok(0),
        Err(error) => Err(error),
    }
}

fn commit_diff_args(commit: &NativeGitCommitSummary) -> Vec<String> {
    if let Some(parent) = commit.parent_shas.first() {
        return vec![
            "diff".to_string(),
            "--find-renames".to_string(),
            "--find-copies".to_string(),
            "--no-color".to_string(),
            "--unified=3".to_string(),
            parent.clone(),
            commit.sha.clone(),
        ];
    }

    vec![
        "show".to_string(),
        "--root".to_string(),
        "--format=".to_string(),
        "--find-renames".to_string(),
        "--find-copies".to_string(),
        "--no-color".to_string(),
        "--unified=3".to_string(),
        commit.sha.clone(),
    ]
}

fn parse_commit_diff_file(lines: Vec<&str>, index: usize) -> NativeGitCommitDiffFile {
    let header = lines.first().copied().unwrap_or("");
    let (old_path, new_path) = parse_diff_header_paths(header);
    let mut kind = "update".to_string();
    let mut previous_path = None::<String>;
    let mut path = new_path
        .clone()
        .unwrap_or_else(|| old_path.clone().unwrap_or_default());

    for line in &lines {
        if line.starts_with("new file mode ") {
            kind = "create".to_string();
            if let Some(new_path) = &new_path {
                path = new_path.clone();
            }
        } else if line.starts_with("deleted file mode ") {
            kind = "delete".to_string();
            if let Some(old_path) = &old_path {
                path = old_path.clone();
            }
        } else if let Some(value) = line.strip_prefix("rename from ") {
            previous_path = Some(value.to_string());
            kind = "move".to_string();
        } else if let Some(value) = line.strip_prefix("rename to ") {
            path = value.to_string();
        }
    }

    let raw = lines.join("\n");
    let parsed = parse_unified_diff(&raw, &path);
    let hunks = parsed
        .hunks
        .into_iter()
        .enumerate()
        .map(|(hunk_index, mut hunk)| {
            hunk.id = format!("{path}:{index}:{hunk_index}");
            for (line_index, line) in hunk.lines.iter_mut().enumerate() {
                line.id = format!("{path}:{index}:{hunk_index}:{line_index}");
            }
            hunk
        })
        .collect::<Vec<_>>();

    NativeGitCommitDiffFile {
        additions: Some(parsed.summary.insertions),
        deletions: Some(parsed.summary.deletions),
        hunks,
        is_text: !parsed.is_binary,
        kind: kind.clone(),
        new_text: None,
        old_text: None,
        path,
        previous_path,
        reversible: false,
        status_label: Some(
            match kind.as_str() {
                "create" => "added",
                "delete" => "deleted",
                "move" => "renamed",
                _ => "modified",
            }
            .to_string(),
        ),
    }
}

fn parse_diff_header_paths(header: &str) -> (Option<String>, Option<String>) {
    let Some(rest) = header.strip_prefix("diff --git a/") else {
        return (None, None);
    };
    let Some((old_path, new_path)) = rest.split_once(" b/") else {
        return (None, None);
    };

    (Some(old_path.to_string()), Some(new_path.to_string()))
}

fn history_format() -> String {
    format!(
        "%H{FIELD_SEPARATOR}%P{FIELD_SEPARATOR}%an{FIELD_SEPARATOR}%ae{FIELD_SEPARATOR}%aI{FIELD_SEPARATOR}%s{FIELD_SEPARATOR}%b{FIELD_SEPARATOR}%D{RECORD_SEPARATOR}"
    )
}

fn normalize_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(DEFAULT_HISTORY_LIMIT).max(1)
}

fn empty_history() -> NativeGitHistoryListResult {
    NativeGitHistoryListResult {
        commits: Vec::new(),
        matched_count: 0,
        total_count: 0,
    }
}

fn is_empty_history_error(error: &GitError) -> bool {
    let GitError::CommandFailed { stderr, .. } = error else {
        return false;
    };

    stderr.contains("does not have any commits yet")
        || stderr.contains("your current branch")
        || stderr.contains("ambiguous argument 'HEAD'")
        || stderr.contains("bad default revision")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use crate::runner::GitRunner;
    use crate::test_support::run_git_fixture;

    use super::{get_commit_detail, list_history};

    #[test]
    fn returns_empty_history_for_empty_repo() {
        let temp = TempDir::new().expect("temp");
        run_git_fixture(temp.path(), &["init", "-b", "main"]);

        let history =
            list_history(&GitRunner::new(), temp.path(), None, false, None).expect("history");

        assert!(history.commits.is_empty());
        assert_eq!(history.total_count, 0);
    }

    #[test]
    fn lists_history_and_filters_query() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        fs::write(temp.path().join("tracked.txt"), "second\n").expect("second");
        run_git_fixture(temp.path(), &["commit", "-am", "Second message"]);

        let history = list_history(
            &GitRunner::new(),
            temp.path(),
            Some("second"),
            false,
            Some(10),
        )
        .expect("history");

        assert_eq!(history.commits.len(), 1);
        assert_eq!(history.commits[0].subject, "Second message");
        assert_eq!(history.matched_count, 1);
    }

    #[test]
    fn reads_root_commit_detail() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        let history =
            list_history(&GitRunner::new(), temp.path(), None, false, Some(1)).expect("history");

        let detail = get_commit_detail(&GitRunner::new(), temp.path(), &history.commits[0].sha)
            .expect("detail");

        assert_eq!(detail.changed_file_count, 1);
        assert_eq!(detail.files[0].kind, "create");
        assert_eq!(detail.insertions, 1);
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
        run_git_fixture(temp.path(), &["commit", "-m", "Initial message"]);
    }
}
