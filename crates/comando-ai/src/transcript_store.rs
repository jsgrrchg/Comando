use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use comando_types::ai::{
    AI_TRANSCRIPT_CURSOR_LIMIT_MAX, NativeAiTranscriptBlockMetadata,
    NativeAiTranscriptEntryEnvelope, NativeAiTranscriptEntryKind, NativeAiTranscriptEntrySummary,
};
use comando_types::ids::SessionId;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use crate::error::{AiError, AiResult};

const TRANSCRIPT_DATABASE_FILE: &str = "transcript-v2.sqlite3";
const LEGACY_TRANSCRIPT_ENTRIES_FILE: &str = "transcript-entries.json";
const TRANSCRIPT_SCHEMA_VERSION: i64 = 1;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub(crate) struct TranscriptStore {
    database_path: PathBuf,
    legacy_entries_path: PathBuf,
}

impl TranscriptStore {
    pub(crate) fn new(session_dir: &Path) -> Self {
        Self {
            database_path: session_dir.join(TRANSCRIPT_DATABASE_FILE),
            legacy_entries_path: session_dir.join(LEGACY_TRANSCRIPT_ENTRIES_FILE),
        }
    }

    pub(crate) fn has_data_source(&self) -> bool {
        self.database_path.exists() || self.legacy_entries_path.exists()
    }

