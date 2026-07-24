use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use comando_types::ai::{
    AI_TRANSCRIPT_BLOCK_CAPABILITY_VERSION, AI_TRANSCRIPT_PAYLOAD_BATCH_MAX_REFS,
    NativeAiCheckpointOpenTranscriptTailInput, NativeAiHistorySessionSummary,
    NativeAiHistoryStorageHealth, NativeAiListSessionHistoryInput,
    NativeAiLoadSessionTranscriptPageInput, NativeAiOpenTranscriptTail,
    NativeAiRuntimeSessionMapping, NativeAiSessionSnapshot, NativeAiSessionStatus,
    NativeAiSessionTranscriptPage, NativeAiTranscriptBlock, NativeAiTranscriptBlockMetadata,
    NativeAiTranscriptBlockMetadataOutput, NativeAiTranscriptEntryEnvelope,
    NativeAiTranscriptEntryKind, NativeAiTranscriptEntrySummary, NativeAiTranscriptPayload,
    NativeAiTranscriptPayloadsOutput, NativeAiTranscriptStorageMode,
    NativeAiTranscriptStorageState,
};
use comando_types::ids::{ProjectId, RuntimeId, RuntimeSessionId, SessionId, WorktreeId};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AiError, AiResult};
use crate::events::now_iso8601;
pub use crate::transcript_store::{AiTranscriptPayload, AiTranscriptPayloadWrite};
use crate::transcript_store::{TRANSCRIPT_SCHEMA_VERSION, TranscriptStore};

pub const HISTORY_FORMAT_VERSION: u32 = 1;
const AI_DIR: &str = "ai";
const SESSIONS_DIR: &str = "sessions";
const SESSION_META_FILE: &str = "session-meta.json";
const SESSION_STATE_FILE: &str = "session-state.json";
const SESSION_TRANSCRIPT_FILE: &str = "transcript.jsonl";
const SESSION_INDEX_FILE: &str = "index.json";
const SESSION_COMPACT_STATE_FILE: &str = "compact-state.json";
const SESSION_TRANSCRIPT_WRITE_STATE_FILE: &str = "transcript-write-state.json";
const SESSION_TOOL_DETAILS_FILE: &str = "tool-details.json";
const SESSION_TOOL_DETAILS_DIR: &str = "tool-details";
const DEFAULT_PAGE_LIMIT: usize = 50;
const MAX_PAGE_LIMIT: usize = 200;
const LEGACY_TRANSCRIPT_BACKFILL_PAGE_SIZE: usize = 256;
const SESSION_PREVIEW_MAX_BYTES: usize = 280;
const SESSION_PREVIEW_SUFFIX: &str = "...";
const MB: u64 = 1024 * 1024;
const CODEX_ITEM_STATUS_PREFIX: &str = "codex-acp:status:item:";
const CODEX_SUBAGENT_PREFIX: &str = "codex-acp:subagent:";
const CODEX_IMAGE_PREFIX: &str = "codex-acp:image:";

