use std::collections::BTreeMap;
use std::path::Path;

use comando_types::git::{
    NativeGitChangeEntry, NativeGitDiffStatRecord, NativeGitFileDiff, NativeGitWorktreeDiffFile,
    NativeGitWorktreeDiffResult, NativeGitWorktreeDiffSection,
};
use comando_types::ids::{ProjectId, WorktreeId};

use crate::diff::{GitFileDiffRequest, get_diff_stats, get_file_diff};
use crate::error::GitResult;
use crate::runner::GitRunner;
use crate::status::get_status;

pub fn list_worktree_diff(
    runner: &GitRunner,
    root_path: impl AsRef<Path>,
    project_id: ProjectId,
    worktree_id: Option<WorktreeId>,
    requested_scopes: Option<&[String]>,
) -> GitResult<NativeGitWorktreeDiffResult> {
    let root_path = root_path.as_ref();
    let status = get_status(runner, root_path, worktree_id.clone())?;
    let stats = diff_stat_map(get_diff_stats(runner, root_path));
    let scopes = requested_scopes
        .map(|scopes| scopes.to_vec())
        .unwrap_or_else(default_scopes);
    let mut sections = Vec::new();

    for scope in scopes {
        let files = status
            .entries
            .iter()
            .filter(|entry| entry.scopes.iter().any(|entry_scope| entry_scope == &scope))
            .map(|entry| worktree_diff_file(runner, root_path, entry, &scope, &stats))
            .collect();
        sections.push(NativeGitWorktreeDiffSection { scope, files });
    }

    Ok(NativeGitWorktreeDiffResult {
        project_id,
        worktree_id,
        sections,
        updated_at: now_rfc3339(),
    })
}

fn worktree_diff_file(
    runner: &GitRunner,
    root_path: &Path,
    entry: &NativeGitChangeEntry,
    scope: &str,
    stats: &BTreeMap<String, DiffStatEntry>,
) -> NativeGitWorktreeDiffFile {
    let stat = stats.get(&format!("{scope}:{}", entry.path));
    let request = GitFileDiffRequest {
        relative_path: entry.path.clone(),
        previous_path: entry.previous_path.clone(),
        change_kind: Some(entry.kind.clone()),
        scope: scope.to_string(),
        staged: scope == "staged",
    };

    match get_file_diff(runner, root_path, &request) {
        Ok(diff) => successful_file(entry, scope, stat, diff),
        Err(error) => NativeGitWorktreeDiffFile {
            additions: stat.map(|stat| stat.additions),
            deletions: stat.map(|stat| stat.deletions),
            diff: None,
            error: Some(error.to_string()),
            is_binary: entry.is_binary,
            is_conflicted: entry.is_conflicted,
            kind: scoped_kind(entry, scope),
            path: entry.path.clone(),
            previous_path: entry.previous_path.clone(),
            scope: scope.to_string(),
        },
    }
}

fn successful_file(
    entry: &NativeGitChangeEntry,
    scope: &str,
    stat: Option<&DiffStatEntry>,
    diff: NativeGitFileDiff,
) -> NativeGitWorktreeDiffFile {
    NativeGitWorktreeDiffFile {
        additions: stat
            .map(|stat| stat.additions)
            .or(Some(diff.summary.insertions)),
        deletions: stat
            .map(|stat| stat.deletions)
            .or(Some(diff.summary.deletions)),
        is_binary: entry.is_binary || diff.is_binary,
        diff: Some(diff),
        error: None,
        is_conflicted: entry.is_conflicted,
        kind: scoped_kind(entry, scope),
        path: entry.path.clone(),
        previous_path: entry.previous_path.clone(),
        scope: scope.to_string(),
    }
}

fn scoped_kind(entry: &NativeGitChangeEntry, scope: &str) -> String {
    if scope == "conflicted" || scope == "untracked" {
        return scope.to_string();
    }

    let status = if scope == "staged" {
        entry.status_index.as_str()
    } else {
        entry.status_working_dir.as_str()
    };

    match status {
        "A" => "added",
        "C" => "copied",
        "D" => "deleted",
        "M" => "modified",
        "R" => "renamed",
        "T" => "typechange",
        _ if scope == "staged" && entry.is_renamed => "renamed",
        _ => entry.kind.as_str(),
    }
    .to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DiffStatEntry {
    additions: i64,
    deletions: i64,
}

fn diff_stat_map(stats: Vec<NativeGitDiffStatRecord>) -> BTreeMap<String, DiffStatEntry> {
    stats
        .into_iter()
        .map(|stat| {
            (
                stat.key,
                DiffStatEntry {
                    additions: stat.additions,
                    deletions: stat.deletions,
                },
            )
        })
        .collect()
}

fn default_scopes() -> Vec<String> {
    ["conflicted", "staged", "unstaged", "untracked"]
        .into_iter()
        .map(ToString::to_string)
        .collect()
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use comando_types::ids::ProjectId;

    use crate::runner::GitRunner;
    use crate::test_support::run_git_fixture;

    use super::list_worktree_diff;

    #[test]
    fn lists_worktree_diff_sections() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        fs::write(temp.path().join("tracked.txt"), "changed\n").expect("change");
        fs::write(temp.path().join("new.txt"), "new\n").expect("new");

        let result = list_worktree_diff(
            &GitRunner::new(),
            temp.path(),
            ProjectId("project_1".to_string()),
            None,
            None,
        )
        .expect("worktree diff");

        let unstaged = result
            .sections
            .iter()
            .find(|section| section.scope == "unstaged")
            .expect("unstaged");
        let untracked = result
            .sections
            .iter()
            .find(|section| section.scope == "untracked")
            .expect("untracked");

        assert_eq!(unstaged.files.len(), 1);
        assert_eq!(untracked.files.len(), 1);
        assert!(unstaged.files[0].diff.is_some());
    }

    #[test]
    fn filters_requested_scopes() {
        let temp = TempDir::new().expect("temp");
        init_repo(&temp);
        fs::write(temp.path().join("new.txt"), "new\n").expect("new");

        let result = list_worktree_diff(
            &GitRunner::new(),
            temp.path(),
            ProjectId("project_1".to_string()),
            None,
            Some(&["untracked".to_string()]),
        )
        .expect("worktree diff");

        assert_eq!(result.sections.len(), 1);
        assert_eq!(result.sections[0].scope, "untracked");
        assert_eq!(result.sections[0].files[0].path, "new.txt");
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
