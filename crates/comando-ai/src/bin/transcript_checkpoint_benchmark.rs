use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use comando_ai::history::AiHistoryStore;
use comando_types::ai::{
    NativeAiCheckpointOpenTranscriptTailInput, NativeAiOpenTranscriptEntryRef,
    NativeAiTranscriptEntryEnvelope, NativeAiTranscriptEntryKind, NativeAiTranscriptEntrySummary,
    NativeAiTranscriptPayloadWrite,
};
use comando_types::ids::SessionId;
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

const DELTA_INTERVAL: Duration = Duration::from_millis(20);
const BYTE_CHECKPOINT_INTERVAL: usize = 10 * 1024;
const TIME_CHECKPOINT_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
enum CheckpointPolicy {
    EveryDelta,
    Grouped,
    PeriodicBytes,
    PeriodicTime,
}

impl CheckpointPolicy {
    fn name(self) -> &'static str {
        match self {
            Self::EveryDelta => "per_delta",
            Self::Grouped => "grouped",
            Self::PeriodicBytes => "periodic_bytes",
            Self::PeriodicTime => "periodic_time",
        }
    }

    fn should_checkpoint(
        self,
        delta_index: usize,
        pending_bytes: usize,
        simulated: Duration,
    ) -> bool {
        match self {
            Self::EveryDelta => true,
            // A fixed group makes this baseline comparable across message sizes.
            Self::Grouped => (delta_index + 1).is_multiple_of(50),
            Self::PeriodicBytes => pending_bytes >= BYTE_CHECKPOINT_INTERVAL,
            Self::PeriodicTime => simulated >= TIME_CHECKPOINT_INTERVAL,
        }
    }
}

#[derive(Serialize)]
struct BenchmarkResult {
    amplification: f64,
    checkpoint_count: u64,
    delta_bytes: usize,
    delta_count: usize,
    duration_ms: f64,
    final_message_bytes: usize,
    final_storage_bytes: u64,
    p50_checkpoint_ms: f64,
    p95_checkpoint_ms: f64,
    p99_checkpoint_ms: f64,
    policy: &'static str,
    reopen_ms: f64,
    serialized_bytes: u64,
    sync_count: u64,
    throughput_bytes_per_second: f64,
    written_bytes: u64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cases = [(500, 200), (1_000, 200), (5_000, 200), (10_000, 100)];
    let policies = [
        CheckpointPolicy::EveryDelta,
        CheckpointPolicy::Grouped,
        CheckpointPolicy::PeriodicBytes,
        CheckpointPolicy::PeriodicTime,
    ];
    let mut results = Vec::new();

    for (delta_count, delta_bytes) in cases {
        for policy in policies {
            results.push(run_case(delta_count, delta_bytes, policy)?);
        }
    }

    println!("{}", serde_json::to_string_pretty(&results)?);
    Ok(())
}

