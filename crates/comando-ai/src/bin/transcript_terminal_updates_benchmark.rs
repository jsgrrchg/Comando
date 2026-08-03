use std::fs;
use std::path::Path;
use std::time::Instant;

use comando_ai::history::AiHistoryStore;
use comando_types::ai::{
    NativeAiCheckpointOpenTranscriptTailInput, NativeAiOpenTranscriptEntryRef,
    NativeAiTranscriptEntryEnvelope, NativeAiTranscriptEntryKind, NativeAiTranscriptEntrySummary,
    NativeAiTranscriptPayloadWrite,
};
use comando_types::ids::SessionId;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const CHECKPOINT_BYTE_BUDGET: usize = 10 * 1024;

#[derive(Serialize)]
struct ResultRow {
    checkpoint_count: u64,
    final_output_bytes: usize,
    final_storage_bytes: u64,
    hashing_ms: f64,
    merge_ms: f64,
    reopen_ms: f64,
    serialization_ms: f64,
    sync_count: u64,
    tool_count: usize,
    total_duration_ms: f64,
    updates_per_tool: usize,
    written_bytes: u64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cases = [
        (1, 1_000, 10 * 1024),
        (1, 1_000, 100 * 1024),
        (1, 1_000, 1024 * 1024),
        (100, 100, 10 * 1024),
    ];
    let mut results = Vec::new();
    for (tools, updates, output_bytes) in cases {
        results.push(run_case(tools, updates, output_bytes)?);
    }
    println!("{}", serde_json::to_string_pretty(&results)?);
    Ok(())
}

fn run_case(
    tools: usize,
    updates: usize,
    final_bytes: usize,
) -> Result<ResultRow, Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("comando-terminal-benchmark-{}", Uuid::new_v4()));
    let session_id = SessionId("terminal-benchmark".to_string());
    let store = AiHistoryStore::new(&root)?;
    store.set_work_metrics_enabled(true);
    let chunk = "x".repeat(final_bytes / updates.max(1));
    let mut outputs = vec![String::new(); tools];
    let mut dirty = vec![false; tools];
    let mut pending_bytes = 0;
    let mut merge_ms = 0.0;
    let mut serialization_ms = 0.0;
    let mut hashing_ms = 0.0;
    let started = Instant::now();

    for update in 0..updates {
        for tool in 0..tools {
            let merge = Instant::now();
            outputs[tool].push_str(&chunk);
            merge_ms += merge.elapsed().as_secs_f64() * 1_000.0;
            dirty[tool] = true;
            pending_bytes += chunk.len();
        }
        if pending_bytes >= CHECKPOINT_BYTE_BUDGET || update + 1 == updates {
            checkpoint(
                &store,
                &session_id,
                &outputs,
                &mut dirty,
                update + 1,
                &mut serialization_ms,
                &mut hashing_ms,
            )?;
            pending_bytes = 0;
        }
    }
    let duration = started.elapsed();
    let metrics = store.work_metrics();
    let reopen = Instant::now();
    let recovered = AiHistoryStore::new(&root)?.load_open_transcript_tail(&session_id)?;
    if recovered.is_none() {
        return Err("terminal updates were not recoverable".into());
    }
    let reopen_ms = reopen.elapsed().as_secs_f64() * 1_000.0;
    let result = ResultRow {
        checkpoint_count: metrics.checkpoint_count,
        final_output_bytes: outputs.iter().map(String::len).sum(),
        final_storage_bytes: directory_size(&root)?,
        hashing_ms,
        merge_ms,
        reopen_ms,
        serialization_ms,
        sync_count: metrics.sync_count,
        tool_count: tools,
        total_duration_ms: duration.as_secs_f64() * 1_000.0,
        updates_per_tool: updates,
        written_bytes: metrics.durable_write_bytes,
    };
    fs::remove_dir_all(&root)?;
    Ok(result)
}

fn checkpoint(
    store: &AiHistoryStore,
    session_id: &SessionId,
    outputs: &[String],
    dirty: &mut [bool],
    revision: usize,
    serialization_ms: &mut f64,
    hashing_ms: &mut f64,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut entries = Vec::new();
    let mut payloads = Vec::new();
    let mut order = Vec::new();
    for (index, output) in outputs.iter().enumerate() {
        let id = format!("tool:{index}");
        let payload_ref = format!("payload:tool:{index}");
        if dirty[index] {
            let value = json!({ "activity": { "id": id, "terminalOutput": output } });
            let serialization = Instant::now();
            let bytes = serde_json::to_vec(&value)?;
            *serialization_ms += serialization.elapsed().as_secs_f64() * 1_000.0;
            let hashing = Instant::now();
            let _ = Sha256::digest(&bytes);
            *hashing_ms += hashing.elapsed().as_secs_f64() * 1_000.0;
            payloads.push(NativeAiTranscriptPayloadWrite {
                payload_ref: payload_ref.clone(),
                value,
            });
            dirty[index] = false;
        }
        entries.push(NativeAiTranscriptEntryEnvelope {
            id: id.clone(),
            session_id: session_id.clone(),
            sequence: (index + 1) as u64,
            kind: NativeAiTranscriptEntryKind::Tool,
            created_at: "2026-07-26T00:00:00.000Z".to_string(),
            updated_at: "2026-07-26T00:00:00.000Z".to_string(),
            summary: NativeAiTranscriptEntrySummary {
                label: Some("Terminal update".to_string()),
                preview: Some(output.chars().take(280).collect()),
                status: Some("streaming".to_string()),
                tool_activity_detail_id: None,
                tool_change_stats: None,
                tool_kind: Some("shell".to_string()),
            },
            payload_ref: Some(payload_ref),
        });
        order.push(NativeAiOpenTranscriptEntryRef {
            entry_id: id,
            entry_revision: revision as u64,
            ordinal: index,
        });
    }
    store.checkpoint_open_transcript_tail(NativeAiCheckpointOpenTranscriptTailInput {
        session_id: session_id.clone(),
        turn_id: "terminal-turn".to_string(),
        terminal_status: None,
        entries,
        payloads,
        removed_entry_ids: Vec::new(),
        entry_order: order,
    })?;
    Ok(())
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
