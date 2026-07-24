use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use comando_types::ai::{
    AI_TRANSCRIPT_PAYLOAD_LIMIT_MAX, NativeAiCheckpointOpenTranscriptTailInput,
    NativeAiOpenTranscriptEntryRef, NativeAiOpenTranscriptTail, NativeAiTranscriptBlockMetadata,
    NativeAiTranscriptEntryEnvelope, NativeAiTranscriptEntryKind, NativeAiTranscriptEntrySummary,
    NativeAiTranscriptPayloadWrite, NativeAiTranscriptTerminalStatus,
};
use comando_types::ids::SessionId;
use rusqlite::{
    Connection, OptionalExtension, Transaction, TransactionBehavior, params, params_from_iter,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AiError, AiResult};
use crate::events::now_iso8601;

const TRANSCRIPT_DATABASE_FILE: &str = "transcript-v2.sqlite3";
const LEGACY_TRANSCRIPT_ENTRIES_FILE: &str = "transcript-entries.json";
const TRANSCRIPT_PAYLOADS_DIR: &str = "transcript-payloads";
pub(crate) const TRANSCRIPT_SCHEMA_VERSION: u32 = 6;
const TRANSCRIPT_BLOCK_SIZE: usize = 256;
const INLINE_PAYLOAD_MAX_BYTES: usize = 64 * 1024;
const TRANSCRIPT_PAYLOAD_REF_MAX_BYTES: usize = 512;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub type AiTranscriptPayloadWrite = NativeAiTranscriptPayloadWrite;

#[derive(Debug, Clone, PartialEq)]
pub struct AiTranscriptPayload {
    pub payload_ref: String,
    pub sha256: String,
    pub byte_length: usize,
    pub value: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TranscriptStoreHealth {
    pub schema_version: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct TranscriptStore {
    database_path: PathBuf,
    legacy_entries_path: PathBuf,
    payloads_dir: PathBuf,
}

impl TranscriptStore {
    pub(crate) fn new(session_dir: &Path) -> Self {
        Self {
            database_path: session_dir.join(TRANSCRIPT_DATABASE_FILE),
            legacy_entries_path: session_dir.join(LEGACY_TRANSCRIPT_ENTRIES_FILE),
            payloads_dir: session_dir.join(TRANSCRIPT_PAYLOADS_DIR),
        }
    }

    pub(crate) fn has_data_source(&self) -> bool {
        self.database_path.exists() || self.legacy_entries_path.exists()
    }

    pub(crate) fn legacy_transcript_backfill_complete(
        &self,
        session_id: &SessionId,
    ) -> AiResult<bool> {
        if !self.database_path.exists() {
            return Ok(false);
        }
        let connection = self.open(session_id, false)?;
        let state = connection
            .query_row(
                "SELECT legacy_transcript_backfill_complete
                 FROM transcript_sessions
                 WHERE session_id = ?1",
                params![session_id.0],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| transcript_sql("load legacy transcript backfill state", error))?;
        Ok(state.unwrap_or(1) == 1)
    }

    pub(crate) fn uses_legacy_transcript_backfill(&self, session_id: &SessionId) -> AiResult<bool> {
        if !self.database_path.exists() {
            return Ok(true);
        }
        let connection = self.open(session_id, false)?;
        let backfill_incomplete = connection
            .query_row(
                "SELECT
                    transcript_origin = 'legacy_backfill'
                    AND legacy_transcript_backfill_complete = 0
                 FROM transcript_sessions
                 WHERE session_id = ?1",
                params![session_id.0],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| transcript_sql("load transcript backfill origin", error))?
            == Some(1);
        if backfill_incomplete {
            return Ok(true);
        }
        let has_native_entries = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM transcript_entries AS entries
                    LEFT JOIN transcript_blocks AS blocks
                        ON blocks.session_id = entries.session_id
                        AND blocks.block_id = entries.block_id
                    WHERE entries.session_id = ?1
                        AND (blocks.turn_id IS NULL
                            OR blocks.turn_id NOT GLOB 'legacy-transcript:*')
                )",
                params![session_id.0],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| transcript_sql("detect native transcript entries", error))?
            == 1;
        // Native entries are authoritative even when the session began as a
        // legacy backfill. An empty native-default row is not sufficient.
        Ok(!has_native_entries)
    }

    pub(crate) fn native_transcript_entry_ids(
        &self,
        session_id: &SessionId,
        entry_ids: &[String],
    ) -> AiResult<BTreeSet<String>> {
        if !self.database_path.exists() || entry_ids.is_empty() {
            return Ok(BTreeSet::new());
        }
        let connection = self.open(session_id, false)?;
        let placeholders = std::iter::repeat_n("?", entry_ids.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT entries.entry_id
             FROM transcript_entries AS entries
             JOIN transcript_blocks AS blocks
                ON blocks.session_id = entries.session_id
                AND blocks.block_id = entries.block_id
             WHERE entries.session_id = ?
                AND entries.entry_id IN ({placeholders})
                AND (blocks.turn_id IS NULL
                    OR blocks.turn_id NOT GLOB 'legacy-transcript:*')"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| transcript_sql("prepare native transcript entry lookup", error))?;
        let parameters =
            std::iter::once(session_id.0.as_str()).chain(entry_ids.iter().map(String::as_str));
        statement
            .query_map(params_from_iter(parameters), |row| row.get::<_, String>(0))
            .map_err(|error| transcript_sql("query native transcript entries", error))?
            .collect::<Result<BTreeSet<_>, _>>()
            .map_err(|error| transcript_sql("read native transcript entry", error))
    }

    pub(crate) fn begin_legacy_transcript_backfill(&self, session_id: &SessionId) -> AiResult<()> {
        if !self.uses_legacy_transcript_backfill(session_id)? {
            return Err(AiError::InvalidInput(
                "A native transcript cannot start a legacy backfill".to_string(),
            ));
        }
        let connection = self.open(session_id, true)?;
        connection
            .execute(
                "INSERT INTO transcript_sessions (
                    session_id,
                    next_sequence,
                    legacy_entries_imported,
                    legacy_transcript_backfill_complete,
                    transcript_origin
                 ) VALUES (?1, 1, 1, 0, 'legacy_backfill')
                 ON CONFLICT (session_id) DO UPDATE SET
                    legacy_transcript_backfill_complete = 0,
                    transcript_origin = 'legacy_backfill'",
                params![session_id.0],
            )
            .map_err(|error| transcript_sql("start legacy transcript backfill", error))?;
        Ok(())
    }

    pub(crate) fn legacy_transcript_backfill_next_offset(
        &self,
        session_id: &SessionId,
    ) -> AiResult<usize> {
        let connection = self.open(session_id, true)?;
        connection
            .query_row(
                "SELECT legacy_transcript_backfill_next_offset
                 FROM transcript_sessions
                 WHERE session_id = ?1",
                params![session_id.0],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| transcript_sql("load legacy transcript backfill checkpoint", error))
            .map(|offset| offset.unwrap_or(0).max(0) as usize)
    }

    pub(crate) fn legacy_transcript_backfill_is_current(
        &self,
        session_id: &SessionId,
        legacy_record_count: usize,
    ) -> AiResult<bool> {
        if !self.legacy_transcript_backfill_complete(session_id)? {
            return Ok(false);
        }
        Ok(self.legacy_transcript_backfill_next_offset(session_id)? >= legacy_record_count)
    }

