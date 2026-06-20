use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use comando_types::git::{
    NativeGitChangeEntry, NativeGitChangeTreeNode, NativeGitScopeCounts, NativeGitStatusSnapshot,
    NativeGitStatusSummary, NativeGitSyncStatus,
};
use comando_types::ids::WorktreeId;

use crate::error::GitResult;
use crate::runner::{GitRunOptions, GitRunner};

pub fn get_status(
    runner: &GitRunner,
    root_path: impl AsRef<Path>,
    worktree_id: Option<WorktreeId>,
) -> GitResult<NativeGitStatusSnapshot> {
    let output = runner.run(
        root_path,
        &["status", "--porcelain=v2", "--branch", "--renames"],
        GitRunOptions::read_only(),
    )?;

    Ok(parse_status_porcelain(&output.stdout, worktree_id))
}

pub fn parse_status_porcelain(
    output: &str,
    worktree_id: Option<WorktreeId>,
) -> NativeGitStatusSnapshot {
    let mut entries = BTreeMap::<String, NativeGitChangeEntry>::new();
    let mut sync = NativeGitSyncStatus {
        ahead: 0,
        behind: 0,
        branch_name: None,
        commit: None,
        detached: false,
        tracking_branch_name: None,
    };

    for line in output.lines() {
        if let Some(header) = line.strip_prefix("# ") {
            parse_branch_header(header, &mut sync);
            continue;
        }

        let Some(entry) = parse_status_entry(line, worktree_id.clone()) else {
            continue;
        };
        merge_entry(&mut entries, entry);
    }

    let entry_list = entries.into_values().collect::<Vec<_>>();
    build_status_snapshot(entry_list, Some(sync))
}

pub fn build_status_snapshot(
    entries: Vec<NativeGitChangeEntry>,
    sync: Option<NativeGitSyncStatus>,
) -> NativeGitStatusSnapshot {
    let counts = count_scopes(&entries);
    let summary = NativeGitStatusSummary {
        changed_count: entries.len().try_into().unwrap_or(u32::MAX),
        staged_count: counts.staged,
        unstaged_count: counts.unstaged,
        untracked_count: counts.untracked,
        conflicted_count: counts.conflicted,
    };
    let tree = build_change_tree(&entries);

    NativeGitStatusSnapshot {
        counts: counts.clone(),
        entries,
        has_conflicts: counts.conflicted > 0,
        has_staged: counts.staged > 0,
        has_unstaged: counts.unstaged > 0,
        has_untracked: counts.untracked > 0,
        is_clean: counts.conflicted == 0
            && counts.staged == 0
            && counts.unstaged == 0
            && counts.untracked == 0,
        summary,
        sync,
        tree,
    }
}

fn parse_branch_header(header: &str, sync: &mut NativeGitSyncStatus) {
    if let Some(value) = header.strip_prefix("branch.oid ") {
        sync.commit = (value != "(initial)").then(|| value.to_string());
        return;
    }

    if let Some(value) = header.strip_prefix("branch.head ") {
        sync.detached = value == "(detached)";
        sync.branch_name = (value != "(detached)").then(|| value.to_string());
        return;
    }

    if let Some(value) = header.strip_prefix("branch.upstream ") {
        sync.tracking_branch_name = Some(value.to_string());
        return;
    }

    if let Some(value) = header.strip_prefix("branch.ab ") {
        for part in value.split_whitespace() {
            if let Some(ahead) = part.strip_prefix('+') {
                sync.ahead = ahead.parse::<i64>().unwrap_or(0);
            } else if let Some(behind) = part.strip_prefix('-') {
                sync.behind = behind.parse::<i64>().unwrap_or(0);
            }
        }
    }
}