    pub(crate) fn append(
        &self,
        session_id: &SessionId,
        entries: Vec<NativeAiTranscriptEntryEnvelope>,
    ) -> AiResult<()> {
        validate_entry_ownership(session_id, &entries)?;
        let mut connection = self.open(session_id, true)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| transcript_sql("start transcript append transaction", error))?;
        append_entries_in_transaction(&transaction, session_id, entries)?;
        transaction
            .commit()
            .map_err(|error| transcript_sql("commit transcript append transaction", error))
    }

    pub(crate) fn load_before(
        &self,
        session_id: &SessionId,
        sequence: Option<u64>,
        limit: usize,
    ) -> AiResult<Vec<NativeAiTranscriptEntryEnvelope>> {
        let limit = cursor_limit_to_sql(limit)?;
        if !self.has_data_source() {
            return Ok(Vec::new());
        }
        let connection = self.open(session_id, false)?;
        let mut entries = match sequence {
            Some(sequence) => {
                let sequence = sequence_to_sql(sequence)?;
                query_entries(
                    &connection,
                    session_id,
                    "SELECT sequence, entry_id, kind, created_at, updated_at, summary_json, payload_ref
                     FROM transcript_entries
                     WHERE session_id = ?1 AND sequence < ?2
                     ORDER BY sequence DESC
                     LIMIT ?3",
                    params![session_id.0, sequence, limit],
                )?
            }
            None => query_entries(
                &connection,
                session_id,
                "SELECT sequence, entry_id, kind, created_at, updated_at, summary_json, payload_ref
                 FROM transcript_entries
                 WHERE session_id = ?1
                 ORDER BY sequence DESC
                 LIMIT ?2",
                params![session_id.0, limit],
            )?,
        };
        entries.reverse();
        Ok(entries)
    }

    pub(crate) fn load_after(
        &self,
        session_id: &SessionId,
        sequence: Option<u64>,
        limit: usize,
    ) -> AiResult<Vec<NativeAiTranscriptEntryEnvelope>> {
        let limit = cursor_limit_to_sql(limit)?;
        if !self.has_data_source() {
            return Ok(Vec::new());
        }
        let connection = self.open(session_id, false)?;
        match sequence {
            Some(sequence) => {
                let sequence = sequence_to_sql(sequence)?;
                query_entries(
                    &connection,
                    session_id,
                    "SELECT sequence, entry_id, kind, created_at, updated_at, summary_json, payload_ref
                     FROM transcript_entries
                     WHERE session_id = ?1 AND sequence > ?2
                     ORDER BY sequence ASC
                     LIMIT ?3",
                    params![session_id.0, sequence, limit],
                )
            }
            None => query_entries(
                &connection,
                session_id,
                "SELECT sequence, entry_id, kind, created_at, updated_at, summary_json, payload_ref
                 FROM transcript_entries
                 WHERE session_id = ?1
                 ORDER BY sequence ASC
                 LIMIT ?2",
                params![session_id.0, limit],
            ),
        }
    }

    pub(crate) fn load_around(
        &self,
        session_id: &SessionId,
        sequence: u64,
        before: usize,
        after: usize,
    ) -> AiResult<Vec<NativeAiTranscriptEntryEnvelope>> {
        let total = before.saturating_add(after).saturating_add(1);
        if total > AI_TRANSCRIPT_CURSOR_LIMIT_MAX {
            return Err(AiError::InvalidInput(
                "Transcript around window exceeds the maximum limit".to_string(),
            ));
        }
        if !self.has_data_source() {
            return Ok(Vec::new());
        }
        let connection = self.open(session_id, false)?;
        let sequence = sequence_to_sql(sequence)?;
        let before = optional_cursor_limit_to_sql(before)?;
        let after = optional_cursor_limit_to_sql(after)?;
        let mut preceding = query_entries(
            &connection,
            session_id,
            "SELECT sequence, entry_id, kind, created_at, updated_at, summary_json, payload_ref
             FROM transcript_entries
             WHERE session_id = ?1 AND sequence < ?2
             ORDER BY sequence DESC
             LIMIT ?3",
            params![session_id.0, sequence, before],
        )?;
        preceding.reverse();
        let center = query_entries(
            &connection,
            session_id,
            "SELECT sequence, entry_id, kind, created_at, updated_at, summary_json, payload_ref
             FROM transcript_entries
             WHERE session_id = ?1 AND sequence = ?2
             LIMIT 1",
            params![session_id.0, sequence],
        )?;
        let following = query_entries(
            &connection,
            session_id,
            "SELECT sequence, entry_id, kind, created_at, updated_at, summary_json, payload_ref
             FROM transcript_entries
             WHERE session_id = ?1 AND sequence > ?2
             ORDER BY sequence ASC
             LIMIT ?3",
            params![session_id.0, sequence, after],
        )?;
        preceding.extend(center);
        preceding.extend(following);
        Ok(preceding)
    }

    pub(crate) fn load_block_metadata(
        &self,
        session_id: &SessionId,
        block_size: usize,
    ) -> AiResult<Vec<NativeAiTranscriptBlockMetadata>> {
        if block_size == 0 || block_size > AI_TRANSCRIPT_CURSOR_LIMIT_MAX {
            return Err(AiError::InvalidInput(
                "Transcript block size is outside the supported range".to_string(),
            ));
        }
        if !self.has_data_source() {
            return Ok(Vec::new());
        }
        let connection = self.open(session_id, false)?;
        let block_size = usize_to_sql(block_size)?;
        let mut statement = connection
            .prepare(
                "WITH blocks AS (
                    SELECT
                        CAST((sequence - 1) / ?2 AS INTEGER) AS block_index,
                        MIN(sequence) AS start_sequence,
                        MAX(sequence) AS end_sequence,
                        COUNT(*) AS entry_count
                    FROM transcript_entries
                    WHERE session_id = ?1
                    GROUP BY block_index
                )
                SELECT
                    blocks.block_index,
                    blocks.start_sequence,
                    blocks.end_sequence,
                    blocks.entry_count,
                    first_entry.created_at,
                    last_entry.created_at
                FROM blocks
                JOIN transcript_entries AS first_entry
                    ON first_entry.session_id = ?1
                    AND first_entry.sequence = blocks.start_sequence
                JOIN transcript_entries AS last_entry
                    ON last_entry.session_id = ?1
                    AND last_entry.sequence = blocks.end_sequence
                ORDER BY blocks.block_index ASC",
            )
            .map_err(|error| transcript_sql("prepare transcript block metadata query", error))?;
        let rows = statement
            .query_map(params![session_id.0, block_size], |row| {
                Ok(StoredBlockMetadata {
                    block_index: row.get(0)?,
                    start_sequence: row.get(1)?,
                    end_sequence: row.get(2)?,
                    entry_count: row.get(3)?,
                    first_created_at: row.get(4)?,
                    last_created_at: row.get(5)?,
                })
            })
            .map_err(|error| transcript_sql("query transcript block metadata", error))?;

        rows.map(|row| {
            let row =
                row.map_err(|error| transcript_sql("read transcript block metadata", error))?;
            row.into_metadata(session_id)
        })
        .collect()
    }

    pub(crate) fn load_block(
        &self,
        session_id: &SessionId,
        block_index: usize,
        block_size: usize,
    ) -> AiResult<Vec<NativeAiTranscriptEntryEnvelope>> {
        if block_size == 0 || block_size > AI_TRANSCRIPT_CURSOR_LIMIT_MAX {
            return Err(AiError::InvalidInput(
                "Transcript block size is outside the supported range".to_string(),
            ));
        }
        if !self.has_data_source() {
            return Ok(Vec::new());
        }
        let start = block_index
            .checked_mul(block_size)
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| {
                AiError::InvalidInput("Transcript block index is too large".to_string())
            })?;
        let end = start
            .checked_add(block_size.saturating_sub(1))
            .ok_or_else(|| {
                AiError::InvalidInput("Transcript block index is too large".to_string())
            })?;
        let connection = self.open(session_id, false)?;
        query_entries(
            &connection,
            session_id,
            "SELECT sequence, entry_id, kind, created_at, updated_at, summary_json, payload_ref
             FROM transcript_entries
             WHERE session_id = ?1 AND sequence BETWEEN ?2 AND ?3
             ORDER BY sequence ASC",
            params![session_id.0, usize_to_sql(start)?, usize_to_sql(end)?],
        )
    }

    fn open(&self, session_id: &SessionId, create_parent: bool) -> AiResult<Connection> {
        if create_parent {
            let parent = self.database_path.parent().ok_or_else(|| {
                AiError::Internal("Transcript database path has no parent".to_string())
            })?;
            fs::create_dir_all(parent).map_err(|error| {
                AiError::Internal(format!(
                    "create transcript database directory failed for {}: {error}",
                    parent.display()
                ))
            })?;
        }
        let mut connection = Connection::open(&self.database_path)
            .map_err(|error| transcript_sql("open transcript database", error))?;
        connection
            .busy_timeout(SQLITE_BUSY_TIMEOUT)
            .map_err(|error| transcript_sql("configure transcript database timeout", error))?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = FULL;",
            )
            .map_err(|error| transcript_sql("configure transcript database", error))?;
        migrate_schema(&mut connection)?;
        self.import_legacy_entries(&mut connection, session_id)?;
        Ok(connection)
    }

    fn import_legacy_entries(
        &self,
        connection: &mut Connection,
        session_id: &SessionId,
    ) -> AiResult<()> {
        let already_imported = connection
            .query_row(
                "SELECT legacy_entries_imported
                 FROM transcript_sessions
                 WHERE session_id = ?1",
                params![session_id.0],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| transcript_sql("load provisional transcript import state", error))?
            == Some(1);
        if already_imported {
            return Ok(());
        }
        let legacy_entries = if self.legacy_entries_path.exists() {
            let bytes = fs::read(&self.legacy_entries_path).map_err(|error| {
                AiError::Internal(format!(
                    "read provisional transcript entries failed for {}: {error}",
                    self.legacy_entries_path.display()
                ))
            })?;
            Some(
                serde_json::from_slice::<Vec<NativeAiTranscriptEntryEnvelope>>(&bytes).map_err(
                    |error| {
                        AiError::Internal(format!(
                            "parse provisional transcript entries failed for {}: {error}",
                            self.legacy_entries_path.display()
                        ))
                    },
                )?,
            )
        } else {
            None
        };
        if let Some(entries) = legacy_entries.as_ref() {
            validate_entry_ownership(session_id, entries)?;
        }

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| transcript_sql("start provisional transcript import", error))?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO transcript_sessions (
                    session_id,
                    next_sequence,
                    legacy_entries_imported
                 ) VALUES (?1, 1, 0)",
                params![session_id.0],
            )
            .map_err(|error| transcript_sql("initialize transcript session", error))?;
        let imported: i64 = transaction
            .query_row(
                "SELECT legacy_entries_imported
                 FROM transcript_sessions
                 WHERE session_id = ?1",
                params![session_id.0],
                |row| row.get(0),
            )
            .map_err(|error| transcript_sql("load provisional transcript import state", error))?;
        if imported == 0 {
            if let Some(entries) = legacy_entries {
                append_entries_in_transaction(&transaction, session_id, entries)?;
            }
            transaction
                .execute(
                    "UPDATE transcript_sessions
                     SET legacy_entries_imported = 1
                     WHERE session_id = ?1",
                    params![session_id.0],
                )
                .map_err(|error| transcript_sql("complete provisional transcript import", error))?;
        }
        transaction
            .commit()
            .map_err(|error| transcript_sql("commit provisional transcript import", error))
    }
}