#[derive(Debug, Clone)]
pub struct AiHistoryStore {
    app_data_dir: PathBuf,
    compaction_policy: HistoryCompactionPolicy,
    legacy_transcript_backfill_indexes: Arc<Mutex<HashMap<String, AiTranscriptIndex>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryCompactionPolicy {
    pub min_obsolete_bytes: u64,
    pub max_physical_to_indexed_ratio: u64,
    pub force_physical_bytes: u64,
}

impl Default for HistoryCompactionPolicy {
    fn default() -> Self {
        Self {
            min_obsolete_bytes: 4 * MB,
            max_physical_to_indexed_ratio: 2,
            force_physical_bytes: 64 * MB,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiHistorySessionMetadata {
    pub version: u32,
    pub session_id: SessionId,
    pub runtime_id: RuntimeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_session_id: Option<RuntimeSessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<WorktreeId>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    pub status: NativeAiSessionStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<String>,
    pub message_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub config_options: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_commands: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_roots: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub owner_kind: AiHistoryOwnerKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<AiHistorySubagentMetadata>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runtime_mappings: Vec<AiHistoryRuntimeMapping>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub config_values: BTreeMap<String, Value>,
}

impl AiHistorySessionMetadata {
    pub fn new_native(input: AiHistorySessionMetadataInput) -> Self {
        let now = now_iso8601();
        Self {
            version: HISTORY_FORMAT_VERSION,
            session_id: input.session_id,
            runtime_id: input.runtime_id,
            runtime_session_id: input.runtime_session_id,
            parent_session_id: input.parent_session_id,
            project_id: input.project_id,
            worktree_id: input.worktree_id,
            title: normalize_title(input.title),
            custom_title: None,
            preview: None,
            status: input.status,
            created_at: now.clone(),
            updated_at: now,
            closed_at: None,
            pinned_at: None,
            message_count: 0,
            model_id: input.model_id,
            mode_id: input.mode_id,
            reasoning_effort: input.reasoning_effort,
            models: Vec::new(),
            modes: Vec::new(),
            config_options: Vec::new(),
            available_commands: Vec::new(),
            additional_roots: input.additional_roots,
            cwd: Some(input.cwd),
            owner_kind: AiHistoryOwnerKind::Native,
            subagent: None,
            runtime_mappings: Vec::new(),
            config_values: input.config_values,
        }
    }

    pub fn runtime_title(&self) -> &str {
        self.subagent
            .as_ref()
            .and_then(|subagent| subagent.nickname.as_deref())
            .unwrap_or(&self.title)
    }

    pub fn display_title(&self) -> &str {
        self.custom_title
            .as_deref()
            .unwrap_or_else(|| self.runtime_title())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiHistorySessionMetadataInput {
    pub session_id: SessionId,
    pub runtime_id: RuntimeId,
    pub runtime_session_id: Option<RuntimeSessionId>,
    pub parent_session_id: Option<SessionId>,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub title: String,
    pub status: NativeAiSessionStatus,
    pub model_id: Option<String>,
    pub mode_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub config_values: BTreeMap<String, Value>,
    pub cwd: String,
    pub additional_roots: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiHistoryOwnerKind {
    Native,
    MigratedLegacy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiHistorySubagentMetadata {
    pub parent_session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_runtime_session_id: Option<RuntimeSessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiHistoryRuntimeMapping {
    pub app_session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_app_session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_runtime_session_id: Option<RuntimeSessionId>,
    pub runtime_session_id: RuntimeSessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiTranscriptIndex {
    pub version: u32,
    pub message_offsets: Vec<u64>,
    pub message_lengths: Vec<u64>,
    pub message_hashes: Vec<String>,
    pub message_ids: Vec<String>,
    pub message_kinds: Vec<String>,
    pub message_roles: Vec<Option<String>>,
    pub updated_at: String,
    pub indexed_transcript_bytes: u64,
}

impl AiTranscriptIndex {
    fn empty() -> Self {
        Self {
            version: HISTORY_FORMAT_VERSION,
            message_offsets: Vec::new(),
            message_lengths: Vec::new(),
            message_hashes: Vec::new(),
            message_ids: Vec::new(),
            message_kinds: Vec::new(),
            message_roles: Vec::new(),
            updated_at: now_iso8601(),
            indexed_transcript_bytes: 0,
        }
    }

    fn len(&self) -> usize {
        self.message_offsets.len()
    }

    fn validate(&self, transcript_len: u64) -> AiResult<()> {
        let len = self.message_offsets.len();
        let same_len = self.message_lengths.len() == len
            && self.message_hashes.len() == len
            && self.message_ids.len() == len
            && self.message_kinds.len() == len
            && self.message_roles.len() == len;
        if !same_len {
            return Err(history_error(
                "AI transcript index has inconsistent vector lengths.",
            ));
        }

        for (offset, length) in self.message_offsets.iter().zip(&self.message_lengths) {
            if *length == 0 || offset.saturating_add(*length) > transcript_len {
                return Err(history_error(
                    "AI transcript index points outside transcript.",
                ));
            }
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiTranscriptRecord {
    pub version: u32,
    pub message_id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub hash: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiHistorySessionState {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_turn_started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_permission: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_user_input: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_activity: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tracked_files: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AiToolActivityDetailStore {
    version: u32,
    #[serde(default)]
    details: BTreeMap<String, AiToolActivityDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AiToolActivityDetail {
    hash: String,
    payload: Value,
}

impl Default for AiHistorySessionState {
    fn default() -> Self {
        Self {
            version: HISTORY_FORMAT_VERSION,
            active_turn_started_at: None,
            last_error: None,
            pending_permission: None,
            pending_user_input: None,
            plan: None,
            token_usage: None,
            tool_activity: Vec::new(),
            tracked_files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct HistoryCompactionState {
    version: u32,
    started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TranscriptWriteState {
    version: u32,
    next_index: AiTranscriptIndex,
    first_changed_offset: usize,
    stale_legacy_entry_ids: Vec<String>,
    #[serde(default)]
    session_metadata: Option<TranscriptWriteSessionMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TranscriptWriteSessionMetadata {
    message_count: usize,
    preview: Option<String>,
    updated_at: String,
}

impl AiHistoryStore {
    pub fn new(app_data_dir: impl Into<PathBuf>) -> AiResult<Self> {
        let app_data_dir = app_data_dir.into();
        if app_data_dir.as_os_str().is_empty() {
            return Err(AiError::InvalidInput(
                "Native AI history requires an app data directory.".to_string(),
            ));
        }

        Ok(Self {
            app_data_dir,
            compaction_policy: HistoryCompactionPolicy::default(),
            legacy_transcript_backfill_indexes: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn with_compaction_policy(mut self, policy: HistoryCompactionPolicy) -> Self {
        self.compaction_policy = policy;
        self
    }

    pub fn storage_key(session_id: &str) -> String {
        format!("session-{}", sha256_hex(session_id.as_bytes()))
    }

    pub fn history_root(&self) -> PathBuf {
        self.app_data_dir.join(AI_DIR)
    }

    pub fn sessions_dir(&self) -> PathBuf {
        self.history_root().join(SESSIONS_DIR)
    }

    pub fn session_dir(&self, session_id: &SessionId) -> PathBuf {
        self.sessions_dir().join(Self::storage_key(&session_id.0))
    }

    pub fn create_session(&self, metadata: AiHistorySessionMetadata) -> AiResult<()> {
        self.ensure_session_dir(&metadata.session_id)?;
        self.save_metadata(&metadata)?;
        if !self.session_state_path(&metadata.session_id).exists() {
            self.save_session_state(&metadata.session_id, &AiHistorySessionState::default())?;
        }
        if !self.index_path(&metadata.session_id).exists() {
            self.save_index(&metadata.session_id, &AiTranscriptIndex::empty())?;
        }
        if !self.transcript_path(&metadata.session_id).exists() {
            self.create_empty_transcript(&metadata.session_id)?;
        }
        Ok(())
    }

    pub fn has_session(&self, session_id: &SessionId) -> bool {
        self.metadata_path(session_id).exists()
    }

    pub fn load_metadata(&self, session_id: &SessionId) -> AiResult<AiHistorySessionMetadata> {
        self.recover_if_needed(session_id)?;
        read_json_file(&self.metadata_path(session_id))
    }

    pub fn save_metadata(&self, metadata: &AiHistorySessionMetadata) -> AiResult<()> {
        self.ensure_session_dir(&metadata.session_id)?;
        atomic_write_json(&self.metadata_path(&metadata.session_id), metadata)
    }

    pub fn load_session_state(&self, session_id: &SessionId) -> AiResult<AiHistorySessionState> {
        self.recover_if_needed(session_id)?;
        let path = self.session_state_path(session_id);
        if !path.exists() {
            return Ok(AiHistorySessionState::default());
        }
        let mut state: AiHistorySessionState = read_json_file(&path)?;
        if normalize_legacy_codex_tool_activities(&mut state.tool_activity) {
            self.save_session_state(session_id, &state)?;
        }
        Ok(state)
    }

    pub fn save_session_state(
        &self,
        session_id: &SessionId,
        state: &AiHistorySessionState,
    ) -> AiResult<()> {
        self.ensure_session_dir(session_id)?;
        atomic_write_json(&self.session_state_path(session_id), state)
    }

    pub fn update_session_state(
        &self,
        session_id: &SessionId,
        update: impl FnOnce(&mut AiHistorySessionState),
    ) -> AiResult<()> {
        if !self.has_session(session_id) {
            return Ok(());
        }
        let mut state = self.load_session_state(session_id)?;
        update(&mut state);
        state.version = HISTORY_FORMAT_VERSION;
        self.save_session_state(session_id, &state)
    }

    pub fn store_tool_activity_detail(
        &self,
        session_id: &SessionId,
        detail_id: &str,
        payload: Value,
    ) -> AiResult<()> {
        if !self.has_session(session_id) {
            return Ok(());
        }
        let path = self.tool_activity_detail_path(session_id, detail_id);
        let existing = if path.exists() {
            Some(read_json_file::<AiToolActivityDetail>(&path)?)
        } else {
            self.load_legacy_tool_activity_detail_entry(session_id, detail_id)?
        };
        let payload = existing
            .as_ref()
            .map(|detail| merge_tool_activity_detail(&detail.payload, payload.clone()))
            .unwrap_or(payload);
        let hash = hash_message_payload(&payload)?;
        if existing.as_ref().is_some_and(|detail| detail.hash == hash) {
            return Ok(());
        }
        fs::create_dir_all(self.tool_details_dir(session_id)).map_err(|error| {
            history_io(
                "create AI tool detail directory",
                &self.tool_details_dir(session_id),
                error,
            )
        })?;
        atomic_write_json(&path, &AiToolActivityDetail { hash, payload })
    }

    pub fn load_tool_activity_detail(
        &self,
        session_id: &SessionId,
        detail_id: &str,
    ) -> AiResult<Option<Value>> {
        self.recover_if_needed(session_id)?;
        let path = self.tool_activity_detail_path(session_id, detail_id);
        if path.exists() {
            let detail: AiToolActivityDetail = read_json_file(&path)?;
            return Ok(Some(detail.payload));
        }
        if let Some(detail) = self.load_legacy_tool_activity_detail_entry(session_id, detail_id)? {
            return Ok(Some(detail.payload));
        }
        self.load_legacy_tool_activity_detail(session_id, detail_id)
    }
    pub fn save_transcript_window(
        &self,
        session_id: &SessionId,
        messages: Vec<Value>,
    ) -> AiResult<()> {
        self.recover_if_needed(session_id)?;
        let mut metadata = self.load_metadata(session_id)?;
        self.ensure_session_dir(session_id)?;
        let transcript_path = self.transcript_path(session_id);
        let mut index = self
            .load_index(session_id)
            .unwrap_or_else(|_| AiTranscriptIndex::empty());
        let transcript_len = file_len(&transcript_path).unwrap_or(0);
        if index.validate(transcript_len).is_err() {
            index = self.rebuild_index_from_transcript(session_id)?;
        }

        let records = messages
            .into_iter()
            .map(AiTranscriptRecord::from_payload)
            .collect::<AiResult<Vec<_>>>()?;
        let next_session_metadata = TranscriptWriteSessionMetadata {
            message_count: records.len(),
            preview: derive_session_preview(records.iter().map(|record| &record.payload)),
            updated_at: now_iso8601(),
        };
        let first_changed = records
            .iter()
            .enumerate()
            .find_map(|(index_pos, record)| {
                (index
                    .message_hashes
                    .get(index_pos)
                    .is_none_or(|hash| hash != &record.hash))
                .then_some(index_pos)
            })
            .unwrap_or(records.len());
        let reuse_len = first_changed.min(index.len()).min(records.len());

        let mut next_index = AiTranscriptIndex {
            version: HISTORY_FORMAT_VERSION,
            message_offsets: index.message_offsets[..reuse_len].to_vec(),
            message_lengths: index.message_lengths[..reuse_len].to_vec(),
            message_hashes: index.message_hashes[..reuse_len].to_vec(),
            message_ids: index.message_ids[..reuse_len].to_vec(),
            message_kinds: index.message_kinds[..reuse_len].to_vec(),
            message_roles: index.message_roles[..reuse_len].to_vec(),
            updated_at: now_iso8601(),
            indexed_transcript_bytes: index.message_lengths[..reuse_len].iter().sum(),
        };

        let transcript_changed = reuse_len < index.len() || reuse_len < records.len();
        let stale_legacy_entry_ids = index.message_ids[reuse_len..]
            .iter()
            .map(|message_id| format!("message:{message_id}"))
            .collect::<Vec<_>>();

        let mut append_offset = transcript_len;
        let mut lines_to_append = Vec::with_capacity(records.len().saturating_sub(reuse_len));
        for record in records.iter().skip(reuse_len) {
            let line = serialize_record_line(record)?;
            let length = line.len() as u64 + 1;
            next_index.message_offsets.push(append_offset);
            next_index.message_lengths.push(length);
            next_index.message_hashes.push(record.hash.clone());
            next_index.message_ids.push(record.message_id.clone());
            next_index.message_kinds.push(record.kind.clone());
            next_index.message_roles.push(record.role.clone());
            next_index.indexed_transcript_bytes += length;
            append_offset += length;
            lines_to_append.push(line);
        }

        if transcript_changed {
            // Persist the target index before touching JSONL so recovery can
            // never mistake an unindexed write for a current SQLite backfill.
            self.write_transcript_write_marker(
                session_id,
                &TranscriptWriteState {
                    version: HISTORY_FORMAT_VERSION,
                    next_index: next_index.clone(),
                    first_changed_offset: reuse_len,
                    stale_legacy_entry_ids: stale_legacy_entry_ids.clone(),
                    session_metadata: Some(next_session_metadata.clone()),
                },
            )?;
        }

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&transcript_path)
            .map_err(|error| history_io("open AI transcript", &transcript_path, error))?;
        for line in &lines_to_append {
            file.write_all(line.as_bytes())
                .and_then(|_| file.write_all(b"\n"))
                .map_err(|error| history_io("append AI transcript", &transcript_path, error))?;
        }
        file.sync_all()
            .map_err(|error| history_io("sync AI transcript", &transcript_path, error))?;

        metadata.message_count = next_session_metadata.message_count;
        metadata.preview = next_session_metadata.preview;
        metadata.updated_at = next_session_metadata.updated_at;
        if transcript_changed {
            self.transcript_store(session_id)
                .invalidate_legacy_transcript_backfill_from(
                    session_id,
                    reuse_len,
                    &stale_legacy_entry_ids,
                )?;
        }
        self.save_index(session_id, &next_index)?;
        self.save_metadata(&metadata)?;
        self.clear_transcript_write_marker(session_id)?;
        self.compact_transcript_if_needed(session_id)?;
        Ok(())
    }

    pub fn load_transcript_page(
        &self,
        input: NativeAiLoadSessionTranscriptPageInput,
    ) -> AiResult<Option<NativeAiSessionTranscriptPage>> {
        if !self.has_session(&input.session_id) {
            return Ok(None);
        }
        self.recover_if_needed(&input.session_id)?;
        let index = self.load_or_repair_index(&input.session_id)?;
        let offset = input.offset.min(index.len());
        let limit = normalize_page_limit(input.limit);
        let end = offset.saturating_add(limit).min(index.len());
        let messages = self.read_payloads_by_index(&input.session_id, &index, offset, end)?;

        Ok(Some(NativeAiSessionTranscriptPage {
            session_id: input.session_id,
            offset,
            total_messages: index.len(),
            messages,
        }))
    }

    pub fn append_transcript_entries(
        &self,
        session_id: &SessionId,
        entries: Vec<NativeAiTranscriptEntryEnvelope>,
    ) -> AiResult<()> {
        self.ensure_session_dir(session_id)?;
        self.transcript_store(session_id)
            .append(session_id, entries)
    }

    pub fn seal_transcript_turn(
        &self,
        session_id: &SessionId,
        turn_id: &str,
        entries: Vec<NativeAiTranscriptEntryEnvelope>,
        payloads: Vec<AiTranscriptPayloadWrite>,
    ) -> AiResult<Vec<NativeAiTranscriptBlockMetadata>> {
        self.ensure_session_dir(session_id)?;
        self.transcript_store(session_id)
            .seal_turn(session_id, turn_id, entries, payloads)
    }

    pub fn reconcile_terminal_open_transcript_tail(
        &self,
        session_id: &SessionId,
        turn_id: &str,
    ) -> AiResult<Vec<NativeAiTranscriptBlockMetadata>> {
        self.transcript_store(session_id)
            .reconcile_terminal_open_tail(session_id, turn_id)
    }

    pub fn checkpoint_open_transcript_tail(
        &self,
        input: NativeAiCheckpointOpenTranscriptTailInput,
    ) -> AiResult<()> {
        self.ensure_session_dir(&input.session_id)?;
        self.transcript_store(&input.session_id)
            .checkpoint_open_tail(input)
    }

    pub fn load_open_transcript_tail(
        &self,
        session_id: &SessionId,
    ) -> AiResult<Option<NativeAiOpenTranscriptTail>> {
        self.transcript_store(session_id).load_open_tail(session_id)
    }

    pub fn load_transcript_payload(
        &self,
        session_id: &SessionId,
        payload_ref: &str,
        max_bytes: usize,
    ) -> AiResult<AiTranscriptPayload> {
        self.transcript_store(session_id)
            .load_payload(session_id, payload_ref, max_bytes)
    }

    pub fn load_transcript_block_metadata(
        &self,
        session_id: &SessionId,
    ) -> AiResult<Vec<NativeAiTranscriptBlockMetadata>> {
        self.transcript_store(session_id)
            .load_block_metadata(session_id)
    }

    pub fn load_transcript_block_metadata_output(
        &self,
        session_id: &SessionId,
    ) -> AiResult<NativeAiTranscriptBlockMetadataOutput> {
        let transcript_store = self.transcript_store(session_id);
        Ok(NativeAiTranscriptBlockMetadataOutput {
            capability_version: AI_TRANSCRIPT_BLOCK_CAPABILITY_VERSION,
            session_id: session_id.clone(),
            transcript_revision: transcript_store.transcript_revision(session_id)?,
            blocks: transcript_store.load_block_metadata(session_id)?,
        })
    }

    pub fn load_transcript_block(
        &self,
        session_id: &SessionId,
        block_id: &str,
    ) -> AiResult<Option<NativeAiTranscriptBlock>> {
        if !block_id.starts_with(&format!("{}:", session_id.0)) {
            return Ok(None);
        }
        let transcript_store = self.transcript_store(session_id);
        let block = transcript_store.load_block(session_id, block_id)?;
        let Some((metadata, entries)) = block else {
            return Ok(None);
        };
        Ok(Some(NativeAiTranscriptBlock {
            capability_version: AI_TRANSCRIPT_BLOCK_CAPABILITY_VERSION,
            transcript_revision: transcript_store.transcript_revision(session_id)?,
            metadata,
            entries,
        }))
    }

    pub fn load_native_transcript_payload(
        &self,
        session_id: &SessionId,
        payload_ref: &str,
        max_bytes: usize,
    ) -> AiResult<NativeAiTranscriptPayload> {
        let payload = self.load_transcript_payload(session_id, payload_ref, max_bytes)?;
        let transcript_revision = self
            .transcript_store(session_id)
            .transcript_revision(session_id)?;
        Ok(NativeAiTranscriptPayload {
            capability_version: AI_TRANSCRIPT_BLOCK_CAPABILITY_VERSION,
            session_id: session_id.clone(),
            transcript_revision,
            payload_ref: payload.payload_ref,
            content_hash: payload.sha256,
            byte_length: payload.byte_length,
            value: payload.value,
        })
    }

    pub fn load_native_transcript_payloads(
        &self,
        session_id: &SessionId,
        payload_refs: &[String],
        max_bytes: usize,
    ) -> AiResult<NativeAiTranscriptPayloadsOutput> {
        if payload_refs.len() > AI_TRANSCRIPT_PAYLOAD_BATCH_MAX_REFS {
            return Err(AiError::TooLarge(format!(
                "a transcript payload batch may contain at most {AI_TRANSCRIPT_PAYLOAD_BATCH_MAX_REFS} refs"
            )));
        }
        let transcript_revision = self
            .transcript_store(session_id)
            .transcript_revision(session_id)?;
        let mut seen = HashSet::new();
        let payloads = payload_refs
            .iter()
            .filter(|payload_ref| seen.insert(payload_ref.as_str()))
            .map(|payload_ref| {
                let payload = self.load_transcript_payload(session_id, payload_ref, max_bytes)?;
                Ok(NativeAiTranscriptPayload {
                    capability_version: AI_TRANSCRIPT_BLOCK_CAPABILITY_VERSION,
                    session_id: session_id.clone(),
                    transcript_revision,
                    payload_ref: payload.payload_ref,
                    content_hash: payload.sha256,
                    byte_length: payload.byte_length,
                    value: payload.value,
                })
            })
            .collect::<AiResult<Vec<_>>>()?;
        Ok(NativeAiTranscriptPayloadsOutput {
            capability_version: AI_TRANSCRIPT_BLOCK_CAPABILITY_VERSION,
            session_id: session_id.clone(),
            payloads,
            transcript_revision,
        })
    }

    pub fn transcript_storage_state(
        &self,
        session_id: &SessionId,
    ) -> AiResult<NativeAiTranscriptStorageState> {
        let transcript_store = self.transcript_store(session_id);
        let migration_manifest_exists = self.history_root().join("migrations").exists();
        let legacy_fallback_available = self.transcript_path(session_id).exists();
        let uses_legacy_transcript_backfill =
            transcript_store.uses_legacy_transcript_backfill(session_id)?;
        let legacy_transcript_pending = uses_legacy_transcript_backfill
            && legacy_fallback_available
            && self.with_legacy_transcript_backfill_index(session_id, |index| {
                // Every session starts with an empty compatibility file; it
                // is not migration input until it contains a record. A
                // previously invalidated backfill still needs completion.
                if index.len() == 0 {
                    if transcript_store.has_data_source()
                        && !transcript_store.legacy_transcript_backfill_complete(session_id)?
                    {
                        transcript_store.advance_legacy_transcript_backfill(session_id, 0, true)?;
                    }
                    return Ok(false);
                }
                if transcript_store
                    .legacy_transcript_backfill_is_current(session_id, index.len())?
                {
                    return Ok(false);
                }
                self.backfill_legacy_transcript_page(session_id, index)?;
                // A single invocation can finish a small transcript. Keep the
                // caller in migrating mode only while more pages remain.
                Ok(!transcript_store
                    .legacy_transcript_backfill_is_current(session_id, index.len())?)
            })?;
        let mode = if transcript_store.has_data_source()
            && (!uses_legacy_transcript_backfill
                || transcript_store.legacy_transcript_backfill_complete(session_id)?)
        {
            NativeAiTranscriptStorageMode::BlockNative
        } else if legacy_transcript_pending || migration_manifest_exists {
            NativeAiTranscriptStorageMode::Migrating
        } else {
            NativeAiTranscriptStorageMode::Legacy
        };
        if mode == NativeAiTranscriptStorageMode::BlockNative {
            self.clear_legacy_transcript_backfill_index(session_id)?;
        }
        Ok(NativeAiTranscriptStorageState {
            capability_version: AI_TRANSCRIPT_BLOCK_CAPABILITY_VERSION,
            session_id: session_id.clone(),
            mode,
            storage_version: TRANSCRIPT_SCHEMA_VERSION,
            legacy_fallback_available,
            migration_manifest_exists,
        })
    }

    fn backfill_legacy_transcript_page(
        &self,
        session_id: &SessionId,
        index: &AiTranscriptIndex,
    ) -> AiResult<()> {
        let transcript_store = self.transcript_store(session_id);
        if !transcript_store.uses_legacy_transcript_backfill(session_id)? {
            return Ok(());
        }
        let offset = transcript_store
            .legacy_transcript_backfill_next_offset(session_id)?
            .min(index.len());
        if transcript_store.legacy_transcript_backfill_complete(session_id)?
            && offset >= index.len()
        {
            return Ok(());
        }

        transcript_store.begin_legacy_transcript_backfill(session_id)?;
        let offset = transcript_store
            .legacy_transcript_backfill_next_offset(session_id)?
            .min(index.len());
        if offset == index.len() {
            return transcript_store.advance_legacy_transcript_backfill(session_id, offset, true);
        }
        let end = (offset + LEGACY_TRANSCRIPT_BACKFILL_PAGE_SIZE).min(index.len());
        let messages = self.read_payloads_by_index(session_id, index, offset, end)?;
        let entries_and_payloads = messages
            .into_iter()
            .map(|message| legacy_transcript_entry(session_id, message))
            .collect::<AiResult<Vec<_>>>()?;
        let candidate_entry_ids = entries_and_payloads
            .iter()
            .map(|(entry, _)| entry.id.clone())
            .collect::<Vec<_>>();
        let native_entry_ids =
            transcript_store.native_transcript_entry_ids(session_id, &candidate_entry_ids)?;
        let (entries, payloads): (Vec<_>, Vec<_>) = entries_and_payloads
            .into_iter()
            .filter(|(entry, _)| !native_entry_ids.contains(&entry.id))
            .unzip();
        if !entries.is_empty() {
            // Native entries already cover their matching JSONL records.
            transcript_store.seal_turn(
                session_id,
                &format!("legacy-transcript:{offset}"),
                entries,
                payloads,
            )?;
        }
        transcript_store.advance_legacy_transcript_backfill(session_id, end, end == index.len())
    }

    fn has_current_block_native_transcript(
        &self,
        session_id: &SessionId,
        transcript_store: &TranscriptStore,
    ) -> AiResult<bool> {
        if !transcript_store.has_data_source() {
            return Ok(false);
        }
        if !transcript_store.uses_legacy_transcript_backfill(session_id)? {
            return Ok(true);
        }
        if !transcript_store.legacy_transcript_backfill_complete(session_id)? {
            return Ok(false);
        }
        if !self.transcript_path(session_id).exists() {
            return Ok(true);
        }

        // A completed flag alone is stale when the compatibility transcript
        // continues growing after its initial backfill.
        let index = self.load_or_repair_index(session_id)?;
        transcript_store.legacy_transcript_backfill_is_current(session_id, index.len())
    }

    pub fn load_session_snapshot(
        &self,
        session_id: &SessionId,
    ) -> AiResult<Option<NativeAiSessionSnapshot>> {
        if !self.has_session(session_id) {
            return Ok(None);
        }
        let metadata = self.load_metadata(session_id)?;
        let state = self.load_session_state(session_id)?;
        let transcript_store = self.transcript_store(session_id);
        let is_block_native =
            self.has_current_block_native_transcript(session_id, &transcript_store)?;
        // Block-native sessions expose their sealed history through the paged
        // transcript APIs. Loading it here would reintroduce an O(history)
        // startup path before the renderer can hydrate its bounded window.
        let messages = if is_block_native {
            Vec::new()
        } else {
            let index = self.load_or_repair_index(session_id)?;
            self.read_payloads_by_index(session_id, &index, 0, index.len())?
        };
        let title = metadata.runtime_title().to_string();
        let manual_title = metadata.custom_title.clone();
        Ok(Some(NativeAiSessionSnapshot {
            session_id: metadata.session_id,
            parent_session_id: metadata.parent_session_id,
            runtime_id: metadata.runtime_id,
            runtime_session_id: metadata.runtime_session_id,
            project_id: metadata.project_id,
            worktree_id: metadata.worktree_id,
            title,
            manual_title,
            status: metadata.status,
            updated_at: metadata.updated_at,
            active_turn_started_at: state.active_turn_started_at,
            closed_at: metadata.closed_at,
            last_error: state.last_error,
            mode_id: metadata.mode_id,
            model_id: metadata.model_id,
            reasoning_effort: metadata.reasoning_effort,
            pending_permission: state.pending_permission,
            pending_user_input: state.pending_user_input,
            plan: state.plan,
            token_usage: state.token_usage,
            available_commands: metadata.available_commands,
            config_options: metadata.config_options,
            messages,
            modes: metadata.modes,
            models: metadata.models,
            tool_activity: if is_block_native {
                Vec::new()
            } else {
                state.tool_activity
            },
            tracked_files: state.tracked_files,
        }))
    }

    pub fn list_session_history(
        &self,
        input: NativeAiListSessionHistoryInput,
    ) -> AiResult<Vec<NativeAiHistorySessionSummary>> {
        let sessions_dir = self.sessions_dir();
        if !sessions_dir.exists() {
            return Ok(Vec::new());
        }

        let mut summaries = Vec::new();
        for entry in fs::read_dir(&sessions_dir)
            .map_err(|error| history_io("read AI sessions dir", &sessions_dir, error))?
        {
            let entry = entry
                .map_err(|error| history_io("read AI sessions dir entry", &sessions_dir, error))?;
            if !entry
                .file_type()
                .map_err(|error| history_io("read AI session file type", &entry.path(), error))?
                .is_dir()
            {
                continue;
            }

            let metadata_path = entry.path().join(SESSION_META_FILE);
            let Ok(metadata) = read_json_file::<AiHistorySessionMetadata>(&metadata_path) else {
                continue;
            };
            if metadata.project_id != input.project_id {
                continue;
            }
            if !history_worktree_scope_matches(
                metadata.project_id.as_ref(),
                metadata.worktree_id.as_ref(),
                input.worktree_id.as_ref(),
            ) {
                continue;
            }
            if metadata.message_count == 0 && metadata.parent_session_id.is_none() {
                continue;
            }
            summaries.push(summary_from_metadata(metadata));
        }

        summaries.sort_by(compare_history_summaries);
        if let Some(limit) = input.limit {
            summaries.truncate(limit);
        }
        Ok(summaries)
    }

    pub fn list_runtime_mappings_for_parent(
        &self,
        parent_session_id: &SessionId,
    ) -> AiResult<Vec<NativeAiRuntimeSessionMapping>> {
        let sessions_dir = self.sessions_dir();
        if !sessions_dir.exists() {
            return Ok(Vec::new());
        }

        let parent_runtime_session_id = self
            .load_metadata(parent_session_id)
            .ok()
            .and_then(|metadata| metadata.runtime_session_id);
        let mut candidates: Vec<(String, NativeAiRuntimeSessionMapping)> = Vec::new();
        for entry in fs::read_dir(&sessions_dir)
            .map_err(|error| history_io("read AI sessions dir", &sessions_dir, error))?
        {
            let entry = entry
                .map_err(|error| history_io("read AI sessions dir entry", &sessions_dir, error))?;
            if !entry
                .file_type()
                .map_err(|error| history_io("read AI session file type", &entry.path(), error))?
                .is_dir()
            {
                continue;
            }

            let metadata_path = entry.path().join(SESSION_META_FILE);
            let Ok(metadata) = read_json_file::<AiHistorySessionMetadata>(&metadata_path) else {
                continue;
            };
            let subagent = metadata.subagent.clone();
            let metadata_parent_session_id = metadata.parent_session_id.clone();
            let parent_app_session_id = subagent
                .as_ref()
                .map(|subagent| subagent.parent_session_id.clone())
                .or(metadata_parent_session_id);
            let parent_runtime_for_child = subagent
                .as_ref()
                .and_then(|subagent| subagent.parent_runtime_session_id.clone());
            let Some(runtime_session_id) = metadata.runtime_session_id else {
                continue;
            };
            candidates.push((
                metadata.updated_at,
                NativeAiRuntimeSessionMapping {
                    app_session_id: metadata.session_id,
                    parent_app_session_id,
                    parent_runtime_session_id: parent_runtime_for_child,
                    runtime_session_id,
                },
            ));
        }

        candidates.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(collect_descendant_runtime_mappings(
            parent_session_id,
            parent_runtime_session_id
                .as_ref()
                .map(|runtime_id| runtime_id.0.as_str()),
            candidates,
        ))
    }

    pub fn set_session_pinned(&self, session_id: &SessionId, pinned: bool) -> AiResult<()> {
        let mut metadata = self.load_metadata(session_id)?;
        metadata.pinned_at = pinned.then(now_iso8601);
        metadata.updated_at = now_iso8601();
        self.save_metadata(&metadata)
    }

    pub fn rename_session(&self, session_id: &SessionId, title: String) -> AiResult<()> {
        let mut metadata = self.load_metadata(session_id)?;
        metadata.custom_title = Some(normalize_title(title));
        metadata.updated_at = now_iso8601();
        self.save_metadata(&metadata)
    }

    pub fn delete_session(&self, session_id: &SessionId) -> AiResult<()> {
        let subtree_session_ids = self.collect_session_subtree_ids(session_id)?;
        for subtree_session_id in subtree_session_ids.into_iter().rev() {
            let session_dir = self.session_dir(&subtree_session_id);
            if !session_dir.exists() {
                continue;
            }
            fs::remove_dir_all(&session_dir)
                .map_err(|error| history_io("delete AI session dir", &session_dir, error))?;
        }
        Ok(())
    }

    fn collect_session_subtree_ids(&self, session_id: &SessionId) -> AiResult<Vec<SessionId>> {
        let sessions_dir = self.sessions_dir();
        if !sessions_dir.exists() {
            return Ok(vec![session_id.clone()]);
        }

        let mut metadata_records = Vec::new();
        for entry in fs::read_dir(&sessions_dir)
            .map_err(|error| history_io("read AI sessions dir", &sessions_dir, error))?
        {
            let entry = entry
                .map_err(|error| history_io("read AI sessions dir entry", &sessions_dir, error))?;
            if !entry
                .file_type()
                .map_err(|error| history_io("read AI session file type", &entry.path(), error))?
                .is_dir()
            {
                continue;
            }
            let metadata_path = entry.path().join(SESSION_META_FILE);
            let Ok(metadata) = read_json_file::<AiHistorySessionMetadata>(&metadata_path) else {
                continue;
            };
            metadata_records.push(metadata);
        }

        let mut pending_session_ids = vec![session_id.clone()];
        let mut subtree_session_ids = Vec::new();
        let mut visited_session_ids = HashSet::new();
        while let Some(current_session_id) = pending_session_ids.pop() {
            if !visited_session_ids.insert(current_session_id.clone()) {
                continue;
            }
            subtree_session_ids.push(current_session_id.clone());
            for metadata in &metadata_records {
                let parent_session_id = metadata
                    .subagent
                    .as_ref()
                    .map(|subagent| &subagent.parent_session_id)
                    .or(metadata.parent_session_id.as_ref());
                if parent_session_id == Some(&current_session_id) {
                    pending_session_ids.push(metadata.session_id.clone());
                }
            }
        }

        Ok(subtree_session_ids)
    }

    pub fn storage_health(&self) -> AiResult<NativeAiHistoryStorageHealth> {
        let sessions_dir = self.sessions_dir();
        let mut native_session_count = 0;
        let mut orphaned_session_dirs = 0;
        let mut healthy = true;
        let mut latest_error = None;
        let mut storage_version = TRANSCRIPT_SCHEMA_VERSION;

        if sessions_dir.exists() {
            for entry in fs::read_dir(&sessions_dir)
                .map_err(|error| history_io("read AI sessions dir", &sessions_dir, error))?
            {
                let entry = entry.map_err(|error| {
                    history_io("read AI sessions dir entry", &sessions_dir, error)
                })?;
                if !entry
                    .file_type()
                    .map_err(|error| history_io("read AI session file type", &entry.path(), error))?
                    .is_dir()
                {
                    continue;
                }
                let metadata_path = entry.path().join(SESSION_META_FILE);
                if metadata_path.exists() {
                    native_session_count += 1;
                    if let Ok(metadata) = read_json_file::<AiHistorySessionMetadata>(&metadata_path)
                    {
                        match TranscriptStore::new(&entry.path()).health(&metadata.session_id) {
                            Ok(transcript_health) => {
                                storage_version =
                                    storage_version.min(transcript_health.schema_version);
                            }
                            Err(_error) => {
                                healthy = false;
                                latest_error = Some(
                                    "Transcript storage health check failed for a native session."
                                        .to_string(),
                                );
                            }
                        }
                    }
                } else {
                    orphaned_session_dirs += 1;
                }
            }
        }

        Ok(NativeAiHistoryStorageHealth {
            healthy,
            storage_version,
            native_session_count,
            legacy_fallback_available: false,
            migration_manifest_exists: self.history_root().join("migrations").exists(),
            orphaned_session_dirs,
            latest_error,
        })
    }

    fn load_or_repair_index(&self, session_id: &SessionId) -> AiResult<AiTranscriptIndex> {
        let index = self.load_index(session_id)?;
        let transcript_path = self.transcript_path(session_id);
        let transcript_len = file_len(&transcript_path).unwrap_or(0);
        match index.validate(transcript_len) {
            Ok(()) => Ok(index),
            Err(_) => self.rebuild_index_from_transcript(session_id),
        }
    }

    fn with_legacy_transcript_backfill_index<T>(
        &self,
        session_id: &SessionId,
        operation: impl FnOnce(&AiTranscriptIndex) -> AiResult<T>,
    ) -> AiResult<T> {
        let is_cached = self
            .legacy_transcript_backfill_indexes
            .lock()
            .map_err(|error| {
                AiError::Internal(format!(
                    "lock legacy transcript backfill indexes failed: {error}"
                ))
            })?
            .contains_key(&session_id.0);
        if !is_cached {
            let index = self.load_or_repair_index(session_id)?;
            self.legacy_transcript_backfill_indexes
                .lock()
                .map_err(|error| {
                    AiError::Internal(format!(
                        "lock legacy transcript backfill indexes failed: {error}"
                    ))
                })?
                .entry(session_id.0.clone())
                .or_insert(index);
        }
        let indexes = self
            .legacy_transcript_backfill_indexes
            .lock()
            .map_err(|error| {
                AiError::Internal(format!(
                    "lock legacy transcript backfill indexes failed: {error}"
                ))
            })?;
        let index = indexes.get(&session_id.0).ok_or_else(|| {
            AiError::Internal("legacy transcript backfill index was not cached".to_string())
        })?;
        operation(index)
    }

    fn clear_legacy_transcript_backfill_index(&self, session_id: &SessionId) -> AiResult<()> {
        self.legacy_transcript_backfill_indexes
            .lock()
            .map_err(|error| {
                AiError::Internal(format!(
                    "lock legacy transcript backfill indexes failed: {error}"
                ))
            })?
            .remove(&session_id.0);
        Ok(())
    }

    fn rebuild_index_from_transcript(&self, session_id: &SessionId) -> AiResult<AiTranscriptIndex> {
        let transcript_path = self.transcript_path(session_id);
        let file = match File::open(&transcript_path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let index = AiTranscriptIndex::empty();
                self.save_index(session_id, &index)?;
                return Ok(index);
            }
            Err(error) => return Err(history_io("open AI transcript", &transcript_path, error)),
        };

        let mut reader = BufReader::new(file);
        let mut offset = 0_u64;
        let mut index = AiTranscriptIndex::empty();
        loop {
            let mut line = String::new();
            let read = reader
                .read_line(&mut line)
                .map_err(|error| history_io("read AI transcript", &transcript_path, error))?;
            if read == 0 {
                break;
            }
            let length = read as u64;
            let record: AiTranscriptRecord = serde_json::from_str(line.trim_end())
                .map_err(|error| history_json("parse AI transcript line", error))?;
            index.message_offsets.push(offset);
            index.message_lengths.push(length);
            index.message_hashes.push(record.hash);
            index.message_ids.push(record.message_id);
            index.message_kinds.push(record.kind);
            index.message_roles.push(record.role);
            index.indexed_transcript_bytes += length;
            offset += length;
        }
        index.updated_at = now_iso8601();
        self.save_index(session_id, &index)?;
        Ok(index)
    }

    fn read_payloads_by_index(
        &self,
        session_id: &SessionId,
        index: &AiTranscriptIndex,
        start: usize,
        end: usize,
    ) -> AiResult<Vec<Value>> {
        let transcript_path = self.transcript_path(session_id);
        let mut file = File::open(&transcript_path)
            .map_err(|error| history_io("open AI transcript", &transcript_path, error))?;
        let mut messages = Vec::with_capacity(end.saturating_sub(start));
        for row in start..end {
            let offset = index.message_offsets[row];
            let length = index.message_lengths[row];
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| history_io("seek AI transcript", &transcript_path, error))?;
            let mut buffer = vec![0_u8; length as usize];
            file.read_exact(&mut buffer).map_err(|error| {
                history_io("read AI transcript record", &transcript_path, error)
            })?;
            let line = std::str::from_utf8(&buffer).map_err(|error| {
                history_error(format!("AI transcript line is not UTF-8: {error}"))
            })?;
            let record: AiTranscriptRecord = serde_json::from_str(line.trim_end())
                .map_err(|error| history_json("parse AI transcript record", error))?;
            if record.hash != index.message_hashes[row] {
                return Err(history_error("AI transcript record hash mismatch."));
            }
            messages.push(record.payload);
        }
        Ok(messages)
    }

    fn compact_transcript_if_needed(&self, session_id: &SessionId) -> AiResult<()> {
        let index = self.load_index(session_id)?;
        let transcript_path = self.transcript_path(session_id);
        let physical_bytes = file_len(&transcript_path).unwrap_or(0);
        if !should_compact_transcript(&self.compaction_policy, physical_bytes, &index) {
            return Ok(());
        }

        self.write_compaction_marker(session_id)?;
        let messages = self.read_payloads_by_index(session_id, &index, 0, index.len())?;
        let records = messages
            .into_iter()
            .map(AiTranscriptRecord::from_payload)
            .collect::<AiResult<Vec<_>>>()?;
        let mut next_index = AiTranscriptIndex::empty();
        let transcript_tmp = self.sidecar_path(session_id, "transcript.tmp");
        {
            let mut file = File::create(&transcript_tmp).map_err(|error| {
                history_io("create compacted AI transcript", &transcript_tmp, error)
            })?;
            for record in &records {
                let offset = file.seek(SeekFrom::End(0)).map_err(|error| {
                    history_io("seek compacted AI transcript", &transcript_tmp, error)
                })?;
                let line = serialize_record_line(record)?;
                file.write_all(line.as_bytes())
                    .and_then(|_| file.write_all(b"\n"))
                    .map_err(|error| {
                        history_io("write compacted AI transcript", &transcript_tmp, error)
                    })?;
                let length = line.len() as u64 + 1;
                next_index.message_offsets.push(offset);
                next_index.message_lengths.push(length);
                next_index.message_hashes.push(record.hash.clone());
                next_index.message_ids.push(record.message_id.clone());
                next_index.message_kinds.push(record.kind.clone());
                next_index.message_roles.push(record.role.clone());
                next_index.indexed_transcript_bytes += length;
            }
            file.sync_all().map_err(|error| {
                history_io("sync compacted AI transcript", &transcript_tmp, error)
            })?;
        }

        let transcript_backup = self.sidecar_path(session_id, "transcript.bak");
        if transcript_path.exists() {
            copy_or_replace(&transcript_path, &transcript_backup)?;
        }
        fs::rename(&transcript_tmp, &transcript_path).map_err(|error| {
            history_io("install compacted AI transcript", &transcript_path, error)
        })?;
        self.save_index(session_id, &next_index)?;
        self.clear_compaction_sidecars(session_id)?;
        Ok(())
    }

    fn recover_if_needed(&self, session_id: &SessionId) -> AiResult<()> {
        let marker = self.compaction_marker_path(session_id);
        if marker.exists() {
            let transcript_path = self.transcript_path(session_id);
            let transcript_backup = self.sidecar_path(session_id, "transcript.bak");
            if !transcript_path.exists() && transcript_backup.exists() {
                copy_or_replace(&transcript_backup, &transcript_path)?;
            }
            self.clear_compaction_sidecars(session_id)?;
        }
        self.recover_pending_transcript_write(session_id)
    }

    fn write_compaction_marker(&self, session_id: &SessionId) -> AiResult<()> {
        let state = HistoryCompactionState {
            version: HISTORY_FORMAT_VERSION,
            started_at: now_iso8601(),
        };
        atomic_write_json(&self.compaction_marker_path(session_id), &state)
    }

    fn write_transcript_write_marker(
        &self,
        session_id: &SessionId,
        state: &TranscriptWriteState,
    ) -> AiResult<()> {
        atomic_write_json(&self.transcript_write_marker_path(session_id), state)
    }

    fn clear_transcript_write_marker(&self, session_id: &SessionId) -> AiResult<()> {
        let marker = self.transcript_write_marker_path(session_id);
        if marker.exists() {
            fs::remove_file(&marker)
                .map_err(|error| history_io("remove transcript write marker", &marker, error))?;
        }
        Ok(())
    }

    fn recover_pending_transcript_write(&self, session_id: &SessionId) -> AiResult<()> {
        let marker = self.transcript_write_marker_path(session_id);
        if !marker.exists() {
            return Ok(());
        }
        let state: TranscriptWriteState = read_json_file(&marker)?;
        if state.version != HISTORY_FORMAT_VERSION {
            return Err(history_error(
                "AI transcript write marker has an unsupported version.",
            ));
        }

        let transcript_len = file_len(&self.transcript_path(session_id)).unwrap_or(0);
        let recovered_messages = state
            .next_index
            .validate(transcript_len)
            .is_ok()
            .then(|| {
                self.read_payloads_by_index(
                    session_id,
                    &state.next_index,
                    0,
                    state.next_index.len(),
                )
            })
            .transpose()?;
        if let Some(messages) = recovered_messages {
            // The source write reached disk, so SQLite must be invalidated
            // before this index can make the revised transcript authoritative.
            self.transcript_store(session_id)
                .invalidate_legacy_transcript_backfill_from(
                    session_id,
                    state.first_changed_offset,
                    &state.stale_legacy_entry_ids,
                )?;
            self.save_index(session_id, &state.next_index)?;
            let recovered_metadata = state.session_metadata.unwrap_or_else(|| {
                // Markers created before session metadata was included still
                // recover accurately from the JSONL payloads they validate.
                TranscriptWriteSessionMetadata {
                    message_count: messages.len(),
                    preview: derive_session_preview(messages.iter()),
                    updated_at: now_iso8601(),
                }
            });
            // The recovery marker is still present, so avoid load_metadata()
            // recursively entering this recovery path before it is cleared.
            let mut metadata: AiHistorySessionMetadata =
                read_json_file(&self.metadata_path(session_id))?;
            metadata.message_count = recovered_metadata.message_count;
            metadata.preview = recovered_metadata.preview;
            metadata.updated_at = recovered_metadata.updated_at;
            self.save_metadata(&metadata)?;
        }
        self.clear_transcript_write_marker(session_id)
    }

    fn clear_compaction_sidecars(&self, session_id: &SessionId) -> AiResult<()> {
        for path in [
            self.compaction_marker_path(session_id),
            self.sidecar_path(session_id, "transcript.tmp"),
            self.sidecar_path(session_id, "transcript.bak"),
        ] {
            if path.exists() {
                fs::remove_file(&path)
                    .map_err(|error| history_io("remove AI history sidecar", &path, error))?;
            }
        }
        Ok(())
    }

    fn load_index(&self, session_id: &SessionId) -> AiResult<AiTranscriptIndex> {
        self.recover_if_needed(session_id)?;
        read_json_file(&self.index_path(session_id))
    }

    fn save_index(&self, session_id: &SessionId, index: &AiTranscriptIndex) -> AiResult<()> {
        self.ensure_session_dir(session_id)?;
        atomic_write_json(&self.index_path(session_id), index)?;
        self.clear_legacy_transcript_backfill_index(session_id)
    }

    fn create_empty_transcript(&self, session_id: &SessionId) -> AiResult<()> {
        let path = self.transcript_path(session_id);
        self.ensure_session_dir(session_id)?;
        File::create(&path)
            .and_then(|file| file.sync_all())
            .map_err(|error| history_io("create AI transcript", &path, error))
    }

    fn ensure_session_dir(&self, session_id: &SessionId) -> AiResult<()> {
        let session_dir = self.session_dir(session_id);
        fs::create_dir_all(&session_dir)
            .map_err(|error| history_io("create AI session dir", &session_dir, error))
    }

    fn metadata_path(&self, session_id: &SessionId) -> PathBuf {
        self.session_dir(session_id).join(SESSION_META_FILE)
    }

    fn session_state_path(&self, session_id: &SessionId) -> PathBuf {
        self.session_dir(session_id).join(SESSION_STATE_FILE)
    }

    fn tool_details_path(&self, session_id: &SessionId) -> PathBuf {
        self.session_dir(session_id).join(SESSION_TOOL_DETAILS_FILE)
    }

    fn tool_details_dir(&self, session_id: &SessionId) -> PathBuf {
        self.session_dir(session_id).join(SESSION_TOOL_DETAILS_DIR)
    }

    fn tool_activity_detail_path(&self, session_id: &SessionId, detail_id: &str) -> PathBuf {
        self.tool_details_dir(session_id)
            .join(format!("{}.json", sha256_hex(detail_id.as_bytes())))
    }

    fn load_legacy_tool_activity_detail_entry(
        &self,
        session_id: &SessionId,
        detail_id: &str,
    ) -> AiResult<Option<AiToolActivityDetail>> {
        let path = self.tool_details_path(session_id);
        if !path.exists() {
            return Ok(None);
        }
        let store: AiToolActivityDetailStore = read_json_file(&path)?;
        Ok(store.details.get(detail_id).cloned())
    }

    fn load_legacy_tool_activity_detail(
        &self,
        session_id: &SessionId,
        detail_id: &str,
    ) -> AiResult<Option<Value>> {
        let state = self.load_session_state(session_id)?;
        let Some(activity) = state.tool_activity.into_iter().find(|activity| {
            activity
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|tool_call_id| {
                    detail_id == format!("tool-detail:{}:{tool_call_id}", session_id.0)
                })
        }) else {
            return Ok(None);
        };
        let raw_input = activity
            .get("rawInputJson")
            .and_then(Value::as_str)
            .and_then(|value| serde_json::from_str(value).ok())
            .unwrap_or(Value::Null);
        let raw_output = activity
            .get("rawOutputJson")
            .and_then(Value::as_str)
            .and_then(|value| serde_json::from_str(value).ok())
            .unwrap_or(Value::Null);
        let detail = json!({
            "diffs": activity.get("diffs").cloned().unwrap_or_else(|| json!([])),
            "rawInput": raw_input,
            "rawOutput": raw_output,
            "terminalOutput": activity.get("terminalOutput").cloned().unwrap_or(Value::Null),
        });
        if is_empty_activity_value(&detail["rawInput"])
            && is_empty_activity_value(&detail["rawOutput"])
            && is_empty_activity_value(&detail["terminalOutput"])
            && detail["diffs"].as_array().is_none_or(Vec::is_empty)
        {
            return Ok(None);
        }
        Ok(Some(detail))
    }
    fn transcript_path(&self, session_id: &SessionId) -> PathBuf {
        self.session_dir(session_id).join(SESSION_TRANSCRIPT_FILE)
    }

    fn transcript_store(&self, session_id: &SessionId) -> TranscriptStore {
        TranscriptStore::new(&self.session_dir(session_id))
    }

    fn index_path(&self, session_id: &SessionId) -> PathBuf {
        self.session_dir(session_id).join(SESSION_INDEX_FILE)
    }

    fn compaction_marker_path(&self, session_id: &SessionId) -> PathBuf {
        self.session_dir(session_id)
            .join(SESSION_COMPACT_STATE_FILE)
    }

    fn transcript_write_marker_path(&self, session_id: &SessionId) -> PathBuf {
        self.session_dir(session_id)
            .join(SESSION_TRANSCRIPT_WRITE_STATE_FILE)
    }

    fn sidecar_path(&self, session_id: &SessionId, name: &str) -> PathBuf {
        self.session_dir(session_id).join(name)
    }
}

fn normalize_legacy_codex_tool_activities(activities: &mut Vec<Value>) -> bool {
    let original = activities.clone();
    let mut replacements = BTreeMap::<usize, Value>::new();
    let mut removed = HashSet::<usize>::new();

    for (alias_index, alias) in original.iter().enumerate() {
        if is_completed_turn_status_activity(alias) {
            removed.insert(alias_index);
            continue;
        }

        let Some(alias_id) = alias.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(logical_id) = alias_id.strip_prefix(CODEX_ITEM_STATUS_PREFIX) else {
            continue;
        };
        let canonical_ids = [
            logical_id.to_string(),
            format!("{CODEX_SUBAGENT_PREFIX}{logical_id}"),
            format!("{CODEX_IMAGE_PREFIX}{logical_id}"),
        ];
        let canonical_index = original.iter().position(|activity| {
            activity
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| canonical_ids.iter().any(|candidate| candidate == id))
        });

        if let Some(canonical_index) = canonical_index {
            let target_index = alias_index.min(canonical_index);
            let discarded_index = alias_index.max(canonical_index);
            replacements.insert(
                target_index,
                merge_canonical_tool_activity(&original[canonical_index], alias),
            );
            removed.insert(discarded_index);
        } else if alias
            .get("title")
            .and_then(Value::as_str)
            .is_some_and(is_internal_codex_item_title)
        {
            removed.insert(alias_index);
        }
    }

    if replacements.is_empty() && removed.is_empty() {
        return false;
    }

    *activities = original
        .into_iter()
        .enumerate()
        .filter_map(|(index, activity)| {
            if removed.contains(&index) {
                None
            } else {
                Some(replacements.remove(&index).unwrap_or(activity))
            }
        })
        .collect();
    true
}

fn merge_canonical_tool_activity(canonical: &Value, alias: &Value) -> Value {
    let mut merged = canonical.clone();
    let (Some(merged_object), Some(alias_object)) = (merged.as_object_mut(), alias.as_object())
    else {
        return canonical.clone();
    };

    if let Some(created_at) = earliest_string_field(canonical, alias, "createdAt") {
        merged_object.insert("createdAt".to_string(), Value::String(created_at));
    }
    if let Some(updated_at) = latest_string_field(canonical, alias, "updatedAt") {
        merged_object.insert("updatedAt".to_string(), Value::String(updated_at));
    }
    for key in [
        "action",
        "diffs",
        "exitCode",
        "locations",
        "rawInputJson",
        "rawOutputJson",
        "summary",
        "terminalOutput",
    ] {
        let should_copy = merged_object.get(key).is_none_or(is_empty_activity_value);
        if should_copy
            && let Some(value) = alias_object.get(key)
            && !is_empty_activity_value(value)
        {
            merged_object.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(merged_object.clone())
}

fn earliest_string_field(canonical: &Value, alias: &Value, key: &str) -> Option<String> {
    [canonical, alias]
        .into_iter()
        .filter_map(|value| value.get(key).and_then(Value::as_str))
        .min()
        .map(str::to_string)
}

fn latest_string_field(canonical: &Value, alias: &Value, key: &str) -> Option<String> {
    [canonical, alias]
        .into_iter()
        .filter_map(|value| value.get(key).and_then(Value::as_str))
        .max()
        .map(str::to_string)
}

fn is_empty_activity_value(value: &Value) -> bool {
    value.is_null()
        || value.as_str().is_some_and(str::is_empty)
        || value.as_array().is_some_and(Vec::is_empty)
}

fn is_internal_codex_item_title(title: &str) -> bool {
    ["Preparing input", "Drafting response", "Reasoning"]
        .iter()
        .any(|candidate| title.trim().eq_ignore_ascii_case(candidate))
}

fn is_completed_turn_status_activity(activity: &Value) -> bool {
    let is_turn_status = activity
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| id.starts_with("comando:turn:") || id.starts_with("acp:turn:"));
    let is_completed = activity
        .get("title")
        .and_then(Value::as_str)
        .is_some_and(|title| title.trim().eq_ignore_ascii_case("Completed"));
    is_turn_status && is_completed
}

fn collect_descendant_runtime_mappings(
    parent_session_id: &SessionId,
    parent_runtime_session_id: Option<&str>,
    candidates: Vec<(String, NativeAiRuntimeSessionMapping)>,
) -> Vec<NativeAiRuntimeSessionMapping> {
    let mut known_app_session_ids = HashSet::from([parent_session_id.0.clone()]);
    let mut known_runtime_session_ids = parent_runtime_session_id
        .map(|runtime_id| HashSet::from([runtime_id.to_string()]))
        .unwrap_or_default();
    let mut included = HashSet::new();
    let mut mappings = Vec::new();

    loop {
        let mut progressed = false;
        for (_, mapping) in &candidates {
            if included.contains(&mapping.app_session_id.0) {
                continue;
            }
            let parent_is_known = mapping
                .parent_app_session_id
                .as_ref()
                .is_some_and(|parent_id| known_app_session_ids.contains(&parent_id.0))
                || mapping
                    .parent_runtime_session_id
                    .as_ref()
                    .is_some_and(|parent_id| known_runtime_session_ids.contains(&parent_id.0));
            if !parent_is_known
                || mapping.app_session_id == *parent_session_id
                || mapping
                    .parent_app_session_id
                    .as_ref()
                    .is_some_and(|parent_id| parent_id == &mapping.app_session_id)
            {
                continue;
            }

            included.insert(mapping.app_session_id.0.clone());
            known_app_session_ids.insert(mapping.app_session_id.0.clone());
            known_runtime_session_ids.insert(mapping.runtime_session_id.0.clone());
            mappings.push(mapping.clone());
            progressed = true;
        }
        if !progressed {
            break;
        }
    }

    mappings
}

pub struct LegacyAiHistoryReader<'a> {
    connection: &'a Connection,
}

#[derive(Debug, Clone)]
struct LegacyHistoryRow {
    session_id: String,
    parent_session_id: Option<String>,
    project_id: Option<String>,
    worktree_id: Option<String>,
    title: String,
    runtime_id: String,
    runtime_session_id: Option<String>,
    parent_runtime_session_id: Option<String>,
    status: String,
    created_at: String,
    updated_at: String,
    pinned_at: Option<String>,
    message_count: usize,
    preview: Option<String>,
    state_json: Option<String>,
    review_json: Option<String>,
}

impl<'a> LegacyAiHistoryReader<'a> {
    pub fn new(connection: &'a Connection) -> Self {
        Self { connection }
    }

    pub fn list_session_history(
        &self,
        input: NativeAiListSessionHistoryInput,
    ) -> AiResult<Vec<NativeAiHistorySessionSummary>> {
        if !self.table_exists("chat_sessions")? {
            return Ok(Vec::new());
        }

        let rows = self.query_history_rows(input.project_id, input.worktree_id, input.limit)?;
        Ok(rows
            .into_iter()
            .filter(|row| row.message_count > 0 || row.parent_session_id.is_some())
            .map(summary_from_legacy_row)
            .collect())
    }

    pub fn load_transcript_page(
        &self,
        input: NativeAiLoadSessionTranscriptPageInput,
    ) -> AiResult<Option<NativeAiSessionTranscriptPage>> {
        if !self.has_session(&input.session_id)? {
            return Ok(None);
        }
        let messages = self.load_all_messages(&input.session_id)?;
        let offset = input.offset.min(messages.len());
        let limit = normalize_page_limit(input.limit);
        let end = offset.saturating_add(limit).min(messages.len());

        Ok(Some(NativeAiSessionTranscriptPage {
            session_id: input.session_id,
            offset,
            total_messages: messages.len(),
            messages: messages[offset..end].to_vec(),
        }))
    }

    pub fn load_session_snapshot(
        &self,
        session_id: &SessionId,
    ) -> AiResult<Option<NativeAiSessionSnapshot>> {
        let Some(row) = self.query_history_row(session_id)? else {
            return Ok(None);
        };
        let state = row
            .state_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or_else(|| json!({}));
        let review = row
            .review_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or_else(|| json!({}));
        let messages = self.load_all_messages(session_id)?;

        Ok(Some(NativeAiSessionSnapshot {
            session_id: SessionId(row.session_id),
            parent_session_id: row.parent_session_id.map(SessionId),
            runtime_id: RuntimeId(
                state
                    .get("runtimeId")
                    .and_then(Value::as_str)
                    .unwrap_or(&row.runtime_id)
                    .to_string(),
            ),
            runtime_session_id: row.runtime_session_id.map(RuntimeSessionId),
            project_id: row.project_id.map(ProjectId),
            worktree_id: row.worktree_id.map(WorktreeId),
            title: state
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or(&row.title)
                .to_string(),
            manual_title: string_field(&state, "manualTitle"),
            status: native_status_from_legacy(
                state
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or(&row.status),
            ),
            updated_at: state
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or(&row.updated_at)
                .to_string(),
            active_turn_started_at: string_field(&state, "activeTurnStartedAt"),
            closed_at: string_field(&state, "closedAt"),
            last_error: string_field(&state, "lastError"),
            mode_id: string_field(&state, "modeId"),
            model_id: string_field(&state, "modelId"),
            reasoning_effort: string_field(&state, "reasoningEffort"),
            pending_permission: state
                .get("pendingPermission")
                .cloned()
                .filter(|v| !v.is_null()),
            pending_user_input: state
                .get("pendingUserInput")
                .cloned()
                .filter(|v| !v.is_null()),
            plan: state.get("plan").cloned().filter(|v| !v.is_null()),
            token_usage: state.get("tokenUsage").cloned().filter(|v| !v.is_null()),
            available_commands: array_field(&state, "availableCommands"),
            config_options: array_field(&state, "configOptions"),
            messages,
            modes: array_field(&state, "modes"),
            models: array_field(&state, "models"),
            tool_activity: array_field(&state, "toolActivity"),
            tracked_files: array_field(&review, "trackedFiles"),
        }))
    }

    pub fn list_runtime_mappings_for_parent(
        &self,
        parent_session_id: &SessionId,
    ) -> AiResult<Vec<NativeAiRuntimeSessionMapping>> {
        if !self.table_exists("chat_session_runtime_links")? {
            return Ok(Vec::new());
        }

        let parent_runtime_session_id =
            self.find_runtime_session_id_by_app_session_id(parent_session_id)?;
        let mut statement = self
            .connection
            .prepare(
                "
                SELECT
                    runtime_session_id,
                    app_session_id,
                    parent_runtime_session_id,
                    parent_app_session_id,
                    updated_at
                FROM chat_session_runtime_links
                ORDER BY updated_at ASC
                ",
            )
            .map_err(|error| history_sql("prepare legacy runtime mapping query", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(4)?,
                    NativeAiRuntimeSessionMapping {
                        runtime_session_id: RuntimeSessionId(row.get::<_, String>(0)?),
                        app_session_id: SessionId(row.get::<_, String>(1)?),
                        parent_runtime_session_id: row
                            .get::<_, Option<String>>(2)?
                            .map(RuntimeSessionId),
                        parent_app_session_id: row.get::<_, Option<String>>(3)?.map(SessionId),
                    },
                ))
            })
            .map_err(|error| history_sql("query legacy runtime mappings", error))?;

        let mut mappings = Vec::new();
        for row in rows {
            mappings.push(row.map_err(|error| history_sql("read legacy runtime mapping", error))?);
        }
        Ok(collect_descendant_runtime_mappings(
            parent_session_id,
            parent_runtime_session_id.as_deref(),
            mappings,
        ))
    }

    fn load_all_messages(&self, session_id: &SessionId) -> AiResult<Vec<Value>> {
        let shadow = self.load_shadow_messages(session_id)?;
        if !shadow.is_empty() {
            return Ok(shadow);
        }
        if let Some(messages) = self.load_runtime_state_messages(session_id)?
            && !messages.is_empty()
        {
            return Ok(messages);
        }
        Ok(self
            .load_transcript_json_messages(session_id)?
            .unwrap_or_default())
    }

    fn load_shadow_messages(&self, session_id: &SessionId) -> AiResult<Vec<Value>> {
        if !self.table_exists("chat_transcript_messages")? {
            return Ok(Vec::new());
        }
        let mut statement = self
            .connection
            .prepare(
                "
                SELECT payload_json
                FROM chat_transcript_messages
                WHERE session_id = ?1
                ORDER BY message_index ASC
                ",
            )
            .map_err(|error| history_sql("prepare legacy shadow message query", error))?;
        let rows = statement
            .query_map([&session_id.0], |row| row.get::<_, String>(0))
            .map_err(|error| history_sql("query legacy shadow messages", error))?;

        let mut messages = Vec::new();
        for row in rows {
            let payload_json =
                row.map_err(|error| history_sql("read legacy shadow message", error))?;
            if let Ok(value) = serde_json::from_str::<Value>(&payload_json)
                && value.is_object()
            {
                messages.push(value);
            }
        }
        Ok(messages)
    }

    fn load_runtime_state_messages(&self, session_id: &SessionId) -> AiResult<Option<Vec<Value>>> {
        if !self.table_exists("chat_session_runtime_state")? {
            return Ok(None);
        }
        let state_json = self
            .connection
            .query_row(
                "
                SELECT state_json
                FROM chat_session_runtime_state
                WHERE session_id = ?1
                ",
                [&session_id.0],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| history_sql("query legacy runtime state", error))?;

        Ok(state_json
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|state| object_array_field(&state, "messages")))
    }

    fn load_transcript_json_messages(
        &self,
        session_id: &SessionId,
    ) -> AiResult<Option<Vec<Value>>> {
        if !self.table_exists("chat_transcripts")? {
            return Ok(None);
        }
        let transcript_json = self
            .connection
            .query_row(
                "
                SELECT transcript_json
                FROM chat_transcripts
                WHERE session_id = ?1
                ",
                [&session_id.0],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| history_sql("query legacy transcript", error))?;

        Ok(transcript_json
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|transcript| object_array_field(&transcript, "messages")))
    }

    fn query_history_rows(
        &self,
        project_id: Option<ProjectId>,
        worktree_id: Option<WorktreeId>,
        limit: Option<usize>,
    ) -> AiResult<Vec<LegacyHistoryRow>> {
        let mut sql = legacy_history_select_sql();
        sql.push_str(
            "
            WHERE ",
        );
        let mut args: Vec<Option<String>> = Vec::new();
        if let Some(project_id) = project_id.as_ref() {
            sql.push_str("chat_sessions.project_id = ? ");
            args.push(Some(project_id.0.clone()));
        } else {
            sql.push_str("chat_sessions.project_id IS NULL ");
        }
        sql.push_str("AND ");
        match worktree_id.as_ref() {
            Some(worktree_id)
                if project_id
                    .as_ref()
                    .is_some_and(|project_id| is_primary_worktree_id(project_id, worktree_id)) =>
            {
                sql.push_str(
                    "(chat_sessions.worktree_id = ? OR chat_sessions.worktree_id IS NULL) ",
                );
                args.push(Some(worktree_id.0.clone()));
            }
            Some(worktree_id) => {
                sql.push_str("chat_sessions.worktree_id = ? ");
                args.push(Some(worktree_id.0.clone()));
            }
            None => {
                if let Some(project_id) = project_id.as_ref() {
                    // Keep null-primary legacy rows visible from canonical scopes.
                    sql.push_str(
                        "(chat_sessions.worktree_id IS NULL OR chat_sessions.worktree_id = ?) ",
                    );
                    args.push(Some(primary_worktree_id(project_id)));
                } else {
                    sql.push_str("chat_sessions.worktree_id IS NULL ");
                }
            }
        }
        sql.push_str(
            "
            ORDER BY chat_sessions.pinned_at IS NULL ASC, chat_sessions.updated_at DESC
            ",
        );
        if let Some(limit) = limit {
            sql.push_str("LIMIT ? ");
            args.push(Some(limit.to_string()));
        }

        let mut statement = self
            .connection
            .prepare(&sql)
            .map_err(|error| history_sql("prepare legacy history query", error))?;
        let mapped = statement
            .query_map(rusqlite::params_from_iter(args.iter()), legacy_row_from_sql)
            .map_err(|error| history_sql("query legacy history", error))?;

        let mut rows = Vec::new();
        for row in mapped {
            rows.push(row.map_err(|error| history_sql("read legacy history row", error))?);
        }
        Ok(rows)
    }

    fn query_history_row(&self, session_id: &SessionId) -> AiResult<Option<LegacyHistoryRow>> {
        if !self.has_session(session_id)? {
            return Ok(None);
        }
        let mut sql = legacy_history_select_sql();
        sql.push_str("WHERE chat_sessions.id = ?1 LIMIT 1");
        self.connection
            .query_row(&sql, [&session_id.0], legacy_row_from_sql)
            .optional()
            .map_err(|error| history_sql("query legacy history row", error))
    }

    fn find_runtime_session_id_by_app_session_id(
        &self,
        app_session_id: &SessionId,
    ) -> AiResult<Option<String>> {
        if !self.table_exists("chat_session_runtime_links")? {
            return Ok(None);
        }

        self.connection
            .query_row(
                "
                SELECT runtime_session_id
                FROM chat_session_runtime_links
                WHERE app_session_id = ?1
                LIMIT 1
                ",
                [&app_session_id.0],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| history_sql("query legacy parent runtime session", error))
    }

    fn list_all_session_ids(&self) -> AiResult<Vec<SessionId>> {
        if !self.table_exists("chat_sessions")? {
            return Ok(Vec::new());
        }
        let mut statement = self
            .connection
            .prepare("SELECT id FROM chat_sessions ORDER BY updated_at ASC")
            .map_err(|error| history_sql("prepare legacy session id query", error))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| history_sql("query legacy session ids", error))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(SessionId(
                row.map_err(|error| history_sql("read legacy session id", error))?,
            ));
        }
        Ok(ids)
    }

    fn has_session(&self, session_id: &SessionId) -> AiResult<bool> {
        if !self.table_exists("chat_sessions")? {
            return Ok(false);
        }
        let found = self
            .connection
            .query_row(
                "SELECT id FROM chat_sessions WHERE id = ?1 LIMIT 1",
                [&session_id.0],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| history_sql("query legacy session existence", error))?;
        Ok(found.is_some())
    }

    fn table_exists(&self, table: &str) -> AiResult<bool> {
        let found = self
            .connection
            .query_row(
                "
                SELECT name
                FROM sqlite_master
                WHERE type = 'table'
                  AND name = ?1
                ",
                [table],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| history_sql("query legacy schema", error))?;
        Ok(found.is_some())
    }
}

pub struct AiHistoryMigrator<'a> {
    store: &'a AiHistoryStore,
    legacy: LegacyAiHistoryReader<'a>,
    source_database_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiHistoryMigrationMode {
    Copy,
    ReadOnly,
}

impl AiHistoryMigrationMode {
    pub fn from_optional(value: Option<&str>) -> AiResult<Self> {
        match value.unwrap_or("copy") {
            "copy" => Ok(Self::Copy),
            "read_only" => Ok(Self::ReadOnly),
            other => Err(AiError::InvalidInput(format!(
                "Unsupported AI history migration mode: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiHistoryMigrationOptions {
    pub mode: AiHistoryMigrationMode,
    pub limit: Option<usize>,
}

impl Default for AiHistoryMigrationOptions {
    fn default() -> Self {
        Self {
            mode: AiHistoryMigrationMode::Copy,
            limit: None,
        }
    }
}

impl<'a> AiHistoryMigrator<'a> {
    pub fn new(
        store: &'a AiHistoryStore,
        connection: &'a Connection,
        source_database_path: Option<String>,
    ) -> Self {
        Self {
            store,
            legacy: LegacyAiHistoryReader::new(connection),
            source_database_path,
        }
    }

    pub fn copy_legacy_history(
        &self,
    ) -> AiResult<comando_types::ai::NativeAiMigrateSessionHistoryOutput> {
        self.copy_legacy_history_with_options(AiHistoryMigrationOptions::default())
    }

    pub fn copy_legacy_history_with_options(
        &self,
        options: AiHistoryMigrationOptions,
    ) -> AiResult<comando_types::ai::NativeAiMigrateSessionHistoryOutput> {
        let started_at = now_iso8601();
        let mut manifest = AiHistoryMigrationManifest {
            version: HISTORY_FORMAT_VERSION,
            source_database_path: self.source_database_path.clone(),
            started_at: started_at.clone(),
            updated_at: started_at.clone(),
            completed_at: None,
            sessions: Vec::new(),
        };
        let mut migrated_sessions = 0;
        let mut skipped_sessions = 0;
        let mut failed_sessions = 0;
        let mut errors = Vec::new();

        let mut session_ids = self.legacy.list_all_session_ids()?;
        if let Some(limit) = options.limit {
            session_ids.truncate(limit);
        }

        for session_id in session_ids {
            if self.store.has_session(&session_id) {
                skipped_sessions += 1;
                manifest.sessions.push(AiHistoryMigrationSessionRecord {
                    session_id: session_id.clone(),
                    storage_key: AiHistoryStore::storage_key(&session_id.0),
                    status: "skipped".to_string(),
                    source_message_count: 0,
                    target_message_count: 0,
                    error: None,
                });
                continue;
            }

            let result = match options.mode {
                AiHistoryMigrationMode::Copy => self.copy_session(&session_id),
                AiHistoryMigrationMode::ReadOnly => self.inspect_session(&session_id),
            };
            match result {
                Ok(count) => {
                    migrated_sessions += 1;
                    manifest.sessions.push(AiHistoryMigrationSessionRecord {
                        session_id: session_id.clone(),
                        storage_key: AiHistoryStore::storage_key(&session_id.0),
                        status: match options.mode {
                            AiHistoryMigrationMode::Copy => "migrated",
                            AiHistoryMigrationMode::ReadOnly => "read_only",
                        }
                        .to_string(),
                        source_message_count: count,
                        target_message_count: match options.mode {
                            AiHistoryMigrationMode::Copy => count,
                            AiHistoryMigrationMode::ReadOnly => 0,
                        },
                        error: None,
                    });
                }
                Err(error) => {
                    failed_sessions += 1;
                    let message = redact_history_error(&error);
                    manifest.sessions.push(AiHistoryMigrationSessionRecord {
                        session_id: session_id.clone(),
                        storage_key: AiHistoryStore::storage_key(&session_id.0),
                        status: "failed".to_string(),
                        source_message_count: 0,
                        target_message_count: 0,
                        error: Some(message.clone()),
                    });
                    errors.push(comando_types::ai::NativeAiHistoryMigrationError {
                        session_id: Some(session_id),
                        message,
                    });
                }
            }
        }

        let completed_at = now_iso8601();
        manifest.updated_at = completed_at.clone();
        manifest.completed_at = Some(completed_at.clone());
        if options.mode == AiHistoryMigrationMode::Copy {
            self.save_manifest(&manifest)?;
        }

        Ok(comando_types::ai::NativeAiMigrateSessionHistoryOutput {
            started_at,
            updated_at: completed_at.clone(),
            completed_at: Some(completed_at),
            migrated_sessions,
            skipped_sessions,
            failed_sessions,
            errors,
        })
    }

    fn inspect_session(&self, session_id: &SessionId) -> AiResult<usize> {
        let snapshot = self
            .legacy
            .load_session_snapshot(session_id)?
            .ok_or_else(|| AiError::SessionNotFound {
                session_id: session_id.0.clone(),
            })?;
        Ok(snapshot.messages.len())
    }

    fn copy_session(&self, session_id: &SessionId) -> AiResult<usize> {
        let snapshot = self
            .legacy
            .load_session_snapshot(session_id)?
            .ok_or_else(|| AiError::SessionNotFound {
                session_id: session_id.0.clone(),
            })?;
        let mut metadata = AiHistorySessionMetadata::new_native(AiHistorySessionMetadataInput {
            session_id: snapshot.session_id.clone(),
            runtime_id: snapshot.runtime_id.clone(),
            runtime_session_id: snapshot.runtime_session_id.clone(),
            parent_session_id: snapshot.parent_session_id.clone(),
            project_id: snapshot.project_id.clone(),
            worktree_id: snapshot.worktree_id.clone(),
            title: snapshot.title.clone(),
            status: snapshot.status.clone(),
            model_id: snapshot.model_id.clone(),
            mode_id: snapshot.mode_id.clone(),
            reasoning_effort: snapshot.reasoning_effort.clone(),
            config_values: BTreeMap::new(),
            cwd: String::new(),
            additional_roots: Vec::new(),
        });
        metadata.owner_kind = AiHistoryOwnerKind::MigratedLegacy;
        let legacy_row = self.legacy.query_history_row(session_id)?;
        if let Some(row) = legacy_row.as_ref()
            && let Some(parent_session_id) = row.parent_session_id.as_ref()
        {
            metadata.subagent = Some(AiHistorySubagentMetadata {
                parent_session_id: SessionId(parent_session_id.clone()),
                parent_runtime_session_id: row
                    .parent_runtime_session_id
                    .clone()
                    .map(RuntimeSessionId),
                nickname: None,
            });
        }
        metadata.created_at = legacy_row
            .as_ref()
            .map(|row| row.created_at.clone())
            .unwrap_or_else(now_iso8601);
        metadata.pinned_at = legacy_row.and_then(|row| row.pinned_at);
        metadata.updated_at = snapshot.updated_at;
        metadata.models = snapshot.models;
        metadata.modes = snapshot.modes;
        metadata.config_options = snapshot.config_options;
        metadata.available_commands = snapshot.available_commands;
        metadata.message_count = snapshot.messages.len();
        metadata.preview = derive_session_preview(snapshot.messages.iter());
        self.store.create_session(metadata.clone())?;
        self.store.save_session_state(
            &metadata.session_id,
            &AiHistorySessionState {
                version: HISTORY_FORMAT_VERSION,
                active_turn_started_at: snapshot.active_turn_started_at,
                last_error: snapshot.last_error,
                pending_permission: snapshot.pending_permission,
                pending_user_input: snapshot.pending_user_input,
                plan: snapshot.plan,
                token_usage: snapshot.token_usage,
                tool_activity: snapshot.tool_activity,
                tracked_files: snapshot.tracked_files,
            },
        )?;
        self.store
            .save_transcript_window(&metadata.session_id, snapshot.messages)?;
        Ok(metadata.message_count)
    }

    fn save_manifest(&self, manifest: &AiHistoryMigrationManifest) -> AiResult<()> {
        let path = self
            .store
            .history_root()
            .join("migrations")
            .join("sqlite-history-v1.json");
        atomic_write_json(&path, manifest)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AiHistoryMigrationManifest {
    version: u32,
    source_database_path: Option<String>,
    started_at: String,
    updated_at: String,
    completed_at: Option<String>,
    sessions: Vec<AiHistoryMigrationSessionRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AiHistoryMigrationSessionRecord {
    session_id: SessionId,
    storage_key: String,
    status: String,
    source_message_count: usize,
    target_message_count: usize,
    error: Option<String>,
}

impl AiTranscriptRecord {
    fn from_payload(payload: Value) -> AiResult<Self> {
        let Some(object) = payload.as_object() else {
            return Err(AiError::InvalidInput(
                "AI transcript messages must be JSON objects.".to_string(),
            ));
        };
        let message_id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AiError::InvalidInput("AI transcript message is missing id.".to_string())
            })?
            .to_string();
        let kind = object
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("assistant")
            .to_string();
        let role = object
            .get("role")
            .and_then(Value::as_str)
            .or_else(|| object.get("kind").and_then(Value::as_str))
            .map(str::to_string);
        let hash = hash_message_payload(&payload)?;

        Ok(Self {
            version: HISTORY_FORMAT_VERSION,
            message_id,
            kind,
            role,
            hash,
            payload,
        })
    }
}

fn legacy_transcript_entry(
    session_id: &SessionId,
    message: Value,
) -> AiResult<(NativeAiTranscriptEntryEnvelope, AiTranscriptPayloadWrite)> {
    let object = message.as_object().ok_or_else(|| {
        AiError::InvalidInput("Legacy AI transcript messages must be JSON objects.".to_string())
    })?;
    let message_id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AiError::InvalidInput("Legacy AI transcript message is missing id.".to_string())
        })?
        .to_string();
    let message_kind = object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("assistant");
    let created_at = object
        .get("createdAt")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(now_iso8601);
    let payload_value = json!({ "kind": "message", "message": message });
    // Payload refs include their content version because sealed payloads are
    // immutable while the compatibility transcript may revise a message.
    let payload_ref = format!(
        "legacy-message:{}:{}",
        sha256_hex(message_id.as_bytes()),
        hash_message_payload(&payload_value)?
    );
    let preview = message_preview_text(&message).map(truncate_session_preview);

    Ok((
        NativeAiTranscriptEntryEnvelope {
            id: format!("message:{message_id}"),
            session_id: session_id.clone(),
            sequence: 0,
            kind: if message_kind == "thinking" {
                NativeAiTranscriptEntryKind::Thinking
            } else {
                NativeAiTranscriptEntryKind::Message
            },
            created_at: created_at.clone(),
            updated_at: created_at,
            summary: NativeAiTranscriptEntrySummary {
                label: Some(message_kind.to_string()),
                preview,
                status: object
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                tool_activity_detail_id: None,
                tool_change_stats: None,
                tool_kind: None,
            },
            payload_ref: Some(payload_ref.clone()),
        },
        AiTranscriptPayloadWrite {
            payload_ref,
            value: payload_value,
        },
    ))
}

fn summary_from_metadata(metadata: AiHistorySessionMetadata) -> NativeAiHistorySessionSummary {
    let title = metadata.display_title().to_string();
    NativeAiHistorySessionSummary {
        session_id: metadata.session_id,
        parent_session_id: metadata.parent_session_id,
        runtime_id: metadata.runtime_id,
        runtime_session_id: metadata.runtime_session_id,
        project_id: metadata.project_id,
        worktree_id: metadata.worktree_id,
        title,
        preview: metadata.preview,
        created_at: metadata.created_at,
        updated_at: metadata.updated_at,
        pinned_at: metadata.pinned_at,
        message_count: metadata.message_count,
    }
}

fn summary_from_legacy_row(row: LegacyHistoryRow) -> NativeAiHistorySessionSummary {
    NativeAiHistorySessionSummary {
        session_id: SessionId(row.session_id),
        parent_session_id: row.parent_session_id.map(SessionId),
        runtime_id: RuntimeId(row.runtime_id),
        runtime_session_id: row.runtime_session_id.map(RuntimeSessionId),
        project_id: row.project_id.map(ProjectId),
        worktree_id: row.worktree_id.map(WorktreeId),
        title: row.title,
        preview: row.preview,
        created_at: row.created_at,
        updated_at: row.updated_at,
        pinned_at: row.pinned_at,
        message_count: row.message_count,
    }
}

fn legacy_history_select_sql() -> String {
    "
    SELECT
        chat_sessions.id AS session_id,
        COALESCE(chat_sessions.parent_session_id, runtime_links.parent_app_session_id) AS parent_session_id,
        chat_sessions.project_id,
        chat_sessions.worktree_id,
        chat_sessions.title,
        chat_sessions.runtime,
        runtime_links.runtime_session_id,
        runtime_links.parent_runtime_session_id,
        chat_sessions.status,
        chat_sessions.created_at,
        chat_sessions.updated_at,
        chat_sessions.pinned_at,
        COALESCE(chat_transcripts.message_count, 0) AS message_count,
        chat_transcripts.preview,
        runtime_state.state_json,
        review_state.review_json
    FROM chat_sessions
    LEFT JOIN chat_transcripts
        ON chat_transcripts.session_id = chat_sessions.id
    LEFT JOIN chat_session_runtime_links AS runtime_links
        ON runtime_links.app_session_id = chat_sessions.id
    LEFT JOIN chat_session_runtime_state AS runtime_state
        ON runtime_state.session_id = chat_sessions.id
    LEFT JOIN chat_session_review_state AS review_state
        ON review_state.session_id = chat_sessions.id
    "
    .to_string()
}

fn legacy_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<LegacyHistoryRow> {
    Ok(LegacyHistoryRow {
        session_id: row.get("session_id")?,
        parent_session_id: row.get("parent_session_id")?,
        project_id: row.get("project_id")?,
        worktree_id: row.get("worktree_id")?,
        title: row.get("title")?,
        runtime_id: row.get("runtime")?,
        runtime_session_id: row.get("runtime_session_id")?,
        parent_runtime_session_id: row.get("parent_runtime_session_id")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        pinned_at: row.get("pinned_at")?,
        message_count: row.get::<_, i64>("message_count")?.max(0) as usize,
        preview: row.get("preview")?,
        state_json: row.get("state_json")?,
        review_json: row.get("review_json")?,
    })
}

fn native_status_from_legacy(status: &str) -> NativeAiSessionStatus {
    match status {
        "streaming" => NativeAiSessionStatus::Streaming,
        "waiting_permission" => NativeAiSessionStatus::WaitingPermission,
        "waiting_user_input" => NativeAiSessionStatus::WaitingUserInput,
        "review_required" => NativeAiSessionStatus::ReviewRequired,
        "error" => NativeAiSessionStatus::Error,
        "closed" => NativeAiSessionStatus::Closed,
        _ => NativeAiSessionStatus::Idle,
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn object_array_field(value: &Value, key: &str) -> Option<Vec<Value>> {
    Some(
        value
            .get(key)?
            .as_array()?
            .iter()
            .filter(|entry| entry.is_object())
            .cloned()
            .collect(),
    )
}

fn compare_history_summaries(
    left: &NativeAiHistorySessionSummary,
    right: &NativeAiHistorySessionSummary,
) -> Ordering {
    match (left.pinned_at.is_some(), right.pinned_at.is_some()) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => right.updated_at.cmp(&left.updated_at),
    }
}

fn history_worktree_scope_matches(
    project_id: Option<&ProjectId>,
    stored_worktree_id: Option<&WorktreeId>,
    requested_worktree_id: Option<&WorktreeId>,
) -> bool {
    if stored_worktree_id == requested_worktree_id {
        return true;
    }

    let Some(project_id) = project_id else {
        return false;
    };

    // Primary sessions were historically persisted with either representation.
    match (stored_worktree_id, requested_worktree_id) {
        (None, Some(worktree_id)) | (Some(worktree_id), None) => {
            is_primary_worktree_id(project_id, worktree_id)
        }
        _ => false,
    }
}

fn is_primary_worktree_id(project_id: &ProjectId, worktree_id: &WorktreeId) -> bool {
    worktree_id.0 == format!("{}:primary", project_id.0)
}

fn primary_worktree_id(project_id: &ProjectId) -> String {
    format!("{}:primary", project_id.0)
}

fn should_compact_transcript(
    policy: &HistoryCompactionPolicy,
    physical_bytes: u64,
    index: &AiTranscriptIndex,
) -> bool {
    if physical_bytes == 0 {
        return false;
    }
    if physical_bytes >= policy.force_physical_bytes {
        return true;
    }
    let obsolete_bytes = physical_bytes.saturating_sub(index.indexed_transcript_bytes);
    obsolete_bytes >= policy.min_obsolete_bytes
        && physical_bytes
            > index
                .indexed_transcript_bytes
                .saturating_mul(policy.max_physical_to_indexed_ratio.max(1))
}

fn serialize_record_line(record: &AiTranscriptRecord) -> AiResult<String> {
    serde_json::to_string(record)
        .map_err(|error| history_json("serialize AI transcript record", error))
}

fn hash_message_payload(payload: &Value) -> AiResult<String> {
    let bytes = serde_json::to_vec(payload)
        .map_err(|error| history_json("serialize AI transcript message", error))?;
    Ok(sha256_hex(&bytes))
}

fn merge_tool_activity_detail(previous: &Value, mut next: Value) -> Value {
    let (Some(previous), Some(next_object)) = (previous.as_object(), next.as_object_mut()) else {
        return next;
    };
    for key in ["diffs", "rawInput", "rawOutput", "terminalOutput"] {
        let empty = next_object.get(key).is_none_or(is_empty_activity_value);
        if empty && let Some(value) = previous.get(key) {
            next_object.insert(key.to_string(), value.clone());
        }
    }
    next
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

fn normalize_page_limit(limit: usize) -> usize {
    if limit == 0 {
        DEFAULT_PAGE_LIMIT
    } else {
        limit.min(MAX_PAGE_LIMIT)
    }
}

fn normalize_title(title: String) -> String {
    let title = title.trim();
    if title.is_empty() {
        "AI Session".to_string()
    } else {
        title.to_string()
    }
}

fn derive_session_preview<'a>(
    messages: impl DoubleEndedIterator<Item = &'a Value>,
) -> Option<String> {
    messages
        .rev()
        .find_map(message_preview_text)
        .map(truncate_session_preview)
}

fn truncate_session_preview(preview: String) -> String {
    if preview.len() <= SESSION_PREVIEW_MAX_BYTES {
        return preview;
    }

    let max_preview_bytes = SESSION_PREVIEW_MAX_BYTES.saturating_sub(SESSION_PREVIEW_SUFFIX.len());
    let mut end = max_preview_bytes.min(preview.len());
    while end > 0 && !preview.is_char_boundary(end) {
        end -= 1;
    }

    format!("{}{}", &preview[..end], SESSION_PREVIEW_SUFFIX)
}

fn message_preview_text(message: &Value) -> Option<String> {
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if !content.is_empty() {
        return Some(content);
    }

    if message.get("kind").and_then(Value::as_str) != Some("image") {
        return None;
    }
    let generated_image = message.get("generatedImage")?;
    let status = generated_image
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    if matches!(status.as_str(), "pending" | "in_progress" | "running")
        || message.get("status").and_then(Value::as_str) == Some("streaming")
    {
        return Some("Generating image...".to_string());
    }
    if generated_image.get("error").is_some()
        || matches!(
            status.as_str(),
            "failed" | "error" | "cancelled" | "canceled"
        )
    {
        return Some("Image generation failed".to_string());
    }
    Some("Generated image".to_string())
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> AiResult<T> {
    let text = fs::read_to_string(path)
        .map_err(|error| history_io("read AI history JSON", path, error))?;
    serde_json::from_str(&text).map_err(|error| history_json("parse AI history JSON", error))
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> AiResult<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| history_json("serialize AI history JSON", error))?;
    atomic_write(path, &bytes)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> AiResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| history_error("AI history path has no parent."))?;
    fs::create_dir_all(parent)
        .map_err(|error| history_io("create AI history parent dir", parent, error))?;
    let tmp_path = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("history"),
        Uuid::new_v4()
    ));
    {
        let mut file = File::create(&tmp_path)
            .map_err(|error| history_io("create AI history temp file", &tmp_path, error))?;
        file.write_all(bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|error| history_io("write AI history temp file", &tmp_path, error))?;
    }
    fs::rename(&tmp_path, path)
        .map_err(|error| history_io("install AI history file", path, error))?;
    Ok(())
}

fn copy_or_replace(from: &Path, to: &Path) -> AiResult<()> {
    if to.exists() {
        fs::remove_file(to).map_err(|error| history_io("replace AI history backup", to, error))?;
    }
    fs::copy(from, to).map_err(|error| history_io("copy AI history file", from, error))?;
    Ok(())
}

fn file_len(path: &Path) -> AiResult<u64> {
    Ok(fs::metadata(path)
        .map_err(|error| history_io("stat AI history file", path, error))?
        .len())
}

fn history_io(action: &str, path: &Path, error: std::io::Error) -> AiError {
    AiError::Internal(format!("{action} failed for {}: {error}", path.display()))
}

fn history_json(action: &str, error: serde_json::Error) -> AiError {
    AiError::Internal(format!("{action} failed: {error}"))
}

fn history_sql(action: &str, error: rusqlite::Error) -> AiError {
    AiError::Internal(format!("{action} failed: {error}"))
}

fn history_error(message: impl Into<String>) -> AiError {
    AiError::Internal(message.into())
}

fn redact_history_error(error: &AiError) -> String {
    match error {
        AiError::InvalidInput(_) => "Invalid legacy AI history row.".to_string(),
        AiError::SessionNotFound { .. } => "Legacy AI session was not found.".to_string(),
        _ => "Failed to migrate legacy AI session.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use comando_types::ai::{NativeAiOpenTranscriptEntryRef, NativeAiTranscriptTerminalStatus};

    #[test]
    fn legacy_codex_tool_aliases_are_normalized_and_reasoning_is_removed() {
        let mut activities = vec![
            json!({
                "id": "codex-acp:status:item:command-1",
                "title": "Running command",
                "createdAt": "2026-07-09T10:00:00.000Z",
                "updatedAt": "2026-07-09T10:00:01.000Z",
                "diffs": [],
                "terminalOutput": "legacy output"
            }),
            json!({
                "id": "command-1",
                "title": "Read Cargo.toml",
                "createdAt": "2026-07-09T10:00:02.000Z",
                "updatedAt": "2026-07-09T10:00:03.000Z",
                "diffs": [{ "path": "Cargo.toml" }],
                "terminalOutput": null
            }),
            json!({
                "id": "codex-acp:status:item:reasoning-1",
                "title": "Reasoning"
            }),
            json!({
                "id": "codex-acp:status:item:sleep-1",
                "title": "Waiting"
            }),
            json!({
                "id": "comando:turn:message-1:completed",
                "title": "Completed"
            }),
            json!({
                "id": "acp:turn:message-2",
                "title": "Completed"
            }),
        ];

        assert!(normalize_legacy_codex_tool_activities(&mut activities));
        assert_eq!(activities.len(), 2);
        assert_eq!(activities[0]["id"], "command-1");
        assert_eq!(activities[0]["createdAt"], "2026-07-09T10:00:00.000Z");
        assert_eq!(activities[0]["updatedAt"], "2026-07-09T10:00:03.000Z");
        assert_eq!(activities[0]["terminalOutput"], "legacy output");
        assert_eq!(activities[0]["diffs"][0]["path"], "Cargo.toml");
        assert_eq!(activities[1]["id"], "codex-acp:status:item:sleep-1");
        assert!(!normalize_legacy_codex_tool_activities(&mut activities));
    }
    use rusqlite::Connection;

    fn store() -> (tempfile::TempDir, AiHistoryStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = AiHistoryStore::new(temp.path()).unwrap();
        (temp, store)
    }

    fn metadata(session_id: &str) -> AiHistorySessionMetadata {
        AiHistorySessionMetadata::new_native(AiHistorySessionMetadataInput {
            session_id: SessionId(session_id.to_string()),
            runtime_id: RuntimeId("codex".to_string()),
            runtime_session_id: Some(RuntimeSessionId("runtime_1".to_string())),
            parent_session_id: None,
            project_id: Some(ProjectId("project_1".to_string())),
            worktree_id: Some(WorktreeId("worktree_1".to_string())),
            title: "Session".to_string(),
            status: NativeAiSessionStatus::Idle,
            model_id: Some("gpt-5".to_string()),
            mode_id: Some("agent".to_string()),
            reasoning_effort: None,
            config_values: BTreeMap::new(),
            cwd: "/tmp/project".to_string(),
            additional_roots: vec!["/tmp/other".to_string()],
        })
    }

    fn message(id: &str, content: &str) -> Value {
        json!({
            "attachments": [],
            "content": content,
            "createdAt": "2026-06-20T12:00:00.000Z",
            "id": id,
            "kind": "assistant",
            "status": "completed"
        })
    }

    #[test]
    fn tool_activity_details_are_stored_as_independent_records() {
        let (_temp, store) = store();
        let session_id = SessionId("tool-details".into());
        store.create_session(metadata(&session_id.0)).unwrap();

        store
            .store_tool_activity_detail(
                &session_id,
                "detail-1",
                json!({ "rawInput": { "command": "first" }, "rawOutput": null }),
            )
            .unwrap();
        store
            .store_tool_activity_detail(
                &session_id,
                "detail-2",
                json!({ "rawInput": { "command": "second" }, "rawOutput": null }),
            )
            .unwrap();
        store
            .store_tool_activity_detail(
                &session_id,
                "detail-1",
                json!({ "rawInput": null, "rawOutput": "done" }),
            )
            .unwrap();

        assert!(!store.tool_details_path(&session_id).exists());
        assert_eq!(
            fs::read_dir(store.tool_details_dir(&session_id))
                .unwrap()
                .count(),
            2
        );
        let detail = store
            .load_tool_activity_detail(&session_id, "detail-1")
            .unwrap()
            .unwrap();
        assert_eq!(detail["rawInput"]["command"], "first");
        assert_eq!(detail["rawOutput"], "done");
    }

    fn transcript_entry(
        session_id: &SessionId,
        id: impl Into<String>,
        preview: impl Into<String>,
    ) -> NativeAiTranscriptEntryEnvelope {
        NativeAiTranscriptEntryEnvelope {
            id: id.into(),
            session_id: session_id.clone(),
            sequence: 0,
            kind: comando_types::ai::NativeAiTranscriptEntryKind::Message,
            created_at: "2026-07-18T00:00:00.000Z".to_string(),
            updated_at: "2026-07-18T00:00:00.000Z".to_string(),
            summary: comando_types::ai::NativeAiTranscriptEntrySummary {
                label: None,
                preview: Some(preview.into()),
                status: Some("completed".to_string()),
                tool_activity_detail_id: None,
                tool_change_stats: None,
                tool_kind: None,
            },
            payload_ref: None,
        }
    }

    fn legacy_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE chat_sessions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT,
                    worktree_id TEXT,
                    parent_session_id TEXT,
                    title TEXT NOT NULL,
                    runtime TEXT NOT NULL,
                    status TEXT NOT NULL,
                    draft TEXT NOT NULL DEFAULT '',
                    pinned_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_opened_at TEXT NOT NULL
                );

                CREATE TABLE chat_transcripts (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL UNIQUE,
                    transcript_json TEXT NOT NULL,
                    message_count INTEGER NOT NULL DEFAULT 0,
                    preview TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE chat_transcript_messages (
                    session_id TEXT NOT NULL,
                    message_index INTEGER NOT NULL,
                    message_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    role TEXT,
                    payload_json TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (session_id, message_id),
                    UNIQUE(session_id, message_index)
                );

                CREATE TABLE chat_session_runtime_state (
                    session_id TEXT PRIMARY KEY,
                    state_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE chat_session_review_state (
                    session_id TEXT PRIMARY KEY,
                    review_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE chat_session_runtime_links (
                    runtime_session_id TEXT PRIMARY KEY,
                    app_session_id TEXT NOT NULL UNIQUE,
                    parent_runtime_session_id TEXT,
                    parent_app_session_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                ",
            )
            .unwrap();
        connection
    }

    fn insert_legacy_session(connection: &Connection, session_id: &str, messages: Vec<Value>) {
        let now = "2026-06-20T12:00:00.000Z";
        let message_count = messages.len() as i64;
        connection
            .execute(
                "
                INSERT INTO chat_sessions (
                    id,
                    project_id,
                    worktree_id,
                    parent_session_id,
                    title,
                    runtime,
                    status,
                    pinned_at,
                    created_at,
                    updated_at,
                    last_opened_at
                )
                VALUES (?1, 'project_1', 'worktree_1', NULL, 'Legacy Session', 'codex', 'idle', NULL, ?2, ?2, ?2)
                ",
                (session_id, now),
            )
            .unwrap();
        connection
            .execute(
                "
                INSERT INTO chat_transcripts (
                    id,
                    session_id,
                    transcript_json,
                    message_count,
                    preview,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, ?3, ?4, 'legacy preview', ?5, ?5)
                ",
                (
                    format!("transcript:{session_id}"),
                    session_id,
                    serde_json::to_string(&json!({ "messages": messages })).unwrap(),
                    message_count,
                    now,
                ),
            )
            .unwrap();
        connection
            .execute(
                "
                INSERT INTO chat_session_runtime_links (
                    runtime_session_id,
                    app_session_id,
                    parent_runtime_session_id,
                    parent_app_session_id,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, NULL, NULL, ?3, ?3)
                ",
                (format!("runtime_{session_id}"), session_id, now),
            )
            .unwrap();
    }

    #[test]
    fn storage_key_is_stable_and_path_safe() {
        let first = AiHistoryStore::storage_key("../session/a\\b");
        let second = AiHistoryStore::storage_key("../session/a\\b");

        assert_eq!(first, second);
        assert!(first.starts_with("session-"));
        assert!(!first.contains('/'));
        assert!(!first.contains('\\'));
        assert!(!first.contains(".."));
    }

    #[test]
    fn rejects_empty_app_data_dir() {
        assert!(matches!(
            AiHistoryStore::new(PathBuf::new()),
            Err(AiError::InvalidInput(_))
        ));
    }

    #[test]
    fn metadata_roundtrips_and_does_not_escape_app_data() {
        let (temp, store) = store();
        let metadata = metadata("../dangerous/session");
        store.create_session(metadata.clone()).unwrap();

        let loaded = store.load_metadata(&metadata.session_id).unwrap();
        assert_eq!(loaded.session_id, metadata.session_id);
        assert!(
            store
                .session_dir(&metadata.session_id)
                .starts_with(temp.path())
        );
    }

    #[test]
    fn transcript_page_reads_by_index() {
        let (_temp, store) = store();
        let metadata = metadata("session_1");
        store.create_session(metadata.clone()).unwrap();
        store
            .save_transcript_window(
                &metadata.session_id,
                vec![
                    message("message_1", "one"),
                    message("message_2", "two"),
                    message("message_3", "three"),
                ],
            )
            .unwrap();

        let page = store
            .load_transcript_page(NativeAiLoadSessionTranscriptPageInput {
                session_id: metadata.session_id.clone(),
                offset: 1,
                limit: 1,
            })
            .unwrap()
            .unwrap();

        assert_eq!(page.total_messages, 3);
        assert_eq!(page.messages, vec![message("message_2", "two")]);
    }

    #[test]
    fn transcript_preview_truncates_unicode_without_panicking() {
        let (_temp, store) = store();
        let metadata = metadata("session_unicode_preview");
        store.create_session(metadata.clone()).unwrap();
        let content = format!("{}“ trailing text", "a".repeat(275));

        store
            .save_transcript_window(&metadata.session_id, vec![message("message_1", &content)])
            .unwrap();

        let preview = store.load_metadata(&metadata.session_id).unwrap().preview;
        let preview = preview.expect("preview");
        assert!(preview.ends_with("..."));
        assert!(preview.len() <= 280);
    }

    #[test]
    fn suffix_update_appends_only_changed_tail() {
        let (_temp, store) = store();
        let metadata = metadata("session_1");
        store.create_session(metadata.clone()).unwrap();
        store
            .save_transcript_window(
                &metadata.session_id,
                vec![message("message_1", "one"), message("message_2", "two")],
            )
            .unwrap();
        let initial_len = file_len(&store.transcript_path(&metadata.session_id)).unwrap();

        store
            .save_transcript_window(
                &metadata.session_id,
                vec![
                    message("message_1", "one"),
                    message("message_2", "two updated"),
                ],
            )
            .unwrap();
        let next_len = file_len(&store.transcript_path(&metadata.session_id)).unwrap();

        assert!(next_len > initial_len);
        let page = store
            .load_transcript_page(NativeAiLoadSessionTranscriptPageInput {
                session_id: metadata.session_id,
                offset: 0,
                limit: 10,
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            page.messages,
            vec![
                message("message_1", "one"),
                message("message_2", "two updated")
            ]
        );
    }

    #[test]
    fn list_filters_scope_and_keeps_empty_children() {
        let (_temp, store) = store();
        let mut root = metadata("root");
        root.message_count = 0;
        store.create_session(root.clone()).unwrap();
        let mut child = metadata("child");
        child.parent_session_id = Some(root.session_id.clone());
        child.message_count = 0;
        store.create_session(child.clone()).unwrap();
        let mut other = metadata("other");
        other.project_id = Some(ProjectId("project_2".to_string()));
        other.message_count = 1;
        store.create_session(other).unwrap();

        let history = store
            .list_session_history(NativeAiListSessionHistoryInput {
                project_id: Some(ProjectId("project_1".to_string())),
                worktree_id: Some(WorktreeId("worktree_1".to_string())),
                limit: None,
            })
            .unwrap();

        assert_eq!(history.len(), 1);
        assert_eq!(history[0].session_id, child.session_id);
    }

    #[test]
    fn list_treats_null_and_canonical_primary_worktrees_as_one_scope() {
        let (_temp, store) = store();
        let mut null_primary = metadata("null_primary");
        null_primary.message_count = 1;
        null_primary.worktree_id = None;
        store.create_session(null_primary.clone()).unwrap();

        let mut canonical_primary = metadata("canonical_primary");
        canonical_primary.message_count = 1;
        canonical_primary.worktree_id = Some(WorktreeId("project_1:primary".to_string()));
        store.create_session(canonical_primary.clone()).unwrap();

        for worktree_id in [None, Some(WorktreeId("project_1:primary".to_string()))] {
            let history = store
                .list_session_history(NativeAiListSessionHistoryInput {
                    project_id: Some(ProjectId("project_1".to_string())),
                    worktree_id,
                    limit: None,
                })
                .unwrap();
            let session_ids = history
                .iter()
                .map(|session| session.session_id.clone())
                .collect::<HashSet<_>>();

            assert_eq!(session_ids.len(), 2);
            assert!(session_ids.contains(&null_primary.session_id));
            assert!(session_ids.contains(&canonical_primary.session_id));
        }
    }

    #[test]
    fn subagent_nickname_is_used_as_the_display_title() {
        let (_temp, store) = store();
        let mut child = metadata("child");
        child.parent_session_id = Some(SessionId("parent".to_string()));
        child.title = "Parent prompt title".to_string();
        child.subagent = Some(AiHistorySubagentMetadata {
            parent_session_id: SessionId("parent".to_string()),
            parent_runtime_session_id: Some(RuntimeSessionId("runtime_parent".to_string())),
            nickname: Some("Kierkegaard".to_string()),
        });
        store.create_session(child.clone()).unwrap();

        let snapshot = store
            .load_session_snapshot(&child.session_id)
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.title, "Kierkegaard");

        let history = store
            .list_session_history(NativeAiListSessionHistoryInput {
                project_id: child.project_id.clone(),
                worktree_id: child.worktree_id.clone(),
                limit: None,
            })
            .unwrap();
        assert_eq!(history[0].title, "Kierkegaard");

        store
            .rename_session(&child.session_id, "Custom child title".to_string())
            .unwrap();
        let renamed_snapshot = store
            .load_session_snapshot(&child.session_id)
            .unwrap()
            .unwrap();
        assert_eq!(renamed_snapshot.title, "Kierkegaard");
        assert_eq!(
            renamed_snapshot.manual_title.as_deref(),
            Some("Custom child title")
        );
    }

    #[test]
    fn pin_rename_snapshot_and_delete_work() {
        let (_temp, store) = store();
        let metadata = metadata("session_1");
        store.create_session(metadata.clone()).unwrap();
        store
            .save_transcript_window(&metadata.session_id, vec![message("message_1", "hello")])
            .unwrap();
        store
            .set_session_pinned(&metadata.session_id, true)
            .unwrap();
        store
            .rename_session(&metadata.session_id, "Renamed".to_string())
            .unwrap();

        let snapshot = store
            .load_session_snapshot(&metadata.session_id)
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.title, metadata.title);
        assert_eq!(snapshot.manual_title.as_deref(), Some("Renamed"));
        assert_eq!(snapshot.messages, vec![message("message_1", "hello")]);
        assert!(
            store
                .load_metadata(&metadata.session_id)
                .unwrap()
                .pinned_at
                .is_some()
        );

        store.delete_session(&metadata.session_id).unwrap();
        assert!(!store.has_session(&metadata.session_id));
    }

    #[test]
    fn deleting_a_session_removes_its_persisted_subtree() {
        let (_temp, store) = store();
        let parent = metadata("parent");
        store.create_session(parent.clone()).unwrap();

        let mut child = metadata("child");
        child.parent_session_id = Some(parent.session_id.clone());
        child.subagent = Some(AiHistorySubagentMetadata {
            parent_session_id: parent.session_id.clone(),
            parent_runtime_session_id: parent.runtime_session_id.clone(),
            nickname: Some("Child".to_string()),
        });
        store.create_session(child.clone()).unwrap();

        let mut grandchild = metadata("grandchild");
        grandchild.parent_session_id = Some(child.session_id.clone());
        grandchild.subagent = Some(AiHistorySubagentMetadata {
            parent_session_id: child.session_id.clone(),
            parent_runtime_session_id: child.runtime_session_id.clone(),
            nickname: Some("Grandchild".to_string()),
        });
        store.create_session(grandchild.clone()).unwrap();

        let unrelated = metadata("unrelated");
        store.create_session(unrelated.clone()).unwrap();

        store.delete_session(&parent.session_id).unwrap();

        assert!(!store.has_session(&parent.session_id));
        assert!(!store.has_session(&child.session_id));
        assert!(!store.has_session(&grandchild.session_id));
        assert!(store.has_session(&unrelated.session_id));
    }

    #[test]
    fn snapshot_includes_aggregated_session_state() {
        let (_temp, store) = store();
        let metadata = metadata("session_1");
        store.create_session(metadata.clone()).unwrap();
        store
            .update_session_state(&metadata.session_id, |state| {
                state.active_turn_started_at = Some("2026-06-20T12:00:00.000Z".to_string());
                state.plan = Some(json!({
                    "entries": [],
                    "title": "Plan",
                    "updatedAt": "2026-06-20T12:00:00.000Z"
                }));
                state.pending_permission = Some(json!({
                    "requestId": "permission_1",
                    "sessionId": "session_1",
                    "title": "Permission",
                    "toolCallId": "tool_1",
                    "updatedAt": "2026-06-20T12:00:00.000Z",
                    "description": null,
                    "options": []
                }));
                state.token_usage = Some(json!({
                    "used": 12,
                    "size": 100,
                    "cost": null,
                    "updatedAt": "2026-06-20T12:00:00.000Z"
                }));
                state.tool_activity = vec![json!({
                    "id": "tool_1",
                    "sessionId": "session_1",
                    "kind": "tool",
                    "status": "completed",
                    "title": "Tool",
                    "summary": null,
                    "createdAt": "2026-06-20T12:00:00.000Z",
                    "updatedAt": "2026-06-20T12:00:00.000Z",
                    "action": null,
                    "diffs": [],
                    "exitCode": null,
                    "locations": [],
                    "rawInputJson": null,
                    "rawOutputJson": null,
                    "terminalOutput": null
                })];
            })
            .unwrap();

        let snapshot = store
            .load_session_snapshot(&metadata.session_id)
            .unwrap()
            .unwrap();

        assert_eq!(
            snapshot.active_turn_started_at.as_deref(),
            Some("2026-06-20T12:00:00.000Z")
        );
        assert!(snapshot.plan.is_some());
        assert!(snapshot.pending_permission.is_some());
        assert_eq!(snapshot.token_usage.unwrap()["used"], 12);
        assert_eq!(snapshot.tool_activity.len(), 1);
    }

    #[test]
    fn runtime_mappings_include_all_native_subagent_descendants() {
        let (_temp, store) = store();
        let parent = metadata("parent");
        store.create_session(parent.clone()).unwrap();
        let mut child = metadata("child");
        child.parent_session_id = Some(parent.session_id.clone());
        child.runtime_session_id = Some(RuntimeSessionId("runtime_child".to_string()));
        child.subagent = Some(AiHistorySubagentMetadata {
            parent_session_id: parent.session_id.clone(),
            parent_runtime_session_id: parent.runtime_session_id.clone(),
            nickname: Some("Child".to_string()),
        });
        store.create_session(child.clone()).unwrap();
        let mut grandchild = metadata("grandchild");
        grandchild.parent_session_id = Some(child.session_id.clone());
        grandchild.runtime_session_id = Some(RuntimeSessionId("runtime_grandchild".to_string()));
        grandchild.subagent = Some(AiHistorySubagentMetadata {
            parent_session_id: child.session_id.clone(),
            parent_runtime_session_id: child.runtime_session_id.clone(),
            nickname: Some("Grandchild".to_string()),
        });
        store.create_session(grandchild.clone()).unwrap();

        let mappings = store
            .list_runtime_mappings_for_parent(&parent.session_id)
            .unwrap();

        assert_eq!(mappings.len(), 2);
        assert_eq!(mappings[0].app_session_id, child.session_id);
        assert_eq!(
            mappings[0].parent_app_session_id.as_ref(),
            Some(&parent.session_id)
        );
        assert_eq!(
            mappings[0].runtime_session_id,
            RuntimeSessionId("runtime_child".to_string())
        );
        assert_eq!(mappings[1].app_session_id, grandchild.session_id);
        assert_eq!(
            mappings[1].parent_app_session_id.as_ref(),
            Some(&child.session_id)
        );
        assert_eq!(
            mappings[1].parent_runtime_session_id.as_ref(),
            child.runtime_session_id.as_ref()
        );
    }

    #[test]
    fn runtime_mappings_include_migrated_children_without_subagent_metadata() {
        let (_temp, store) = store();
        let parent = metadata("parent");
        store.create_session(parent.clone()).unwrap();
        let mut child = metadata("child");
        child.parent_session_id = Some(parent.session_id.clone());
        child.runtime_session_id = Some(RuntimeSessionId("runtime_child".to_string()));
        store.create_session(child.clone()).unwrap();

        let mappings = store
            .list_runtime_mappings_for_parent(&parent.session_id)
            .unwrap();

        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].app_session_id, child.session_id);
        assert_eq!(
            mappings[0].parent_app_session_id.as_ref(),
            Some(&parent.session_id)
        );
    }

    #[test]
    fn compaction_rewrites_obsolete_transcript_lines() {
        let (_temp, store) = store();
        let store = store.with_compaction_policy(HistoryCompactionPolicy {
            min_obsolete_bytes: 1,
            max_physical_to_indexed_ratio: 1,
            force_physical_bytes: u64::MAX,
        });
        let metadata = metadata("session_1");
        store.create_session(metadata.clone()).unwrap();
        store
            .save_transcript_window(&metadata.session_id, vec![message("message_1", "one")])
            .unwrap();
        store
            .save_transcript_window(
                &metadata.session_id,
                vec![message("message_1", "one updated")],
            )
            .unwrap();

        let transcript = fs::read_to_string(store.transcript_path(&metadata.session_id)).unwrap();
        assert_eq!(transcript.lines().count(), 1);
        assert!(transcript.contains("one updated"));
    }

    #[test]
    fn recovery_removes_compaction_marker() {
        let (_temp, store) = store();
        let metadata = metadata("session_1");
        store.create_session(metadata.clone()).unwrap();
        store.write_compaction_marker(&metadata.session_id).unwrap();

        store.load_metadata(&metadata.session_id).unwrap();

        assert!(!store.compaction_marker_path(&metadata.session_id).exists());
    }

    #[test]
    fn legacy_reader_prefers_shadow_messages() {
        let connection = legacy_connection();
        let transcript_message = message("message_transcript", "from transcript");
        insert_legacy_session(&connection, "legacy_1", vec![transcript_message]);
        let shadow_message = message("message_shadow", "from shadow");
        connection
            .execute(
                "
                INSERT INTO chat_transcript_messages (
                    session_id,
                    message_index,
                    message_id,
                    kind,
                    role,
                    payload_json,
                    content_hash,
                    created_at,
                    updated_at
                )
                VALUES ('legacy_1', 0, 'message_shadow', 'message', 'assistant', ?1, 'hash', ?2, ?2)
                ",
                (
                    serde_json::to_string(&shadow_message).unwrap(),
                    "2026-06-20T12:00:00.000Z",
                ),
            )
            .unwrap();

        let reader = LegacyAiHistoryReader::new(&connection);
        let page = reader
            .load_transcript_page(NativeAiLoadSessionTranscriptPageInput {
                session_id: SessionId("legacy_1".to_string()),
                offset: 0,
                limit: 10,
            })
            .unwrap()
            .unwrap();

        assert_eq!(page.messages, vec![shadow_message]);
    }

    #[test]
    fn legacy_reader_falls_back_to_transcript_when_runtime_state_messages_empty() {
        let connection = legacy_connection();
        let transcript_message = message("message_transcript", "from transcript");
        insert_legacy_session(&connection, "legacy_1", vec![transcript_message.clone()]);
        connection
            .execute(
                "
                INSERT INTO chat_session_runtime_state (
                    session_id,
                    state_json,
                    created_at,
                    updated_at
                )
                VALUES ('legacy_1', ?1, ?2, ?2)
                ",
                (
                    serde_json::to_string(&json!({ "messages": [] })).unwrap(),
                    "2026-06-20T12:00:00.000Z",
                ),
            )
            .unwrap();

        let reader = LegacyAiHistoryReader::new(&connection);
        let page = reader
            .load_transcript_page(NativeAiLoadSessionTranscriptPageInput {
                session_id: SessionId("legacy_1".to_string()),
                offset: 0,
                limit: 10,
            })
            .unwrap()
            .unwrap();
        let snapshot = reader
            .load_session_snapshot(&SessionId("legacy_1".to_string()))
            .unwrap()
            .unwrap();

        assert_eq!(page.messages, vec![transcript_message.clone()]);
        assert_eq!(snapshot.messages, vec![transcript_message]);
    }

    #[test]
    fn legacy_reader_lists_scoped_history() {
        let connection = legacy_connection();
        insert_legacy_session(&connection, "legacy_1", vec![message("message_1", "hello")]);
        let reader = LegacyAiHistoryReader::new(&connection);

        let history = reader
            .list_session_history(NativeAiListSessionHistoryInput {
                project_id: Some(ProjectId("project_1".to_string())),
                worktree_id: Some(WorktreeId("worktree_1".to_string())),
                limit: None,
            })
            .unwrap();

        assert_eq!(history.len(), 1);
        assert_eq!(
            history[0].runtime_session_id.as_ref().unwrap().0,
            "runtime_legacy_1"
        );
    }

    #[test]
    fn legacy_reader_treats_null_and_canonical_primary_worktrees_as_one_scope() {
        let connection = legacy_connection();
        insert_legacy_session(
            &connection,
            "legacy_null_primary",
            vec![message("one", "hello")],
        );
        insert_legacy_session(
            &connection,
            "legacy_canonical_primary",
            vec![message("two", "hello")],
        );
        connection
            .execute(
                "UPDATE chat_sessions SET worktree_id = NULL WHERE id = 'legacy_null_primary'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE chat_sessions SET worktree_id = ?1 WHERE id = 'legacy_canonical_primary'",
                ["project_1:primary"],
            )
            .unwrap();

        let reader = LegacyAiHistoryReader::new(&connection);
        for worktree_id in [None, Some(WorktreeId("project_1:primary".to_string()))] {
            let history = reader
                .list_session_history(NativeAiListSessionHistoryInput {
                    project_id: Some(ProjectId("project_1".to_string())),
                    worktree_id,
                    limit: None,
                })
                .unwrap();
            let session_ids = history
                .iter()
                .map(|session| session.session_id.clone())
                .collect::<HashSet<_>>();

            assert_eq!(session_ids.len(), 2);
            assert!(session_ids.contains(&SessionId("legacy_null_primary".to_string())));
            assert!(session_ids.contains(&SessionId("legacy_canonical_primary".to_string())));
        }
    }

    #[test]
    fn legacy_reader_loads_tracked_files_from_review_state() {
        let connection = legacy_connection();
        insert_legacy_session(&connection, "legacy_1", vec![message("message_1", "hello")]);
        connection
            .execute(
                "
                INSERT INTO chat_session_review_state (
                    session_id,
                    review_json,
                    created_at,
                    updated_at
                )
                VALUES ('legacy_1', ?1, ?2, ?2)
                ",
                (
                    serde_json::to_string(&json!({
                        "trackedFiles": [
                            {
                                "path": "src/app.ts",
                                "status": "modified"
                            }
                        ]
                    }))
                    .unwrap(),
                    "2026-06-20T12:00:00.000Z",
                ),
            )
            .unwrap();

        let reader = LegacyAiHistoryReader::new(&connection);
        let snapshot = reader
            .load_session_snapshot(&SessionId("legacy_1".to_string()))
            .unwrap()
            .unwrap();

        assert_eq!(snapshot.tracked_files.len(), 1);
        assert_eq!(snapshot.tracked_files[0]["path"], "src/app.ts");
    }

    #[test]
    fn legacy_reader_lists_runtime_mappings_for_parent() {
        let connection = legacy_connection();
        insert_legacy_session(
            &connection,
            "parent",
            vec![message("message_parent", "parent")],
        );
        insert_legacy_session(
            &connection,
            "child",
            vec![message("message_child", "child")],
        );
        insert_legacy_session(
            &connection,
            "grandchild",
            vec![message("message_grandchild", "grandchild")],
        );
        connection
            .execute(
                "UPDATE chat_sessions SET parent_session_id = 'parent' WHERE id = 'child'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE chat_sessions SET parent_session_id = 'child' WHERE id = 'grandchild'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "
                UPDATE chat_session_runtime_links
                SET parent_app_session_id = 'parent',
                    parent_runtime_session_id = 'runtime_parent'
                WHERE app_session_id = 'child'
                ",
                [],
            )
            .unwrap();
        connection
            .execute(
                "
                UPDATE chat_session_runtime_links
                SET parent_app_session_id = 'child',
                    parent_runtime_session_id = 'runtime_child'
                WHERE app_session_id = 'grandchild'
                ",
                [],
            )
            .unwrap();

        let reader = LegacyAiHistoryReader::new(&connection);
        let mappings = reader
            .list_runtime_mappings_for_parent(&SessionId("parent".to_string()))
            .unwrap();

        assert_eq!(mappings.len(), 2);
        assert_eq!(mappings[0].app_session_id, SessionId("child".to_string()));
        assert_eq!(
            mappings[0].runtime_session_id,
            RuntimeSessionId("runtime_child".to_string())
        );
        assert_eq!(
            mappings[0].parent_runtime_session_id.as_ref(),
            Some(&RuntimeSessionId("runtime_parent".to_string()))
        );
        assert_eq!(
            mappings[1].app_session_id,
            SessionId("grandchild".to_string())
        );
        assert_eq!(
            mappings[1].parent_app_session_id.as_ref(),
            Some(&SessionId("child".to_string()))
        );
    }

    #[test]
    fn migrator_copies_legacy_sessions_idempotently() {
        let connection = legacy_connection();
        insert_legacy_session(&connection, "legacy_1", vec![message("message_1", "hello")]);
        connection
            .execute(
                "UPDATE chat_sessions SET pinned_at = ?1 WHERE id = 'legacy_1'",
                ["2026-06-20T12:30:00.000Z"],
            )
            .unwrap();
        let (_temp, store) = store();
        let migrator =
            AiHistoryMigrator::new(&store, &connection, Some("/tmp/comando.sqlite".to_string()));

        let first = migrator.copy_legacy_history().unwrap();
        let second = migrator.copy_legacy_history().unwrap();

        assert_eq!(first.migrated_sessions, 1);
        assert_eq!(first.failed_sessions, 0);
        assert_eq!(second.migrated_sessions, 0);
        assert_eq!(second.skipped_sessions, 1);
        let snapshot = store
            .load_session_snapshot(&SessionId("legacy_1".to_string()))
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.messages, vec![message("message_1", "hello")]);
        assert_eq!(
            store
                .load_metadata(&SessionId("legacy_1".to_string()))
                .unwrap()
                .pinned_at
                .as_deref(),
            Some("2026-06-20T12:30:00.000Z")
        );
        assert!(
            store
                .history_root()
                .join("migrations")
                .join("sqlite-history-v1.json")
                .exists()
        );
    }

    #[test]
    fn migrator_respects_read_only_and_limit() {
        let connection = legacy_connection();
        insert_legacy_session(&connection, "legacy_1", vec![message("message_1", "hello")]);
        insert_legacy_session(&connection, "legacy_2", vec![message("message_2", "world")]);
        let (_temp, store) = store();
        let migrator =
            AiHistoryMigrator::new(&store, &connection, Some("/tmp/comando.sqlite".to_string()));

        let read_only = migrator
            .copy_legacy_history_with_options(AiHistoryMigrationOptions {
                mode: AiHistoryMigrationMode::ReadOnly,
                limit: Some(1),
            })
            .unwrap();

        assert_eq!(read_only.migrated_sessions, 1);
        assert!(!store.has_session(&SessionId("legacy_1".to_string())));
        assert!(
            !store
                .history_root()
                .join("migrations")
                .join("sqlite-history-v1.json")
                .exists()
        );

        let copied = migrator
            .copy_legacy_history_with_options(AiHistoryMigrationOptions {
                mode: AiHistoryMigrationMode::Copy,
                limit: Some(1),
            })
            .unwrap();

        assert_eq!(copied.migrated_sessions, 1);
        assert!(store.has_session(&SessionId("legacy_1".to_string())));
        assert!(!store.has_session(&SessionId("legacy_2".to_string())));
    }

    #[test]
    fn transcript_blocks_use_bounded_sequence_ranges() {
        let (_temp, store) = store();
        let session_id = SessionId("bounded_blocks".to_string());
        let entries = (0..300)
            .map(|index| {
                transcript_entry(
                    &session_id,
                    format!("message-{index}"),
                    format!("fixture-{index}"),
                )
            })
            .collect();
        store
            .seal_transcript_turn(&session_id, "turn-1", entries, vec![])
            .unwrap();

        let metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        assert_eq!(metadata.len(), 2);
        assert_eq!(metadata[0].entry_count, 256);
        assert_eq!(metadata[1].entry_count, 44);
        let second_block = store
            .load_transcript_block(&session_id, &metadata[1].block_id)
            .unwrap()
            .unwrap();
        assert_eq!(second_block.entries.len(), 44);
        assert_eq!(second_block.entries[0].sequence, 257);
    }

    #[test]
    fn block_transcript_capabilities_enforce_ownership() {
        let (_temp, store) = store();
        let session_id = SessionId("paged_capabilities".to_string());
        let mut entries = (0..20)
            .map(|index| {
                transcript_entry(
                    &session_id,
                    format!("message-{index}"),
                    format!("fixture-{index}"),
                )
            })
            .collect::<Vec<_>>();
        entries[0].payload_ref = Some("payload:message-0".to_string());
        store
            .seal_transcript_turn(
                &session_id,
                "turn-1",
                entries,
                vec![AiTranscriptPayloadWrite {
                    payload_ref: "payload:message-0".to_string(),
                    value: json!({ "content": "full payload" }),
                }],
            )
            .unwrap();

        let metadata_output = store
            .load_transcript_block_metadata_output(&session_id)
            .unwrap();
        assert_eq!(metadata_output.capability_version, 1);
        assert_eq!(metadata_output.blocks.len(), 1);
        assert!(metadata_output.transcript_revision > 0);

        let block = store
            .load_transcript_block(&session_id, &metadata_output.blocks[0].block_id)
            .unwrap()
            .unwrap();
        assert_eq!(block.entries.len(), 20);
        assert_eq!(block.entries[0].sequence, 1);

        let payload = store
            .load_native_transcript_payload(&session_id, "payload:message-0", 64 * 1024)
            .unwrap();
        assert_eq!(payload.session_id, session_id);
        assert_eq!(payload.value, json!({ "content": "full payload" }));
        let payload_limit_error = store
            .load_native_transcript_payload(&session_id, "payload:message-0", 1)
            .unwrap_err()
            .to_native_error();
        assert_eq!(
            payload_limit_error.code,
            comando_types::error::NativeErrorCode::TooLarge
        );

        let foreign_session = SessionId("foreign_session".to_string());
        assert!(
            store
                .load_transcript_block(&session_id, "foreign_session:0")
                .unwrap()
                .is_none()
        );
        let foreign_payload_error = store
            .load_native_transcript_payload(&foreign_session, "payload:message-0", 64 * 1024)
            .unwrap_err()
            .to_native_error();
        assert_eq!(
            foreign_payload_error.code,
            comando_types::error::NativeErrorCode::NotFound
        );

        let state = store.transcript_storage_state(&session_id).unwrap();
        assert_eq!(state.mode, NativeAiTranscriptStorageMode::BlockNative);
        assert_eq!(state.storage_version, TRANSCRIPT_SCHEMA_VERSION);

        let legacy_session_id = SessionId("legacy_capability_fallback".to_string());
        store
            .create_session(metadata(&legacy_session_id.0))
            .unwrap();
        let legacy_state = store.transcript_storage_state(&legacy_session_id).unwrap();
        assert_eq!(legacy_state.mode, NativeAiTranscriptStorageMode::Legacy);
    }

    #[test]
    fn transcript_storage_state_backfills_legacy_messages_into_sealed_blocks() {
        let (_temp, store) = store();
        let session_id = SessionId("legacy_transcript_backfill".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(
                &session_id,
                vec![
                    message("legacy-1", "first legacy message"),
                    message("legacy-2", "second legacy message"),
                ],
            )
            .unwrap();

        let state = store.transcript_storage_state(&session_id).unwrap();
        assert_eq!(state.mode, NativeAiTranscriptStorageMode::BlockNative);

        let metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        assert_eq!(metadata.len(), 1);
        let block = store
            .load_transcript_block(&session_id, &metadata[0].block_id)
            .unwrap()
            .unwrap();
        assert_eq!(block.entries.len(), 2);
        let payload = store
            .load_native_transcript_payload(
                &session_id,
                block.entries[0].payload_ref.as_deref().unwrap(),
                1024,
            )
            .unwrap();
        assert_eq!(payload.value["kind"], "message");
        assert_eq!(payload.value["message"]["id"], "legacy-1");

        let snapshot = store.load_session_snapshot(&session_id).unwrap().unwrap();
        assert!(snapshot.messages.is_empty());
        assert!(snapshot.tool_activity.is_empty());
    }

    #[test]
    fn transcript_storage_state_skips_legacy_backfill_for_native_transcripts() {
        let (_temp, store) = store();
        let session_id = SessionId("native_transcript_with_legacy_jsonl".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();
        let message = message("message-1", "native content");
        store
            .save_transcript_window(&session_id, vec![message.clone()])
            .unwrap();
        let (entry, payload) = legacy_transcript_entry(&session_id, message).unwrap();
        store
            .seal_transcript_turn(&session_id, "native-turn", vec![entry], vec![payload])
            .unwrap();

        let state = store.transcript_storage_state(&session_id).unwrap();

        assert_eq!(state.mode, NativeAiTranscriptStorageMode::BlockNative);
        let transcript_store = store.transcript_store(&session_id);
        assert!(
            !transcript_store
                .uses_legacy_transcript_backfill(&session_id)
                .unwrap()
        );
        assert!(
            transcript_store
                .legacy_transcript_backfill_complete(&session_id)
                .unwrap()
        );
    }

    #[test]
    fn transcript_storage_state_keeps_native_entries_authoritative_after_legacy_migration() {
        let (_temp, store) = store();
        let session_id = SessionId("native_entry_after_legacy_migration".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();
        let legacy_message = message("legacy-1", "legacy content");
        store
            .save_transcript_window(&session_id, vec![legacy_message.clone()])
            .unwrap();
        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );

        let native_message = message("native-1", "native content");
        let (entry, payload) =
            legacy_transcript_entry(&session_id, native_message.clone()).unwrap();
        store
            .seal_transcript_turn(&session_id, "native-turn", vec![entry], vec![payload])
            .unwrap();
        store
            .save_transcript_window(&session_id, vec![legacy_message, native_message])
            .unwrap();

        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );
        let entries = store
            .load_transcript_block_metadata(&session_id)
            .unwrap()
            .into_iter()
            .flat_map(|block| {
                store
                    .load_transcript_block(&session_id, &block.block_id)
                    .unwrap()
                    .unwrap()
                    .entries
            })
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(entries, vec!["message:legacy-1", "message:native-1"]);
    }

    #[test]
    fn snapshot_keeps_a_legacy_transcript_visible_when_a_completed_backfill_is_stale() {
        let (_temp, store) = store();
        let session_id = SessionId("stale_legacy_backfill_snapshot".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(&session_id, vec![message("legacy-1", "first")])
            .unwrap();
        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );

        store
            .save_transcript_window(
                &session_id,
                vec![
                    message("legacy-1", "first"),
                    message("legacy-2", "second"),
                    message("legacy-3", "third"),
                ],
            )
            .unwrap();

        let snapshot = store.load_session_snapshot(&session_id).unwrap().unwrap();
        assert_eq!(snapshot.messages.len(), 3);
        assert_eq!(snapshot.messages[2]["id"], "legacy-3");
    }

    #[test]
    fn transcript_storage_state_resumes_a_completed_backfill_when_legacy_history_grows() {
        let (_temp, store) = store();
        let session_id = SessionId("resume_completed_legacy_backfill".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(&session_id, vec![message("legacy-1", "first")])
            .unwrap();
        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );

        store
            .save_transcript_window(
                &session_id,
                vec![
                    message("legacy-1", "first"),
                    message("legacy-2", "second"),
                    message("legacy-3", "third"),
                ],
            )
            .unwrap();

        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );
        let metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        assert_eq!(
            metadata
                .iter()
                .map(|block| block.entry_count)
                .sum::<usize>(),
            3
        );
        assert!(
            store
                .load_session_snapshot(&session_id)
                .unwrap()
                .unwrap()
                .messages
                .is_empty()
        );
    }

    #[test]
    fn transcript_storage_state_reconciles_a_revised_legacy_message() {
        let (_temp, store) = store();
        let session_id = SessionId("reconcile_revised_legacy_message".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(&session_id, vec![message("legacy-1", "draft")])
            .unwrap();
        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );

        store
            .save_transcript_window(&session_id, vec![message("legacy-1", "complete")])
            .unwrap();
        let fallback = store.load_session_snapshot(&session_id).unwrap().unwrap();
        assert_eq!(fallback.messages[0]["content"], "complete");

        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );
        let metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        let block = store
            .load_transcript_block(&session_id, &metadata[0].block_id)
            .unwrap()
            .unwrap();
        let payload = store
            .load_native_transcript_payload(
                &session_id,
                block.entries[0].payload_ref.as_deref().unwrap(),
                1024,
            )
            .unwrap();
        assert_eq!(payload.value["message"]["content"], "complete");
    }

    #[test]
    fn transcript_write_recovery_reconciles_jsonl_written_before_sqlite_invalidation() {
        let (_temp, store) = store();
        let session_id = SessionId("recover_transcript_write_before_sqlite".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(&session_id, vec![message("legacy-1", "draft")])
            .unwrap();
        store.transcript_storage_state(&session_id).unwrap();

        let replacement = message("legacy-1", "complete");
        let record = AiTranscriptRecord::from_payload(replacement.clone()).unwrap();
        let line = serialize_record_line(&record).unwrap();
        let length = line.len() as u64 + 1;
        let offset = file_len(&store.transcript_path(&session_id)).unwrap();
        let next_index = AiTranscriptIndex {
            version: HISTORY_FORMAT_VERSION,
            message_offsets: vec![offset],
            message_lengths: vec![length],
            message_hashes: vec![record.hash],
            message_ids: vec![record.message_id],
            message_kinds: vec![record.kind],
            message_roles: vec![record.role],
            updated_at: now_iso8601(),
            indexed_transcript_bytes: length,
        };
        store
            .write_transcript_write_marker(
                &session_id,
                &TranscriptWriteState {
                    version: HISTORY_FORMAT_VERSION,
                    next_index,
                    first_changed_offset: 0,
                    stale_legacy_entry_ids: vec!["message:legacy-1".to_string()],
                    session_metadata: None,
                },
            )
            .unwrap();
        let mut file = OpenOptions::new()
            .append(true)
            .open(store.transcript_path(&session_id))
            .unwrap();
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .unwrap();

        let snapshot = store.load_session_snapshot(&session_id).unwrap().unwrap();
        assert_eq!(snapshot.messages[0], replacement);
        assert!(!store.transcript_write_marker_path(&session_id).exists());

        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );
        let block_id = &store.load_transcript_block_metadata(&session_id).unwrap()[0].block_id;
        let block = store
            .load_transcript_block(&session_id, block_id)
            .unwrap()
            .unwrap();
        let payload = store
            .load_native_transcript_payload(
                &session_id,
                block.entries[0].payload_ref.as_deref().unwrap(),
                1024,
            )
            .unwrap();
        assert_eq!(payload.value["message"]["content"], "complete");
    }

    #[test]
    fn transcript_write_recovery_restores_metadata_for_a_first_synced_write() {
        let (_temp, store) = store();
        let session_id = SessionId("recover_first_transcript_write_metadata".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();

        let first_message = message("assistant-1", "Recovered first answer.");
        let record = AiTranscriptRecord::from_payload(first_message.clone()).unwrap();
        let line = serialize_record_line(&record).unwrap();
        let length = line.len() as u64 + 1;
        let target_metadata = TranscriptWriteSessionMetadata {
            message_count: 1,
            preview: Some("Recovered first answer.".to_string()),
            updated_at: "2026-07-20T00:00:00.000Z".to_string(),
        };
        let next_index = AiTranscriptIndex {
            version: HISTORY_FORMAT_VERSION,
            message_offsets: vec![0],
            message_lengths: vec![length],
            message_hashes: vec![record.hash],
            message_ids: vec![record.message_id],
            message_kinds: vec![record.kind],
            message_roles: vec![record.role],
            updated_at: target_metadata.updated_at.clone(),
            indexed_transcript_bytes: length,
        };
        store
            .write_transcript_write_marker(
                &session_id,
                &TranscriptWriteState {
                    version: HISTORY_FORMAT_VERSION,
                    next_index,
                    first_changed_offset: 0,
                    stale_legacy_entry_ids: Vec::new(),
                    session_metadata: Some(target_metadata.clone()),
                },
            )
            .unwrap();
        let mut file = OpenOptions::new()
            .append(true)
            .open(store.transcript_path(&session_id))
            .unwrap();
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .unwrap();

        let page = store
            .load_transcript_page(NativeAiLoadSessionTranscriptPageInput {
                session_id: session_id.clone(),
                offset: 0,
                limit: 10,
            })
            .unwrap()
            .unwrap();
        assert_eq!(page.messages, vec![first_message]);
        assert!(!store.transcript_write_marker_path(&session_id).exists());

        let recovered_metadata = store.load_metadata(&session_id).unwrap();
        assert_eq!(
            recovered_metadata.message_count,
            target_metadata.message_count
        );
        assert_eq!(recovered_metadata.preview, target_metadata.preview);
        assert_eq!(recovered_metadata.updated_at, target_metadata.updated_at);
        let history = store
            .list_session_history(NativeAiListSessionHistoryInput {
                project_id: Some(ProjectId("project_1".to_string())),
                worktree_id: Some(WorktreeId("worktree_1".to_string())),
                limit: None,
            })
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].session_id, session_id);
    }

    #[test]
    fn transcript_save_retries_invalidation_after_a_sqlite_failure() {
        let (_temp, store) = store();
        let session_id = SessionId("retry_legacy_invalidation".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(&session_id, vec![message("legacy-1", "draft")])
            .unwrap();
        store.transcript_storage_state(&session_id).unwrap();

        let database_path = store.session_dir(&session_id).join("transcript-v2.sqlite3");
        let original_permissions = fs::metadata(&database_path).unwrap().permissions();
        let mut read_only_permissions = original_permissions.clone();
        read_only_permissions.set_readonly(true);
        fs::set_permissions(&database_path, read_only_permissions).unwrap();
        let failed_save =
            store.save_transcript_window(&session_id, vec![message("legacy-1", "complete")]);
        fs::set_permissions(&database_path, original_permissions).unwrap();
        assert!(failed_save.is_err());

        let recovered_page = store
            .load_transcript_page(NativeAiLoadSessionTranscriptPageInput {
                session_id: session_id.clone(),
                offset: 0,
                limit: 1,
            })
            .unwrap()
            .unwrap();
        assert_eq!(recovered_page.messages[0]["content"], "complete");

        store
            .save_transcript_window(&session_id, vec![message("legacy-1", "complete")])
            .unwrap();
        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );
        let metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        let block = store
            .load_transcript_block(&session_id, &metadata[0].block_id)
            .unwrap()
            .unwrap();
        let payload = store
            .load_native_transcript_payload(
                &session_id,
                block.entries[0].payload_ref.as_deref().unwrap(),
                1024,
            )
            .unwrap();
        assert_eq!(payload.value["message"]["content"], "complete");
    }

    #[test]
    fn transcript_storage_state_removes_entries_truncated_from_legacy_history() {
        let (_temp, store) = store();
        let session_id = SessionId("truncate_legacy_transcript".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(
                &session_id,
                vec![message("legacy-1", "first"), message("legacy-2", "removed")],
            )
            .unwrap();
        store.transcript_storage_state(&session_id).unwrap();
        let metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        let obsolete_payload_ref = store
            .load_transcript_block(&session_id, &metadata[0].block_id)
            .unwrap()
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.id == "message:legacy-2")
            .unwrap()
            .payload_ref
            .unwrap();

        store
            .save_transcript_window(&session_id, vec![message("legacy-1", "first")])
            .unwrap();
        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );

        let metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        let entries = metadata
            .iter()
            .flat_map(|block| {
                store
                    .load_transcript_block(&session_id, &block.block_id)
                    .unwrap()
                    .unwrap()
                    .entries
            })
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(entries, vec!["message:legacy-1"]);
        assert!(
            store
                .load_native_transcript_payload(&session_id, &obsolete_payload_ref, 1024)
                .is_err()
        );
    }

    #[test]
    fn transcript_storage_state_completes_a_legacy_backfill_truncated_to_empty() {
        let (_temp, store) = store();
        let session_id = SessionId("empty_legacy_transcript_after_truncation".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(&session_id, vec![message("legacy-1", "first")])
            .unwrap();
        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );

        store
            .save_transcript_window(&session_id, Vec::new())
            .unwrap();

        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );
        assert!(
            store
                .load_transcript_block_metadata(&session_id)
                .unwrap()
                .is_empty()
        );
        let snapshot = store.load_session_snapshot(&session_id).unwrap().unwrap();
        assert!(snapshot.messages.is_empty());
    }

    #[test]
    fn transcript_storage_state_replaces_legacy_entries_with_new_ids() {
        let (_temp, store) = store();
        let session_id = SessionId("replace_legacy_transcript_id".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(
                &session_id,
                vec![
                    message("legacy-1", "first"),
                    message("legacy-2", "replaced"),
                ],
            )
            .unwrap();
        store.transcript_storage_state(&session_id).unwrap();
        let metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        let obsolete_payload_ref = store
            .load_transcript_block(&session_id, &metadata[0].block_id)
            .unwrap()
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.id == "message:legacy-2")
            .unwrap()
            .payload_ref
            .unwrap();

        store
            .save_transcript_window(
                &session_id,
                vec![
                    message("legacy-1", "first"),
                    message("legacy-3", "replacement"),
                ],
            )
            .unwrap();
        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );

        let metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        let entries = metadata
            .iter()
            .flat_map(|block| {
                store
                    .load_transcript_block(&session_id, &block.block_id)
                    .unwrap()
                    .unwrap()
                    .entries
            })
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(entries, vec!["message:legacy-1", "message:legacy-3"]);
        assert!(
            store
                .load_native_transcript_payload(&session_id, &obsolete_payload_ref, 1024)
                .is_err()
        );
    }

    #[test]
    fn transcript_storage_state_resumes_a_partial_legacy_backfill() {
        let (_temp, store) = store();
        let session_id = SessionId("resume_legacy_transcript_backfill".to_string());
        let messages = (0..300)
            .map(|index| message(&format!("legacy-{index}"), "legacy content"))
            .collect::<Vec<_>>();
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(&session_id, messages.clone())
            .unwrap();

        let transcript_store = store.transcript_store(&session_id);
        transcript_store
            .begin_legacy_transcript_backfill(&session_id)
            .unwrap();
        let first_page = messages[..256]
            .iter()
            .cloned()
            .map(|message| legacy_transcript_entry(&session_id, message))
            .collect::<AiResult<Vec<_>>>()
            .unwrap();
        let (entries, payloads): (Vec<_>, Vec<_>) = first_page.into_iter().unzip();
        transcript_store
            .seal_turn(&session_id, "legacy-transcript:0", entries, payloads)
            .unwrap();
        transcript_store
            .advance_legacy_transcript_backfill(&session_id, 256, false)
            .unwrap();

        let state = store.transcript_storage_state(&session_id).unwrap();
        assert_eq!(state.mode, NativeAiTranscriptStorageMode::BlockNative);
        let metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        assert_eq!(metadata.len(), 2);
        assert_eq!(
            metadata
                .iter()
                .map(|block| block.entry_count)
                .sum::<usize>(),
            300
        );
    }

    #[test]
    fn transcript_reconciliation_removes_replaced_legacy_entry_after_native_gap() {
        let (_temp, store) = store();
        let session_id = SessionId("mixed_transcript_reconciliation".to_string());
        let mut messages = (0..300)
            .map(|index| message(&format!("legacy-{index}"), "legacy content"))
            .collect::<Vec<_>>();
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(&session_id, messages.clone())
            .unwrap();

        let transcript_store = store.transcript_store(&session_id);
        transcript_store
            .begin_legacy_transcript_backfill(&session_id)
            .unwrap();
        let (native_entry, native_payload) =
            legacy_transcript_entry(&session_id, messages[0].clone()).unwrap();
        transcript_store
            .seal_turn(
                &session_id,
                "native-turn",
                vec![native_entry],
                vec![native_payload],
            )
            .unwrap();

        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::Migrating
        );

        messages[100] = message("legacy-replacement", "replacement content");
        store.save_transcript_window(&session_id, messages).unwrap();
        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );

        let entry_ids = store
            .load_transcript_block_metadata(&session_id)
            .unwrap()
            .into_iter()
            .flat_map(|block| {
                store
                    .load_transcript_block(&session_id, &block.block_id)
                    .unwrap()
                    .unwrap()
                    .entries
            })
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(entry_ids.len(), 300);
        assert!(!entry_ids.contains(&"message:legacy-100".to_string()));
        assert!(entry_ids.contains(&"message:legacy-replacement".to_string()));
    }

    #[test]
    fn schema_upgrade_keeps_an_incomplete_legacy_backfill_with_native_entries() {
        let (_temp, store) = store();
        let session_id = SessionId("schema_upgrade_partial_legacy_backfill".to_string());
        let mut messages = (0..300)
            .map(|index| message(&format!("legacy-{index}"), "legacy content"))
            .collect::<Vec<_>>();
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(&session_id, messages.clone())
            .unwrap();

        let transcript_store = store.transcript_store(&session_id);
        transcript_store
            .begin_legacy_transcript_backfill(&session_id)
            .unwrap();
        let first_page = messages[..256]
            .iter()
            .cloned()
            .map(|message| legacy_transcript_entry(&session_id, message))
            .collect::<AiResult<Vec<_>>>()
            .unwrap();
        let (entries, payloads): (Vec<_>, Vec<_>) = first_page.into_iter().unzip();
        transcript_store
            .seal_turn(&session_id, "legacy-transcript:0", entries, payloads)
            .unwrap();
        transcript_store
            .advance_legacy_transcript_backfill(&session_id, 256, false)
            .unwrap();

        let native_message = message("native-1", "native content");
        let (entry, payload) =
            legacy_transcript_entry(&session_id, native_message.clone()).unwrap();
        transcript_store
            .seal_turn(&session_id, "native-turn", vec![entry], vec![payload])
            .unwrap();
        messages.push(native_message);
        store.save_transcript_window(&session_id, messages).unwrap();

        let database_path = store.session_dir(&session_id).join("transcript-v2.sqlite3");
        let connection = Connection::open(database_path).unwrap();
        connection
            .execute_batch(
                "ALTER TABLE transcript_sessions DROP COLUMN transcript_origin;
                 PRAGMA user_version = 5;",
            )
            .unwrap();
        drop(connection);

        assert_eq!(
            store.transcript_storage_state(&session_id).unwrap().mode,
            NativeAiTranscriptStorageMode::BlockNative
        );
        let entry_count = store
            .load_transcript_block_metadata(&session_id)
            .unwrap()
            .into_iter()
            .map(|block| block.entry_count)
            .sum::<usize>();
        assert_eq!(entry_count, 301);
    }

    #[test]
    fn transcript_storage_state_reuses_the_legacy_index_between_backfill_pages() {
        let (_temp, store) = store();
        let session_id = SessionId("cached_legacy_transcript_backfill".to_string());
        let messages = (0..300)
            .map(|index| message(&format!("legacy-{index}"), "legacy content"))
            .collect::<Vec<_>>();
        store.create_session(metadata(&session_id.0)).unwrap();
        store.save_transcript_window(&session_id, messages).unwrap();

        let first_state = store.transcript_storage_state(&session_id).unwrap();
        assert_eq!(first_state.mode, NativeAiTranscriptStorageMode::Migrating);
        fs::write(store.index_path(&session_id), "not valid JSON").unwrap();

        let completed_state = store.transcript_storage_state(&session_id).unwrap();
        assert_eq!(
            completed_state.mode,
            NativeAiTranscriptStorageMode::BlockNative
        );
        let metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        assert_eq!(metadata.len(), 2);
    }

    #[test]
    #[ignore = "stress gate for the block-native SQLite migration path"]
    fn block_native_extreme_history_stays_paged_after_migration() {
        let (_temp, store) = store();
        let session_id = SessionId("extreme_block_native_history".to_string());
        let messages = (0..10_000)
            .map(|index| message(&format!("legacy-{index}"), "synthetic content"))
            .collect::<Vec<_>>();
        store.create_session(metadata(&session_id.0)).unwrap();
        store.save_transcript_window(&session_id, messages).unwrap();

        let mut state = store.transcript_storage_state(&session_id).unwrap();
        while state.mode == NativeAiTranscriptStorageMode::Migrating {
            state = store.transcript_storage_state(&session_id).unwrap();
        }
        assert_eq!(state.mode, NativeAiTranscriptStorageMode::BlockNative);

        let snapshot = store.load_session_snapshot(&session_id).unwrap().unwrap();
        assert!(snapshot.messages.is_empty());
        assert!(snapshot.tool_activity.is_empty());

        let metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        assert_eq!(metadata.len(), 40);
        assert_eq!(
            metadata
                .iter()
                .map(|block| block.entry_count)
                .sum::<usize>(),
            10_000
        );
    }

    #[test]
    fn open_transcript_tail_recovers_order_and_seals_idempotently() {
        let (temp, store) = store();
        let session_id = SessionId("recover_open_tail".to_string());
        let mut first = transcript_entry(&session_id, "message-1", "first draft");
        first.payload_ref = Some("tail:message-1".to_string());
        store
            .checkpoint_open_transcript_tail(NativeAiCheckpointOpenTranscriptTailInput {
                session_id: session_id.clone(),
                turn_id: "turn-1".to_string(),
                terminal_status: None,
                entries: vec![first.clone()],
                payloads: vec![AiTranscriptPayloadWrite {
                    payload_ref: "tail:message-1".to_string(),
                    value: json!({ "kind": "message", "content": "first draft" }),
                }],
                removed_entry_ids: Vec::new(),
                entry_order: vec![NativeAiOpenTranscriptEntryRef {
                    entry_id: first.id.clone(),
                    entry_revision: 1,
                    ordinal: 0,
                }],
            })
            .unwrap();

        first.summary.preview = Some("final first".to_string());
        first.updated_at = "2026-07-18T00:00:01.000Z".to_string();
        let mut second = transcript_entry(&session_id, "message-2", "second");
        second.payload_ref = Some("tail:message-2".to_string());
        store
            .checkpoint_open_transcript_tail(NativeAiCheckpointOpenTranscriptTailInput {
                session_id: session_id.clone(),
                turn_id: "turn-1".to_string(),
                terminal_status: Some(NativeAiTranscriptTerminalStatus::Cancelled),
                entries: vec![second.clone(), first.clone()],
                payloads: vec![
                    AiTranscriptPayloadWrite {
                        payload_ref: "tail:message-1".to_string(),
                        value: json!({ "kind": "message", "content": "final first" }),
                    },
                    AiTranscriptPayloadWrite {
                        payload_ref: "tail:message-2".to_string(),
                        value: json!({ "kind": "message", "content": "second" }),
                    },
                ],
                removed_entry_ids: Vec::new(),
                entry_order: vec![
                    NativeAiOpenTranscriptEntryRef {
                        entry_id: first.id.clone(),
                        entry_revision: 2,
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
        assert!(
            store
                .load_transcript_block_metadata(&session_id)
                .unwrap()
                .is_empty()
        );
        drop(store);

        let reopened = AiHistoryStore::new(temp.path()).unwrap();
        let recovered = reopened
            .load_open_transcript_tail(&session_id)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.turn_id, "turn-1");
        assert_eq!(
            recovered.terminal_status,
            Some(NativeAiTranscriptTerminalStatus::Cancelled)
        );
        assert_eq!(
            recovered
                .entries
                .iter()
                .map(|entry| (entry.id.as_str(), entry.sequence))
                .collect::<Vec<_>>(),
            vec![("message-1", 1), ("message-2", 2)]
        );
        assert_eq!(recovered.payloads[0].payload_ref, "tail:message-1");
        assert_eq!(
            recovered.payloads[0].value,
            json!({ "kind": "message", "content": "final first" })
        );
        assert_eq!(recovered.payloads[1].payload_ref, "tail:message-2");
        assert_eq!(
            recovered.payloads[1].value,
            json!({ "kind": "message", "content": "second" })
        );

        let sealed = reopened
            .seal_transcript_turn(
                &session_id,
                "turn-1",
                recovered.entries.clone(),
                recovered.payloads.clone(),
            )
            .unwrap();
        let resealed = reopened
            .seal_transcript_turn(&session_id, "turn-1", recovered.entries, recovered.payloads)
            .unwrap();

        assert_eq!(sealed, resealed);
        assert_eq!(sealed.len(), 1);
        assert!(
            reopened
                .load_open_transcript_tail(&session_id)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn interrupted_native_tail_is_absent_from_sealed_history_after_restart() {
        let (temp, store) = store();
        let session_id = SessionId("interrupted_native_tail".to_string());
        let legacy_message = message("assistant-1", "Recovered streamed output.");
        store.create_session(metadata(&session_id.0)).unwrap();
        store
            .save_transcript_window(&session_id, vec![legacy_message.clone()])
            .unwrap();

        let mut entry = transcript_entry(
            &session_id,
            "message:assistant-1",
            "Recovered streamed output.",
        );
        entry.payload_ref = Some("tail:assistant-1".to_string());
        store
            .checkpoint_open_transcript_tail(NativeAiCheckpointOpenTranscriptTailInput {
                session_id: session_id.clone(),
                turn_id: "interrupted-turn".to_string(),
                terminal_status: None,
                entries: vec![entry],
                payloads: vec![AiTranscriptPayloadWrite {
                    payload_ref: "tail:assistant-1".to_string(),
                    value: json!({ "kind": "message", "message": legacy_message }),
                }],
                removed_entry_ids: Vec::new(),
                entry_order: vec![NativeAiOpenTranscriptEntryRef {
                    entry_id: "message:assistant-1".to_string(),
                    entry_revision: 1,
                    ordinal: 0,
                }],
            })
            .unwrap();
        drop(store);

        let reopened = AiHistoryStore::new(temp.path()).unwrap();
        let snapshot = reopened
            .load_session_snapshot(&session_id)
            .unwrap()
            .unwrap();
        let page = reopened
            .load_transcript_page(NativeAiLoadSessionTranscriptPageInput {
                session_id: session_id.clone(),
                offset: 0,
                limit: 10,
            })
            .unwrap()
            .unwrap();

        // The native snapshot delegates history to sealed blocks, but an
        // interrupted tail has not produced one yet.
        assert!(snapshot.messages.is_empty());
        assert_eq!(page.messages.len(), 1);
        assert!(
            reopened
                .load_transcript_block_metadata(&session_id)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            reopened
                .load_open_transcript_tail(&session_id)
                .unwrap()
                .unwrap()
                .entries
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["message:assistant-1"]
        );
    }

    #[test]
    fn restart_reconciles_terminal_tail_so_history_and_block_native_chat_are_complete() {
        let (temp, store) = store();
        let session_id = SessionId("restart_terminal_tail_reconciliation".to_string());
        let mut session_metadata = metadata(&session_id.0);
        session_metadata.status = NativeAiSessionStatus::Streaming;
        store.create_session(session_metadata).unwrap();

        // History continues to read the compatibility transcript while an open
        // terminal tail can leave the block-native projection incomplete.
        store
            .save_transcript_window(
                &session_id,
                vec![
                    message("assistant-a", "First durable answer."),
                    message("assistant-b", "Completed answer awaiting recovery."),
                ],
            )
            .unwrap();

        let first = transcript_entry(&session_id, "message:assistant-a", "First durable answer.");
        let second = transcript_entry(
            &session_id,
            "message:assistant-b",
            "Completed answer awaiting recovery.",
        );
        store
            .seal_transcript_turn(&session_id, "turn-a", vec![first.clone()], vec![])
            .unwrap();
        store
            .checkpoint_open_transcript_tail(NativeAiCheckpointOpenTranscriptTailInput {
                session_id: session_id.clone(),
                turn_id: "turn-b".to_string(),
                terminal_status: Some(NativeAiTranscriptTerminalStatus::Completed),
                entries: vec![first.clone(), second.clone()],
                payloads: vec![],
                removed_entry_ids: vec![],
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
        drop(store);

        let reopened = AiHistoryStore::new(temp.path()).unwrap();
        let startup_snapshot = reopened
            .load_session_snapshot(&session_id)
            .unwrap()
            .unwrap();
        assert_eq!(startup_snapshot.status, NativeAiSessionStatus::Streaming);
        assert!(startup_snapshot.messages.is_empty());
        let history = reopened
            .load_transcript_page(NativeAiLoadSessionTranscriptPageInput {
                session_id: session_id.clone(),
                offset: 0,
                limit: 10,
            })
            .unwrap()
            .unwrap();
        assert_eq!(history.messages.len(), 2);
        assert_eq!(
            reopened
                .load_transcript_block_metadata(&session_id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            reopened
                .load_open_transcript_tail(&session_id)
                .unwrap()
                .unwrap()
                .terminal_status,
            Some(NativeAiTranscriptTerminalStatus::Completed)
        );

        let metadata = reopened
            .reconcile_terminal_open_transcript_tail(&session_id, "turn-b")
            .unwrap();
        assert!(
            reopened
                .load_open_transcript_tail(&session_id)
                .unwrap()
                .is_none()
        );
        assert_eq!(metadata.len(), 2);

        let block_entry_ids = metadata
            .iter()
            .flat_map(|block| {
                reopened
                    .load_transcript_block(&session_id, &block.block_id)
                    .unwrap()
                    .unwrap()
                    .entries
            })
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(block_entry_ids, vec![first.id, second.id]);
        assert_eq!(
            reopened
                .load_transcript_page(NativeAiLoadSessionTranscriptPageInput {
                    session_id: session_id.clone(),
                    offset: 0,
                    limit: 10,
                })
                .unwrap()
                .unwrap()
                .messages
                .len(),
            2
        );

        assert_eq!(
            reopened
                .reconcile_terminal_open_transcript_tail(&session_id, "turn-b")
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn sealing_turn_persists_payload_and_stable_block_revision() {
        let (_temp, store) = store();
        let session_id = SessionId("sealed_turn".to_string());
        let mut entry = transcript_entry(&session_id, "message-1", "collapsed summary");
        entry.payload_ref = Some("payload:message-1".to_string());
        let payload = AiTranscriptPayloadWrite {
            payload_ref: "payload:message-1".to_string(),
            value: json!({ "content": "full payload", "toolOutput": [1, 2, 3] }),
        };

        let sealed = store
            .seal_transcript_turn(
                &session_id,
                "turn-1",
                vec![entry.clone()],
                vec![payload.clone()],
            )
            .unwrap();
        assert_eq!(sealed.len(), 1);
        assert_eq!(sealed[0].revision, 2);
        let loaded_payload = store
            .load_transcript_payload(&session_id, "payload:message-1", 1024)
            .unwrap();
        assert_eq!(loaded_payload.value, payload.value);

        let resealed = store
            .seal_transcript_turn(&session_id, "turn-1", vec![entry.clone()], vec![payload])
            .unwrap();
        assert_eq!(resealed[0].revision, 2);

        let mut corrected = entry;
        corrected.summary.preview = Some("corrected summary".to_string());
        store
            .append_transcript_entries(&session_id, vec![corrected])
            .unwrap();
        let corrected_metadata = store.load_transcript_block_metadata(&session_id).unwrap();
        assert_eq!(corrected_metadata[0].revision, 3);

        let next_entry = transcript_entry(&session_id, "message-2", "next turn");
        let next_blocks = store
            .seal_transcript_turn(&session_id, "turn-2", vec![next_entry], vec![])
            .unwrap();
        assert_eq!(next_blocks.len(), 1);
        assert_eq!(next_blocks[0].block_id, format!("{}:1", session_id.0));
        assert_eq!(next_blocks[0].start_sequence, 2);
    }

    #[test]
    fn consecutive_turns_seal_scoped_status_and_plan_entries() {
        let (_temp, store) = store();
        let session_id = SessionId("scoped_turn_markers".to_string());

        let mut first_status = transcript_entry(
            &session_id,
            "status:active-turn:turn-1",
            "First turn is streaming",
        );
        first_status.kind = comando_types::ai::NativeAiTranscriptEntryKind::Status;
        let mut first_plan = transcript_entry(&session_id, "plan:active:turn-1", "First turn plan");
        first_plan.kind = comando_types::ai::NativeAiTranscriptEntryKind::Plan;

        let first_blocks = store
            .seal_transcript_turn(
                &session_id,
                "turn-1",
                vec![first_status, first_plan],
                vec![],
            )
            .unwrap();

        let mut second_status = transcript_entry(
            &session_id,
            "status:active-turn:turn-2",
            "Second turn is streaming",
        );
        second_status.kind = comando_types::ai::NativeAiTranscriptEntryKind::Status;
        let mut second_plan =
            transcript_entry(&session_id, "plan:active:turn-2", "Second turn plan");
        second_plan.kind = comando_types::ai::NativeAiTranscriptEntryKind::Plan;

        let second_blocks = store
            .seal_transcript_turn(
                &session_id,
                "turn-2",
                vec![second_status, second_plan],
                vec![],
            )
            .unwrap();

        assert_eq!(first_blocks.len(), 1);
        assert_eq!(second_blocks.len(), 1);
        assert_ne!(first_blocks[0].block_id, second_blocks[0].block_id);
        assert_eq!(
            store
                .load_transcript_block_metadata(&session_id)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn failed_turn_seal_rolls_back_entries_blocks_and_orphaned_payload_file() {
        let (_temp, store) = store();
        let session_id = SessionId("failed_seal".to_string());
        let mut entry = transcript_entry(&session_id, "message-1", "summary");
        entry.payload_ref = Some("payload:missing".to_string());
        let large_payload = AiTranscriptPayloadWrite {
            payload_ref: "payload:unused".to_string(),
            value: Value::String("x".repeat(70 * 1024)),
        };

        let error = store
            .seal_transcript_turn(&session_id, "turn-1", vec![entry], vec![large_payload])
            .unwrap_err();

        assert!(error.to_string().contains("was not persisted"));
        assert!(
            store
                .load_transcript_block_metadata(&session_id)
                .unwrap()
                .is_empty()
        );
        let payloads_dir = store.session_dir(&session_id).join("transcript-payloads");
        assert!(!payloads_dir.exists() || fs::read_dir(payloads_dir).unwrap().next().is_none());
    }

    #[test]
    fn transcript_payloads_are_session_scoped_limited_and_health_checked() {
        let (_temp, store) = store();
        let session_id = SessionId("payload_owner".to_string());
        store.create_session(metadata(&session_id.0)).unwrap();
        let mut entry = transcript_entry(&session_id, "message-1", "summary");
        entry.payload_ref = Some("payload:large".to_string());
        let payload_value = Value::String("x".repeat(70 * 1024));
        store
            .seal_transcript_turn(
                &session_id,
                "turn-1",
                vec![entry],
                vec![AiTranscriptPayloadWrite {
                    payload_ref: "payload:large".to_string(),
                    value: payload_value.clone(),
                }],
            )
            .unwrap();

        let limit_error = store
            .load_transcript_payload(&session_id, "payload:large", 1024)
            .unwrap_err();
        let foreign_error = store
            .load_transcript_payload(
                &SessionId("different_session".to_string()),
                "payload:large",
                128 * 1024,
            )
            .unwrap_err();
        let loaded = store
            .load_transcript_payload(&session_id, "payload:large", 128 * 1024)
            .unwrap();
        let health = store.storage_health().unwrap();

        assert!(limit_error.to_string().contains("exceeds the requested"));
        assert!(
            foreign_error
                .to_string()
                .contains("not found for this session")
        );
        assert_eq!(loaded.value, payload_value);
        assert_eq!(health.storage_version, TRANSCRIPT_SCHEMA_VERSION);
        assert!(health.healthy);
        assert_eq!(
            fs::read_dir(store.session_dir(&session_id).join("transcript-payloads"))
                .unwrap()
                .count(),
            1
        );
    }
}
