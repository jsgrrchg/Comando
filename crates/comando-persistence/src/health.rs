use comando_types::persistence::NativePersistenceStorageHealth;
use rusqlite::Connection;

use crate::metadata;

pub fn closed_storage_health() -> NativePersistenceStorageHealth {
    NativePersistenceStorageHealth {
        opened: false,
        database_reachable: false,
        schema_compatible: false,
        metadata_ready: false,
        project_count: 0,
        worktree_count: 0,
        checked_at: crate::store::now_rfc3339(),
    }
}

pub fn storage_health(
    connection: &Connection,
    schema_compatible: bool,
) -> NativePersistenceStorageHealth {
    NativePersistenceStorageHealth {
        opened: true,
        database_reachable: true,
        schema_compatible,
        metadata_ready: metadata::metadata_table_exists(connection).unwrap_or(false),
        project_count: count_visible_projects(connection),
        worktree_count: count_visible_worktrees(connection),
        checked_at: crate::store::now_rfc3339(),
    }
}

fn count_visible_projects(connection: &Connection) -> u64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM projects WHERE is_hidden = 0",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(to_count)
        .unwrap_or(0)
}

fn count_visible_worktrees(connection: &Connection) -> u64 {
    connection
        .query_row(
            "
            SELECT COUNT(*)
            FROM project_worktrees
            INNER JOIN projects
                ON projects.id = project_worktrees.project_id
            WHERE projects.is_hidden = 0
            ",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(to_count)
        .unwrap_or(0)
}

fn to_count(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}