fn migrate_schema(connection: &mut Connection) -> AiResult<()> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| transcript_sql("read transcript schema version", error))?;
    if version > TRANSCRIPT_SCHEMA_VERSION {
        return Err(AiError::Internal(format!(
            "Transcript database schema version {version} is newer than supported version {TRANSCRIPT_SCHEMA_VERSION}"
        )));
    }
    if version == TRANSCRIPT_SCHEMA_VERSION {
        return Ok(());
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| transcript_sql("start transcript schema migration", error))?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS transcript_sessions (
                session_id TEXT PRIMARY KEY NOT NULL,
                next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1),
                legacy_entries_imported INTEGER NOT NULL DEFAULT 0
                    CHECK (legacy_entries_imported IN (0, 1))
             ) STRICT;

             CREATE TABLE IF NOT EXISTS transcript_entries (
                session_id TEXT NOT NULL,
                entry_id TEXT NOT NULL,
                sequence INTEGER NOT NULL CHECK (sequence >= 1),
                kind TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                summary_json TEXT NOT NULL,
                payload_ref TEXT,
                PRIMARY KEY (session_id, entry_id),
                UNIQUE (session_id, sequence),
                FOREIGN KEY (session_id) REFERENCES transcript_sessions(session_id)
                    ON DELETE CASCADE
             ) STRICT;

             CREATE INDEX IF NOT EXISTS transcript_entries_session_sequence_idx
                ON transcript_entries (session_id, sequence);",
        )
        .map_err(|error| transcript_sql("create transcript schema", error))?;
    transaction
        .pragma_update(None, "user_version", TRANSCRIPT_SCHEMA_VERSION)
        .map_err(|error| transcript_sql("set transcript schema version", error))?;
    transaction
        .commit()
        .map_err(|error| transcript_sql("commit transcript schema migration", error))
}

