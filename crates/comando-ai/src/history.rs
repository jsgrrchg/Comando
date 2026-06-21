use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use comando_types::ai::{
    NativeAiHistorySessionSummary, NativeAiHistoryStorageHealth, NativeAiListSessionHistoryInput,
    NativeAiLoadSessionTranscriptPageInput, NativeAiSessionSnapshot, NativeAiSessionStatus,
    NativeAiSessionTranscriptPage,
};
use comando_types::ids::{ProjectId, RuntimeId, RuntimeSessionId, SessionId, WorktreeId};
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
            active_turn_started_at: None,
            closed_at: metadata.closed_at,
            last_error: None,
            mode_id: metadata.mode_id,
            model_id: metadata.model_id,
            pending_permission: None,
            pending_user_input: None,
            plan: None,
            token_usage: None,
            available_commands: metadata.available_commands,
            config_options: metadata.config_options,
            messages,
            modes: metadata.modes,
            models: metadata.models,
            tool_activity: Vec::new(),
            tracked_files: Vec::new(),
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

fn history_error(message: impl Into<String>) -> AiError {
    AiError::Internal(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
