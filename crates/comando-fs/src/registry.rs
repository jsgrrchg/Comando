use std::path::PathBuf;

use comando_types::ids::{ProjectId, WorktreeId};
use comando_types::projects::{
    NativeProjectListResult, NativeProjectState, NativeProjectSummary, NativeWorktreeSummary,
};

use crate::copy::{copy_entries, copy_external_entries};
use crate::error::FsError;
use crate::mutations::{create_directory, create_file, delete_entry, rename_entry};
use crate::origin::WriteTracker;
use crate::read::read_file;
use crate::tree::{list_entries, list_tree_children};
use crate::watcher::{WatcherDrain, WatcherRegistry};
use crate::write::write_file;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRoot {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub root_path: PathBuf,
}

#[derive(Debug, Default, Clone)]
pub struct ProjectRootRegistry {
    projects: Vec<NativeProjectSummary>,
    worktrees: Vec<NativeWorktreeSummary>,
}

impl ProjectRootRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn sync_state(&mut self, state: NativeProjectState) {
        self.projects = state.projects;
        self.worktrees = state.worktrees;
    }

    pub fn sync_list_result(&mut self, state: NativeProjectListResult) {
        self.projects = state.projects;
        self.worktrees = state.worktrees;
    }

    pub fn resolve(
        &self,
        project_id: &ProjectId,
        worktree_id: Option<&WorktreeId>,
    ) -> Result<ProjectRoot, FsError> {
        let project = self
            .projects
            .iter()
            .find(|project| &project.id == project_id)
            .ok_or(FsError::ProjectNotFound)?;

        if let Some(worktree_id) = worktree_id.filter(|id| !id.0.ends_with(":primary")) {
            let worktree = self
                .worktrees
                .iter()
                .find(|worktree| &worktree.id == worktree_id && &worktree.project_id == project_id)
                .ok_or(FsError::WorktreeNotFound)?;

            return Ok(ProjectRoot {
                project_id: project_id.clone(),
                worktree_id: Some(worktree.id.clone()),
                root_path: PathBuf::from(&worktree.root_path),
            });
        }

        if let Some(primary) = self
            .worktrees
            .iter()
            .find(|worktree| &worktree.project_id == project_id && worktree.is_primary)
        {
            return Ok(ProjectRoot {
                project_id: project_id.clone(),
                worktree_id: Some(primary.id.clone()),
                root_path: PathBuf::from(&primary.root_path),
            });
        }

        Ok(ProjectRoot {
            project_id: project_id.clone(),
            worktree_id: None,
            root_path: PathBuf::from(&project.root_path),
        })
    }

    pub fn roots(&self) -> Vec<ProjectRoot> {
        let mut roots = Vec::new();
        for project in &self.projects {
            let project_worktrees = self
                .worktrees
                .iter()
                .filter(|worktree| worktree.project_id == project.id)
                .collect::<Vec<_>>();
            if project_worktrees.is_empty() {
                roots.push(ProjectRoot {
                    project_id: project.id.clone(),
                    worktree_id: None,
                    root_path: PathBuf::from(&project.root_path),
                });
            } else {
                roots.extend(project_worktrees.into_iter().map(|worktree| ProjectRoot {
                    project_id: project.id.clone(),
                    worktree_id: Some(worktree.id.clone()),
                    root_path: PathBuf::from(&worktree.root_path),
                }));
            }
        }
        roots
    }
}

#[derive(Debug, Default)]
pub struct ProjectFsService {
    registry: ProjectRootRegistry,
    watcher: WatcherRegistry,
}

impl ProjectFsService {
    pub fn new() -> Self {
        Self {
            registry: ProjectRootRegistry::new(),
            watcher: WatcherRegistry::new(),
        }
    }

    pub fn sync_state(&mut self, state: NativeProjectState) {
        self.registry.sync_state(state);
    }

    pub fn sync_list_result(&mut self, state: NativeProjectListResult) {
        self.registry.sync_list_result(state);
    }

    pub fn sync_watchers_from_registry(&mut self) -> Result<(), FsError> {
        self.watcher.sync_roots(self.registry.roots())
    }

    pub fn resolve_root(
        &self,
        project_id: &ProjectId,
        worktree_id: Option<&WorktreeId>,
    ) -> Result<ProjectRoot, FsError> {
        self.registry.resolve(project_id, worktree_id)
    }

    pub fn write_tracker(&self) -> WriteTracker {
        self.watcher.write_tracker()
    }