fn append_entries_in_transaction(
    transaction: &Transaction<'_>,
    session_id: &SessionId,
    entries: Vec<NativeAiTranscriptEntryEnvelope>,
) -> AiResult<()> {
    transaction
        .execute(
            "INSERT OR IGNORE INTO transcript_sessions (
                session_id,
                next_sequence,
                legacy_entries_imported
             ) VALUES (?1, 1, 1)",
            params![session_id.0],
        )
        .map_err(|error| transcript_sql("initialize transcript sequence", error))?;
    let mut next_sequence: i64 = transaction
        .query_row(
            "SELECT next_sequence
             FROM transcript_sessions
             WHERE session_id = ?1",
            params![session_id.0],
            |row| row.get(0),
        )
        .map_err(|error| transcript_sql("load next transcript sequence", error))?;

    for entry in entries {
        let existing_sequence = transaction
            .query_row(
                "SELECT sequence
                 FROM transcript_entries
                 WHERE session_id = ?1 AND entry_id = ?2",
                params![session_id.0, entry.id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| transcript_sql("find transcript entry", error))?;
        let sequence = match existing_sequence {
            Some(sequence) => sequence,
            None => {
                let assigned = next_sequence;
                next_sequence = next_sequence.checked_add(1).ok_or_else(|| {
                    AiError::Internal("Transcript sequence space is exhausted".to_string())
                })?;
                assigned
            }
        };
        let kind = serde_json::to_string(&entry.kind)
            .map_err(|error| transcript_json("serialize transcript entry kind", error))?;
        let summary = serde_json::to_string(&entry.summary)
            .map_err(|error| transcript_json("serialize transcript entry summary", error))?;
        transaction
            .execute(
                "INSERT INTO transcript_entries (
                    session_id,
                    entry_id,
                    sequence,
                    kind,
                    created_at,
                    updated_at,
                    summary_json,
                    payload_ref
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (session_id, entry_id) DO UPDATE SET
                    kind = excluded.kind,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    summary_json = excluded.summary_json,
                    payload_ref = excluded.payload_ref",
                params![
                    session_id.0,
                    entry.id,
                    sequence,
                    kind,
                    entry.created_at,
                    entry.updated_at,
                    summary,
                    entry.payload_ref,
                ],
            )
            .map_err(|error| transcript_sql("upsert transcript entry", error))?;
    }
    transaction
        .execute(
            "UPDATE transcript_sessions
             SET next_sequence = ?2
             WHERE session_id = ?1",
            params![session_id.0, next_sequence],
        )
        .map_err(|error| transcript_sql("advance transcript sequence", error))?;
    Ok(())
}

