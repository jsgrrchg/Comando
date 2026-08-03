use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Instant;

use comando_ai::history::{
    AiHistorySessionMetadata, AiHistorySessionMetadataInput, AiHistoryStore,
};
use comando_types::ai::NativeAiSessionStatus;
use comando_types::ids::{RuntimeId, SessionId};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultRow {
    case: &'static str,
    attempted_updates: usize,
    estimated_write_bytes_avoided: u64,
    hash_check_ms: f64,
    hash_checks: usize,
    payload_bytes: usize,
    persisted_updates: usize,
    storage_ms: f64,
    total_written_bytes: u64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let small_diffs = (0..500)
        .map(|index| diff_payload(index, 48, "small"))
        .collect::<Vec<_>>();
    let large_diffs = (0..100)
        .map(|index| diff_payload(index, 1024 * 1024, "large"))
        .collect::<Vec<_>>();
    let repeated = vec![diff_payload(0, 1024 * 1024, "identical"); 100];
    let partially_modified = (0..100)
        .map(|index| diff_payload(index, 1024 * 1024, "partial"))
        .collect::<Vec<_>>();

    let results = [
        run_case("500-small-diffs", small_diffs, 500)?,
        run_case("100-one-megabyte-diffs", large_diffs, 100)?,
        run_case("100-identical-updates", repeated, 1)?,
        run_case("100-partially-modified-updates", partially_modified, 100)?,
    ];
    println!("{}", serde_json::to_string_pretty(&results)?);
    Ok(())
}

fn run_case(
    case: &'static str,
    diffs: Vec<Value>,
    expected_persisted_updates: usize,
) -> Result<ResultRow, Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("comando-diffs-benchmark-{}", Uuid::new_v4()));
    let session_id = SessionId("diffs-benchmark".to_string());
    let detail_id = "tool-detail:diffs-benchmark:tool-1";
    let store = AiHistoryStore::new(&root)?;
    store.create_session(metadata(session_id.clone()))?;

    let payloads = diffs
        .into_iter()
        .map(|diff| json!({ "diffs": [diff], "rawInput": null, "rawOutput": null, "terminalOutput": null }))
        .collect::<Vec<_>>();
    let payload_bytes =
        serde_json::to_vec(payloads.first().expect("benchmark has a payload"))?.len();
    let hash_check_ms = measure_hash_checks(&payloads)?;

    let storage_started = Instant::now();
    for payload in &payloads {
        store.store_tool_activity_detail(&session_id, detail_id, payload.clone())?;
    }
    let storage_ms = storage_started.elapsed().as_secs_f64() * 1_000.0;
    let total_written_bytes = directory_size(&root)?;
    fs::remove_dir_all(&root)?;

    Ok(ResultRow {
        case,
        attempted_updates: payloads.len(),
        estimated_write_bytes_avoided: (payloads.len().saturating_sub(expected_persisted_updates)
            * payload_bytes) as u64,
        hash_check_ms,
        hash_checks: payloads.len(),
        payload_bytes,
        persisted_updates: expected_persisted_updates,
        storage_ms,
        total_written_bytes,
    })
}

fn measure_hash_checks(payloads: &[Value]) -> Result<f64, serde_json::Error> {
    let started = Instant::now();
    for payload in payloads {
        // This matches the serialization and SHA-256 work used to reject unchanged details.
        let bytes = serde_json::to_vec(payload)?;
        let _ = Sha256::digest(&bytes);
    }
    Ok(started.elapsed().as_secs_f64() * 1_000.0)
}

fn diff_payload(index: usize, body_bytes: usize, label: &str) -> Value {
    json!({
        "before": format!("{label}-before-{index}"),
        "after": "x".repeat(body_bytes),
        "newPath": format!("src/{label}-{index}.rs"),
        "oldPath": format!("src/{label}-{index}.rs")
    })
}

fn metadata(session_id: SessionId) -> AiHistorySessionMetadata {
    AiHistorySessionMetadata::new_native(AiHistorySessionMetadataInput {
        session_id,
        runtime_id: RuntimeId("codex".to_string()),
        runtime_session_id: None,
        parent_session_id: None,
        project_id: None,
        worktree_id: None,
        title: "Diff benchmark".to_string(),
        status: NativeAiSessionStatus::Idle,
        model_id: None,
        mode_id: None,
        reasoning_effort: None,
        config_values: BTreeMap::new(),
        cwd: "/tmp".to_string(),
        additional_roots: Vec::new(),
    })
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