    pub(crate) fn invalidate_legacy_transcript_backfill_from(
        &self,
        session_id: &SessionId,
        first_changed_offset: usize,
        stale_entry_ids: &[String],
    ) -> AiResult<()> {
        if !self.database_path.exists() {
            return Ok(());
        }
        if !self.uses_legacy_transcript_backfill(session_id)? {
            return Ok(());
        }

        let mut connection = self.open(session_id, false)?;
        // The JSONL writer can revise streaming messages in place, so retain
        // the earliest affected cursor instead of trusting a completed flag.
        let obsolete_payload_files = (|| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| {
                    transcript_sql("start legacy transcript invalidation transaction", error)
                })?;
            let obsolete_payload_files =
                purge_legacy_transcript_entries_from(&transaction, session_id, stale_entry_ids)?;
            transaction
                .execute(
                    "UPDATE transcript_sessions
                 SET
                    legacy_transcript_backfill_complete = 0,
                    legacy_transcript_backfill_next_offset = MIN(
                        legacy_transcript_backfill_next_offset,
                        ?2
                    )
                 WHERE session_id = ?1",
                    params![session_id.0, first_changed_offset as i64],
                )
                .map_err(|error| transcript_sql("invalidate legacy transcript backfill", error))?;
            transaction
                .commit()
                .map_err(|error| transcript_sql("commit legacy transcript invalidation", error))?;
            Ok(obsolete_payload_files)
        })()?;
        self.remove_unreferenced_payload_files(&connection, session_id, &obsolete_payload_files);

        Ok(())
    }

    pub(crate) fn advance_legacy_transcript_backfill(
        &self,
        session_id: &SessionId,
        next_offset: usize,
        complete: bool,
    ) -> AiResult<()> {
        let connection = self.open(session_id, true)?;
        connection
            .execute(
                "UPDATE transcript_sessions
                 SET
                    legacy_transcript_backfill_next_offset = ?2,
                    legacy_transcript_backfill_complete = ?3
                 WHERE session_id = ?1",
                params![session_id.0, next_offset as i64, i64::from(complete)],
            )
            .map_err(|error| {
                transcript_sql("advance legacy transcript backfill checkpoint", error)
            })?;
        Ok(())
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

    pub(crate) fn seal_turn(
        &self,
        session_id: &SessionId,
        turn_id: &str,
        entries: Vec<NativeAiTranscriptEntryEnvelope>,
        payloads: Vec<AiTranscriptPayloadWrite>,
    ) -> AiResult<Vec<NativeAiTranscriptBlockMetadata>> {
        if turn_id.trim().is_empty() {
            return Err(AiError::InvalidInput(
                "Transcript turn ID must not be empty".to_string(),
            ));
        }
        if entries.is_empty() {
            return Err(AiError::InvalidInput(
                "Transcript turn must contain at least one entry".to_string(),
            ));
        }
        validate_entry_ownership(session_id, &entries)?;
        validate_payload_writes(&payloads)?;
        let entry_ids = entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>();
        let mut connection = self.open(session_id, true)?;
        let prepared_payloads = self.prepare_payloads(payloads)?;
        let result = (|| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| transcript_sql("start transcript seal transaction", error))?;
            let obsolete_payload_files =
                persist_payloads(&transaction, session_id, &prepared_payloads)?;
            append_entries_in_transaction(&transaction, session_id, entries)?;
            let block_ids = block_ids_for_entries(&transaction, session_id, &entry_ids)?;
            if block_ids.is_empty() {
                return Err(AiError::Internal(
                    "Transcript turn entries were not assigned to blocks".to_string(),
                ));
            }
            validate_block_payload_references(&transaction, session_id, &block_ids)?;
            seal_blocks(&transaction, session_id, turn_id, &block_ids)?;
            let metadata = load_block_metadata_by_ids(&transaction, session_id, &block_ids)?;
            transaction
                .execute(
                    "DELETE FROM transcript_open_tails
                     WHERE session_id = ?1 AND turn_id = ?2",
                    params![session_id.0, turn_id],
                )
                .map_err(|error| transcript_sql("clear sealed open transcript tail", error))?;
            transaction
                .commit()
                .map_err(|error| transcript_sql("commit transcript seal transaction", error))?;
            Ok((metadata, obsolete_payload_files))
        })();
        match result {
            Ok((metadata, obsolete_payload_files)) => {
                self.remove_unreferenced_payload_files(
                    &connection,
                    session_id,
                    &obsolete_payload_files,
                );
                Ok(metadata)
            }
            Err(error) => {
                self.remove_orphaned_payload_files(&connection, session_id, &prepared_payloads);
                Err(error)
            }
        }
    }

    pub(crate) fn checkpoint_open_tail(
        &self,
        input: NativeAiCheckpointOpenTranscriptTailInput,
    ) -> AiResult<()> {
        let NativeAiCheckpointOpenTranscriptTailInput {
            session_id,
            turn_id,
            terminal_status,
            entries,
            payloads,
            removed_entry_ids,
            entry_order,
        } = input;
        if turn_id.trim().is_empty() {
            return Err(AiError::InvalidInput(
                "Open transcript turn ID must not be empty".to_string(),
            ));
        }
        if entry_order.is_empty()
            && (removed_entry_ids.is_empty() && terminal_status.is_none()
                || !entries.is_empty()
                || !payloads.is_empty())
        {
            return Err(AiError::InvalidInput(
                "Open transcript tail update must include ordered entries, removals, or a terminal status"
                    .to_string(),
            ));
        }
        validate_entry_ownership(&session_id, &entries)?;
        validate_payload_writes(&payloads)?;
        validate_open_tail_entry_updates(&entry_order, &removed_entry_ids)?;
        let mut connection = self.open(&session_id, true)?;
        let prepared_payloads = self.prepare_payloads(payloads)?;
        let result = (|| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| {
                    transcript_sql("start open transcript checkpoint transaction", error)
                })?;
            let obsolete_payload_files =
                persist_payloads(&transaction, &session_id, &prepared_payloads)?;
            append_entries_in_transaction(&transaction, &session_id, entries)?;
            persist_open_tail(
                &transaction,
                &session_id,
                &turn_id,
                terminal_status.as_ref(),
                &removed_entry_ids,
                &entry_order,
            )?;
            transaction.commit().map_err(|error| {
                transcript_sql("commit open transcript checkpoint transaction", error)
            })?;
            Ok(obsolete_payload_files)
        })();
        match result {
            Ok(obsolete_payload_files) => {
                self.remove_unreferenced_payload_files(
                    &connection,
                    &session_id,
                    &obsolete_payload_files,
                );
                Ok(())
            }
            Err(error) => {
                self.remove_orphaned_payload_files(&connection, &session_id, &prepared_payloads);
                Err(error)
            }
        }
    }

    pub(crate) fn load_open_tail(
        &self,
        session_id: &SessionId,
    ) -> AiResult<Option<NativeAiOpenTranscriptTail>> {
        if !self.has_data_source() {
            return Ok(None);
        }
        let connection = self.open(session_id, false)?;
        let state = connection
            .query_row(
                "SELECT turn_id, terminal_status, updated_at, revision
                 FROM transcript_open_tails
                 WHERE session_id = ?1",
                params![session_id.0],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| transcript_sql("load open transcript tail state", error))?;
        let Some((turn_id, terminal_status, updated_at, revision)) = state else {
            return Ok(None);
        };
        let mut statement = connection
            .prepare(
                "SELECT
                    entries.sequence,
                    entries.entry_id,
                    entries.kind,
                    entries.created_at,
                    entries.updated_at,
                    entries.summary_json,
                    entries.payload_ref,
                    open_entries.entry_revision,
                    open_entries.ordinal
                 FROM transcript_open_tail_entries AS open_entries
                 JOIN transcript_entries AS entries
                    ON entries.session_id = open_entries.session_id
                    AND entries.entry_id = open_entries.entry_id
                 WHERE open_entries.session_id = ?1
                 ORDER BY open_entries.ordinal ASC",
            )
            .map_err(|error| transcript_sql("prepare open transcript tail entries", error))?;
        let rows = statement
            .query_map(params![session_id.0], |row| {
                Ok((
                    StoredTranscriptEntry {
                        sequence: row.get(0)?,
                        entry_id: row.get(1)?,
                        kind: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                        summary_json: row.get(5)?,
                        payload_ref: row.get(6)?,
                    },
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            })
            .map_err(|error| transcript_sql("query open transcript tail entries", error))?;
        let mut entries = Vec::new();
        let mut entry_revisions = Vec::new();
        for row in rows {
            let (stored, entry_revision, ordinal) =
                row.map_err(|error| transcript_sql("read open transcript tail entry", error))?;
            let entry = stored.into_envelope(session_id)?;
            entry_revisions.push(NativeAiOpenTranscriptEntryRef {
                entry_id: entry.id.clone(),
                entry_revision: sql_to_u64(entry_revision, "open tail entry revision")?,
                ordinal: sql_to_usize(ordinal, "open tail entry ordinal")?,
            });
            entries.push(entry);
        }
        drop(statement);
        drop(connection);

        let mut payloads = Vec::new();
        for payload_ref in entries
            .iter()
            .filter_map(|entry| entry.payload_ref.as_deref())
        {
            let payload =
                self.load_payload(session_id, payload_ref, AI_TRANSCRIPT_PAYLOAD_LIMIT_MAX)?;
            payloads.push(AiTranscriptPayloadWrite {
                payload_ref: payload.payload_ref,
                value: payload.value,
            });
        }
        Ok(Some(NativeAiOpenTranscriptTail {
            session_id: session_id.clone(),
            turn_id,
            terminal_status: terminal_status
                .as_deref()
                .map(parse_terminal_status)
                .transpose()?,
            updated_at,
            revision: sql_to_u64(revision, "open tail revision")?,
            entries,
            payloads,
            entry_revisions,
        }))
    }

    pub(crate) fn load_payload(
        &self,
        session_id: &SessionId,
        payload_ref: &str,
        max_bytes: usize,
    ) -> AiResult<AiTranscriptPayload> {
        validate_payload_ref(payload_ref)?;
        if max_bytes == 0 || max_bytes > AI_TRANSCRIPT_PAYLOAD_LIMIT_MAX {
            return Err(AiError::InvalidInput(
                "Transcript payload limit is outside the supported range".to_string(),
            ));
        }
        if !self.has_data_source() {
            return Err(AiError::NotFound(
                "Transcript payload was not found for this session".to_string(),
            ));
        }
        let connection = self.open(session_id, false)?;
        let payload = connection
            .query_row(
                "SELECT content_hash, byte_length, inline_data, file_name
                 FROM transcript_payloads
                 WHERE session_id = ?1 AND payload_ref = ?2",
                params![session_id.0, payload_ref],
                |row| {
                    Ok(StoredPayload {
                        content_hash: row.get(0)?,
                        byte_length: row.get(1)?,
                        inline_data: row.get(2)?,
                        file_name: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|error| transcript_sql("load transcript payload metadata", error))?
            .ok_or_else(|| {
                AiError::NotFound("Transcript payload was not found for this session".to_string())
            })?;
        let byte_length = usize::try_from(payload.byte_length).map_err(|_| {
            AiError::Internal("Transcript payload has an invalid byte length".to_string())
        })?;
        if byte_length > max_bytes {
            return Err(AiError::TooLarge(format!(
                "Transcript payload exceeds the requested {max_bytes} byte limit"
            )));
        }
        let bytes = match (payload.inline_data, payload.file_name) {
            (Some(bytes), None) => bytes,
            (None, Some(file_name)) => self.read_payload_file(&payload.content_hash, &file_name)?,
            _ => {
                return Err(AiError::Internal(
                    "Transcript payload storage metadata is inconsistent".to_string(),
                ));
            }
        };
        validate_payload_bytes(&payload.content_hash, byte_length, &bytes)?;
        let value = serde_json::from_slice(&bytes)
            .map_err(|error| transcript_json("parse transcript payload", error))?;
        Ok(AiTranscriptPayload {
            payload_ref: payload_ref.to_string(),
            sha256: payload.content_hash,
            byte_length,
            value,
        })
    }

    pub(crate) fn health(&self, session_id: &SessionId) -> AiResult<TranscriptStoreHealth> {
        if !self.has_data_source() {
            return Ok(TranscriptStoreHealth {
                schema_version: TRANSCRIPT_SCHEMA_VERSION,
            });
        }
        let connection = self.open(session_id, false)?;
        let integrity: String = connection
            .pragma_query_value(None, "quick_check", |row| row.get(0))
            .map_err(|error| transcript_sql("check transcript database integrity", error))?;
        if integrity != "ok" {
            return Err(AiError::Internal(
                "Transcript database integrity check failed".to_string(),
            ));
        }
        self.validate_external_payload_files(&connection, session_id)?;
        Ok(TranscriptStoreHealth {
            schema_version: TRANSCRIPT_SCHEMA_VERSION,
        })
    }

    pub(crate) fn transcript_revision(&self, session_id: &SessionId) -> AiResult<u64> {
        if !self.has_data_source() {
            return Ok(0);
        }
        let connection = self.open(session_id, false)?;
        load_transcript_revision(&connection, session_id)
    }

    pub(crate) fn load_block_metadata(
        &self,
        session_id: &SessionId,
    ) -> AiResult<Vec<NativeAiTranscriptBlockMetadata>> {
        if !self.has_data_source() {
            return Ok(Vec::new());
        }
        let connection = self.open(session_id, false)?;
        load_all_block_metadata(&connection, session_id)
    }

    pub(crate) fn load_block(
        &self,
        session_id: &SessionId,
        block_id: &str,
    ) -> AiResult<
        Option<(
            NativeAiTranscriptBlockMetadata,
            Vec<NativeAiTranscriptEntryEnvelope>,
        )>,
    > {
        if !self.has_data_source() {
            return Ok(None);
        }
        let connection = self.open(session_id, false)?;
        let metadata = load_block_metadata(&connection, session_id, block_id)?;
        let Some(metadata) = metadata else {
            return Ok(None);
        };
        let entries = query_entries(
            &connection,
            session_id,
            "SELECT sequence, entry_id, kind, created_at, updated_at, summary_json, payload_ref
             FROM transcript_entries
             WHERE session_id = ?1 AND block_id = ?2
             ORDER BY sequence ASC",
            params![session_id.0, block_id],
        )?;
        Ok(Some((metadata, entries)))
    }

    fn prepare_payloads(
        &self,
        payloads: Vec<AiTranscriptPayloadWrite>,
    ) -> AiResult<Vec<PreparedPayload>> {
        let mut prepared = payloads
            .into_iter()
            .map(|payload| {
                let bytes = serde_json::to_vec(&payload.value)
                    .map_err(|error| transcript_json("serialize transcript payload", error))?;
                if bytes.len() > AI_TRANSCRIPT_PAYLOAD_LIMIT_MAX {
                    return Err(AiError::TooLarge(format!(
                        "Transcript payload exceeds the {AI_TRANSCRIPT_PAYLOAD_LIMIT_MAX} byte limit"
                    )));
                }
                let content_hash = sha256_hex(&bytes);
                let file_name = (bytes.len() > INLINE_PAYLOAD_MAX_BYTES)
                    .then(|| format!("{content_hash}.json"));
                Ok(PreparedPayload {
                    payload_ref: payload.payload_ref,
                    content_hash,
                    bytes,
                    file_name,
                    created_file: false,
                })
            })
            .collect::<AiResult<Vec<_>>>()?;

        let mut created_paths = Vec::new();
        for payload in &mut prepared {
            let Some(file_name) = payload.file_name.as_ref() else {
                continue;
            };
            let path = self.payloads_dir.join(file_name);
            let write_result = if path.exists() {
                let existing = fs::read(&path).map_err(|error| {
                    payload_io("read content-addressed transcript payload", &path, error)
                })?;
                validate_payload_bytes(&payload.content_hash, payload.bytes.len(), &existing)
            } else {
                let created = atomic_write_payload(&path, &payload.bytes)?;
                payload.created_file = created;
                if created {
                    created_paths.push(path);
                    Ok(())
                } else {
                    let existing = fs::read(&path).map_err(|error| {
                        payload_io("read concurrent transcript payload", &path, error)
                    })?;
                    validate_payload_bytes(&payload.content_hash, payload.bytes.len(), &existing)
                }
            };
            if let Err(error) = write_result {
                for created_path in created_paths {
                    let _ = fs::remove_file(created_path);
                }
                return Err(error);
            }
        }
        Ok(prepared)
    }

    fn remove_orphaned_payload_files(
        &self,
        connection: &Connection,
        session_id: &SessionId,
        payloads: &[PreparedPayload],
    ) {
        for payload in payloads.iter().filter(|payload| payload.created_file) {
            let referenced = connection
                .query_row(
                    "SELECT 1
                     FROM transcript_payloads
                     WHERE session_id = ?1 AND content_hash = ?2
                     LIMIT 1",
                    params![session_id.0, payload.content_hash],
                    |_| Ok(()),
                )
                .optional()
                .ok()
                .flatten()
                .is_some();
            if !referenced && let Some(file_name) = payload.file_name.as_ref() {
                let _ = fs::remove_file(self.payloads_dir.join(file_name));
            }
        }
    }

    fn remove_unreferenced_payload_files(
        &self,
        connection: &Connection,
        session_id: &SessionId,
        file_names: &[String],
    ) {
        for file_name in file_names {
            let referenced = connection
                .query_row(
                    "SELECT 1
                     FROM transcript_payloads
                     WHERE session_id = ?1 AND file_name = ?2
                     LIMIT 1",
                    params![session_id.0, file_name],
                    |_| Ok(()),
                )
                .optional()
                .ok()
                .flatten()
                .is_some();
            if !referenced {
                let _ = fs::remove_file(self.payloads_dir.join(file_name));
            }
        }
    }

    fn read_payload_file(&self, content_hash: &str, file_name: &str) -> AiResult<Vec<u8>> {
        let expected_file_name = format!("{content_hash}.json");
        if file_name != expected_file_name {
            return Err(AiError::Internal(
                "Transcript payload file metadata is invalid".to_string(),
            ));
        }
        let path = self.payloads_dir.join(file_name);
        fs::read(&path)
            .map_err(|error| payload_io("read content-addressed transcript payload", &path, error))
    }

    fn validate_external_payload_files(
        &self,
        connection: &Connection,
        session_id: &SessionId,
    ) -> AiResult<()> {
        let mut statement = connection
            .prepare(
                "SELECT content_hash, file_name
                 FROM transcript_payloads
                 WHERE session_id = ?1 AND file_name IS NOT NULL",
            )
            .map_err(|error| transcript_sql("prepare transcript payload health query", error))?;
        let rows = statement
            .query_map(params![session_id.0], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| transcript_sql("query transcript payload health", error))?;
        for row in rows {
            let (content_hash, file_name) =
                row.map_err(|error| transcript_sql("read transcript payload health row", error))?;
            let expected_file_name = format!("{content_hash}.json");
            if file_name != expected_file_name || !self.payloads_dir.join(file_name).is_file() {
                return Err(AiError::Internal(
                    "Transcript payload file is missing or invalid".to_string(),
                ));
            }
        }
        Ok(())
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
                transaction
                    .execute(
                        "UPDATE transcript_blocks
                         SET
                            is_sealed = 1,
                            turn_id = COALESCE(turn_id, 'legacy:' || block_id),
                            sealed_at = COALESCE(sealed_at, ?2)
                         WHERE session_id = ?1 AND is_sealed = 0",
                        params![session_id.0, now_iso8601()],
                    )
                    .map_err(|error| {
                        transcript_sql("seal imported legacy transcript blocks", error)
                    })?;
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
    if version > i64::from(TRANSCRIPT_SCHEMA_VERSION) {
        return Err(AiError::Internal(format!(
            "Transcript database schema version {version} is newer than supported version {TRANSCRIPT_SCHEMA_VERSION}"
        )));
    }
    if version == i64::from(TRANSCRIPT_SCHEMA_VERSION) {
        return Ok(());
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| transcript_sql("start transcript schema migration", error))?;
    let locked_version: i64 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| transcript_sql("recheck transcript schema version", error))?;
    if locked_version > i64::from(TRANSCRIPT_SCHEMA_VERSION) {
        return Err(AiError::Internal(format!(
            "Transcript database schema version {locked_version} is newer than supported version {TRANSCRIPT_SCHEMA_VERSION}"
        )));
    }
    if locked_version == i64::from(TRANSCRIPT_SCHEMA_VERSION) {
        transaction
            .commit()
            .map_err(|error| transcript_sql("commit transcript schema check", error))?;
        return Ok(());
    }

    if locked_version == 0 {
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS transcript_sessions (
                session_id TEXT PRIMARY KEY NOT NULL,
                next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1),
                legacy_entries_imported INTEGER NOT NULL DEFAULT 0
                    CHECK (legacy_entries_imported IN (0, 1)),
                legacy_transcript_backfill_complete INTEGER NOT NULL DEFAULT 1
                    CHECK (legacy_transcript_backfill_complete IN (0, 1)),
                legacy_transcript_backfill_next_offset INTEGER NOT NULL DEFAULT 0
                    CHECK (legacy_transcript_backfill_next_offset >= 0),
                transcript_origin TEXT NOT NULL DEFAULT 'native'
                    CHECK (transcript_origin IN ('native', 'legacy_backfill'))
             ) STRICT;

             CREATE TABLE IF NOT EXISTS transcript_entries (
                session_id TEXT NOT NULL,
                entry_id TEXT NOT NULL,
                sequence INTEGER NOT NULL CHECK (sequence >= 1),
                block_id TEXT,
                kind TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                summary_json TEXT NOT NULL,
                payload_ref TEXT,
                PRIMARY KEY (session_id, entry_id),
                UNIQUE (session_id, sequence),
                FOREIGN KEY (session_id) REFERENCES transcript_sessions(session_id)
                    ON DELETE CASCADE
             ) STRICT;",
            )
            .map_err(|error| transcript_sql("create transcript base schema", error))?;
    } else if locked_version == 1 {
        transaction
            .execute_batch("ALTER TABLE transcript_entries ADD COLUMN block_id TEXT;")
            .map_err(|error| transcript_sql("add transcript entry block ownership", error))?;
    } else if locked_version == 2 {
        // Version 2 already contains entries, blocks, and immutable payloads.
    } else if locked_version == 3 {
        transaction
            .execute_batch(
                "ALTER TABLE transcript_sessions
                 ADD COLUMN legacy_transcript_backfill_complete INTEGER NOT NULL DEFAULT 1
                 CHECK (legacy_transcript_backfill_complete IN (0, 1));",
            )
            .map_err(|error| transcript_sql("add legacy transcript backfill state", error))?;
    } else if locked_version == 4 {
        transaction
            .execute_batch(
                "ALTER TABLE transcript_sessions
                 ADD COLUMN legacy_transcript_backfill_next_offset INTEGER NOT NULL DEFAULT 0
                 CHECK (legacy_transcript_backfill_next_offset >= 0);",
            )
            .map_err(|error| transcript_sql("add legacy transcript backfill checkpoint", error))?;
    } else if locked_version == 5 {
        transaction
            .execute_batch(
                "ALTER TABLE transcript_sessions
                 ADD COLUMN transcript_origin TEXT NOT NULL DEFAULT 'native'
                 CHECK (transcript_origin IN ('native', 'legacy_backfill'));",
            )
            .map_err(|error| transcript_sql("add transcript origin", error))?;
    } else {
        return Err(AiError::Internal(format!(
            "Transcript database schema version {locked_version} cannot be migrated"
        )));
    }

    if matches!(locked_version, 1 | 2) {
        transaction
            .execute_batch(
                "ALTER TABLE transcript_sessions
                 ADD COLUMN legacy_transcript_backfill_complete INTEGER NOT NULL DEFAULT 1
                 CHECK (legacy_transcript_backfill_complete IN (0, 1));",
            )
            .map_err(|error| transcript_sql("add legacy transcript backfill state", error))?;
    }

    if matches!(locked_version, 1..=3) {
        transaction
            .execute_batch(
                "ALTER TABLE transcript_sessions
                 ADD COLUMN legacy_transcript_backfill_next_offset INTEGER NOT NULL DEFAULT 0
                 CHECK (legacy_transcript_backfill_next_offset >= 0);",
            )
            .map_err(|error| transcript_sql("add legacy transcript backfill checkpoint", error))?;
    }

    if matches!(locked_version, 1..=4) {
        transaction
            .execute_batch(
                "ALTER TABLE transcript_sessions
                 ADD COLUMN transcript_origin TEXT NOT NULL DEFAULT 'native'
                 CHECK (transcript_origin IN ('native', 'legacy_backfill'));",
            )
            .map_err(|error| transcript_sql("add transcript origin", error))?;
    }

    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS transcript_blocks (
                session_id TEXT NOT NULL,
                block_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
                turn_id TEXT,
                start_sequence INTEGER NOT NULL CHECK (start_sequence >= 1),
                end_sequence INTEGER NOT NULL CHECK (end_sequence >= start_sequence),
                entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
                estimated_row_count INTEGER NOT NULL CHECK (estimated_row_count >= 0),
                estimated_height INTEGER NOT NULL CHECK (estimated_height >= 0),
                first_created_at TEXT NOT NULL,
                last_created_at TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK (revision >= 0),
                is_sealed INTEGER NOT NULL DEFAULT 0 CHECK (is_sealed IN (0, 1)),
                sealed_at TEXT,
                PRIMARY KEY (session_id, block_id),
                UNIQUE (session_id, ordinal),
                FOREIGN KEY (session_id) REFERENCES transcript_sessions(session_id)
                    ON DELETE CASCADE
             ) STRICT;

             CREATE INDEX IF NOT EXISTS transcript_blocks_session_ordinal_idx
                ON transcript_blocks (session_id, ordinal);

             CREATE INDEX IF NOT EXISTS transcript_entries_session_block_sequence_idx
                ON transcript_entries (session_id, block_id, sequence);

             CREATE TABLE IF NOT EXISTS transcript_payloads (
                session_id TEXT NOT NULL,
                payload_ref TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
                inline_data BLOB,
                file_name TEXT,
                created_at TEXT NOT NULL,
                PRIMARY KEY (session_id, payload_ref),
                FOREIGN KEY (session_id) REFERENCES transcript_sessions(session_id)
                    ON DELETE CASCADE,
                CHECK (
                    (inline_data IS NOT NULL AND file_name IS NULL)
                    OR (inline_data IS NULL AND file_name IS NOT NULL)
                )
             ) STRICT;

             CREATE INDEX IF NOT EXISTS transcript_payloads_session_hash_idx
                ON transcript_payloads (session_id, content_hash);

             CREATE TABLE IF NOT EXISTS transcript_open_tails (
                session_id TEXT PRIMARY KEY NOT NULL,
                turn_id TEXT NOT NULL,
                terminal_status TEXT CHECK (
                    terminal_status IS NULL
                    OR terminal_status IN ('cancelled', 'completed', 'failed')
                ),
                updated_at TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK (revision >= 1),
                FOREIGN KEY (session_id) REFERENCES transcript_sessions(session_id)
                    ON DELETE CASCADE
             ) STRICT;

             CREATE TABLE IF NOT EXISTS transcript_open_tail_entries (
                session_id TEXT NOT NULL,
                entry_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
                entry_revision INTEGER NOT NULL CHECK (entry_revision >= 1),
                PRIMARY KEY (session_id, entry_id),
                UNIQUE (session_id, ordinal),
                FOREIGN KEY (session_id) REFERENCES transcript_open_tails(session_id)
                    ON DELETE CASCADE,
                FOREIGN KEY (session_id, entry_id)
                    REFERENCES transcript_entries(session_id, entry_id)
                    ON DELETE CASCADE
             ) STRICT;

             CREATE INDEX IF NOT EXISTS transcript_open_tail_entries_order_idx
                ON transcript_open_tail_entries (session_id, ordinal);",
        )
        .map_err(|error| {
            transcript_sql(
                "create transcript blocks, payload, and open tail schema",
                error,
            )
        })?;

    if locked_version == 1 {
        transaction
            .execute_batch(
                "WITH grouped AS (
                    SELECT
                        session_id,
                        CAST((sequence - 1) / 256 AS INTEGER) AS ordinal,
                        MIN(sequence) AS start_sequence,
                        MAX(sequence) AS end_sequence,
                        COUNT(*) AS entry_count
                    FROM transcript_entries
                    GROUP BY session_id, ordinal
                 )
                 INSERT INTO transcript_blocks (
                    session_id,
                    block_id,
                    ordinal,
                    turn_id,
                    start_sequence,
                    end_sequence,
                    entry_count,
                    estimated_row_count,
                    estimated_height,
                    first_created_at,
                    last_created_at,
                    revision,
                    is_sealed,
                    sealed_at
                 )
                 SELECT
                    grouped.session_id,
                    grouped.session_id || ':' || grouped.ordinal,
                    grouped.ordinal,
                    NULL,
                    grouped.start_sequence,
                    grouped.end_sequence,
                    grouped.entry_count,
                    grouped.entry_count,
                    grouped.entry_count * 72,
                    first_entry.created_at,
                    last_entry.created_at,
                    1,
                    0,
                    NULL
                 FROM grouped
                 JOIN transcript_entries AS first_entry
                    ON first_entry.session_id = grouped.session_id
                    AND first_entry.sequence = grouped.start_sequence
                 JOIN transcript_entries AS last_entry
                    ON last_entry.session_id = grouped.session_id
                    AND last_entry.sequence = grouped.end_sequence;

                 UPDATE transcript_entries
                 SET block_id = session_id || ':' || CAST((sequence - 1) / 256 AS INTEGER);",
            )
            .map_err(|error| transcript_sql("backfill transcript block metadata", error))?;
    }
    if matches!(locked_version, 1 | 2) {
        transaction
            .execute(
                "UPDATE transcript_blocks
                 SET
                    is_sealed = 1,
                    turn_id = COALESCE(turn_id, 'legacy:' || block_id),
                    sealed_at = COALESCE(sealed_at, ?1)
                 WHERE is_sealed = 0",
                params![now_iso8601()],
            )
            .map_err(|error| transcript_sql("seal migrated transcript blocks", error))?;
    }
    if matches!(locked_version, 1..=5) {
        // Existing backfills are identifiable by their own turns. A native
        // block always wins so a failed legacy attempt cannot poison it.
        transaction
            .execute_batch(
                "UPDATE transcript_sessions AS sessions
                 SET transcript_origin = 'legacy_backfill'
                 WHERE sessions.legacy_transcript_backfill_complete = 0
                    OR (
                        EXISTS (
                        SELECT 1 FROM transcript_blocks AS blocks
                        WHERE blocks.session_id = sessions.session_id
                            AND blocks.turn_id GLOB 'legacy-transcript:*'
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM transcript_blocks AS blocks
                            WHERE blocks.session_id = sessions.session_id
                                AND (blocks.turn_id IS NULL
                                    OR blocks.turn_id NOT GLOB 'legacy-transcript:*')
                        )
                    );",
            )
            .map_err(|error| transcript_sql("classify transcript origins", error))?;
    }
    transaction
        .pragma_update(None, "user_version", i64::from(TRANSCRIPT_SCHEMA_VERSION))
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
    let mut touched_block_ids = BTreeSet::new();

    for entry in entries {
        let kind = serde_json::to_string(&entry.kind)
            .map_err(|error| transcript_json("serialize transcript entry kind", error))?;
        let summary = serde_json::to_string(&entry.summary)
            .map_err(|error| transcript_json("serialize transcript entry summary", error))?;
        let existing = transaction
            .query_row(
                "SELECT
                    block_id,
                    kind,
                    created_at,
                    updated_at,
                    summary_json,
                    payload_ref
                 FROM transcript_entries
                 WHERE session_id = ?1 AND entry_id = ?2",
                params![session_id.0, entry.id],
                |row| {
                    Ok(ExistingTranscriptEntry {
                        block_id: row.get(0)?,
                        kind: row.get(1)?,
                        created_at: row.get(2)?,
                        updated_at: row.get(3)?,
                        summary_json: row.get(4)?,
                        payload_ref: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|error| transcript_sql("find transcript entry", error))?;
        match existing {
            Some(existing) => {
                let block_id = existing.block_id.ok_or_else(|| {
                    AiError::Internal("Transcript entry has no block assignment".to_string())
                })?;
                let changed = existing.kind != kind
                    || existing.created_at != entry.created_at
                    || existing.updated_at != entry.updated_at
                    || existing.summary_json != summary
                    || existing.payload_ref != entry.payload_ref;
                if changed {
                    transaction
                        .execute(
                            "UPDATE transcript_entries
                             SET
                                kind = ?3,
                                created_at = ?4,
                                updated_at = ?5,
                                summary_json = ?6,
                                payload_ref = ?7
                             WHERE session_id = ?1 AND entry_id = ?2",
                            params![
                                session_id.0,
                                entry.id,
                                kind,
                                entry.created_at,
                                entry.updated_at,
                                summary,
                                entry.payload_ref,
                            ],
                        )
                        .map_err(|error| transcript_sql("update transcript entry", error))?;
                    touched_block_ids.insert(block_id);
                }
            }
            None => {
                let sequence = next_sequence;
                next_sequence = next_sequence.checked_add(1).ok_or_else(|| {
                    AiError::Internal("Transcript sequence space is exhausted".to_string())
                })?;
                let block_id = select_or_create_open_block(
                    transaction,
                    session_id,
                    sequence,
                    &entry.created_at,
                )?;
                transaction
                    .execute(
                        "INSERT INTO transcript_entries (
                    session_id,
                    entry_id,
                    sequence,
                    block_id,
                    kind,
                    created_at,
                    updated_at,
                    summary_json,
                    payload_ref
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![
                            session_id.0,
                            entry.id,
                            sequence,
                            block_id,
                            kind,
                            entry.created_at,
                            entry.updated_at,
                            summary,
                            entry.payload_ref,
                        ],
                    )
                    .map_err(|error| transcript_sql("insert transcript entry", error))?;
                transaction
                    .execute(
                        "UPDATE transcript_blocks
                         SET entry_count = entry_count + 1
                         WHERE session_id = ?1 AND block_id = ?2",
                        params![session_id.0, block_id],
                    )
                    .map_err(|error| transcript_sql("reserve transcript block entry", error))?;
                touched_block_ids.insert(block_id);
            }
        }
    }
    transaction
        .execute(
            "UPDATE transcript_sessions
             SET next_sequence = ?2
             WHERE session_id = ?1",
            params![session_id.0, next_sequence],
        )
        .map_err(|error| transcript_sql("advance transcript sequence", error))?;
    for block_id in touched_block_ids {
        refresh_block_metadata(transaction, session_id, &block_id)?;
    }
    Ok(())
}

fn validate_open_tail_entry_updates(
    entry_order: &[NativeAiOpenTranscriptEntryRef],
    removed_entry_ids: &[String],
) -> AiResult<()> {
    let mut entry_ids = BTreeSet::new();
    let mut ordinals = BTreeSet::new();
    for entry in entry_order {
        if entry.entry_id.trim().is_empty() || entry.entry_revision == 0 {
            return Err(AiError::InvalidInput(
                "Open transcript entry state is invalid".to_string(),
            ));
        }
        if !entry_ids.insert(entry.entry_id.as_str()) || !ordinals.insert(entry.ordinal) {
            return Err(AiError::InvalidInput(
                "Open transcript entry updates contain duplicates".to_string(),
            ));
        }
    }
    for entry_id in removed_entry_ids {
        if entry_id.trim().is_empty() || !entry_ids.insert(entry_id.as_str()) {
            return Err(AiError::InvalidInput(
                "Open transcript entry updates contain duplicate removals".to_string(),
            ));
        }
    }
    Ok(())
}

fn persist_open_tail(
    transaction: &Transaction<'_>,
    session_id: &SessionId,
    turn_id: &str,
    terminal_status: Option<&NativeAiTranscriptTerminalStatus>,
    removed_entry_ids: &[String],
    entry_order: &[NativeAiOpenTranscriptEntryRef],
) -> AiResult<()> {
    for entry in entry_order {
        let exists = transaction
            .query_row(
                "SELECT 1
                 FROM transcript_entries
                 WHERE session_id = ?1 AND entry_id = ?2",
                params![session_id.0, entry.entry_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| transcript_sql("validate open transcript entry", error))?
            .is_some();
        if !exists {
            return Err(AiError::InvalidInput(
                "Open transcript tail references an entry that was not persisted".to_string(),
            ));
        }
    }
    transaction
        .execute(
            "INSERT INTO transcript_open_tails (
                session_id,
                turn_id,
                terminal_status,
                updated_at,
                revision
             ) VALUES (?1, ?2, ?3, ?4, 1)
             ON CONFLICT (session_id) DO UPDATE SET
                turn_id = excluded.turn_id,
                terminal_status = excluded.terminal_status,
                updated_at = excluded.updated_at,
                revision = transcript_open_tails.revision + 1",
            params![
                session_id.0,
                turn_id,
                terminal_status.map(terminal_status_to_sql),
                now_iso8601(),
            ],
        )
        .map_err(|error| transcript_sql("persist open transcript tail state", error))?;

    for entry_id in removed_entry_ids {
        transaction
            .execute(
                "DELETE FROM transcript_open_tail_entries
                 WHERE session_id = ?1 AND entry_id = ?2",
                params![session_id.0, entry_id],
            )
            .map_err(|error| transcript_sql("remove open transcript entry", error))?;
    }

    reserve_open_tail_ordinals(transaction, session_id, entry_order)?;
    for entry in entry_order {
        transaction
            .execute(
                "INSERT INTO transcript_open_tail_entries (
                    session_id,
                    entry_id,
                    ordinal,
                    entry_revision
                 ) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (session_id, entry_id) DO UPDATE SET
                    ordinal = excluded.ordinal,
                    entry_revision = excluded.entry_revision",
                params![
                    session_id.0,
                    entry.entry_id,
                    usize_to_sql(entry.ordinal)?,
                    u64_to_sql(entry.entry_revision, "open tail entry revision")?,
                ],
            )
            .map_err(|error| transcript_sql("persist open transcript entry order", error))?;
    }
    Ok(())
}

fn reserve_open_tail_ordinals(
    transaction: &Transaction<'_>,
    session_id: &SessionId,
    entry_order: &[NativeAiOpenTranscriptEntryRef],
) -> AiResult<()> {
    if entry_order.is_empty() {
        return Ok(());
    }
    let temporary_start: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(ordinal), -1) + ?2 + 1
             FROM transcript_open_tail_entries
             WHERE session_id = ?1",
            params![session_id.0, usize_to_sql(entry_order.len())?],
            |row| row.get(0),
        )
        .map_err(|error| transcript_sql("reserve temporary transcript ordinals", error))?;
    for (index, entry) in entry_order.iter().enumerate() {
        // Move only changed rows out of the unique ordinal range before their
        // final UPSERT, so reordered entries never collide with each other.
        transaction
            .execute(
                "UPDATE transcript_open_tail_entries
                 SET ordinal = ?3
                 WHERE session_id = ?1 AND entry_id = ?2",
                params![
                    session_id.0,
                    entry.entry_id,
                    temporary_start + usize_to_sql(index)?,
                ],
            )
            .map_err(|error| transcript_sql("reserve open transcript entry ordinal", error))?;
    }
    Ok(())
}