fn query_entries<P>(
    connection: &Connection,
    session_id: &SessionId,
    sql: &str,
    params: P,
) -> AiResult<Vec<NativeAiTranscriptEntryEnvelope>>
where
    P: rusqlite::Params,
{
    let mut statement = connection
        .prepare_cached(sql)
        .map_err(|error| transcript_sql("prepare transcript entries query", error))?;
    let rows = statement
        .query_map(params, |row| {
            Ok(StoredTranscriptEntry {
                sequence: row.get(0)?,
                entry_id: row.get(1)?,
                kind: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                summary_json: row.get(5)?,
                payload_ref: row.get(6)?,
            })
        })
        .map_err(|error| transcript_sql("query transcript entries", error))?;
    rows.map(|row| {
        let row = row.map_err(|error| transcript_sql("read transcript entry", error))?;
        row.into_envelope(session_id)
    })
    .collect()
}

#[derive(Debug)]
struct StoredTranscriptEntry {
    sequence: i64,
    entry_id: String,
    kind: String,
    created_at: String,
    updated_at: String,
    summary_json: String,
    payload_ref: Option<String>,
}

impl StoredTranscriptEntry {
    fn into_envelope(self, session_id: &SessionId) -> AiResult<NativeAiTranscriptEntryEnvelope> {
        Ok(NativeAiTranscriptEntryEnvelope {
            id: self.entry_id,
            session_id: session_id.clone(),
            sequence: u64::try_from(self.sequence).map_err(|_| {
                AiError::Internal("Transcript entry has an invalid sequence".to_string())
            })?,
            kind: serde_json::from_str::<NativeAiTranscriptEntryKind>(&self.kind)
                .map_err(|error| transcript_json("parse transcript entry kind", error))?,
            created_at: self.created_at,
            updated_at: self.updated_at,
            summary: serde_json::from_str::<NativeAiTranscriptEntrySummary>(&self.summary_json)
                .map_err(|error| transcript_json("parse transcript entry summary", error))?,
            payload_ref: self.payload_ref,
        })
    }
}

#[derive(Debug)]
struct StoredBlockMetadata {
    block_index: i64,
    start_sequence: i64,
    end_sequence: i64,
    entry_count: i64,
    first_created_at: String,
    last_created_at: String,
}

impl StoredBlockMetadata {
    fn into_metadata(self, session_id: &SessionId) -> AiResult<NativeAiTranscriptBlockMetadata> {
        let block_index = usize::try_from(self.block_index)
            .map_err(|_| AiError::Internal("Transcript block has an invalid index".to_string()))?;
        let entry_count = usize::try_from(self.entry_count)
            .map_err(|_| AiError::Internal("Transcript block has an invalid size".to_string()))?;
        Ok(NativeAiTranscriptBlockMetadata {
            block_id: format!("{}:{block_index}", session_id.0),
            session_id: session_id.clone(),
            start_sequence: u64::try_from(self.start_sequence).map_err(|_| {
                AiError::Internal("Transcript block has an invalid start sequence".to_string())
            })?,
            end_sequence: u64::try_from(self.end_sequence).map_err(|_| {
                AiError::Internal("Transcript block has an invalid end sequence".to_string())
            })?,
            entry_count,
            estimated_row_count: entry_count,
            estimated_height: u64::try_from(entry_count)
                .unwrap_or(u64::MAX)
                .saturating_mul(72),
            first_created_at: self.first_created_at,
            last_created_at: self.last_created_at,
            revision: 1,
        })
    }
}

fn validate_entry_ownership(
    session_id: &SessionId,
    entries: &[NativeAiTranscriptEntryEnvelope],
) -> AiResult<()> {
    if entries.iter().any(|entry| entry.session_id != *session_id) {
        return Err(AiError::InvalidInput(
            "Transcript entry belongs to a different session".to_string(),
        ));
    }
    Ok(())
}