fn parse_status_entry(line: &str, worktree_id: Option<WorktreeId>) -> Option<NativeGitChangeEntry> {
    if let Some(path) = line.strip_prefix("? ") {
        return Some(build_entry(path, None, "?", "?", worktree_id));
    }

    if let Some(rest) = line.strip_prefix("1 ") {
        let parts = split_status_fields(rest, 8);
        let xy = parts.first()?;
        let path = parts.get(7)?;
        return Some(build_entry(
            path,
            None,
            status_index(xy),
            status_working_dir(xy),
            worktree_id,
        ));
    }

    if let Some(rest) = line.strip_prefix("2 ") {
        let parts = split_status_fields(rest, 9);
        let xy = parts.first()?;
        let path_field = parts.get(8)?;
        let (path, previous_path) = split_rename_paths(path_field);
        return Some(build_entry(
            path,
            previous_path,
            status_index(xy),
            status_working_dir(xy),
            worktree_id,
        ));
    }

    if let Some(rest) = line.strip_prefix("u ") {
        let parts = split_status_fields(rest, 10);
        let xy = parts.first()?;
        let path = parts.get(9)?;
        let mut entry = build_entry(
            path,
            None,
            status_index(xy),
            status_working_dir(xy),
            worktree_id,
        );
        entry.is_conflicted = true;
        entry.kind = "conflicted".to_string();
        entry.scopes = vec!["conflicted".to_string()];
        entry.scope = "conflicted".to_string();
        return Some(entry);
    }

    None
}

fn split_status_fields(value: &str, fields: usize) -> Vec<&str> {
    value.splitn(fields, ' ').collect()
}

fn split_rename_paths(path_field: &str) -> (&str, Option<String>) {
    let mut parts = path_field.splitn(2, '\t');
    let path = parts.next().unwrap_or(path_field);
    let previous_path = parts.next().map(ToString::to_string);
    (path, previous_path)
}

fn status_index(xy: &str) -> &str {
    xy.get(0..1).unwrap_or(" ")
}

fn status_working_dir(xy: &str) -> &str {
    xy.get(1..2).unwrap_or(" ")
}

fn build_entry(
    path: &str,
    previous_path: Option<String>,
    status_index: &str,
    status_working_dir: &str,
    worktree_id: Option<WorktreeId>,
) -> NativeGitChangeEntry {
    let normalized_path = normalize_git_path(path);
    let scopes = determine_scopes(status_index, status_working_dir);
    let is_renamed = previous_path
        .as_deref()
        .is_some_and(|previous| previous != normalized_path.as_str())
        || status_index == "R"
        || status_working_dir == "R";
    let kind = determine_change_kind(status_index, status_working_dir, &scopes, is_renamed);
    let scope = primary_scope(&scopes);

    NativeGitChangeEntry {
        id: format!("git-change:{normalized_path}"),
        name: file_name(&normalized_path),
        parent_relative_path: parent_relative_path(&normalized_path),
        path: normalized_path,
        previous_path,
        scopes,
        scope,
        kind,
        status_index: status_index.to_string(),
        status_working_dir: status_working_dir.to_string(),
        is_binary: false,
        is_conflicted: false,
        is_renamed,
        additions: None,
        deletions: None,
        worktree_id,
    }
}

fn merge_entry(entries: &mut BTreeMap<String, NativeGitChangeEntry>, entry: NativeGitChangeEntry) {
    entries
        .entry(entry.path.clone())
        .and_modify(|existing| {
            existing.scopes = merge_scopes(&existing.scopes, &entry.scopes);
            existing.scope = primary_scope(&existing.scopes);
            existing.is_conflicted = existing.is_conflicted || entry.is_conflicted;
            existing.is_binary = existing.is_binary || entry.is_binary;
            existing.is_renamed = existing.is_renamed || entry.is_renamed;
            if existing.previous_path.is_none() {
                existing.previous_path = entry.previous_path.clone();
            }
            if existing.status_index.trim().is_empty() || existing.status_index == "?" {
                existing.status_index = entry.status_index.clone();
            }
            if existing.status_working_dir.trim().is_empty() {
                existing.status_working_dir = entry.status_working_dir.clone();
            }
            if existing.is_conflicted {
                existing.kind = "conflicted".to_string();
            }
        })
        .or_insert(entry);
}