fn terminal_status_to_sql(status: &NativeAiTranscriptTerminalStatus) -> &'static str {
    match status {
        NativeAiTranscriptTerminalStatus::Cancelled => "cancelled",
        NativeAiTranscriptTerminalStatus::Completed => "completed",
        NativeAiTranscriptTerminalStatus::Failed => "failed",
    }
}

fn parse_terminal_status(value: &str) -> AiResult<NativeAiTranscriptTerminalStatus> {
    match value {
        "cancelled" => Ok(NativeAiTranscriptTerminalStatus::Cancelled),
        "completed" => Ok(NativeAiTranscriptTerminalStatus::Completed),
        "failed" => Ok(NativeAiTranscriptTerminalStatus::Failed),
        _ => Err(AiError::Internal(
            "Open transcript terminal status is invalid".to_string(),
        )),
    }
}

#[derive(Debug)]
struct ExistingTranscriptEntry {
    block_id: Option<String>,
    kind: String,
    created_at: String,
    updated_at: String,
    summary_json: String,
    payload_ref: Option<String>,
}

fn select_or_create_open_block(
    transaction: &Transaction<'_>,
    session_id: &SessionId,
    sequence: i64,
    created_at: &str,
) -> AiResult<String> {
    let available = transaction
        .query_row(
            "SELECT block_id
             FROM transcript_blocks
             WHERE session_id = ?1 AND is_sealed = 0 AND entry_count < ?2
             ORDER BY ordinal DESC
             LIMIT 1",
            params![session_id.0, usize_to_sql(TRANSCRIPT_BLOCK_SIZE)?],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| transcript_sql("find open transcript block", error))?;
    if let Some(block_id) = available {
        return Ok(block_id);
    }

    let ordinal: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(ordinal) + 1, 0)
             FROM transcript_blocks
             WHERE session_id = ?1",
            params![session_id.0],
            |row| row.get(0),
        )
        .map_err(|error| transcript_sql("allocate transcript block ordinal", error))?;
    let block_id = format!("{}:{ordinal}", session_id.0);
    transaction
        .execute(
            "INSERT INTO transcript_blocks (
                session_id,
                block_id,
                ordinal,
                turn_id,
                start_sequence,
                end_sequence,
                entry_count,
                estimated_row_count,
                estimated_height,
                first_created_at,
                last_created_at,
                revision,
                is_sealed,
                sealed_at
             ) VALUES (?1, ?2, ?3, NULL, ?4, ?4, 0, 0, 0, ?5, ?5, 0, 0, NULL)",
            params![session_id.0, block_id, ordinal, sequence, created_at],
        )
        .map_err(|error| transcript_sql("create transcript block", error))?;
    Ok(block_id)
}