fn run_case(
    delta_count: usize,
    delta_bytes: usize,
    policy: CheckpointPolicy,
) -> Result<BenchmarkResult, Box<dyn std::error::Error>> {
    let root =
        std::env::temp_dir().join(format!("comando-transcript-benchmark-{}", Uuid::new_v4()));
    let session_id = SessionId("benchmark-session".to_string());
    let store = AiHistoryStore::new(&root)?;
    store.set_work_metrics_enabled(true);
    let delta = "x".repeat(delta_bytes);
    let mut message = String::with_capacity(delta_count * delta_bytes);
    let mut checkpoint_samples = Vec::new();
    let mut pending_bytes = 0;
    let mut pending_time = Duration::ZERO;
    let started = Instant::now();

    for index in 0..delta_count {
        message.push_str(&delta);
        pending_bytes += delta_bytes;
        pending_time += DELTA_INTERVAL;
        if !policy.should_checkpoint(index, pending_bytes, pending_time) {
            continue;
        }
        checkpoint(
            &store,
            &session_id,
            &message,
            index + 1,
            &mut checkpoint_samples,
        )?;
        pending_bytes = 0;
        pending_time = Duration::ZERO;
    }
    if pending_bytes > 0 {
        checkpoint(
            &store,
            &session_id,
            &message,
            delta_count,
            &mut checkpoint_samples,
        )?;
    }
    let duration = started.elapsed();
    let metrics = store.work_metrics();
    let reopen_started = Instant::now();
    let reopened = AiHistoryStore::new(&root)?;
    let tail = reopened.load_open_transcript_tail(&session_id)?;
    let reopen = reopen_started.elapsed();
    if tail.is_none() {
        return Err("checkpointed tail was not recoverable".into());
    }

    let final_storage_bytes = directory_size(&root)?;
    let final_message_bytes = message.len();
    let result = BenchmarkResult {
        amplification: metrics.durable_write_bytes as f64 / final_message_bytes.max(1) as f64,
        checkpoint_count: metrics.checkpoint_count,
        delta_bytes,
        delta_count,
        duration_ms: duration.as_secs_f64() * 1_000.0,
        final_message_bytes,
        final_storage_bytes,
        p50_checkpoint_ms: percentile(&mut checkpoint_samples.clone(), 0.50),
        p95_checkpoint_ms: percentile(&mut checkpoint_samples.clone(), 0.95),
        p99_checkpoint_ms: percentile(&mut checkpoint_samples, 0.99),
        policy: policy.name(),
        reopen_ms: reopen.as_secs_f64() * 1_000.0,
        serialized_bytes: metrics.serialized_bytes,
        sync_count: metrics.sync_count,
        throughput_bytes_per_second: final_message_bytes as f64
            / duration.as_secs_f64().max(f64::EPSILON),
        written_bytes: metrics.durable_write_bytes,
    };
    fs::remove_dir_all(&root)?;
    Ok(result)
}

fn checkpoint(
    store: &AiHistoryStore,
    session_id: &SessionId,
    content: &str,
    revision: usize,
    samples: &mut Vec<f64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    let entry = NativeAiTranscriptEntryEnvelope {
        id: "message:assistant-live".to_string(),
        session_id: session_id.clone(),
        sequence: 1,
        kind: NativeAiTranscriptEntryKind::Message,
        created_at: "2026-07-26T00:00:00.000Z".to_string(),
        updated_at: "2026-07-26T00:00:00.000Z".to_string(),
        summary: NativeAiTranscriptEntrySummary {
            label: Some("Streaming benchmark message".to_string()),
            preview: Some(content.chars().take(280).collect()),
            status: Some("streaming".to_string()),
            tool_activity_detail_id: None,
            tool_change_stats: None,
            tool_kind: None,
        },
        payload_ref: Some("payload:assistant-live".to_string()),
    };
    store.checkpoint_open_transcript_tail(NativeAiCheckpointOpenTranscriptTailInput {
        session_id: session_id.clone(),
        turn_id: "benchmark-turn".to_string(),
        terminal_status: None,
        entries: vec![entry],
        payloads: vec![NativeAiTranscriptPayloadWrite {
            payload_ref: "payload:assistant-live".to_string(),
            value: json!({ "message": { "content": content } }),
        }],
        removed_entry_ids: Vec::new(),
        entry_order: vec![NativeAiOpenTranscriptEntryRef {
            entry_id: "message:assistant-live".to_string(),
            entry_revision: revision as u64,
            ordinal: 0,
        }],
    })?;
    samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    Ok(())
}

fn percentile(samples: &mut [f64], percentile: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    samples.sort_by(f64::total_cmp);
    let index = ((samples.len() - 1) as f64 * percentile).ceil() as usize;
    samples[index]
}

fn directory_size(path: &Path) -> std::io::Result<u64> {
    let mut total = 0;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        total += if metadata.is_dir() {
            directory_size(&entry.path())?
        } else {
            metadata.len()
        };
    }
    Ok(total)
}