fn merge_scopes(first: &[String], second: &[String]) -> Vec<String> {
    let mut scopes = first.iter().chain(second).cloned().collect::<BTreeSet<_>>();
    let ordered = ["conflicted", "staged", "unstaged", "untracked"];
    ordered
        .iter()
        .filter_map(|scope| scopes.take(*scope))
        .collect()
}

fn determine_scopes(index: &str, working_dir: &str) -> Vec<String> {
    if is_conflict_code(index, working_dir) {
        return vec!["conflicted".to_string()];
    }

    if index == "?" && working_dir == "?" {
        return vec!["untracked".to_string()];
    }

    let mut scopes = Vec::new();
    if !index.trim().is_empty() && index != "." {
        scopes.push("staged".to_string());
    }
    if !working_dir.trim().is_empty() && working_dir != "." {
        scopes.push("unstaged".to_string());
    }

    if scopes.is_empty() {
        scopes.push("unstaged".to_string());
    }

    scopes
}

fn determine_change_kind(
    index: &str,
    working_dir: &str,
    scopes: &[String],
    is_renamed: bool,
) -> String {
    if scopes.iter().any(|scope| scope == "conflicted") {
        return "conflicted".to_string();
    }
    if index == "?" && working_dir == "?" {
        return "untracked".to_string();
    }
    if is_renamed {
        return "renamed".to_string();
    }
    if index == "C" || working_dir == "C" {
        return "copied".to_string();
    }
    if index == "T" || working_dir == "T" {
        return "typechange".to_string();
    }
    if index == "D" || working_dir == "D" {
        return "deleted".to_string();
    }
    if index == "A" || working_dir == "A" {
        return "added".to_string();
    }
    if !index.trim().is_empty() || !working_dir.trim().is_empty() {
        return "modified".to_string();
    }
    "unknown".to_string()
}

fn is_conflict_code(index: &str, working_dir: &str) -> bool {
    index.contains('U')
        || working_dir.contains('U')
        || (index == "A" && working_dir == "A")
        || (index == "D" && working_dir == "D")
}

fn primary_scope(scopes: &[String]) -> String {
    for scope in ["conflicted", "unstaged", "staged", "untracked"] {
        if scopes.iter().any(|candidate| candidate == scope) {
            return scope.to_string();
        }
    }

    "unstaged".to_string()
}

fn count_scopes(entries: &[NativeGitChangeEntry]) -> NativeGitScopeCounts {
    let mut counts = NativeGitScopeCounts {
        conflicted: 0,
        staged: 0,
        untracked: 0,
        unstaged: 0,
    };

    for entry in entries {
        for scope in &entry.scopes {
            increment_scope(&mut counts, scope);
        }
    }

    counts
}

fn increment_scope(counts: &mut NativeGitScopeCounts, scope: &str) {
    match scope {
        "conflicted" => counts.conflicted += 1,
        "staged" => counts.staged += 1,
        "untracked" => counts.untracked += 1,
        "unstaged" => counts.unstaged += 1,
        _ => {}
    }
}