fn refresh_block_metadata(
    transaction: &Transaction<'_>,
    session_id: &SessionId,
    block_id: &str,
) -> AiResult<()> {
    let updated = transaction
        .execute(
            "UPDATE transcript_blocks
             SET
                start_sequence = (
                    SELECT MIN(sequence) FROM transcript_entries
                    WHERE session_id = ?1 AND block_id = ?2
                ),
                end_sequence = (
                    SELECT MAX(sequence) FROM transcript_entries
                    WHERE session_id = ?1 AND block_id = ?2
                ),
                entry_count = (
                    SELECT COUNT(*) FROM transcript_entries
                    WHERE session_id = ?1 AND block_id = ?2
                ),
                estimated_row_count = (
                    SELECT COUNT(*) FROM transcript_entries
                    WHERE session_id = ?1 AND block_id = ?2
                ),
                estimated_height = (
                    SELECT COUNT(*) * 72 FROM transcript_entries
                    WHERE session_id = ?1 AND block_id = ?2
                ),
                first_created_at = (
                    SELECT created_at FROM transcript_entries
                    WHERE session_id = ?1 AND block_id = ?2
                    ORDER BY sequence ASC LIMIT 1
                ),
                last_created_at = (
                    SELECT created_at FROM transcript_entries
                    WHERE session_id = ?1 AND block_id = ?2
                    ORDER BY sequence DESC LIMIT 1
                ),
                revision = revision + 1
             WHERE session_id = ?1 AND block_id = ?2",
            params![session_id.0, block_id],
        )
        .map_err(|error| transcript_sql("refresh transcript block metadata", error))?;
    if updated != 1 {
        return Err(AiError::Internal(
            "Transcript block metadata could not be refreshed".to_string(),
        ));
    }
    Ok(())
}

