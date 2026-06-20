use std::path::Path;

use comando_fs::ProjectRoot;
use comando_types::ids::ProjectId;

pub fn project_root(root_path: &Path) -> ProjectRoot {
    ProjectRoot {
        project_id: ProjectId("project_1".to_string()),
        worktree_id: None,
        root_path: root_path.to_path_buf(),
    }
}
