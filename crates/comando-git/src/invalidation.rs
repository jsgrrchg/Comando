use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use comando_types::git::NativeGitRepositoryInvalidation;
use comando_types::ids::{ProjectId, WorktreeId};

const DEFAULT_COOLESCING_WINDOW: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitInvalidationReason {
    Filesystem,
    Status,
    Branch,
    Worktree,
    Remote,
    Unknown,
}

impl GitInvalidationReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Filesystem => "filesystem",
            Self::Status => "status",
            Self::Branch => "branch",
            Self::Worktree => "worktree",
            Self::Remote => "remote",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone)]
pub struct GitInvalidationCoalescer {
    window: Duration,
    pending: BTreeMap<String, PendingInvalidation>,
}

impl GitInvalidationCoalescer {
    pub fn new() -> Self {
        Self {
            window: DEFAULT_COOLESCING_WINDOW,
            pending: BTreeMap::new(),
        }
    }

    pub fn with_window(window: Duration) -> Self {
        Self {
            window,
            pending: BTreeMap::new(),
        }
    }

    pub fn queue(
        &mut self,
        project_id: ProjectId,
        worktree_id: Option<WorktreeId>,
        root_path: Option<String>,
        reason: GitInvalidationReason,
    ) {
        let key = invalidation_key(&project_id, worktree_id.as_ref(), root_path.as_deref());
        self.pending
            .entry(key)
            .and_modify(|pending| {
                pending.reason = merge_reason(pending.reason, reason);
                pending.queued_at = Instant::now();
            })
            .or_insert_with(|| PendingInvalidation {
                project_id,
                worktree_id,
                root_path,
                reason,
                queued_at: Instant::now(),
            });
    }

    pub fn drain_ready(&mut self) -> Vec<NativeGitRepositoryInvalidation> {
        let now = Instant::now();
        let ready_keys = self
            .pending
            .iter()
            .filter_map(|(key, pending)| {
                (now.duration_since(pending.queued_at) >= self.window).then(|| key.clone())
            })
            .collect::<Vec<_>>();
        let mut ready = Vec::new();

        for key in ready_keys {
            if let Some(pending) = self.pending.remove(&key) {
                ready.push(pending.into_invalidation());
            }
        }

        ready
    }

    pub fn drain_all(&mut self) -> Vec<NativeGitRepositoryInvalidation> {
        let pending = std::mem::take(&mut self.pending);
        pending
            .into_values()
            .map(PendingInvalidation::into_invalidation)
            .collect()
    }
}

impl Default for GitInvalidationCoalescer {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
struct PendingInvalidation {
    project_id: ProjectId,
    worktree_id: Option<WorktreeId>,
    root_path: Option<String>,
    reason: GitInvalidationReason,
    queued_at: Instant,
}

impl PendingInvalidation {
    fn into_invalidation(self) -> NativeGitRepositoryInvalidation {
        NativeGitRepositoryInvalidation {
            occurred_at: now_rfc3339(),
            project_id: self.project_id,
            worktree_id: self.worktree_id,
            root_path: self.root_path,
            reason: self.reason.as_str().to_string(),
        }
    }
}

fn merge_reason(
    existing: GitInvalidationReason,
    incoming: GitInvalidationReason,
) -> GitInvalidationReason {
    if priority(incoming) > priority(existing) {
        incoming
    } else {
        existing
    }
}

fn priority(reason: GitInvalidationReason) -> u8 {
    match reason {
        GitInvalidationReason::Remote => 5,
        GitInvalidationReason::Worktree => 4,
        GitInvalidationReason::Branch => 3,
        GitInvalidationReason::Status => 2,
        GitInvalidationReason::Filesystem => 1,
        GitInvalidationReason::Unknown => 0,
    }
}

fn invalidation_key(
    project_id: &ProjectId,
    worktree_id: Option<&WorktreeId>,
    root_path: Option<&str>,
) -> String {
    format!(
        "{}:{}:{}",
        project_id.0,
        worktree_id.map(|id| id.0.as_str()).unwrap_or(""),
        root_path.unwrap_or("")
    )
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use comando_types::ids::{ProjectId, WorktreeId};

    use super::{GitInvalidationCoalescer, GitInvalidationReason};

    #[test]
    fn coalesces_same_repository_invalidations() {
        let mut coalescer = GitInvalidationCoalescer::with_window(Duration::from_secs(60));
        coalescer.queue(
            ProjectId("project_1".to_string()),
            Some(WorktreeId("worktree_1".to_string())),
            Some("/repo".to_string()),
            GitInvalidationReason::Filesystem,
        );
        coalescer.queue(
            ProjectId("project_1".to_string()),
            Some(WorktreeId("worktree_1".to_string())),
            Some("/repo".to_string()),
            GitInvalidationReason::Branch,
        );

        let drained = coalescer.drain_all();

        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].reason, "branch");
    }

    #[test]
    fn drain_ready_respects_window() {
        let mut coalescer = GitInvalidationCoalescer::with_window(Duration::from_millis(1));
        coalescer.queue(
            ProjectId("project_1".to_string()),
            None,
            None,
            GitInvalidationReason::Status,
        );

        assert!(coalescer.drain_ready().is_empty());
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(coalescer.drain_ready().len(), 1);
    }
}