fn purge_legacy_transcript_entries_from(
    transaction: &Transaction<'_>,
    session_id: &SessionId,
    stale_entry_ids: &[String],
) -> AiResult<Vec<String>> {
    let mut affected_blocks = BTreeSet::new();
    // IDs preserve the JSONL-to-SQLite mapping even when native entries were
    // skipped during backfill and therefore consumed no SQLite sequence.
    for entry_ids in stale_entry_ids.chunks(500) {
        let placeholders = std::iter::repeat_n("?", entry_ids.len())
            .collect::<Vec<_>>()
            .join(", ");
        let parameters = std::iter::once(session_id.0.as_str())
            .chain(entry_ids.iter().map(String::as_str))
            .collect::<Vec<_>>();
        let lookup_sql = format!(
            "SELECT DISTINCT entries.block_id
             FROM transcript_entries AS entries
             JOIN transcript_blocks AS blocks
                ON blocks.session_id = entries.session_id
                AND blocks.block_id = entries.block_id
             WHERE entries.session_id = ?
                AND entries.entry_id IN ({placeholders})
                AND blocks.turn_id GLOB 'legacy-transcript:*'"
        );
        let mut statement = transaction
            .prepare(&lookup_sql)
            .map_err(|error| transcript_sql("prepare legacy transcript purge blocks", error))?;
        let block_ids = statement
            .query_map(params_from_iter(parameters.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| transcript_sql("query legacy transcript purge blocks", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| transcript_sql("read legacy transcript purge block", error))?;
        affected_blocks.extend(block_ids);

        // Only backfill turns participate here so native transcript entries
        // keep their own lifecycle during compatibility reconciliation.
        let delete_sql = format!(
            "DELETE FROM transcript_entries
             WHERE session_id = ?
                AND entry_id IN (
                    SELECT entries.entry_id
                    FROM transcript_entries AS entries
                    JOIN transcript_blocks AS blocks
                        ON blocks.session_id = entries.session_id
                        AND blocks.block_id = entries.block_id
                    WHERE entries.session_id = ?
                        AND entries.entry_id IN ({placeholders})
                        AND blocks.turn_id GLOB 'legacy-transcript:*'
                )"
        );
        let delete_parameters = std::iter::once(session_id.0.as_str())
            .chain(std::iter::once(session_id.0.as_str()))
            .chain(entry_ids.iter().map(String::as_str));
        transaction
            .execute(&delete_sql, params_from_iter(delete_parameters))
            .map_err(|error| transcript_sql("remove stale legacy transcript entries", error))?;
    }

    if affected_blocks.is_empty() {
        return Ok(Vec::new());
    }

    for block_id in affected_blocks {
        let has_entries = transaction
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM transcript_entries
                    WHERE session_id = ?1 AND block_id = ?2
                )",
                params![session_id.0, block_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| transcript_sql("check legacy transcript block after purge", error))?
            == 1;
        if has_entries {
            refresh_block_metadata(transaction, session_id, &block_id)?;
        } else {
            transaction
                .execute(
                    "DELETE FROM transcript_blocks
                     WHERE session_id = ?1 AND block_id = ?2",
                    params![session_id.0, block_id],
                )
                .map_err(|error| transcript_sql("remove empty legacy transcript block", error))?;
        }
    }

    let obsolete_payload_files = {
        let mut statement = transaction
            .prepare(
                "SELECT file_name
                 FROM transcript_payloads AS payloads
                 WHERE payloads.session_id = ?1
                    AND payloads.file_name IS NOT NULL
                    AND NOT EXISTS (
                        SELECT 1 FROM transcript_entries AS entries
                        WHERE entries.session_id = payloads.session_id
                            AND entries.payload_ref = payloads.payload_ref
                    )",
            )
            .map_err(|error| transcript_sql("prepare stale transcript payload cleanup", error))?;
        statement
            .query_map(params![session_id.0], |row| row.get::<_, String>(0))
            .map_err(|error| transcript_sql("query stale transcript payload files", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| transcript_sql("read stale transcript payload file", error))?
    };
    transaction
        .execute(
            "DELETE FROM transcript_payloads
             WHERE session_id = ?1
                AND NOT EXISTS (
                    SELECT 1 FROM transcript_entries AS entries
                    WHERE entries.session_id = transcript_payloads.session_id
                        AND entries.payload_ref = transcript_payloads.payload_ref
                )",
            params![session_id.0],
        )
        .map_err(|error| transcript_sql("remove stale transcript payloads", error))?;

    Ok(obsolete_payload_files)
}

#[derive(Debug)]
struct PreparedPayload {
    payload_ref: String,
    content_hash: String,
    bytes: Vec<u8>,
    file_name: Option<String>,
    created_file: bool,
}

#[derive(Debug)]
struct StoredPayload {
    content_hash: String,
    byte_length: i64,
    inline_data: Option<Vec<u8>>,
    file_name: Option<String>,
}

fn persist_payloads(
    transaction: &Transaction<'_>,
    session_id: &SessionId,
    payloads: &[PreparedPayload],
) -> AiResult<Vec<String>> {
    let mut obsolete_file_names = BTreeSet::new();
    for payload in payloads {
        let existing = transaction
            .query_row(
                "SELECT
                    payloads.content_hash,
                    payloads.file_name,
                    EXISTS (
                        SELECT 1
                        FROM transcript_entries AS entries
                        JOIN transcript_blocks AS blocks
                            ON blocks.session_id = entries.session_id
                            AND blocks.block_id = entries.block_id
                        WHERE entries.session_id = payloads.session_id
                            AND entries.payload_ref = payloads.payload_ref
                            AND blocks.is_sealed = 1
                    )
                 FROM transcript_payloads AS payloads
                 WHERE payloads.session_id = ?1 AND payloads.payload_ref = ?2",
                params![session_id.0, payload.payload_ref],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| transcript_sql("find transcript payload", error))?;
        if let Some((existing_hash, existing_file_name, sealed_reference)) = existing {
            if existing_hash == payload.content_hash {
                continue;
            }
            if sealed_reference == 1 {
                return Err(AiError::InvalidInput(
                    "Sealed transcript payload references are immutable".to_string(),
                ));
            }
            let inline_data = payload
                .file_name
                .is_none()
                .then_some(payload.bytes.as_slice());
            transaction
                .execute(
                    "UPDATE transcript_payloads
                     SET
                        content_hash = ?3,
                        byte_length = ?4,
                        inline_data = ?5,
                        file_name = ?6,
                        created_at = ?7
                     WHERE session_id = ?1 AND payload_ref = ?2",
                    params![
                        session_id.0,
                        payload.payload_ref,
                        payload.content_hash,
                        usize_to_sql(payload.bytes.len())?,
                        inline_data,
                        payload.file_name,
                        now_iso8601(),
                    ],
                )
                .map_err(|error| transcript_sql("update open transcript payload", error))?;
            transaction
                .execute(
                    "UPDATE transcript_blocks
                     SET revision = revision + 1
                     WHERE session_id = ?1 AND block_id IN (
                        SELECT block_id
                        FROM transcript_entries
                        WHERE session_id = ?1 AND payload_ref = ?2
                     )",
                    params![session_id.0, payload.payload_ref],
                )
                .map_err(|error| {
                    transcript_sql("refresh open transcript payload revision", error)
                })?;
            if let Some(file_name) = existing_file_name {
                obsolete_file_names.insert(file_name);
            }
            continue;
        }
        let inline_data = payload
            .file_name
            .is_none()
            .then_some(payload.bytes.as_slice());
        transaction
            .execute(
                "INSERT INTO transcript_payloads (
                    session_id,
                    payload_ref,
                    content_hash,
                    byte_length,
                    inline_data,
                    file_name,
                    created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    session_id.0,
                    payload.payload_ref,
                    payload.content_hash,
                    usize_to_sql(payload.bytes.len())?,
                    inline_data,
                    payload.file_name,
                    now_iso8601(),
                ],
            )
            .map_err(|error| transcript_sql("persist transcript payload", error))?;
    }
    Ok(obsolete_file_names.into_iter().collect())
}

fn block_ids_for_entries(
    transaction: &Transaction<'_>,
    session_id: &SessionId,
    entry_ids: &[String],
) -> AiResult<Vec<String>> {
    let mut block_ids = BTreeSet::new();
    for entry_id in entry_ids {
        let block_id = transaction
            .query_row(
                "SELECT block_id
                 FROM transcript_entries
                 WHERE session_id = ?1 AND entry_id = ?2",
                params![session_id.0, entry_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| transcript_sql("load transcript entry block", error))?
            .flatten()
            .ok_or_else(|| {
                AiError::Internal("Transcript turn entry has no block assignment".to_string())
            })?;
        block_ids.insert(block_id);
    }
    Ok(block_ids.into_iter().collect())
}

fn validate_block_payload_references(
    transaction: &Transaction<'_>,
    session_id: &SessionId,
    block_ids: &[String],
) -> AiResult<()> {
    for block_id in block_ids {
        let missing_ref = transaction
            .query_row(
                "SELECT entries.payload_ref
                 FROM transcript_entries AS entries
                 LEFT JOIN transcript_payloads AS payloads
                    ON payloads.session_id = entries.session_id
                    AND payloads.payload_ref = entries.payload_ref
                 WHERE entries.session_id = ?1
                    AND entries.block_id = ?2
                    AND entries.payload_ref IS NOT NULL
                    AND payloads.payload_ref IS NULL
                 LIMIT 1",
                params![session_id.0, block_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| transcript_sql("validate transcript payload references", error))?;
        if missing_ref.is_some() {
            return Err(AiError::InvalidInput(
                "Transcript turn references a payload that was not persisted".to_string(),
            ));
        }
    }
    Ok(())
}

fn seal_blocks(
    transaction: &Transaction<'_>,
    session_id: &SessionId,
    turn_id: &str,
    block_ids: &[String],
) -> AiResult<()> {
    for block_id in block_ids {
        let state = transaction
            .query_row(
                "SELECT is_sealed, turn_id
                 FROM transcript_blocks
                 WHERE session_id = ?1 AND block_id = ?2",
                params![session_id.0, block_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .map_err(|error| transcript_sql("load transcript block seal state", error))?;
        if state.0 == 1 {
            if state.1.as_deref() != Some(turn_id) {
                return Err(AiError::InvalidInput(
                    "Transcript block is already sealed by another turn".to_string(),
                ));
            }
            continue;
        }
        transaction
            .execute(
                "UPDATE transcript_blocks
                 SET
                    is_sealed = 1,
                    turn_id = ?3,
                    sealed_at = ?4,
                    revision = revision + 1
                 WHERE session_id = ?1 AND block_id = ?2",
                params![session_id.0, block_id, turn_id, now_iso8601()],
            )
            .map_err(|error| transcript_sql("seal transcript block", error))?;
    }
    Ok(())
}

fn load_all_block_metadata(
    connection: &Connection,
    session_id: &SessionId,
) -> AiResult<Vec<NativeAiTranscriptBlockMetadata>> {
    let mut statement = connection
        .prepare(
            "SELECT
                block_id,
                start_sequence,
                end_sequence,
                entry_count,
                estimated_row_count,
                estimated_height,
                first_created_at,
                last_created_at,
                revision
             FROM transcript_blocks
             WHERE session_id = ?1 AND is_sealed = 1
             ORDER BY ordinal ASC",
        )
        .map_err(|error| transcript_sql("prepare transcript block metadata query", error))?;
    let rows = statement
        .query_map(params![session_id.0], stored_block_metadata_from_row)
        .map_err(|error| transcript_sql("query transcript block metadata", error))?;
    rows.map(|row| {
        row.map_err(|error| transcript_sql("read transcript block metadata", error))?
            .into_metadata(session_id)
    })
    .collect()
}

fn load_transcript_revision(connection: &Connection, session_id: &SessionId) -> AiResult<u64> {
    let revision = connection
        .query_row(
            "SELECT COALESCE(SUM(revision), 0)
             FROM transcript_blocks
             WHERE session_id = ?1",
            params![session_id.0],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| transcript_sql("load transcript revision", error))?;
    sql_to_u64(revision, "revision")
}

fn load_block_metadata(
    connection: &Connection,
    session_id: &SessionId,
    block_id: &str,
) -> AiResult<Option<NativeAiTranscriptBlockMetadata>> {
    connection
        .query_row(
            "SELECT
                block_id,
                start_sequence,
                end_sequence,
                entry_count,
                estimated_row_count,
                estimated_height,
                first_created_at,
                last_created_at,
                revision
             FROM transcript_blocks
             WHERE session_id = ?1 AND block_id = ?2",
            params![session_id.0, block_id],
            stored_block_metadata_from_row,
        )
        .optional()
        .map_err(|error| transcript_sql("load transcript block metadata", error))?
        .map(|metadata| metadata.into_metadata(session_id))
        .transpose()
}

fn load_block_metadata_by_ids(
    connection: &Connection,
    session_id: &SessionId,
    block_ids: &[String],
) -> AiResult<Vec<NativeAiTranscriptBlockMetadata>> {
    let mut metadata = block_ids
        .iter()
        .map(|block_id| {
            load_block_metadata(connection, session_id, block_id)?.ok_or_else(|| {
                AiError::Internal("Sealed transcript block metadata was not found".to_string())
            })
        })
        .collect::<AiResult<Vec<_>>>()?;
    metadata.sort_by_key(|block| block.start_sequence);
    Ok(metadata)
}

fn stored_block_metadata_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredBlockMetadata> {
    Ok(StoredBlockMetadata {
        block_id: row.get(0)?,
        start_sequence: row.get(1)?,
        end_sequence: row.get(2)?,
        entry_count: row.get(3)?,
        estimated_row_count: row.get(4)?,
        estimated_height: row.get(5)?,
        first_created_at: row.get(6)?,
        last_created_at: row.get(7)?,
        revision: row.get(8)?,
    })
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
    block_id: String,
    start_sequence: i64,
    end_sequence: i64,
    entry_count: i64,
    estimated_row_count: i64,
    estimated_height: i64,
    first_created_at: String,
    last_created_at: String,
    revision: i64,
}

impl StoredBlockMetadata {
    fn into_metadata(self, session_id: &SessionId) -> AiResult<NativeAiTranscriptBlockMetadata> {
        let entry_count = usize::try_from(self.entry_count)
            .map_err(|_| AiError::Internal("Transcript block has an invalid size".to_string()))?;
        Ok(NativeAiTranscriptBlockMetadata {
            block_id: self.block_id,
            session_id: session_id.clone(),
            start_sequence: u64::try_from(self.start_sequence).map_err(|_| {
                AiError::Internal("Transcript block has an invalid start sequence".to_string())
            })?,
            end_sequence: u64::try_from(self.end_sequence).map_err(|_| {
                AiError::Internal("Transcript block has an invalid end sequence".to_string())
            })?,
            entry_count,
            estimated_row_count: usize::try_from(self.estimated_row_count).map_err(|_| {
                AiError::Internal("Transcript block has an invalid estimated row count".to_string())
            })?,
            estimated_height: u64::try_from(self.estimated_height).map_err(|_| {
                AiError::Internal("Transcript block has an invalid estimated height".to_string())
            })?,
            first_created_at: self.first_created_at,
            last_created_at: self.last_created_at,
            revision: u64::try_from(self.revision).map_err(|_| {
                AiError::Internal("Transcript block has an invalid revision".to_string())
            })?,
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

fn validate_payload_writes(payloads: &[AiTranscriptPayloadWrite]) -> AiResult<()> {
    let mut refs = BTreeSet::new();
    for payload in payloads {
        validate_payload_ref(&payload.payload_ref)?;
        if !refs.insert(payload.payload_ref.as_str()) {
            return Err(AiError::InvalidInput(
                "Transcript payload reference is duplicated in the turn".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_payload_ref(payload_ref: &str) -> AiResult<()> {
    if payload_ref.trim().is_empty()
        || payload_ref.len() > TRANSCRIPT_PAYLOAD_REF_MAX_BYTES
        || payload_ref.contains('\0')
    {
        return Err(AiError::InvalidInput(
            "Transcript payload reference is invalid".to_string(),
        ));
    }
    Ok(())
}

fn validate_payload_bytes(
    content_hash: &str,
    expected_length: usize,
    bytes: &[u8],
) -> AiResult<()> {
    if bytes.len() != expected_length || sha256_hex(bytes) != content_hash {
        return Err(AiError::Internal(
            "Transcript payload content failed integrity validation".to_string(),
        ));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn atomic_write_payload(path: &Path, bytes: &[u8]) -> AiResult<bool> {
    let parent = path
        .parent()
        .ok_or_else(|| AiError::Internal("Transcript payload path has no parent".to_string()))?;
    fs::create_dir_all(parent)
        .map_err(|error| payload_io("create transcript payload directory", parent, error))?;
    let temp_path = parent.join(format!(".payload-{}.tmp", Uuid::new_v4()));
    let write_result = (|| {
        let mut file = File::create(&temp_path).map_err(|error| {
            payload_io("create transcript payload temp file", &temp_path, error)
        })?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| payload_io("write transcript payload temp file", &temp_path, error))?;
        Ok::<(), AiError>(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    match fs::rename(&temp_path, path) {
        Ok(()) => Ok(true),
        Err(_) if path.exists() => {
            let _ = fs::remove_file(&temp_path);
            Ok(false)
        }
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            Err(payload_io("install transcript payload file", path, error))
        }
    }
}

fn usize_to_sql(value: usize) -> AiResult<i64> {
    i64::try_from(value)
        .map_err(|_| AiError::InvalidInput("Transcript query limit is too large".to_string()))
}

fn u64_to_sql(value: u64, label: &str) -> AiResult<i64> {
    i64::try_from(value)
        .map_err(|_| AiError::InvalidInput(format!("Transcript {label} is too large")))
}

fn sql_to_u64(value: i64, label: &str) -> AiResult<u64> {
    u64::try_from(value).map_err(|_| AiError::Internal(format!("Transcript {label} is invalid")))
}

fn sql_to_usize(value: i64, label: &str) -> AiResult<usize> {
    usize::try_from(value).map_err(|_| AiError::Internal(format!("Transcript {label} is invalid")))
}

fn transcript_sql(action: &str, error: rusqlite::Error) -> AiError {
    AiError::Storage(format!("{action} failed: {error}"))
}

fn transcript_json(action: &str, error: serde_json::Error) -> AiError {
    AiError::Storage(format!("{action} failed: {error}"))
}

fn payload_io(action: &str, path: &Path, error: std::io::Error) -> AiError {
    AiError::Storage(format!("{action} failed for {}: {error}", path.display()))
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
                tool_activity_detail_id: None,
                tool_change_stats: None,
                tool_kind: None,
            },
            payload_ref: None,
        }
    }

    #[test]
    fn newer_schema_is_rejected_without_touching_provisional_entries() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = SessionId("future-schema".to_string());
        let store = TranscriptStore::new(temp.path());
        let legacy_bytes = serde_json::to_vec(&vec![entry(&session_id, "entry-1")]).unwrap();
        fs::write(&store.legacy_entries_path, &legacy_bytes).unwrap();
        let connection = Connection::open(&store.database_path).unwrap();
        connection
            .pragma_update(
                None,
                "user_version",
                i64::from(TRANSCRIPT_SCHEMA_VERSION) + 1,
            )
            .unwrap();
        drop(connection);

        let error = store.load_block_metadata(&session_id).unwrap_err();

        assert!(error.to_string().contains("newer than supported"));
        assert_eq!(fs::read(&store.legacy_entries_path).unwrap(), legacy_bytes);
    }

    #[test]
    fn repository_rejects_foreign_entries() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = SessionId("owned-session".to_string());
        let foreign_session_id = SessionId("foreign-session".to_string());
        let store = TranscriptStore::new(temp.path());

        let ownership_error = store
            .append(&session_id, vec![entry(&foreign_session_id, "entry-1")])
            .unwrap_err();
        assert!(ownership_error.to_string().contains("different session"));
        assert!(!store.database_path.exists());
    }

    #[test]
    fn block_metadata_query_uses_only_the_persisted_block_index() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = SessionId("block-query-plan".to_string());
        let store = TranscriptStore::new(temp.path());
        store
            .append(&session_id, vec![entry(&session_id, "entry-1")])
            .unwrap();
        let connection = store.open(&session_id, false).unwrap();
        let plan = connection
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT block_id, start_sequence, end_sequence
                 FROM transcript_blocks
                 WHERE session_id = ?1
                 ORDER BY ordinal ASC",
            )
            .unwrap()
            .query_map(params![session_id.0], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .join("\n");

        assert!(
            plan.contains("transcript_blocks_session_ordinal_idx"),
            "unexpected query plan: {plan}"
        );
        assert!(!plan.contains("transcript_entries"));
    }

    #[test]
    fn checkpoint_updates_only_changed_open_tail_rows() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = SessionId("incremental-open-tail".to_string());
        let store = TranscriptStore::new(temp.path());
        let first = entry(&session_id, "entry-1");
        let second = entry(&session_id, "entry-2");
        store
            .checkpoint_open_tail(NativeAiCheckpointOpenTranscriptTailInput {
                session_id: session_id.clone(),
                turn_id: "turn-1".to_string(),
                terminal_status: None,
                entries: vec![first.clone(), second.clone()],
                payloads: Vec::new(),
                removed_entry_ids: Vec::new(),
                entry_order: vec![
                    NativeAiOpenTranscriptEntryRef {
                        entry_id: first.id.clone(),
                        entry_revision: 1,
                        ordinal: 0,
                    },
                    NativeAiOpenTranscriptEntryRef {
                        entry_id: second.id.clone(),
                        entry_revision: 1,
                        ordinal: 1,
                    },
                ],
            })
            .unwrap();

        let connection = store.open(&session_id, false).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_existing_open_tail_delete
                 BEFORE DELETE ON transcript_open_tail_entries
                 WHEN OLD.entry_id = 'entry-1'
                 BEGIN SELECT RAISE(ABORT, 'existing entry deleted'); END;
                 CREATE TRIGGER reject_existing_open_tail_update
                 BEFORE UPDATE ON transcript_open_tail_entries
                 WHEN OLD.entry_id = 'entry-1'
                 BEGIN SELECT RAISE(ABORT, 'existing entry updated'); END;",
            )
            .unwrap();
        drop(connection);

        let third = entry(&session_id, "entry-3");
        store
            .checkpoint_open_tail(NativeAiCheckpointOpenTranscriptTailInput {
                session_id: session_id.clone(),
                turn_id: "turn-1".to_string(),
                terminal_status: None,
                entries: vec![third.clone()],
                payloads: Vec::new(),
                removed_entry_ids: Vec::new(),
                entry_order: vec![NativeAiOpenTranscriptEntryRef {
                    entry_id: third.id.clone(),
                    entry_revision: 1,
                    ordinal: 2,
                }],
            })
            .unwrap();

        let tail = store.load_open_tail(&session_id).unwrap().unwrap();
        assert_eq!(
            tail.entries
                .iter()
                .map(|entry| &entry.id)
                .collect::<Vec<_>>(),
            vec![&first.id, &second.id, &third.id],
        );
    }

    #[test]
    fn checkpoint_persists_terminal_status_without_entry_updates() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = SessionId("terminal-open-tail".to_string());
        let store = TranscriptStore::new(temp.path());
        let first = entry(&session_id, "entry-1");

        store
            .checkpoint_open_tail(NativeAiCheckpointOpenTranscriptTailInput {
                session_id: session_id.clone(),
                turn_id: "turn-1".to_string(),
                terminal_status: None,
                entries: vec![first.clone()],
                payloads: Vec::new(),
                removed_entry_ids: Vec::new(),
                entry_order: vec![NativeAiOpenTranscriptEntryRef {
                    entry_id: first.id.clone(),
                    entry_revision: 1,
                    ordinal: 0,
                }],
            })
            .unwrap();

        store
            .checkpoint_open_tail(NativeAiCheckpointOpenTranscriptTailInput {
                session_id: session_id.clone(),
                turn_id: "turn-1".to_string(),
                terminal_status: Some(NativeAiTranscriptTerminalStatus::Completed),
                entries: Vec::new(),
                payloads: Vec::new(),
                removed_entry_ids: Vec::new(),
                entry_order: Vec::new(),
            })
            .unwrap();

        let tail = store.load_open_tail(&session_id).unwrap().unwrap();
        assert_eq!(
            tail.terminal_status,
            Some(NativeAiTranscriptTerminalStatus::Completed)
        );
        assert_eq!(
            tail.entries
                .iter()
                .map(|entry| &entry.id)
                .collect::<Vec<_>>(),
            vec![&first.id]
        );
    }

    #[test]
    fn terminal_open_tail_with_a_foreign_sealed_block_reproduces_seal_failure() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = SessionId("foreign-sealed-tail".to_string());
        let store = TranscriptStore::new(temp.path());
        let first = entry(&session_id, "entry-in-sealed-block");
        let second = entry(&session_id, "entry-in-open-block");

        store.append(&session_id, vec![first.clone()]).unwrap();
        store
            .seal_turn(&session_id, "turn-a", vec![first.clone()], Vec::new())
            .unwrap();

        // The recovered terminal tail deliberately retains a reference owned by turn-a.
        store
            .checkpoint_open_tail(NativeAiCheckpointOpenTranscriptTailInput {
                session_id: session_id.clone(),
                turn_id: "turn-b".to_string(),
                terminal_status: Some(NativeAiTranscriptTerminalStatus::Completed),
                entries: vec![first.clone(), second.clone()],
                payloads: Vec::new(),
                removed_entry_ids: Vec::new(),
                entry_order: vec![
                    NativeAiOpenTranscriptEntryRef {
                        entry_id: first.id.clone(),
                        entry_revision: 1,
                        ordinal: 0,
                    },
                    NativeAiOpenTranscriptEntryRef {
                        entry_id: second.id.clone(),
                        entry_revision: 1,
                        ordinal: 1,
                    },
                ],
            })
            .unwrap();

        let error = store
            .seal_turn(
                &session_id,
                "turn-b",
                vec![first.clone(), second.clone()],
                Vec::new(),
            )
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("Transcript block is already sealed by another turn")
        );
        let tail = store.load_open_tail(&session_id).unwrap().unwrap();
        assert_eq!(tail.turn_id, "turn-b");
        assert_eq!(
            tail.terminal_status,
            Some(NativeAiTranscriptTerminalStatus::Completed)
        );
        assert_eq!(
            tail.entries
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec![first.id.as_str(), second.id.as_str()]
        );
        assert_eq!(store.load_block_metadata(&session_id).unwrap().len(), 1);

        let connection = store.open(&session_id, false).unwrap();
        let (sealed, open): (i64, i64) = connection
            .query_row(
                "SELECT
                    SUM(CASE WHEN is_sealed = 1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN is_sealed = 0 THEN 1 ELSE 0 END)
                 FROM transcript_blocks
                 WHERE session_id = ?1",
                params![session_id.0],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((sealed, open), (1, 1));
    }

    #[test]
    fn checkpoint_reorders_only_the_changed_open_tail_rows() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = SessionId("reordered-open-tail".to_string());
        let store = TranscriptStore::new(temp.path());
        let first = entry(&session_id, "entry-1");
        let second = entry(&session_id, "entry-2");
        store
            .checkpoint_open_tail(NativeAiCheckpointOpenTranscriptTailInput {
                session_id: session_id.clone(),
                turn_id: "turn-1".to_string(),
                terminal_status: None,
                entries: vec![first.clone(), second.clone()],
                payloads: Vec::new(),
                removed_entry_ids: Vec::new(),
                entry_order: vec![
                    NativeAiOpenTranscriptEntryRef {
                        entry_id: first.id.clone(),
                        entry_revision: 1,
                        ordinal: 0,
                    },
                    NativeAiOpenTranscriptEntryRef {
                        entry_id: second.id.clone(),
                        entry_revision: 1,
                        ordinal: 1,
                    },
                ],
            })
            .unwrap();

        store
            .checkpoint_open_tail(NativeAiCheckpointOpenTranscriptTailInput {
                session_id: session_id.clone(),
                turn_id: "turn-1".to_string(),
                terminal_status: None,
                entries: Vec::new(),
                payloads: Vec::new(),
                removed_entry_ids: Vec::new(),
                entry_order: vec![
                    NativeAiOpenTranscriptEntryRef {
                        entry_id: second.id.clone(),
                        entry_revision: 2,
                        ordinal: 0,
                    },
                    NativeAiOpenTranscriptEntryRef {
                        entry_id: first.id.clone(),
                        entry_revision: 2,
                        ordinal: 1,
                    },
                ],
            })
            .unwrap();

        let tail = store.load_open_tail(&session_id).unwrap().unwrap();
        assert_eq!(
            tail.entries
                .iter()
                .map(|entry| &entry.id)
                .collect::<Vec<_>>(),
            vec![&second.id, &first.id],
        );
    }

    #[test]
    fn version_one_entries_are_migrated_to_persisted_blocks() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = SessionId("schema-v1".to_string());
        let store = TranscriptStore::new(temp.path());
        let connection = Connection::open(&store.database_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE transcript_sessions (
                    session_id TEXT PRIMARY KEY NOT NULL,
                    next_sequence INTEGER NOT NULL,
                    legacy_entries_imported INTEGER NOT NULL
                 );
                 CREATE TABLE transcript_entries (
                    session_id TEXT NOT NULL,
                    entry_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    summary_json TEXT NOT NULL,
                    payload_ref TEXT,
                    PRIMARY KEY (session_id, entry_id),
                    UNIQUE (session_id, sequence)
                 );
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO transcript_sessions VALUES (?1, 2, 1)",
                params![session_id.0],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO transcript_entries VALUES (
                    ?1, 'entry-1', 1, '\"message\"',
                    '2026-07-18T00:00:00.000Z',
                    '2026-07-18T00:00:00.000Z',
                    '{\"label\":null,\"preview\":\"fixture\",\"status\":\"completed\"}',
                    NULL
                 )",
                params![session_id.0],
            )
            .unwrap();
        drop(connection);

        let metadata = store.load_block_metadata(&session_id).unwrap();
        let connection = store.open(&session_id, false).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();

        assert_eq!(version, i64::from(TRANSCRIPT_SCHEMA_VERSION));
        assert_eq!(metadata.len(), 1);
        assert_eq!(metadata[0].block_id, format!("{}:0", session_id.0));
        assert_eq!(metadata[0].entry_count, 1);
    }
}