    pub fn watcher_mut(&mut self) -> &mut WatcherRegistry {
        &mut self.watcher
    }

    pub fn drain_watchers(&mut self, force: bool) -> WatcherDrain {
        self.watcher.drain(force)
    }

    #[cfg(feature = "test-hooks")]
    pub fn queue_test_invalidation_after_delay(
        &mut self,
        root: ProjectRoot,
        relative_path: String,
        delay: std::time::Duration,
    ) {
        self.watcher
            .queue_test_invalidation_after_delay(root, relative_path, delay);
    }
}

impl ProjectFsService {
    pub fn list_tree_children(
        &self,
        input: &comando_types::projects::NativeProjectTreeChildrenInput,
    ) -> Result<comando_types::projects::NativeProjectTreeChildrenResult, FsError> {
        let root = self.resolve_root(&input.project_id, input.worktree_id.as_ref())?;
        Ok(comando_types::projects::NativeProjectTreeChildrenResult {
            entries: list_tree_children(&root, input.parent_relative_path.as_deref())?,
        })
    }

    pub fn list_entries(
        &self,
        input: &comando_types::projects::NativeProjectListEntriesInput,
    ) -> Result<comando_types::projects::NativeProjectListEntriesResult, FsError> {
        let root = self.resolve_root(&input.project_id, input.worktree_id.as_ref())?;
        list_entries(&root, input.limit)
    }

    pub fn read_file(
        &self,
        input: &comando_types::fs::NativeFsReadFileInput,
    ) -> Result<comando_types::fs::NativeFsReadFileResult, FsError> {
        let root = self.resolve_root(&input.project_id, input.worktree_id.as_ref())?;
        read_file(&root, input)
    }

    pub fn write_file(
        &self,
        input: &comando_types::fs::NativeFsWriteFileInput,
    ) -> Result<comando_types::fs::NativeFsWriteFileResult, FsError> {
        let root = self.resolve_root(&input.project_id, input.worktree_id.as_ref())?;
        write_file(&root, input, &self.write_tracker())
    }

    pub fn create_file(
        &self,
        input: &comando_types::fs::NativeFsCreateEntryInput,
    ) -> Result<comando_types::fs::NativeFsEntryMutationResult, FsError> {
        let root = self.resolve_root(&input.project_id, input.worktree_id.as_ref())?;
        create_file(&root, input, &self.write_tracker())
    }

    pub fn create_directory(
        &self,
        input: &comando_types::fs::NativeFsCreateEntryInput,
    ) -> Result<comando_types::fs::NativeFsEntryMutationResult, FsError> {
        let root = self.resolve_root(&input.project_id, input.worktree_id.as_ref())?;
        create_directory(&root, input, &self.write_tracker())
    }

    pub fn rename_entry(
        &self,
        input: &comando_types::fs::NativeFsRenameEntryInput,
    ) -> Result<comando_types::fs::NativeFsEntryMutationResult, FsError> {
        let root = self.resolve_root(&input.project_id, input.worktree_id.as_ref())?;
        rename_entry(&root, input, &self.write_tracker())
    }

    pub fn delete_entry(
        &self,
        input: &comando_types::fs::NativeFsDeleteEntryInput,
    ) -> Result<comando_types::fs::NativeFsEntryMutationResult, FsError> {
        let root = self.resolve_root(&input.project_id, input.worktree_id.as_ref())?;
        delete_entry(&root, input, &self.write_tracker())
    }

    pub fn copy_entries(
        &self,
        input: &comando_types::fs::NativeFsCopyEntriesInput,
    ) -> Result<comando_types::fs::NativeFsEntryMutationListResult, FsError> {
        let root = self.resolve_root(&input.project_id, input.worktree_id.as_ref())?;
        Ok(comando_types::fs::NativeFsEntryMutationListResult {
            entries: copy_entries(&root, input, &self.write_tracker())?,
        })
    }

    pub fn copy_external_entries(
        &self,
        input: &comando_types::fs::NativeFsCopyExternalEntriesInput,
    ) -> Result<comando_types::fs::NativeFsEntryMutationListResult, FsError> {
        let root = self.resolve_root(&input.project_id, input.worktree_id.as_ref())?;
        Ok(comando_types::fs::NativeFsEntryMutationListResult {
            entries: copy_external_entries(&root, input, &self.write_tracker())?,
        })
    }
}