fn build_change_tree(entries: &[NativeGitChangeEntry]) -> Vec<NativeGitChangeTreeNode> {
    let mut root = MutableTreeNode::default();

    for entry in entries {
        let mut current = &mut root;
        let mut relative_path = String::new();
        let segments = entry.path.split('/').collect::<Vec<_>>();

        for (index, segment) in segments.iter().enumerate() {
            relative_path = if relative_path.is_empty() {
                (*segment).to_string()
            } else {
                format!("{relative_path}/{segment}")
            };
            let is_leaf = index == segments.len() - 1;
            current = current
                .children
                .entry((*segment).to_string())
                .or_insert_with(|| MutableTreeNode {
                    change_entry_id: None,
                    counts: empty_counts(),
                    kind: if is_leaf { "file" } else { "directory" }.to_string(),
                    name: (*segment).to_string(),
                    parent_relative_path: parent_relative_path(&relative_path),
                    relative_path: relative_path.clone(),
                    children: BTreeMap::new(),
                });

            if is_leaf {
                current.kind = "file".to_string();
                current.change_entry_id = Some(entry.id.clone());
            }
        }
    }

    let entries_by_id = entries
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    root.into_nodes(&entries_by_id)
}

#[derive(Debug, Clone)]
struct MutableTreeNode {
    change_entry_id: Option<String>,
    counts: NativeGitScopeCounts,
    kind: String,
    name: String,
    parent_relative_path: Option<String>,
    relative_path: String,
    children: BTreeMap<String, MutableTreeNode>,
}

impl Default for MutableTreeNode {
    fn default() -> Self {
        Self {
            change_entry_id: None,
            counts: empty_counts(),
            kind: String::new(),
            name: String::new(),
            parent_relative_path: None,
            relative_path: String::new(),
            children: BTreeMap::new(),
        }
    }
}

impl MutableTreeNode {
    fn into_nodes(
        mut self,
        entries_by_id: &BTreeMap<&str, &NativeGitChangeEntry>,
    ) -> Vec<NativeGitChangeTreeNode> {
        self.populate_counts(entries_by_id);
        self.children
            .into_values()
            .map(|child| child.into_node(entries_by_id))
            .collect()
    }

    fn into_node(
        mut self,
        entries_by_id: &BTreeMap<&str, &NativeGitChangeEntry>,
    ) -> NativeGitChangeTreeNode {
        self.populate_counts(entries_by_id);
        let id = format!("git-tree:{}", self.relative_path);
        let children = sort_tree_nodes(
            self.children
                .into_values()
                .map(|child| child.into_node(entries_by_id))
                .collect(),
        );

        NativeGitChangeTreeNode {
            id,
            change_entry_id: self.change_entry_id,
            children,
            counts: self.counts,
            kind: self.kind,
            name: self.name,
            parent_relative_path: self.parent_relative_path,
            relative_path: self.relative_path,
        }
    }

    fn populate_counts(&mut self, entries_by_id: &BTreeMap<&str, &NativeGitChangeEntry>) {
        let mut counts = empty_counts();
        if let Some(entry) = self
            .change_entry_id
            .as_deref()
            .and_then(|id| entries_by_id.get(id))
        {
            for scope in &entry.scopes {
                increment_scope(&mut counts, scope);
            }
        }

        for child in self.children.values_mut() {
            child.populate_counts(entries_by_id);
            counts.conflicted += child.counts.conflicted;
            counts.staged += child.counts.staged;
            counts.untracked += child.counts.untracked;
            counts.unstaged += child.counts.unstaged;
        }

        self.counts = counts;
    }
}

fn sort_tree_nodes(mut nodes: Vec<NativeGitChangeTreeNode>) -> Vec<NativeGitChangeTreeNode> {
    nodes.sort_by(|left, right| {
        if left.kind != right.kind {
            return if left.kind == "directory" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }

        left.name.cmp(&right.name)
    });
    nodes
}

fn empty_counts() -> NativeGitScopeCounts {
    NativeGitScopeCounts {
        conflicted: 0,
        staged: 0,
        untracked: 0,
        unstaged: 0,
    }
}

