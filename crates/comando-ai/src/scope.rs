use comando_types::ids::{ProjectId, WorktreeId};

use crate::error::{AiError, AiResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionScope {
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub cwd: String,
    pub additional_roots: Vec<String>,
}

impl SessionScope {
    pub fn new(
        project_id: Option<ProjectId>,
        worktree_id: Option<WorktreeId>,
        cwd: impl Into<String>,
        additional_roots: Vec<String>,
    ) -> AiResult<Self> {
        let cwd = cwd.into();
        if cwd.trim().is_empty() {
            return Err(AiError::InvalidInput(
                "Native AI sessions require a cwd.".to_string(),
            ));
        }

        Ok(Self {
            project_id,
            worktree_id,
            cwd,
            additional_roots,
        })
    }
}
