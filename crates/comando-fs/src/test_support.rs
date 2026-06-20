use std::path::Path;

use comando_types::ids::{ProjectId, WorktreeId};

use crate::registry::ProjectRoot;

pub fn project_root(path: &Path) -> ProjectRoot {
    ProjectRoot {
        project_id: ProjectId("project_1".to_string()),
        worktree_id: Some(WorktreeId("project_1:primary".to_string())),
        root_path: path.to_path_buf(),
    }
}
