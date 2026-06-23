use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use comando_types::ai::{
    NativeAiHistorySessionSummary, NativeAiHistoryStorageHealth, NativeAiListSessionHistoryInput,
    NativeAiLoadSessionTranscriptPageInput, NativeAiRuntimeSessionMapping, NativeAiSessionSnapshot,
    NativeAiSessionStatus, NativeAiSessionTranscriptPage,
};
use comando_types::ids::{ProjectId, RuntimeId, RuntimeSessionId, SessionId, WorktreeId};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AiError, AiResult};
use crate::events::now_iso8601;

pub const HISTORY_FORMAT_VERSION: u32 = 1;
const AI_DIR: &str = "ai";
const SESSIONS_DIR: &str = "sessions";
const SESSION_META_FILE: &str = "session-meta.json";
const SESSION_STATE_FILE: &str = "session-state.json";
const SESSION_TRANSCRIPT_FILE: &str = "transcript.jsonl";
const SESSION_INDEX_FILE: &str = "index.json";
const SESSION_COMPACT_STATE_FILE: &str = "compact-state.json";
const DEFAULT_PAGE_LIMIT: usize = 50;
const MAX_PAGE_LIMIT: usize = 200;
const MB: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct AiHistoryStore {
    app_data_dir: PathBuf,
    compaction_policy: HistoryCompactionPolicy,
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
        read_json_file(&path)
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

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&transcript_path)
            .map_err(|error| history_io("open AI transcript", &transcript_path, error))?;
        for record in records.iter().skip(reuse_len) {
            let offset = file
                .seek(SeekFrom::End(0))
                .map_err(|error| history_io("seek AI transcript", &transcript_path, error))?;
            let line = serialize_record_line(record)?;
            file.write_all(line.as_bytes())
                .and_then(|_| file.write_all(b"\n"))
                .map_err(|error| history_io("append AI transcript", &transcript_path, error))?;
            let length = line.len() as u64 + 1;
            next_index.message_offsets.push(offset);
            next_index.message_lengths.push(length);
            next_index.message_hashes.push(record.hash.clone());
            next_index.message_ids.push(record.message_id.clone());
            next_index.message_kinds.push(record.kind.clone());
            next_index.message_roles.push(record.role.clone());
            next_index.indexed_transcript_bytes += length;
        }
        file.sync_all()
            .map_err(|error| history_io("sync AI transcript", &transcript_path, error))?;

        metadata.message_count = records.len();
        metadata.preview = derive_session_preview(records.iter().map(|record| &record.payload));
        metadata.updated_at = now_iso8601();
        self.save_index(session_id, &next_index)?;
        self.save_metadata(&metadata)?;
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

    pub fn load_session_snapshot(
        &self,
        session_id: &SessionId,
    ) -> AiResult<Option<NativeAiSessionSnapshot>> {
        if !self.has_session(session_id) {
            return Ok(None);
        }
        let metadata = self.load_metadata(session_id)?;
        let state = self.load_session_state(session_id)?;
        let index = self.load_or_repair_index(session_id)?;
        let messages = self.read_payloads_by_index(session_id, &index, 0, index.len())?;

        Ok(Some(NativeAiSessionSnapshot {
            session_id: metadata.session_id,
            parent_session_id: metadata.parent_session_id,
            runtime_id: metadata.runtime_id,
            runtime_session_id: metadata.runtime_session_id,
            project_id: metadata.project_id,
            worktree_id: metadata.worktree_id,
            title: metadata.title,
            status: metadata.status,
            updated_at: metadata.updated_at,
            active_turn_started_at: state.active_turn_started_at,
            closed_at: metadata.closed_at,
            last_error: state.last_error,
            mode_id: metadata.mode_id,
            model_id: metadata.model_id,
            pending_permission: state.pending_permission,
            pending_user_input: state.pending_user_input,
            plan: state.plan,
            token_usage: state.token_usage,
            available_commands: metadata.available_commands,
            config_options: metadata.config_options,
            messages,
            modes: metadata.modes,
            models: metadata.models,
            tool_activity: state.tool_activity,
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
            if metadata.worktree_id != input.worktree_id {
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
        let mut mappings: Vec<(String, NativeAiRuntimeSessionMapping)> = Vec::new();
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
            let matches_parent = parent_app_session_id.as_ref() == Some(parent_session_id)
                || parent_runtime_session_id
                    .as_ref()
                    .is_some_and(|parent_runtime| {
                        parent_runtime_for_child.as_ref() == Some(parent_runtime)
                    });
            if !matches_parent {
                continue;
            }
            let Some(runtime_session_id) = metadata.runtime_session_id else {
                continue;
            };
            mappings.push((
                metadata.updated_at,
                NativeAiRuntimeSessionMapping {
                    app_session_id: metadata.session_id,
                    parent_app_session_id,
                    parent_runtime_session_id: parent_runtime_for_child,
                    runtime_session_id,
                },
            ));
        }

        mappings.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(mappings.into_iter().map(|(_, mapping)| mapping).collect())
    }

    pub fn set_session_pinned(&self, session_id: &SessionId, pinned: bool) -> AiResult<()> {
        let mut metadata = self.load_metadata(session_id)?;
        metadata.pinned_at = pinned.then(now_iso8601);
        metadata.updated_at = now_iso8601();
        self.save_metadata(&metadata)
    }

    pub fn rename_session(&self, session_id: &SessionId, title: String) -> AiResult<()> {
        let mut metadata = self.load_metadata(session_id)?;
        metadata.title = normalize_title(title.clone());
        metadata.custom_title = Some(normalize_title(title));
        metadata.updated_at = now_iso8601();
        self.save_metadata(&metadata)
    }

    pub fn delete_session(&self, session_id: &SessionId) -> AiResult<()> {
        let session_dir = self.session_dir(session_id);
        if !session_dir.exists() {
            return Ok(());
        }
        fs::remove_dir_all(&session_dir)
            .map_err(|error| history_io("delete AI session dir", &session_dir, error))
    }

    pub fn storage_health(&self) -> AiResult<NativeAiHistoryStorageHealth> {
        let sessions_dir = self.sessions_dir();
        let mut native_session_count = 0;
        let mut orphaned_session_dirs = 0;

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
                if entry.path().join(SESSION_META_FILE).exists() {
                    native_session_count += 1;
                } else {
                    orphaned_session_dirs += 1;
                }
            }
        }

        Ok(NativeAiHistoryStorageHealth {
            healthy: true,
            storage_version: HISTORY_FORMAT_VERSION,
            native_session_count,
            legacy_fallback_available: false,
            migration_manifest_exists: self.history_root().join("migrations").exists(),
            orphaned_session_dirs,
            latest_error: None,
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
        if !marker.exists() {
            return Ok(());
        }

        let transcript_path = self.transcript_path(session_id);
        let transcript_backup = self.sidecar_path(session_id, "transcript.bak");
        if !transcript_path.exists() && transcript_backup.exists() {
            copy_or_replace(&transcript_backup, &transcript_path)?;
        }
        self.clear_compaction_sidecars(session_id)
    }

    fn write_compaction_marker(&self, session_id: &SessionId) -> AiResult<()> {
        let state = HistoryCompactionState {
            version: HISTORY_FORMAT_VERSION,
            started_at: now_iso8601(),
        };
        atomic_write_json(&self.compaction_marker_path(session_id), &state)
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
        atomic_write_json(&self.index_path(session_id), index)
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

    fn transcript_path(&self, session_id: &SessionId) -> PathBuf {
        self.session_dir(session_id).join(SESSION_TRANSCRIPT_FILE)
    }

    fn index_path(&self, session_id: &SessionId) -> PathBuf {
        self.session_dir(session_id).join(SESSION_INDEX_FILE)
    }

    fn compaction_marker_path(&self, session_id: &SessionId) -> PathBuf {
        self.session_dir(session_id)
            .join(SESSION_COMPACT_STATE_FILE)
    }

    fn sidecar_path(&self, session_id: &SessionId, name: &str) -> PathBuf {
        self.session_dir(session_id).join(name)
    }
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
                    parent_app_session_id
                FROM chat_session_runtime_links
                WHERE parent_app_session_id = ?1
                   OR (
                        ?2 IS NOT NULL
                        AND parent_runtime_session_id = ?2
                   )
                ORDER BY updated_at ASC
                ",
            )
            .map_err(|error| history_sql("prepare legacy runtime mapping query", error))?;
        let rows = statement
            .query_map(
                rusqlite::params![parent_session_id.0, parent_runtime_session_id],
                |row| {
                    Ok(NativeAiRuntimeSessionMapping {
                        runtime_session_id: RuntimeSessionId(row.get::<_, String>(0)?),
                        app_session_id: SessionId(row.get::<_, String>(1)?),
                        parent_runtime_session_id: row
                            .get::<_, Option<String>>(2)?
                            .map(RuntimeSessionId),
                        parent_app_session_id: row.get::<_, Option<String>>(3)?.map(SessionId),
                    })
                },
            )
            .map_err(|error| history_sql("query legacy runtime mappings", error))?;

        let mut mappings = Vec::new();
        for row in rows {
            mappings.push(row.map_err(|error| history_sql("read legacy runtime mapping", error))?);
        }
        Ok(mappings)
    }

    fn load_all_messages(&self, session_id: &SessionId) -> AiResult<Vec<Value>> {
        let shadow = self.load_shadow_messages(session_id)?;
        if !shadow.is_empty() {
            return Ok(shadow);
        }
        if let Some(messages) = self.load_runtime_state_messages(session_id)? {
            if !messages.is_empty() {
                return Ok(messages);
            }
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
            if let Ok(value) = serde_json::from_str::<Value>(&payload_json) {
                if value.is_object() {
                    messages.push(value);
                }
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
        if let Some(project_id) = project_id {
            sql.push_str("chat_sessions.project_id = ? ");
            args.push(Some(project_id.0));
        } else {
            sql.push_str("chat_sessions.project_id IS NULL ");
        }
        sql.push_str("AND ");
        if let Some(worktree_id) = worktree_id {
            sql.push_str("chat_sessions.worktree_id = ? ");
            args.push(Some(worktree_id.0));
        } else {
            sql.push_str("chat_sessions.worktree_id IS NULL ");
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

fn summary_from_metadata(metadata: AiHistorySessionMetadata) -> NativeAiHistorySessionSummary {
    NativeAiHistorySessionSummary {
        session_id: metadata.session_id,
        parent_session_id: metadata.parent_session_id,
        runtime_id: metadata.runtime_id,
        runtime_session_id: metadata.runtime_session_id,
        project_id: metadata.project_id,
        worktree_id: metadata.worktree_id,
        title: metadata.title,
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
        .map(|preview| {
            if preview.len() > 280 {
                format!("{}...", &preview[..277])
            } else {
                preview
            }
        })
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
        assert_eq!(snapshot.title, "Renamed");
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
    fn runtime_mappings_include_native_subagent_children() {
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

        let mappings = store
            .list_runtime_mappings_for_parent(&parent.session_id)
            .unwrap();

        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].app_session_id, child.session_id);
        assert_eq!(
            mappings[0].parent_app_session_id.as_ref(),
            Some(&parent.session_id)
        );
        assert_eq!(
            mappings[0].runtime_session_id,
            RuntimeSessionId("runtime_child".to_string())
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
        connection
            .execute(
                "UPDATE chat_sessions SET parent_session_id = 'parent' WHERE id = 'child'",
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

        let reader = LegacyAiHistoryReader::new(&connection);
        let mappings = reader
            .list_runtime_mappings_for_parent(&SessionId("parent".to_string()))
            .unwrap();

        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].app_session_id, SessionId("child".to_string()));
        assert_eq!(
            mappings[0].runtime_session_id,
            RuntimeSessionId("runtime_child".to_string())
        );
        assert_eq!(
            mappings[0].parent_runtime_session_id.as_ref(),
            Some(&RuntimeSessionId("runtime_parent".to_string()))
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
}