fn sequence_to_sql(sequence: u64) -> AiResult<i64> {
    i64::try_from(sequence)
        .map_err(|_| AiError::InvalidInput("Transcript sequence is too large".to_string()))
}

fn cursor_limit_to_sql(limit: usize) -> AiResult<i64> {
    if limit == 0 || limit > AI_TRANSCRIPT_CURSOR_LIMIT_MAX {
        return Err(AiError::InvalidInput(
            "Transcript query limit is outside the supported range".to_string(),
        ));
    }
    usize_to_sql(limit)
}

fn optional_cursor_limit_to_sql(limit: usize) -> AiResult<i64> {
    if limit > AI_TRANSCRIPT_CURSOR_LIMIT_MAX {
        return Err(AiError::InvalidInput(
            "Transcript query limit is outside the supported range".to_string(),
        ));
    }
    usize_to_sql(limit)
}

fn usize_to_sql(value: usize) -> AiResult<i64> {
    i64::try_from(value)
        .map_err(|_| AiError::InvalidInput("Transcript query limit is too large".to_string()))
}

fn transcript_sql(action: &str, error: rusqlite::Error) -> AiError {
    AiError::Internal(format!("{action} failed: {error}"))
}

fn transcript_json(action: &str, error: serde_json::Error) -> AiError {
    AiError::Internal(format!("{action} failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(session_id: &SessionId, id: &str) -> NativeAiTranscriptEntryEnvelope {
        NativeAiTranscriptEntryEnvelope {
            id: id.to_string(),
            session_id: session_id.clone(),
            sequence: 0,
            kind: NativeAiTranscriptEntryKind::Message,
            created_at: "2026-07-18T00:00:00.000Z".to_string(),
            updated_at: "2026-07-18T00:00:00.000Z".to_string(),
            summary: NativeAiTranscriptEntrySummary {
                label: None,
                preview: Some(id.to_string()),
                status: Some("completed".to_string()),
            },
            payload_ref: None,
        }
    }

    #[test]
    fn cursor_queries_use_the_session_sequence_index() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = SessionId("query-plan".to_string());
        let store = TranscriptStore::new(temp.path());
        store
            .append(&session_id, vec![entry(&session_id, "entry-1")])
            .unwrap();
        let connection = store.open(&session_id, false).unwrap();
        let plan = connection
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT sequence, entry_id
                 FROM transcript_entries
                 WHERE session_id = ?1 AND sequence > ?2
                 ORDER BY sequence ASC
                 LIMIT ?3",
            )
            .unwrap()
            .query_map(params![session_id.0, 0_i64, 10_i64], |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .join("\n");

        assert!(
            plan.contains("transcript_entries_session_sequence_idx"),
            "unexpected query plan: {plan}"
        );
    }

    #[test]
    fn newer_schema_is_rejected_without_touching_provisional_entries() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = SessionId("future-schema".to_string());
        let store = TranscriptStore::new(temp.path());
        let legacy_bytes = serde_json::to_vec(&vec![entry(&session_id, "entry-1")]).unwrap();
        fs::write(&store.legacy_entries_path, &legacy_bytes).unwrap();
        let connection = Connection::open(&store.database_path).unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();
        drop(connection);

        let error = store.load_after(&session_id, None, 10).unwrap_err();

        assert!(error.to_string().contains("newer than supported"));
        assert_eq!(fs::read(&store.legacy_entries_path).unwrap(), legacy_bytes);
    }

    #[test]
    fn repository_rejects_foreign_entries_and_oversized_windows() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = SessionId("owned-session".to_string());
        let foreign_session_id = SessionId("foreign-session".to_string());
        let store = TranscriptStore::new(temp.path());

        let ownership_error = store
            .append(&session_id, vec![entry(&foreign_session_id, "entry-1")])
            .unwrap_err();
        let limit_error = store
            .load_after(&session_id, None, AI_TRANSCRIPT_CURSOR_LIMIT_MAX + 1)
            .unwrap_err();

        assert!(ownership_error.to_string().contains("different session"));
        assert!(
            limit_error
                .to_string()
                .contains("outside the supported range")
        );
        assert!(!store.database_path.exists());
    }
}
