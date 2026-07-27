use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Instant;

use comando_ai::history::{
    AiHistorySessionMetadata, AiHistorySessionMetadataInput, AiHistoryStore,
};
use comando_types::ai::{
    NativeAiCheckpointOpenTranscriptTailInput, NativeAiOpenTranscriptEntryRef,
    NativeAiSessionStatus, NativeAiTranscriptEntryEnvelope, NativeAiTranscriptEntryKind,
    NativeAiTranscriptEntrySummary,
};
use comando_types::ids::{RuntimeId, SessionId};
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

const MESSAGE_COUNT: usize = 10_000;
const SEALED_ENTRY_COUNT: usize = 100_000;
const OPEN_TOOL_COUNT: usize = 2_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultRow {
    first_block_entries: usize,
    first_block_ms: f64,
    metadata_blocks: usize,
    metadata_entries: usize,
    metadata_query_ms: f64,
    open_store_ms: f64,
    recovery_ms: f64,
    seal_open_tail_ms: f64,
    storage_bytes: u64,
    tail_entries: usize,
    tail_load_ms: f64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("comando-reopen-benchmark-{}", Uuid::new_v4()));
    let session_id = SessionId("reopen-benchmark".to_string());
    prepare_store(&root, &session_id)?;

    let opened = Instant::now();
    let reopened = AiHistoryStore::new(&root)?;
    let open_store_ms = elapsed_ms(opened);

    let recovery = Instant::now();
    reopened.load_metadata(&session_id)?;
    let recovery_ms = elapsed_ms(recovery);

    let metadata_started = Instant::now();
    let metadata = reopened.load_transcript_block_metadata(&session_id)?;
    let metadata_query_ms = elapsed_ms(metadata_started);
    let first_block_id = metadata
        .first()
        .ok_or("reopen benchmark did not create sealed blocks")?
        .block_id
        .clone();

    let first_block_started = Instant::now();
    let first_block = reopened
        .load_transcript_block(&session_id, &first_block_id)?
        .ok_or("first transcript block was not recoverable")?;
    let first_block_ms = elapsed_ms(first_block_started);

    let tail_started = Instant::now();
    let tail = reopened
        .load_open_transcript_tail(&session_id)?
        .ok_or("open tool tail was not recoverable")?;
    let tail_load_ms = elapsed_ms(tail_started);

    let seal_started = Instant::now();
    reopened.seal_transcript_turn(&session_id, &tail.turn_id, tail.entries, tail.payloads)?;
    let seal_open_tail_ms = elapsed_ms(seal_started);

    let result = ResultRow {
        first_block_entries: first_block.entries.len(),
        first_block_ms,
        metadata_blocks: metadata.len(),
        metadata_entries: metadata.iter().map(|block| block.entry_count).sum(),
        metadata_query_ms,
        open_store_ms,
        recovery_ms,
        seal_open_tail_ms,
        storage_bytes: directory_size(&root)?,
        tail_entries: OPEN_TOOL_COUNT,
        tail_load_ms,
    };
    fs::remove_dir_all(&root)?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn prepare_store(root: &Path, session_id: &SessionId) -> Result<(), Box<dyn std::error::Error>> {
    let store = AiHistoryStore::new(root)?;
    store.create_session(metadata(session_id.clone()))?;
    store.save_transcript_window(session_id, legacy_messages())?;

    // Materialize compatibility messages before adding native-only entry metadata.
    while store.transcript_storage_state(session_id)?.mode
        != comando_types::ai::NativeAiTranscriptStorageMode::BlockNative
    {}

    store.seal_transcript_turn(
        session_id,
        "metadata-turn",
        entries(
            session_id,
            "metadata",
            SEALED_ENTRY_COUNT,
            NativeAiTranscriptEntryKind::Status,
        ),
        Vec::new(),
    )?;

    let tools = entries(
        session_id,
        "tool",
        OPEN_TOOL_COUNT,
        NativeAiTranscriptEntryKind::Tool,
    );
    let order = tools
        .iter()
        .enumerate()
        .map(|(ordinal, entry)| NativeAiOpenTranscriptEntryRef {
            entry_id: entry.id.clone(),
            entry_revision: 1,
            ordinal,
        })
        .collect();
    store.checkpoint_open_transcript_tail(NativeAiCheckpointOpenTranscriptTailInput {
        session_id: session_id.clone(),
        turn_id: "open-tools-turn".to_string(),
        terminal_status: None,
        entries: tools,
        payloads: Vec::new(),
        removed_entry_ids: Vec::new(),
        entry_order: order,
    })?;
    Ok(())
}

fn legacy_messages() -> Vec<Value> {
    (0..MESSAGE_COUNT)
        .map(|index| {
            json!({
                "id": format!("message-{index}"),
                "kind": "message",
                "role": "assistant",
                "content": "Synthetic history message"
            })
        })
        .collect()
}

fn entries(
    session_id: &SessionId,
    prefix: &str,
    count: usize,
    kind: NativeAiTranscriptEntryKind,
) -> Vec<NativeAiTranscriptEntryEnvelope> {
    (0..count)
        .map(|index| NativeAiTranscriptEntryEnvelope {
            id: format!("{prefix}:{index}"),
            session_id: session_id.clone(),
            sequence: 0,
            kind: kind.clone(),
            created_at: "2026-07-26T00:00:00.000Z".to_string(),
            updated_at: "2026-07-26T00:00:00.000Z".to_string(),
            summary: NativeAiTranscriptEntrySummary {
                label: Some(format!("{prefix} entry")),
                preview: Some("Synthetic benchmark metadata".to_string()),
                status: Some("completed".to_string()),
                tool_activity_detail_id: None,
                tool_change_stats: None,
                tool_kind: (kind == NativeAiTranscriptEntryKind::Tool).then(|| "shell".to_string()),
            },
            payload_ref: None,
        })
        .collect()
}

fn metadata(session_id: SessionId) -> AiHistorySessionMetadata {
    AiHistorySessionMetadata::new_native(AiHistorySessionMetadataInput {
        session_id,
        runtime_id: RuntimeId("codex".to_string()),
        runtime_session_id: None,
        parent_session_id: None,
        project_id: None,
        worktree_id: None,
        title: "Reopen benchmark".to_string(),
        status: NativeAiSessionStatus::Idle,
        model_id: None,
        mode_id: None,
        reasoning_effort: None,
        config_values: BTreeMap::new(),
        cwd: "/tmp".to_string(),
        additional_roots: Vec::new(),
    })
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1_000.0
}

fn directory_size(path: &Path) -> std::io::Result<u64> {
    fs::read_dir(path)?.try_fold(0, |total, entry| {
        let entry = entry?;
        let metadata = entry.metadata()?;
        Ok(total
            + if metadata.is_dir() {
                directory_size(&entry.path())?
            } else {
                metadata.len()
            })
    })
}
