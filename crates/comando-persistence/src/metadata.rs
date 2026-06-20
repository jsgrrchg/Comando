use comando_types::capabilities::PROTOCOL_VERSION;
use comando_types::persistence::NativePersistenceMode;
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::PersistenceError;

pub const METADATA_TABLE: &str = "native_backend_metadata";

pub fn ensure_metadata(
    connection: &Connection,
    schema_version: &str,
    mode: &NativePersistenceMode,
) -> Result<(), PersistenceError> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS native_backend_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        ",
    )?;

    upsert_metadata(connection, "native.schema_version", schema_version)?;
    upsert_metadata(
        connection,
        "native.last_opened_at",
        &crate::store::now_rfc3339(),
    )?;
    upsert_metadata(connection, "native.storage_mode", storage_mode_value(mode))?;
    upsert_metadata(
        connection,
        "native.protocol_version",
        &PROTOCOL_VERSION.to_string(),
    )?;

    Ok(())
}

pub fn metadata_table_exists(connection: &Connection) -> rusqlite::Result<bool> {
    let name = connection
        .query_row(
            "
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name = ?
            ",
            [METADATA_TABLE],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    Ok(name.is_some())
}

fn upsert_metadata(
    connection: &Connection,
    key: &str,
    value: &str,
) -> Result<(), PersistenceError> {
    connection.execute(
        "
        INSERT INTO native_backend_metadata (key, value, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        ",
        params![key, value, crate::store::now_rfc3339()],
    )?;

    Ok(())
}

fn storage_mode_value(mode: &NativePersistenceMode) -> &'static str {
    match mode {
        NativePersistenceMode::Shadow => "shadow",
        NativePersistenceMode::Write => "write",
    }
}