fn normalize_git_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn file_name(path: &str) -> String {
    PathBuf::from(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

fn parent_relative_path(path: &str) -> Option<String> {
    let parent = PathBuf::from(path)
        .parent()
        .map(|path| path.to_string_lossy().replace('\\', "/"))?;

    (!parent.is_empty()).then_some(parent)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use crate::runner::GitRunner;
    use crate::test_support::run_git_fixture;

    use super::{get_status, parse_status_porcelain};

    #[test]
    fn parses_clean_status_headers() {
        let status = parse_status_porcelain(
            "# branch.oid 1111111111111111111111111111111111111111\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n",
            None,
        );

        assert!(status.is_clean);
        assert_eq!(
            status
                .sync
                .as_ref()
                .and_then(|sync| sync.branch_name.as_deref()),
            Some("main")
        );
        assert_eq!(status.sync.as_ref().map(|sync| sync.ahead), Some(2));
        assert_eq!(status.sync.as_ref().map(|sync| sync.behind), Some(3));
    }

    #[test]
    fn parses_untracked_status() {
        let status = parse_status_porcelain("? src/new file.ts\n", None);

        assert_eq!(status.summary.untracked_count, 1);
        assert_eq!(status.entries[0].kind, "untracked");
        assert_eq!(status.entries[0].path, "src/new file.ts");
    }

    #[test]
    fn parses_renamed_status() {
        let status = parse_status_porcelain(
            "2 R. N... 100644 100644 100644 1111111 2222222 R100 src/new.ts\tsrc/old.ts\n",
            None,
        );

        assert_eq!(status.summary.staged_count, 1);
        assert_eq!(status.entries[0].kind, "renamed");
        assert_eq!(
            status.entries[0].previous_path.as_deref(),
            Some("src/old.ts")
        );
    }

    #[test]
    fn reads_status_from_git_repository() {
        let temp = TempDir::new().expect("temp");
        init_repo_with_commit(&temp);
        fs::write(temp.path().join("tracked.txt"), "changed\n").expect("write");
        fs::write(temp.path().join("new.txt"), "new\n").expect("new");

        let status = get_status(&GitRunner::new(), temp.path(), None).expect("status");

        assert_eq!(status.summary.changed_count, 2);
        assert_eq!(status.summary.unstaged_count, 1);
        assert_eq!(status.summary.untracked_count, 1);
        assert_eq!(status.tree[0].kind, "file");
    }

    #[test]
    fn detects_staged_and_unstaged_scopes_for_same_path() {
        let temp = TempDir::new().expect("temp");
        init_repo_with_commit(&temp);
        fs::write(temp.path().join("tracked.txt"), "staged\n").expect("write");
        run_git_fixture(temp.path(), &["add", "tracked.txt"]);
        fs::write(temp.path().join("tracked.txt"), "unstaged\n").expect("write");

        let status = get_status(&GitRunner::new(), temp.path(), None).expect("status");
        let entry = status
            .entries
            .iter()
            .find(|entry| entry.path == "tracked.txt")
            .expect("entry");

        assert_eq!(entry.scopes, vec!["staged", "unstaged"]);
        assert_eq!(entry.scope, "unstaged");
    }

    #[test]
    fn detects_conflicted_paths() {
        let temp = TempDir::new().expect("temp");
        init_repo_with_commit(&temp);
        run_git_fixture(temp.path(), &["checkout", "-b", "feature"]);
        fs::write(temp.path().join("tracked.txt"), "feature\n").expect("feature");
        run_git_fixture(temp.path(), &["commit", "-am", "feature"]);
        run_git_fixture(temp.path(), &["checkout", "main"]);
        fs::write(temp.path().join("tracked.txt"), "main\n").expect("main");
        run_git_fixture(temp.path(), &["commit", "-am", "main"]);
        let _ = std::process::Command::new("git")
            .current_dir(temp.path())
            .args(["merge", "feature"])
            .status()
            .expect("merge starts");

        let status = get_status(&GitRunner::new(), temp.path(), None).expect("status");

        assert_eq!(status.summary.conflicted_count, 1);
        assert_eq!(status.entries[0].kind, "conflicted");
    }

    fn init_repo_with_commit(temp: &TempDir) {
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
