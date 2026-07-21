use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Instant;

use comando_ai::session::NativeAiSession;
use comando_diff::{
    ReviewDecision, ReviewTrackedFile, ReviewTrackedFileKind, compute_tracked_file_patch,
    resolve_tracked_file_hunks, sync_tracked_file, tracked_current_text,
};
use comando_fs::WriteTracker;
use comando_fs::path::{ScopedPathIntent, normalize_relative_path, resolve_scoped_path};
use comando_fs::read::hash_content_bytes;
use comando_types::ai::{
    NativeAiEventBase, NativeAiReviewDeltaReadyPayload, NativeAiToolActivityPayload,
    NativeReviewDeltaReference, NativeReviewDeltaState, NativeReviewDeltaSummary,
    NativeReviewFileSummary, NativeReviewLoadDeltaInput, NativeReviewLoadDeltaOutput,
};
use comando_types::error::{NativeError, NativeErrorCode};
use comando_types::ids::{ReviewDeltaId, ReviewRevision, SessionId, ToolCallId};
use serde::{Deserialize, Serialize};
use serde_json::json;

const MAX_REVIEW_TEXT_BYTES: u64 = 5 * 1024 * 1024;
const MAX_PENDING_REVIEW_TEXT_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug)]
pub struct NativeReviewService {
    baseline_counter: u64,
    open_buffers: HashMap<PathBuf, ReviewBuffer>,
    work_states: HashMap<SessionId, HashMap<String, ReviewWorkState>>,
    worker: NativeReviewWorker,
}

impl Default for NativeReviewService {
    fn default() -> Self {
        Self {
            baseline_counter: 0,
            open_buffers: HashMap::new(),
            work_states: HashMap::new(),
            worker: NativeReviewWorker::new(),
        }
    }
}

impl NativeReviewWorker {
    fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        let (result_sender, results) = mpsc::channel();
        let registry = Arc::new(Mutex::new(ReviewWorkerRegistry::default()));
        let worker_registry = Arc::clone(&registry);
        let thread = thread::spawn(move || {
            while let Ok(command) = receiver.recv() {
                match command {
                    NativeReviewWorkerCommand::Materialize(task) => {
                        if !review_worker_task_is_current(&worker_registry, &task) {
                            continue;
                        }
                        let Some(result) = materialize_review_worker_task(&worker_registry, task)
                        else {
                            continue;
                        };
                        if result_sender.send(result).is_err() {
                            break;
                        }
                    }
                    NativeReviewWorkerCommand::Shutdown => break,
                }
            }
        });
        Self {
            handle: NativeReviewWorkerHandle { registry, sender },
            results,
            thread: Some(thread),
        }
    }
}

impl Drop for NativeReviewWorker {
    fn drop(&mut self) {
        self.handle.cancel_all();
        let _ = self.handle.sender.send(NativeReviewWorkerCommand::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl NativeReviewWorkerHandle {
    pub fn ingest_tool_activity(
        &self,
        mut payload: NativeAiToolActivityPayload,
    ) -> Vec<NativeAiReviewDeltaReadyPayload> {
        let received_at = Instant::now();
        if !is_terminal_review_activity(&payload) {
            return Vec::new();
        }
        let diffs = Arc::<[NativeReviewRuntimeDiff]>::from(bound_review_runtime_diffs(
            payload
                .diffs
                .drain(..)
                .filter_map(|diff| serde_json::from_value::<NativeReviewRuntimeDiff>(diff).ok()),
        ));
        if diffs.is_empty() {
            return Vec::new();
        }
        let tool_call_id = payload.tool_call_id.clone();

        let mut registry = self.registry.lock().expect("review worker registry lock");
        let Some(session) = registry.sessions.get_mut(&payload.base.session_id) else {
            let unavailable = unavailable_activity_delta(
                &payload,
                &diffs,
                ReviewUnavailableReason::BaselineUnavailable,
            );
            record_review_delta(
                "sidecar.review-placeholder",
                received_at,
                &unavailable.delta,
            );
            return vec![unavailable];
        };
        let Some(work_cycle_id) = session.current_work_cycle_id.clone() else {
            let unavailable = unavailable_activity_delta(
                &payload,
                &diffs,
                ReviewUnavailableReason::BaselineUnavailable,
            );
            record_review_delta(
                "sidecar.review-placeholder",
                received_at,
                &unavailable.delta,
            );
            return vec![unavailable];
        };
        let Some(cycle) = session.cycles.get_mut(&work_cycle_id) else {
            let unavailable = unavailable_activity_delta(
                &payload,
                &diffs,
                ReviewUnavailableReason::BaselineUnavailable,
            );
            record_review_delta(
                "sidecar.review-placeholder",
                received_at,
                &unavailable.delta,
            );
            return vec![unavailable];
        };
        let mut outputs = supersede_fully_replaced_pending_deltas(cycle, &diffs)
            .into_iter()
            .map(|delta| NativeAiReviewDeltaReadyPayload {
                base: payload.base.clone(),
                delta,
            })
            .collect::<Vec<_>>();
        let input_revision = ReviewRevision(cycle.next_revision.saturating_add(1));
        // Reserve a newer revision for materialization so the renderer can replace
        // this lightweight placeholder without changing its delta identity.
        let revision = ReviewRevision(input_revision.0.saturating_add(1));
        cycle.next_revision = revision.0;
        let delta_id = ReviewDeltaId(format!(
            "review:{}:{}:{}:{}",
            payload.base.session_id.0, work_cycle_id, tool_call_id.0, input_revision.0
        ));
        let provisional = NativeReviewDeltaSummary {
            delta_id: delta_id.clone(),
            session_id: payload.base.session_id.clone(),
            work_cycle_id: work_cycle_id.clone(),
            tool_call_id: tool_call_id.clone(),
            input_revision,
            revision: input_revision,
            state: NativeReviewDeltaState::Preparing,
            files: diffs
                .iter()
                .map(|diff| NativeReviewFileSummary {
                    path: diff.path.clone(),
                    previous_path: diff.previous_path.clone(),
                    state: NativeReviewDeltaState::Preparing,
                    observed_hash: None,
                    reason: None,
                })
                .collect(),
            updated_at: now(),
        };
        // Keep the raw payload in the cycle until the worker finishes so the
        // placeholder remains addressable without putting text on the event stream.
        cycle.deltas.insert(delta_id.clone(), provisional.clone());
        cycle.pending_deltas.insert(
            delta_id.clone(),
            PendingReviewDelta {
                delta: provisional.clone(),
                diffs: Arc::clone(&diffs),
            },
        );
        let task = NativeReviewWorkerTask {
            base: payload.base.clone(),
            delta_id: delta_id.clone(),
            epoch: cycle.epoch,
            input_revision,
            revision,
            tool_call_id,
            work_cycle_id: work_cycle_id.clone(),
            queued_at: Instant::now(),
        };
        drop(registry);

        // The unbounded handoff keeps the event bridge non-blocking without losing review work.
        if self
            .sender
            .send(NativeReviewWorkerCommand::Materialize(task))
            .is_err()
        {
            self.remove_pending_delta(&payload.base.session_id, &work_cycle_id, &delta_id);
            self.record_delta(unavailable_delta(
                provisional.clone(),
                ReviewUnavailableReason::WorkerUnavailable,
            ));
            outputs.push(NativeAiReviewDeltaReadyPayload {
                base: payload.base,
                delta: unavailable_delta(provisional, ReviewUnavailableReason::WorkerUnavailable),
            });
            record_review_delta(
                "sidecar.review-placeholder",
                received_at,
                &outputs.last().expect("unavailable delta output").delta,
            );
            return outputs;
        }
        record_review_delta("sidecar.review-placeholder", received_at, &provisional);
        outputs.push(NativeAiReviewDeltaReadyPayload {
            base: payload.base,
            delta: provisional,
        });
        outputs
    }

    pub fn enqueue_tool_activity(&self, payload: NativeAiToolActivityPayload) {
        let _ = self.ingest_tool_activity(payload);
    }

    fn register_baseline(
        &self,
        session_id: SessionId,
        work_cycle_id: String,
        context: ReviewBaselineContext,
    ) {
        {
            let mut registry = self.registry.lock().expect("review worker registry lock");
            let session = registry.sessions.entry(session_id.clone()).or_default();
            session.current_work_cycle_id = Some(work_cycle_id.clone());
            session.cycles.insert(
                work_cycle_id,
                ReviewWorkerCycle {
                    deltas: HashMap::new(),
                    epoch: 0,
                    next_revision: context.revision.0,
                    pending_deltas: HashMap::new(),
                    context,
                },
            );
        }
        self.propagate_parent_state(&session_id);
    }

    pub fn inherit_session(&self, parent_session_id: &SessionId, child_session_id: SessionId) {
        let mut registry = self.registry.lock().expect("review worker registry lock");
        let parent = registry.sessions.get(parent_session_id).cloned();
        registry.sessions.insert(
            child_session_id,
            ReviewWorkerSession {
                // A child can be announced before the parent prompt has captured its review
                // baseline. Retain the relationship so the later baseline propagates to it.
                cycles: parent
                    .as_ref()
                    .map(|parent| review_worker_cycles_for_child(&parent.cycles))
                    .unwrap_or_default(),
                current_work_cycle_id: parent.and_then(|parent| parent.current_work_cycle_id),
                parent_session_id: Some(parent_session_id.clone()),
            },
        );
    }

    fn propagate_parent_state(&self, parent_session_id: &SessionId) {
        let mut registry = self.registry.lock().expect("review worker registry lock");
        let Some(parent) = registry.sessions.get(parent_session_id).cloned() else {
            return;
        };
        let mut pending = vec![parent_session_id.clone()];
        let mut visited = HashSet::new();
        while let Some(current_parent) = pending.pop() {
            if !visited.insert(current_parent.clone()) {
                continue;
            }
            let child_ids = registry
                .sessions
                .iter()
                .filter_map(|(session_id, session)| {
                    (session.parent_session_id.as_ref() == Some(&current_parent))
                        .then_some(session_id.clone())
                })
                .collect::<Vec<_>>();
            for child_id in child_ids {
                if let Some(child) = registry.sessions.get_mut(&child_id) {
                    child.cycles = review_worker_cycles_for_child(&parent.cycles);
                    child.current_work_cycle_id = parent.current_work_cycle_id.clone();
                }
                pending.push(child_id);
            }
        }
    }

    fn parent_session_id(&self, session_id: &SessionId) -> Option<SessionId> {
        self.registry
            .lock()
            .expect("review worker registry lock")
            .sessions
            .get(session_id)
            .and_then(|session| session.parent_session_id.clone())
    }

    fn update_buffer(&self, path: &Path, buffer: Option<ReviewBuffer>) {
        let mut registry = self.registry.lock().expect("review worker registry lock");
        for session in registry.sessions.values_mut() {
            for cycle in session.cycles.values_mut() {
                if let Some(buffer) = buffer.as_ref() {
                    cycle
                        .context
                        .observed_buffers
                        .insert(path.to_path_buf(), buffer.clone());
                } else {
                    cycle.context.observed_buffers.remove(path);
                }
            }
        }
    }

    fn prioritize_session(&self, session_id: &SessionId) {
        let mut registry = self.registry.lock().expect("review worker registry lock");
        let Some(session) = registry.sessions.get_mut(session_id) else {
            return;
        };
        for cycle in session.cycles.values_mut() {
            cycle.epoch = cycle.epoch.saturating_add(1);
            cycle.pending_deltas.clear();
        }
    }

    fn pending_delta(&self, reference: &NativeReviewDeltaReference) -> Option<PendingReviewDelta> {
        let registry = self.registry.lock().expect("review worker registry lock");
        let pending = registry
            .sessions
            .get(&reference.session_id)
            .and_then(|session| session.cycles.get(&reference.work_cycle_id))
            .and_then(|cycle| cycle.pending_deltas.get(&reference.delta_id))?
            .clone();
        let delta = &pending.delta;
        (delta.session_id == reference.session_id
            && delta.work_cycle_id == reference.work_cycle_id
            && delta.tool_call_id == reference.tool_call_id
            && delta.input_revision == reference.input_revision
            && delta.revision == reference.expected_revision)
            .then_some(pending)
    }

    fn remove_pending_delta(
        &self,
        session_id: &SessionId,
        work_cycle_id: &str,
        delta_id: &ReviewDeltaId,
    ) {
        let mut registry = self.registry.lock().expect("review worker registry lock");
        if let Some(cycle) = registry
            .sessions
            .get_mut(session_id)
            .and_then(|session| session.cycles.get_mut(work_cycle_id))
        {
            cycle.pending_deltas.remove(delta_id);
        }
    }

    fn record_delta(&self, delta: NativeReviewDeltaSummary) {
        let mut registry = self.registry.lock().expect("review worker registry lock");
        if let Some(cycle) = registry
            .sessions
            .get_mut(&delta.session_id)
            .and_then(|session| session.cycles.get_mut(&delta.work_cycle_id))
        {
            cycle.deltas.insert(delta.delta_id.clone(), delta);
        }
    }

    pub fn cancel_session(&self, session_id: &SessionId) {
        self.registry
            .lock()
            .expect("review worker registry lock")
            .sessions
            .remove(session_id);
    }

    fn cancel_all(&self) {
        self.registry
            .lock()
            .expect("review worker registry lock")
            .sessions
            .clear();
    }

    fn result_is_current(&self, result: &NativeReviewWorkerResult) -> bool {
        let registry = self.registry.lock().expect("review worker registry lock");
        registry
            .sessions
            .get(&result.delta.session_id)
            .and_then(|session| session.cycles.get(&result.delta.work_cycle_id))
            .is_some_and(|cycle| {
                cycle.epoch == result.epoch
                    && cycle.pending_deltas.contains_key(&result.delta.delta_id)
            })
    }
}

fn is_terminal_review_activity(payload: &NativeAiToolActivityPayload) -> bool {
    matches!(payload.status.as_str(), "completed" | "failed") && !payload.diffs.is_empty()
}

fn bound_review_runtime_diffs(
    diffs: impl IntoIterator<Item = NativeReviewRuntimeDiff>,
) -> Vec<NativeReviewRuntimeDiff> {
    let mut retained_bytes = 0_u64;
    diffs
        .into_iter()
        .map(|mut diff| {
            let text_bytes = review_text_bytes(&diff);
            if review_text_is_too_large(&diff)
                || retained_bytes.saturating_add(text_bytes) > MAX_PENDING_REVIEW_TEXT_BYTES
            {
                // Keep the file identity but drop text that would exceed the bounded queue budget.
                diff.old_text = None;
                diff.new_text = None;
                diff.unavailable_reason = Some(ReviewUnavailableReason::TooLarge);
            } else {
                retained_bytes = retained_bytes.saturating_add(text_bytes);
            }
            diff
        })
        .collect()
}

fn review_text_bytes(diff: &NativeReviewRuntimeDiff) -> u64 {
    [diff.old_text.as_ref(), diff.new_text.as_ref()]
        .into_iter()
        .flatten()
        .map(|text| text.len() as u64)
        .sum()
}

fn review_text_is_too_large(diff: &NativeReviewRuntimeDiff) -> bool {
    [diff.old_text.as_ref(), diff.new_text.as_ref()]
        .into_iter()
        .flatten()
        .any(|text| text.len() as u64 > MAX_REVIEW_TEXT_BYTES)
}

fn unavailable_activity_delta(
    payload: &NativeAiToolActivityPayload,
    diffs: &[NativeReviewRuntimeDiff],
    reason: ReviewUnavailableReason,
) -> NativeAiReviewDeltaReadyPayload {
    let delta = NativeReviewDeltaSummary {
        delta_id: ReviewDeltaId(format!(
            "review:{}:unavailable:{}",
            payload.base.session_id.0, payload.tool_call_id.0
        )),
        session_id: payload.base.session_id.clone(),
        work_cycle_id: format!("review-unavailable:{}", payload.tool_call_id.0),
        tool_call_id: payload.tool_call_id.clone(),
        input_revision: ReviewRevision(0),
        revision: ReviewRevision(0),
        state: NativeReviewDeltaState::Unavailable,
        files: diffs
            .iter()
            .map(|diff| NativeReviewFileSummary {
                path: diff.path.clone(),
                previous_path: diff.previous_path.clone(),
                state: NativeReviewDeltaState::Unavailable,
                observed_hash: None,
                reason: Some(reason.as_str().to_string()),
            })
            .collect(),
        updated_at: payload.base.updated_at.clone(),
    };
    NativeAiReviewDeltaReadyPayload {
        base: payload.base.clone(),
        delta,
    }
}

fn unavailable_delta(
    delta: NativeReviewDeltaSummary,
    reason: ReviewUnavailableReason,
) -> NativeReviewDeltaSummary {
    NativeReviewDeltaSummary {
        state: NativeReviewDeltaState::Unavailable,
        files: delta
            .files
            .into_iter()
            .map(|file| NativeReviewFileSummary {
                state: NativeReviewDeltaState::Unavailable,
                reason: Some(reason.as_str().to_string()),
                ..file
            })
            .collect(),
        ..delta
    }
}

fn supersede_fully_replaced_pending_deltas(
    cycle: &mut ReviewWorkerCycle,
    incoming_diffs: &[NativeReviewRuntimeDiff],
) -> Vec<NativeReviewDeltaSummary> {
    let incoming_paths = incoming_diffs
        .iter()
        .flat_map(review_diff_paths)
        .collect::<HashSet<_>>();
    let replaced_ids = cycle
        .deltas
        .iter()
        .filter_map(|(delta_id, delta)| {
            (delta.state != NativeReviewDeltaState::Superseded
                && delta
                    .files
                    .iter()
                    .flat_map(review_file_paths)
                    .all(|path| incoming_paths.contains(path)))
            .then_some(delta_id.clone())
        })
        .collect::<Vec<_>>();
    let superseded = replaced_ids
        .into_iter()
        .filter_map(|delta_id| {
            cycle.pending_deltas.remove(&delta_id);
            cycle.deltas.get(&delta_id).cloned()
        })
        .map(|delta| NativeReviewDeltaSummary {
            state: NativeReviewDeltaState::Superseded,
            files: delta
                .files
                .into_iter()
                .map(|file| NativeReviewFileSummary {
                    state: NativeReviewDeltaState::Superseded,
                    ..file
                })
                .collect(),
            ..delta
        })
        .collect::<Vec<_>>();
    for delta in &superseded {
        cycle.deltas.insert(delta.delta_id.clone(), delta.clone());
    }
    superseded
}

fn review_diff_paths(diff: &NativeReviewRuntimeDiff) -> impl Iterator<Item = &str> {
    std::iter::once(diff.path.as_str()).chain(diff.previous_path.as_deref())
}

fn review_file_paths(file: &NativeReviewFileSummary) -> impl Iterator<Item = &str> {
    std::iter::once(file.path.as_str()).chain(file.previous_path.as_deref())
}

fn provisional_review_tracked_files(pending: &PendingReviewDelta) -> Vec<serde_json::Value> {
    pending
        .diffs
        .iter()
        .filter(|diff| diff.unavailable_reason.is_none())
        .filter_map(|diff| {
            let mut file = compute_tracked_file_patch(
                &pending.delta.session_id.0,
                &diff.path,
                diff.previous_path.clone(),
                diff.old_text.clone(),
                diff.new_text.clone(),
                pending.delta.updated_at.clone(),
            )?;
            // The preparation phase exposes file content promptly, while only the worker owns
            // definitive hunks and their anchoring information.
            file.hunks.clear();
            file.hunks_are_anchored = None;
            file.tool_call_id = Some(pending.delta.tool_call_id.0.clone());
            file.version = u32::try_from(pending.delta.revision.0).ok();
            Some(serde_json::to_value(file).expect("provisional tracked file serializes"))
        })
        .collect()
}

fn record_review_delta(name: &'static str, started_at: Instant, delta: &NativeReviewDeltaSummary) {
    crate::performance::record(name, started_at.elapsed(), || {
        format!(
            "deltaId={} sessionId={} toolCallId={} state={:?}",
            delta.delta_id.0, delta.session_id.0, delta.tool_call_id.0, delta.state
        )
    });
}

fn review_worker_task_is_current(
    registry: &Arc<Mutex<ReviewWorkerRegistry>>,
    task: &NativeReviewWorkerTask,
) -> bool {
    let registry = registry.lock().expect("review worker registry lock");
    let Some(cycle) = registry
        .sessions
        .get(&task.base.session_id)
        .and_then(|session| session.cycles.get(&task.work_cycle_id))
    else {
        return false;
    };
    cycle.epoch == task.epoch
}

fn materialize_review_worker_task(
    registry: &Arc<Mutex<ReviewWorkerRegistry>>,
    task: NativeReviewWorkerTask,
) -> Option<NativeReviewWorkerResult> {
    let materialization_started_at = Instant::now();
    crate::performance::record(
        "sidecar.review-worker-queue",
        materialization_started_at.duration_since(task.queued_at),
        || {
            format!(
                "deltaId={} sessionId={} toolCallId={}",
                task.delta_id.0, task.base.session_id.0, task.tool_call_id.0
            )
        },
    );
    let context = {
        let registry = registry.lock().expect("review worker registry lock");
        registry
            .sessions
            .get(&task.base.session_id)
            .and_then(|session| session.cycles.get(&task.work_cycle_id))
            .filter(|cycle| cycle.epoch == task.epoch)
            .map(|cycle| cycle.context.clone())?
    };
    let diffs = {
        let registry = registry.lock().expect("review worker registry lock");
        registry
            .sessions
            .get(&task.base.session_id)
            .and_then(|session| session.cycles.get(&task.work_cycle_id))
            .filter(|cycle| cycle.epoch == task.epoch)
            .and_then(|cycle| cycle.pending_deltas.get(&task.delta_id))
            .map(|pending| Arc::clone(&pending.diffs))?
    };
    let updated_at = now();
    let materialized_files = diffs
        .iter()
        .map(|diff| materialize_review_file(&context, diff, &task.base.session_id, &updated_at))
        .collect::<Vec<_>>();
    let files = materialized_files
        .iter()
        .map(|file| file.summary.clone())
        .collect::<Vec<_>>();
    let tracked_files = materialized_files
        .into_iter()
        .filter_map(|file| file.tracked_file)
        .collect::<Vec<_>>();
    let state = if files
        .iter()
        .all(|file| file.state == NativeReviewDeltaState::Ready)
    {
        NativeReviewDeltaState::Ready
    } else if files
        .iter()
        .all(|file| file.state == NativeReviewDeltaState::Unavailable)
    {
        NativeReviewDeltaState::Unavailable
    } else {
        NativeReviewDeltaState::Partial
    };
    let delta = NativeReviewDeltaSummary {
        delta_id: task.delta_id.clone(),
        session_id: task.base.session_id.clone(),
        work_cycle_id: task.work_cycle_id.clone(),
        tool_call_id: task.tool_call_id.clone(),
        input_revision: task.input_revision,
        revision: task.revision,
        state,
        files,
        updated_at,
    };
    if !review_worker_task_is_current(registry, &task) {
        return None;
    }
    record_review_delta(
        "sidecar.review-worker-materialize",
        materialization_started_at,
        &delta,
    );
    Some(NativeReviewWorkerResult {
        base: task.base,
        delta,
        epoch: task.epoch,
        tracked_files,
    })
}

#[derive(Debug)]
struct MaterializedReviewFile {
    summary: NativeReviewFileSummary,
    tracked_file: Option<ReviewTrackedFile>,
}

fn materialize_review_file(
    context: &ReviewBaselineContext,
    diff: &NativeReviewRuntimeDiff,
    session_id: &SessionId,
    updated_at: &str,
) -> MaterializedReviewFile {
    if let Some(reason) = diff.unavailable_reason {
        return unavailable_review_file(diff, reason);
    }
    if diff.old_text.is_none() && diff.new_text.is_none() {
        return unavailable_review_file(diff, ReviewUnavailableReason::MissingText);
    }
    let observed = match read_worker_current_text(context, &diff.path) {
        Ok(observed) => observed,
        Err(reason) => return unavailable_review_file(diff, reason),
    };
    let observed_hash = observed
        .as_ref()
        .map(|text| hash_content_bytes(text.as_bytes()));
    let state = if observed.as_ref().is_some_and(|text| {
        diff.new_text.as_deref() != Some(text) && diff.old_text.as_deref() != Some(text)
    }) {
        NativeReviewDeltaState::Partial
    } else {
        NativeReviewDeltaState::Ready
    };
    // Keep detail in the backend so the control plane only emits its summary.
    let tracked_file = compute_tracked_file_patch(
        &session_id.0,
        &diff.path,
        diff.previous_path.clone(),
        diff.old_text.clone(),
        diff.new_text.clone(),
        updated_at.to_string(),
    );
    MaterializedReviewFile {
        summary: NativeReviewFileSummary {
            path: diff.path.clone(),
            previous_path: diff.previous_path.clone(),
            state,
            observed_hash,
            reason: None,
        },
        tracked_file,
    }
}

#[derive(Debug, Clone, Copy)]
enum ReviewUnavailableReason {
    BaselineUnavailable,
    MissingText,
    TooLarge,
    NotText,
    ContentUnavailable,
    WorkerUnavailable,
}

impl ReviewUnavailableReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::BaselineUnavailable => "baseline_unavailable",
            Self::MissingText => "missing_text",
            Self::TooLarge => "too_large",
            Self::NotText => "not_text",
            Self::ContentUnavailable => "content_unavailable",
            Self::WorkerUnavailable => "worker_unavailable",
        }
    }
}

fn unavailable_review_file(
    diff: &NativeReviewRuntimeDiff,
    reason: ReviewUnavailableReason,
) -> MaterializedReviewFile {
    MaterializedReviewFile {
        summary: NativeReviewFileSummary {
            path: diff.path.clone(),
            previous_path: diff.previous_path.clone(),
            state: NativeReviewDeltaState::Unavailable,
            observed_hash: None,
            reason: Some(reason.as_str().to_string()),
        },
        tracked_file: None,
    }
}

fn read_worker_current_text(
    context: &ReviewBaselineContext,
    review_path: &str,
) -> Result<Option<String>, ReviewUnavailableReason> {
    let resolved = resolve_worker_review_path(context, review_path)
        .ok_or(ReviewUnavailableReason::ContentUnavailable)?;
    if let Some(buffer) = context.observed_buffers.get(&resolved) {
        return Ok(Some(buffer.content.clone()));
    }
    let metadata = match fs::metadata(&resolved) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ReviewUnavailableReason::ContentUnavailable),
    };
    if metadata.len() > MAX_REVIEW_TEXT_BYTES {
        return Err(ReviewUnavailableReason::TooLarge);
    }
    let bytes = fs::read(resolved).map_err(|_| ReviewUnavailableReason::ContentUnavailable)?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| ReviewUnavailableReason::NotText)
}

fn resolve_worker_review_path(
    context: &ReviewBaselineContext,
    review_path: &str,
) -> Option<PathBuf> {
    let candidate = PathBuf::from(review_path);
    if candidate.is_absolute() {
        if candidate
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return None;
        }
        let mut roots = std::iter::once(PathBuf::from(&context.cwd))
            .chain(context.additional_roots.iter().map(PathBuf::from));
        return roots
            .any(|root| candidate.starts_with(root))
            .then_some(candidate);
    }
    if candidate
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(Path::new(&context.cwd).join(candidate))
}

#[derive(Debug)]
struct NativeReviewWorker {
    handle: NativeReviewWorkerHandle,
    results: mpsc::Receiver<NativeReviewWorkerResult>,
    thread: Option<thread::JoinHandle<()>>,
}

#[derive(Debug, Clone)]
pub struct NativeReviewWorkerHandle {
    registry: Arc<Mutex<ReviewWorkerRegistry>>,
    sender: mpsc::Sender<NativeReviewWorkerCommand>,
}

#[derive(Debug, Default)]
struct ReviewWorkerRegistry {
    sessions: HashMap<SessionId, ReviewWorkerSession>,
}

#[derive(Debug, Clone, Default)]
struct ReviewWorkerSession {
    cycles: HashMap<String, ReviewWorkerCycle>,
    current_work_cycle_id: Option<String>,
    parent_session_id: Option<SessionId>,
}

#[derive(Debug, Clone)]
struct ReviewWorkerCycle {
    context: ReviewBaselineContext,
    deltas: HashMap<ReviewDeltaId, NativeReviewDeltaSummary>,
    epoch: u64,
    next_revision: u64,
    pending_deltas: HashMap<ReviewDeltaId, PendingReviewDelta>,
}

#[derive(Debug, Clone)]
struct PendingReviewDelta {
    delta: NativeReviewDeltaSummary,
    diffs: Arc<[NativeReviewRuntimeDiff]>,
}

fn review_worker_cycles_for_child(
    cycles: &HashMap<String, ReviewWorkerCycle>,
) -> HashMap<String, ReviewWorkerCycle> {
    cycles
        .iter()
        .map(|(work_cycle_id, cycle)| {
            let mut inherited = cycle.clone();
            // A child inherits the baseline, not another session's queued payloads.
            inherited.deltas.clear();
            inherited.pending_deltas.clear();
            (work_cycle_id.clone(), inherited)
        })
        .collect()
}

#[derive(Debug)]
enum NativeReviewWorkerCommand {
    Materialize(NativeReviewWorkerTask),
    Shutdown,
}

#[derive(Debug, Clone)]
struct NativeReviewWorkerTask {
    base: NativeAiEventBase,
    delta_id: ReviewDeltaId,
    epoch: u64,
    input_revision: ReviewRevision,
    revision: ReviewRevision,
    tool_call_id: ToolCallId,
    work_cycle_id: String,
    queued_at: Instant,
}

#[derive(Debug)]
struct NativeReviewWorkerResult {
    base: NativeAiEventBase,
    delta: NativeReviewDeltaSummary,
    epoch: u64,
    tracked_files: Vec<ReviewTrackedFile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeReviewRuntimeDiff {
    path: String,
    #[serde(default)]
    previous_path: Option<String>,
    #[serde(default)]
    old_text: Option<String>,
    #[serde(default)]
    new_text: Option<String>,
    #[serde(skip)]
    unavailable_reason: Option<ReviewUnavailableReason>,
}

#[derive(Debug, Clone)]
struct ReviewBuffer {
    content: String,
    content_hash: String,
    revision: ReviewRevision,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct ReviewWorkState {
    context: ReviewBaselineContext,
    decisions: HashMap<ReviewDeltaId, ReviewRevision>,
    deltas: HashMap<ReviewDeltaId, NativeReviewDeltaSummary>,
    materialized_files: HashMap<ReviewDeltaId, Vec<ReviewTrackedFile>>,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct ReviewBaselineContext {
    additional_roots: Vec<String>,
    cwd: String,
    observed_buffers: HashMap<PathBuf, ReviewBuffer>,
    revision: ReviewRevision,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewSessionInput {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_cycle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_revision: Option<ReviewRevision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<ToolCallId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewFileBufferInput {
    pub absolute_path: String,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewFileMutationInput {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_root: Option<String>,
    pub tracked_file: ReviewTrackedFile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<NativeReviewDeltaReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewHunkMutationInput {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_root: Option<String>,
    pub tracked_file: ReviewTrackedFile,
    pub hunk_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<NativeReviewDeltaReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewRejectAllInput {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_root: Option<String>,
    #[serde(default)]
    pub tracked_files: Vec<ReviewTrackedFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<NativeReviewDeltaReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewCaptureOutput {
    pub captured: bool,
    pub session_id: SessionId,
    pub updated_at: String,
    pub work_cycle_id: String,
    pub revision: ReviewRevision,
    pub delta: NativeReviewDeltaSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewCommandOutput {
    pub session_id: SessionId,
    pub tracked_files: Vec<ReviewTrackedFile>,
    pub changed_files: Vec<String>,
    pub conflicts: Vec<NativeReviewConflict>,
    pub updated_at: String,
    pub state_found: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeReviewConflict {
    pub path: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_change_hash: Option<String>,
}

#[derive(Debug, Clone)]
struct RollbackBackup {
    path: PathBuf,
    content: Option<Vec<u8>>,
    open_buffer: Option<ReviewBuffer>,
}

impl NativeReviewService {
    pub fn set_app_data_dir(&mut self, _app_data_dir: impl Into<PathBuf>) {}

    pub fn worker_handle(&self) -> NativeReviewWorkerHandle {
        self.worker.handle.clone()
    }

    pub fn drain_worker_events(&mut self) -> Vec<NativeAiReviewDeltaReadyPayload> {
        let mut events = Vec::new();
        for result in self.worker.results.try_iter() {
            if !self.worker.handle.result_is_current(&result) {
                continue;
            }
            self.worker.handle.record_delta(result.delta.clone());
            self.worker.handle.remove_pending_delta(
                &result.delta.session_id,
                &result.delta.work_cycle_id,
                &result.delta.delta_id,
            );
            let needs_inherited_cycle = self
                .work_states
                .get(&result.delta.session_id)
                .is_none_or(|cycles| !cycles.contains_key(&result.delta.work_cycle_id));
            if needs_inherited_cycle {
                let mut ancestor_id = result.delta.session_id.clone();
                while let Some(parent_id) = self.worker.handle.parent_session_id(&ancestor_id) {
                    if let Some(parent_state) = self
                        .work_states
                        .get(&parent_id)
                        .and_then(|cycles| cycles.get(&result.delta.work_cycle_id))
                        .cloned()
                    {
                        self.work_states
                            .entry(result.delta.session_id.clone())
                            .or_default()
                            .insert(result.delta.work_cycle_id.clone(), parent_state);
                        break;
                    }
                    ancestor_id = parent_id;
                }
            }
            let Some(state) = self
                .work_states
                .get_mut(&result.delta.session_id)
                .and_then(|cycles| cycles.get_mut(&result.delta.work_cycle_id))
            else {
                continue;
            };
            state
                .deltas
                .insert(result.delta.delta_id.clone(), result.delta.clone());
            state
                .materialized_files
                .insert(result.delta.delta_id.clone(), result.tracked_files);
            events.push(NativeAiReviewDeltaReadyPayload {
                base: result.base,
                delta: result.delta,
            });
        }
        events
    }

    pub fn close_session(&mut self, session_id: &SessionId) {
        self.work_states.remove(session_id);
        self.worker.handle.cancel_session(session_id);
    }

    pub fn notify_file_buffer(&mut self, input: NativeReviewFileBufferInput) {
        let path = PathBuf::from(input.absolute_path);
        if let Some(content) = input.content {
            let revision = self
                .open_buffers
                .get(&path)
                .map(|buffer| ReviewRevision(buffer.revision.0 + 1))
                .unwrap_or(ReviewRevision(1));
            self.open_buffers.insert(
                path.clone(),
                ReviewBuffer {
                    content_hash: hash_content_bytes(content.as_bytes()),
                    content,
                    revision,
                },
            );
            self.worker
                .handle
                .update_buffer(&path, self.open_buffers.get(&path).cloned());
        } else {
            self.open_buffers.remove(&path);
            self.worker.handle.update_buffer(&path, None);
        }
    }

    pub fn capture_baseline(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewSessionInput,
    ) -> Result<NativeReviewCaptureOutput, NativeError> {
        self.baseline_counter = self.baseline_counter.saturating_add(1);
        let work_cycle_id = input
            .work_cycle_id
            .unwrap_or_else(|| format!("baseline-{}", self.baseline_counter));
        let revision = input.input_revision.unwrap_or(ReviewRevision(1));
        let tool_call_id = input
            .tool_call_id
            .unwrap_or_else(|| ToolCallId("baseline".into()));
        let updated_at = now();
        let delta_id = ReviewDeltaId(format!(
            "baseline:{}:{}",
            session.session_id.0, self.baseline_counter
        ));
        let delta = NativeReviewDeltaSummary {
            delta_id: delta_id.clone(),
            session_id: session.session_id.clone(),
            work_cycle_id: work_cycle_id.clone(),
            tool_call_id,
            input_revision: revision,
            revision,
            state: NativeReviewDeltaState::Unavailable,
            files: Vec::new(),
            updated_at: updated_at.clone(),
        };
        let mut deltas = self
            .work_states
            .get(&session.session_id)
            .and_then(|cycles| cycles.get(&work_cycle_id))
            .map(|state| state.deltas.clone())
            .unwrap_or_default();
        for previous_delta in deltas.values_mut() {
            previous_delta.state = NativeReviewDeltaState::Superseded;
        }
        deltas.insert(delta_id, delta.clone());
        let context = ReviewBaselineContext {
            additional_roots: session.scope.additional_roots.clone(),
            cwd: session.scope.cwd.clone(),
            observed_buffers: self.open_buffers.clone(),
            revision,
        };
        let work_state = ReviewWorkState {
            context: context.clone(),
            decisions: HashMap::new(),
            deltas,
            materialized_files: HashMap::new(),
        };
        self.work_states
            .entry(session.session_id.clone())
            .or_default()
            .insert(work_cycle_id.clone(), work_state);
        self.worker.handle.register_baseline(
            session.session_id.clone(),
            work_cycle_id.clone(),
            context,
        );
        Ok(NativeReviewCaptureOutput {
            captured: true,
            session_id: session.session_id.clone(),
            updated_at,
            work_cycle_id,
            revision,
            delta,
        })
    }

    pub fn load_delta(
        &self,
        input: NativeReviewLoadDeltaInput,
    ) -> Result<NativeReviewLoadDeltaOutput, NativeError> {
        let started_at = Instant::now();
        if let Some(pending) = self.worker.handle.pending_delta(&input.reference) {
            let output = NativeReviewLoadDeltaOutput {
                tracked_files: provisional_review_tracked_files(&pending),
                delta: pending.delta,
            };
            record_review_delta("sidecar.review-delta-load", started_at, &output.delta);
            return Ok(output);
        }
        let delta = self.resolve_reference(&input.reference)?;
        let tracked_files = self
            .work_states
            .get(&input.reference.session_id)
            .and_then(|cycles| cycles.get(&input.reference.work_cycle_id))
            .and_then(|state| state.materialized_files.get(&input.reference.delta_id))
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|file| serde_json::to_value(file).expect("tracked file serializes"))
            .collect();
        let output = NativeReviewLoadDeltaOutput {
            delta,
            tracked_files,
        };
        record_review_delta("sidecar.review-delta-load", started_at, &output.delta);
        Ok(output)
    }

    fn resolve_reference(
        &self,
        reference: &NativeReviewDeltaReference,
    ) -> Result<NativeReviewDeltaSummary, NativeError> {
        let state = self
            .work_states
            .get(&reference.session_id)
            .and_then(|cycles| cycles.get(&reference.work_cycle_id))
            .ok_or_else(|| review_reference_conflict(reference, "work_cycle_not_found"))?;
        let delta = state
            .deltas
            .get(&reference.delta_id)
            .ok_or_else(|| review_reference_conflict(reference, "delta_not_found"))?;
        if delta.session_id != reference.session_id
            || delta.work_cycle_id != reference.work_cycle_id
            || delta.tool_call_id != reference.tool_call_id
            || delta.input_revision != reference.input_revision
        {
            return Err(review_reference_conflict(reference, "reference_mismatch"));
        }
        if delta.state == NativeReviewDeltaState::Superseded {
            return Err(review_reference_conflict(reference, "superseded"));
        }
        if delta.revision != reference.expected_revision {
            return Err(review_reference_conflict(reference, "stale_revision"));
        }
        Ok(delta.clone())
    }

    fn record_decision(
        &mut self,
        reference: &NativeReviewDeltaReference,
    ) -> Result<(), NativeError> {
        let delta = self.resolve_reference(reference)?;
        let state = self
            .work_states
            .get_mut(&reference.session_id)
            .and_then(|cycles| cycles.get_mut(&reference.work_cycle_id))
            .expect("validated review work state exists");
        state
            .decisions
            .insert(delta.delta_id, reference.expected_revision);
        Ok(())
    }

    pub fn reject_file(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewFileMutationInput,
        write_tracker: &WriteTracker,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        self.worker.handle.prioritize_session(&input.session_id);
        if let Some(reference) = input.reference.as_ref() {
            self.record_decision(reference)?;
        }
        let updated_at = now();
        let review_root = normalize_review_root(session, input.review_root.as_deref())?;
        let tracked_file = self.prepare_tracked_file(
            session,
            review_root.as_deref(),
            input.tracked_file,
            input.expected_version,
        )?;
        let changed_files = self.revert_tracked_file(
            session,
            review_root.as_deref(),
            &tracked_file,
            write_tracker,
        )?;
        Ok(command_output(
            session.session_id.clone(),
            changed_files,
            updated_at,
        ))
    }

    pub fn reject_hunks(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewHunkMutationInput,
        write_tracker: &WriteTracker,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        self.worker.handle.prioritize_session(&input.session_id);
        if let Some(reference) = input.reference.as_ref() {
            self.record_decision(reference)?;
        }
        let updated_at = now();
        let review_root = normalize_review_root(session, input.review_root.as_deref())?;
        let tracked_file = self.prepare_tracked_file(
            session,
            review_root.as_deref(),
            input.tracked_file,
            input.expected_version,
        )?;
        self.assert_current_matches(session, review_root.as_deref(), &tracked_file)?;

        let hunk_ids = normalize_review_hunk_ids(
            session,
            review_root.as_deref(),
            &input.hunk_ids,
            &tracked_file.path,
        );
        let next = resolve_tracked_file_hunks(
            &tracked_file,
            &hunk_ids,
            ReviewDecision::Reject,
            updated_at.clone(),
        );

        let mut changed_files = Vec::new();
        if let Some(next_file) = next {
            let current = tracked_current_text(&tracked_file);
            let next_text = tracked_current_text(&next_file);
            if current != next_text {
                self.write_review_text(
                    session,
                    review_root.as_deref(),
                    &next_file.path,
                    &next_text,
                    write_tracker,
                )?;
                changed_files.push(next_file.path.clone());
            }
        } else {
            changed_files.extend(self.revert_tracked_file(
                session,
                review_root.as_deref(),
                &tracked_file,
                write_tracker,
            )?);
        }

        Ok(command_output(
            session.session_id.clone(),
            changed_files,
            updated_at,
        ))
    }

    pub fn reject_all(
        &mut self,
        session: &NativeAiSession,
        input: NativeReviewRejectAllInput,
        write_tracker: &WriteTracker,
    ) -> Result<NativeReviewCommandOutput, NativeError> {
        self.worker.handle.prioritize_session(&input.session_id);
        if let Some(reference) = input.reference.as_ref() {
            self.record_decision(reference)?;
        }
        let updated_at = now();
        let review_root = normalize_review_root(session, input.review_root.as_deref())?;
        let tracked_files = input
            .tracked_files
            .into_iter()
            .map(|tracked_file| {
                self.prepare_tracked_file(session, review_root.as_deref(), tracked_file, None)
            })
            .collect::<Result<Vec<_>, _>>()?;

        for tracked_file in &tracked_files {
            self.assert_current_matches(session, review_root.as_deref(), tracked_file)?;
            self.assert_move_previous_path_available(
                session,
                review_root.as_deref(),
                tracked_file,
            )?;
        }

        let backups =
            self.create_rollback_backups(session, review_root.as_deref(), &tracked_files)?;
        let mut changed_files = Vec::new();
        if let Err(error) = tracked_files.iter().try_for_each(|tracked_file| {
            self.revert_tracked_file(session, review_root.as_deref(), tracked_file, write_tracker)
                .map(|paths| changed_files.extend(paths))
        }) {
            if let Err(rollback_error) = self.restore_backups(backups, write_tracker) {
                return Err(NativeError::new(
                    NativeErrorCode::InternalError,
                    format!(
                        "Native review reject all failed and rollback could not be completed: {} Rollback error: {}",
                        error.message, rollback_error.message
                    ),
                )
                .with_details(json!({
                    "originalError": error,
                    "rollbackError": rollback_error
                })));
            }
            return Err(error);
        }

        Ok(command_output(
            session.session_id.clone(),
            changed_files,
            updated_at,
        ))
    }

    fn prepare_tracked_file(
        &self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        tracked_file: ReviewTrackedFile,
        expected_version: Option<u32>,
    ) -> Result<ReviewTrackedFile, NativeError> {
        if tracked_file.session_id != session.session_id.0 {
            return Err(NativeError::new(
                NativeErrorCode::InvalidArgs,
                "Cannot safely apply this review change because the session does not match.",
            ));
        }
        validate_version(&tracked_file, expected_version)?;

        let mut normalized = tracked_file;
        normalize_tracked_file_paths(session, review_root, &mut normalized)?;
        Ok(sync_tracked_file(&normalized))
    }

    fn read_working_tree_text(
        &self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        review_path: &str,
    ) -> Result<Option<String>, NativeError> {
        let resolved = match resolve_review_path_for_root(
            session,
            review_root,
            review_path,
            ScopedPathIntent::ReadExisting,
        ) {
            Ok(path) => path,
            Err(error) if error.code == NativeErrorCode::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if let Some(buffer) = self.open_buffers.get(&resolved) {
            return ensure_review_text(buffer.content.clone(), review_path);
        }
        read_text_file_for_review(&resolved, review_path)
    }

    fn assert_current_matches(
        &self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        tracked_file: &ReviewTrackedFile,
    ) -> Result<(), NativeError> {
        let expected = match tracked_file.kind {
            ReviewTrackedFileKind::Delete => None,
            _ => Some(tracked_current_text(tracked_file)),
        };
        let current = self.read_working_tree_text(session, review_root, &tracked_file.path)?;
        match (expected, current) {
            (None, None) => Ok(()),
            (Some(expected), Some(current)) if expected == current => Ok(()),
            (Some(_), Some(current)) => Err(review_conflict(
                &tracked_file.path,
                "content_hash_mismatch",
                Some(hash_content_bytes(current.as_bytes())),
            )),
            (Some(_), None) => Err(review_conflict(&tracked_file.path, "missing_file", None)),
            (None, Some(current)) => Err(review_conflict(
                &tracked_file.path,
                "path_exists",
                Some(hash_content_bytes(current.as_bytes())),
            )),
        }
    }

    fn assert_move_previous_path_available(
        &self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        tracked_file: &ReviewTrackedFile,
    ) -> Result<(), NativeError> {
        if tracked_file.kind != ReviewTrackedFileKind::Move {
            return Ok(());
        }
        let Some(previous_path) = tracked_file.previous_path.as_deref() else {
            return Ok(());
        };
        if self
            .read_working_tree_text(session, review_root, previous_path)?
            .is_some()
        {
            return Err(review_conflict(previous_path, "path_exists", None));
        }
        Ok(())
    }

    fn revert_tracked_file(
        &mut self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        tracked_file: &ReviewTrackedFile,
        write_tracker: &WriteTracker,
    ) -> Result<Vec<String>, NativeError> {
        self.assert_current_matches(session, review_root, tracked_file)?;
        self.assert_move_previous_path_available(session, review_root, tracked_file)?;
        let mut changed = Vec::new();
        match tracked_file.kind {
            ReviewTrackedFileKind::Create => {
                self.remove_review_file(session, review_root, &tracked_file.path, write_tracker)?;
                changed.push(tracked_file.path.clone());
            }
            ReviewTrackedFileKind::Delete | ReviewTrackedFileKind::Update => {
                let old_text = tracked_file
                    .old_text
                    .as_deref()
                    .ok_or_else(|| review_conflict(&tracked_file.path, "not_reversible", None))?;
                self.write_review_text(
                    session,
                    review_root,
                    &tracked_file.path,
                    old_text,
                    write_tracker,
                )?;
                changed.push(tracked_file.path.clone());
            }
            ReviewTrackedFileKind::Move => {
                let old_text = tracked_file
                    .old_text
                    .as_deref()
                    .ok_or_else(|| review_conflict(&tracked_file.path, "not_reversible", None))?;
                let previous_path = tracked_file
                    .previous_path
                    .as_deref()
                    .ok_or_else(|| review_conflict(&tracked_file.path, "not_reversible", None))?;
                self.remove_review_file(session, review_root, &tracked_file.path, write_tracker)?;
                self.write_review_text(
                    session,
                    review_root,
                    previous_path,
                    old_text,
                    write_tracker,
                )?;
                changed.push(tracked_file.path.clone());
                changed.push(previous_path.to_string());
            }
        }
        Ok(changed)
    }

    fn write_review_text(
        &mut self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        relative_path: &str,
        text: &str,
        write_tracker: &WriteTracker,
    ) -> Result<(), NativeError> {
        let resolved = resolve_review_path_for_root(
            session,
            review_root,
            relative_path,
            ScopedPathIntent::CreateTarget,
        )?;
        if let Some(parent) = resolved.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| review_io("create review parent directory", parent, error))?;
        }
        fs::write(&resolved, text)
            .map_err(|error| review_io("write review file", &resolved, error))?;
        write_tracker.track_content(resolved.clone(), text);
        if let Some(buffer) = self.open_buffers.get_mut(&resolved) {
            buffer.content = text.to_string();
            buffer.content_hash = hash_content_bytes(text.as_bytes());
            buffer.revision = ReviewRevision(buffer.revision.0 + 1);
        }
        Ok(())
    }

    fn remove_review_file(
        &mut self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        relative_path: &str,
        write_tracker: &WriteTracker,
    ) -> Result<(), NativeError> {
        let resolved = resolve_review_path_for_root(
            session,
            review_root,
            relative_path,
            ScopedPathIntent::ReadExisting,
        )?;
        match fs::remove_file(&resolved) {
            Ok(()) => {
                write_tracker.track_any(resolved.clone());
                self.open_buffers.remove(&resolved);
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(review_io("remove review file", &resolved, error)),
        }
    }

    fn create_rollback_backups(
        &self,
        session: &NativeAiSession,
        review_root: Option<&str>,
        tracked_files: &[ReviewTrackedFile],
    ) -> Result<Vec<RollbackBackup>, NativeError> {
        let mut paths = HashSet::new();
        let mut backups = Vec::new();
        for tracked_file in tracked_files {
            for relative_path in revert_paths(tracked_file) {
                let resolved = resolve_review_path_for_root(
                    session,
                    review_root,
                    &relative_path,
                    ScopedPathIntent::CreateTarget,
                )?;
                if !paths.insert(resolved.clone()) {
                    continue;
                }
                let content = match fs::read(&resolved) {
                    Ok(content) => Some(content),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(review_io("backup review file", &resolved, error)),
                };
                let open_buffer = self.open_buffers.get(&resolved).cloned();
                backups.push(RollbackBackup {
                    path: resolved,
                    content,
                    open_buffer,
                });
            }
        }
        Ok(backups)
    }

    fn restore_backups(
        &mut self,
        backups: Vec<RollbackBackup>,
        write_tracker: &WriteTracker,
    ) -> Result<(), NativeError> {
        for backup in backups.into_iter().rev() {
            if let Some(content) = backup.content {
                if let Some(parent) = backup.path.parent() {
                    fs::create_dir_all(parent).map_err(|error| {
                        review_io("restore review parent directory", parent, error)
                    })?;
                }
                fs::write(&backup.path, &content)
                    .map_err(|error| review_io("restore review file", &backup.path, error))?;
                write_tracker.track_bytes(backup.path.clone(), &content);
            } else if let Err(error) = fs::remove_file(&backup.path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                return Err(review_io(
                    "remove restored review file",
                    &backup.path,
                    error,
                ));
            } else {
                write_tracker.track_any(backup.path.clone());
            }

            if let Some(buffer) = backup.open_buffer {
                self.open_buffers.insert(backup.path, buffer);
            } else {
                self.open_buffers.remove(&backup.path);
            }
        }
        Ok(())
    }
}

fn command_output(
    session_id: SessionId,
    changed_files: Vec<String>,
    updated_at: String,
) -> NativeReviewCommandOutput {
    NativeReviewCommandOutput {
        session_id,
        tracked_files: Vec::new(),
        changed_files,
        conflicts: Vec::new(),
        updated_at,
        state_found: false,
    }
}

fn read_text_file_for_review(
    path: &Path,
    display_path: &str,
) -> Result<Option<String>, NativeError> {
    let metadata =
        fs::metadata(path).map_err(|error| review_io("read review file metadata", path, error))?;
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() > MAX_REVIEW_TEXT_BYTES {
        return Err(NativeError::new(
            NativeErrorCode::TooLarge,
            "Cannot review this file because it is too large.",
        )
        .with_details(json!({ "path": display_path })));
    }
    let bytes = fs::read(path).map_err(|error| review_io("read review file", path, error))?;
    if bytes.contains(&0) {
        return Err(NativeError::new(
            NativeErrorCode::BinaryFile,
            "Cannot review binary files as text.",
        )
        .with_details(json!({ "path": display_path })));
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        NativeError::new(
            NativeErrorCode::NotSupported,
            "Cannot review this file because its encoding is unsupported.",
        )
        .with_details(json!({ "path": display_path }))
    })?;
    ensure_review_text(text, display_path)
}

fn ensure_review_text(text: String, display_path: &str) -> Result<Option<String>, NativeError> {
    if text.len() as u64 > MAX_REVIEW_TEXT_BYTES {
        return Err(NativeError::new(
            NativeErrorCode::TooLarge,
            "Cannot review this file because it is too large.",
        )
        .with_details(json!({ "path": display_path })));
    }
    if text.contains('\0') {
        return Err(NativeError::new(
            NativeErrorCode::BinaryFile,
            "Cannot review binary files as text.",
        )
        .with_details(json!({ "path": display_path })));
    }
    Ok(Some(text))
}

fn normalize_review_hunk_ids(
    session: &NativeAiSession,
    review_root: Option<&str>,
    hunk_ids: &[String],
    tracked_path: &str,
) -> Vec<String> {
    let mut normalized = Vec::with_capacity(hunk_ids.len() * 2);
    for hunk_id in hunk_ids {
        normalized.push(hunk_id.clone());
        if let Some(rewritten) = rewrite_review_hunk_id(session, review_root, hunk_id, tracked_path)
            && rewritten != *hunk_id
        {
            normalized.push(rewritten);
        }
    }
    normalized
}

fn rewrite_review_hunk_id(
    session: &NativeAiSession,
    review_root: Option<&str>,
    hunk_id: &str,
    tracked_path: &str,
) -> Option<String> {
    let mut parts = hunk_id.rsplitn(4, ':');
    let hunk_index = parts.next()?;
    let new_start = parts.next()?;
    let old_start = parts.next()?;
    let seed = parts.next()?;
    let normalized_seed =
        normalize_review_path_for_root(session, review_root, seed, ScopedPathIntent::CreateTarget)
            .ok()?
            .state_path;
    if normalized_seed != tracked_path {
        return None;
    }
    Some(format!(
        "{tracked_path}:{old_start}:{new_start}:{hunk_index}"
    ))
}

fn validate_version(
    tracked_file: &ReviewTrackedFile,
    expected_version: Option<u32>,
) -> Result<(), NativeError> {
    if let Some(expected_version) = expected_version
        && tracked_file.version.unwrap_or(1) != expected_version
    {
        return Err(review_conflict(
            &tracked_file.path,
            "stale_review_version",
            None,
        ));
    }
    Ok(())
}

fn revert_paths(tracked_file: &ReviewTrackedFile) -> Vec<String> {
    let mut paths = vec![tracked_file.path.clone()];
    if tracked_file.kind == ReviewTrackedFileKind::Move
        && let Some(previous_path) = &tracked_file.previous_path
    {
        paths.push(previous_path.clone());
    }
    paths
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NormalizedReviewPath {
    absolute_path: PathBuf,
    state_path: String,
}

fn resolve_review_path_for_root(
    session: &NativeAiSession,
    review_root: Option<&str>,
    review_path: &str,
    intent: ScopedPathIntent,
) -> Result<PathBuf, NativeError> {
    normalize_review_path_for_root(session, review_root, review_path, intent)
        .map(|resolved| resolved.absolute_path)
}

fn normalize_review_root(
    session: &NativeAiSession,
    review_root: Option<&str>,
) -> Result<Option<String>, NativeError> {
    let Some(review_root) = review_root.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    let root = Path::new(review_root);
    if !root.is_absolute() {
        return Err(invalid_review_path());
    }
    let cwd = Path::new(&session.scope.cwd);
    if cwd.strip_prefix(root).is_err() {
        return Err(NativeError::new(
            NativeErrorCode::PermissionDenied,
            "Cannot safely apply this review change because the review root is outside the session scope.",
        ));
    }
    Ok(Some(root.to_string_lossy().to_string()))
}

fn normalize_review_path_for_root(
    session: &NativeAiSession,
    review_root: Option<&str>,
    candidate: &str,
    intent: ScopedPathIntent,
) -> Result<NormalizedReviewPath, NativeError> {
    let Some(review_root) = review_root else {
        return normalize_review_path(session, candidate, intent);
    };
    let root = Path::new(review_root);
    let candidate_path = Path::new(candidate);
    if candidate_path.is_absolute() {
        if let Some(normalized) = normalize_absolute_path_inside_root(
            root,
            candidate_path,
            intent,
            AbsoluteReviewPathMode::ProjectRelative,
        )? {
            return Ok(normalized);
        }
        return normalize_absolute_review_path(session, candidate_path, candidate, intent);
    }

    let resolved =
        resolve_scoped_path(root, Some(candidate), false, intent).map_err(review_path_error)?;
    let Some(state_path) = resolved.relative_path else {
        return Err(invalid_review_path());
    };
    Ok(NormalizedReviewPath {
        absolute_path: resolved.absolute_path,
        state_path,
    })
}

fn normalize_tracked_file_paths(
    session: &NativeAiSession,
    review_root: Option<&str>,
    tracked_file: &mut ReviewTrackedFile,
) -> Result<bool, NativeError> {
    let original_path = tracked_file.path.clone();
    let normalized = normalize_review_path_for_root(
        session,
        review_root,
        &original_path,
        ScopedPathIntent::CreateTarget,
    )?;
    let mut changed = original_path != normalized.state_path;
    tracked_file.path = normalized.state_path;

    if let Some(previous_path) = tracked_file.previous_path.as_deref() {
        let original_previous_path = previous_path.to_string();
        let normalized_previous_path = normalize_review_path_for_root(
            session,
            review_root,
            &original_previous_path,
            ScopedPathIntent::CreateTarget,
        )?;
        changed |= original_previous_path != normalized_previous_path.state_path;
        tracked_file.previous_path = Some(normalized_previous_path.state_path);
    }

    if changed {
        *tracked_file = sync_tracked_file(tracked_file);
    }
    Ok(changed)
}

fn normalize_review_path(
    session: &NativeAiSession,
    candidate: &str,
    intent: ScopedPathIntent,
) -> Result<NormalizedReviewPath, NativeError> {
    let candidate_path = Path::new(candidate);
    if candidate_path.is_absolute() {
        return normalize_absolute_review_path(session, candidate_path, candidate, intent);
    }

    let resolved = resolve_scoped_path(
        Path::new(&session.scope.cwd),
        Some(candidate),
        false,
        intent,
    )
    .map_err(review_path_error)?;
    let Some(state_path) = resolved.relative_path else {
        return Err(invalid_review_path());
    };
    Ok(NormalizedReviewPath {
        absolute_path: resolved.absolute_path,
        state_path,
    })
}

fn normalize_absolute_review_path(
    session: &NativeAiSession,
    candidate_path: &Path,
    candidate_display: &str,
    intent: ScopedPathIntent,
) -> Result<NormalizedReviewPath, NativeError> {
    if let Some(normalized) = normalize_absolute_path_inside_root(
        Path::new(&session.scope.cwd),
        candidate_path,
        intent,
        AbsoluteReviewPathMode::ProjectRelative,
    )? {
        return Ok(normalized);
    }

    for root in &session.scope.additional_roots {
        if let Some(normalized) = normalize_absolute_path_inside_root(
            Path::new(root),
            candidate_path,
            intent,
            AbsoluteReviewPathMode::KeepAbsolute(candidate_display),
        )? {
            return Ok(normalized);
        }
    }

    Err(NativeError::new(
        NativeErrorCode::PermissionDenied,
        "Cannot safely apply this review change because the path is outside the project.",
    ))
}

#[derive(Debug, Clone, Copy)]
enum AbsoluteReviewPathMode<'a> {
    ProjectRelative,
    KeepAbsolute(&'a str),
}

fn normalize_absolute_path_inside_root(
    root: &Path,
    candidate_path: &Path,
    intent: ScopedPathIntent,
    mode: AbsoluteReviewPathMode<'_>,
) -> Result<Option<NormalizedReviewPath>, NativeError> {
    let Ok(relative) = candidate_path.strip_prefix(root) else {
        return Ok(None);
    };
    let relative_path = normalize_relative_path(relative);
    let resolved = resolve_scoped_path(root, Some(&relative_path), false, intent)
        .map_err(review_path_error)?;
    let Some(resolved_relative_path) = resolved.relative_path else {
        return Err(invalid_review_path());
    };
    let state_path = match mode {
        AbsoluteReviewPathMode::ProjectRelative => resolved_relative_path,
        AbsoluteReviewPathMode::KeepAbsolute(candidate_display) => candidate_display.to_string(),
    };
    Ok(Some(NormalizedReviewPath {
        absolute_path: resolved.absolute_path,
        state_path,
    }))
}

fn invalid_review_path() -> NativeError {
    NativeError::new(
        NativeErrorCode::InvalidArgs,
        "Cannot safely apply this review change because the path is invalid.",
    )
}

fn review_path_error(error: comando_fs::FsError) -> NativeError {
    match error {
        comando_fs::FsError::NotFound => {
            NativeError::new(NativeErrorCode::NotFound, "Review file was not found.")
        }
        comando_fs::FsError::PathEscape => NativeError::new(
            NativeErrorCode::PermissionDenied,
            "Cannot safely apply this review change because the path is outside the project.",
        ),
        comando_fs::FsError::InvalidPath => NativeError::new(
            NativeErrorCode::InvalidArgs,
            "Cannot safely apply this review change because the path is invalid.",
        ),
        _ => error.to_native_error(),
    }
}

fn review_conflict(path: &str, reason: &str, external_change_hash: Option<String>) -> NativeError {
    NativeError::new(
        NativeErrorCode::Conflict,
        "Cannot safely apply this review change because the file no longer matches the reviewed content.",
    )
    .with_details(json!({
        "conflict": {
            "externalChangeHash": external_change_hash,
            "path": path,
            "reason": reason
        }
    }))
}

fn review_reference_conflict(reference: &NativeReviewDeltaReference, reason: &str) -> NativeError {
    NativeError::new(
        NativeErrorCode::Conflict,
        "Cannot apply this review decision because its delta reference is no longer current.",
    )
    .with_details(json!({
        "reviewDelta": {
            "deltaId": reference.delta_id.0,
            "expectedRevision": reference.expected_revision.0,
            "reason": reason,
            "sessionId": reference.session_id.0,
            "workCycleId": reference.work_cycle_id,
        }
    }))
}

fn review_io(action: &str, path: &Path, error: std::io::Error) -> NativeError {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => NativeErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => NativeErrorCode::PermissionDenied,
        _ => NativeErrorCode::InternalError,
    };
    NativeError::new(code, format!("Native review failed to {action}: {error}"))
        .with_details(json!({ "path": path.to_string_lossy() }))
}

fn now() -> String {
    comando_persistence::store::now_rfc3339()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::thread;
    use std::time::Duration;

    use comando_ai::scope::SessionScope;
    use comando_ai::session::NativeAiSession;
    use comando_diff::compute_tracked_file_patch;
    use comando_fs::WriteTracker;
    use comando_types::ai::NativeAiSessionStatus;
    use comando_types::ids::{RuntimeId, SessionId};

    use super::*;

    #[test]
    fn worker_materializes_terminal_tool_diffs_from_the_versioned_buffer() {
        let repo = tempfile::tempdir().expect("tempdir");
        let path = repo.path().join("a.txt");
        fs::write(&path, "disk before\n").expect("write disk");
        let session = test_session(repo.path(), "s-worker-buffer");
        let mut service = NativeReviewService::default();
        service.notify_file_buffer(NativeReviewFileBufferInput {
            absolute_path: path.to_string_lossy().to_string(),
            content: Some("editor after\n".into()),
        });
        capture_worker_baseline(&mut service, &session, "cycle-1");

        service.worker_handle().enqueue_tool_activity(tool_activity(
            &session,
            "tool-1",
            vec![serde_json::json!({
                "path": "a.txt",
                "oldText": "before\n",
                "newText": "editor after\n"
            })],
        ));

        let events = wait_for_worker_events(&mut service);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].delta.state, NativeReviewDeltaState::Ready);
        assert_eq!(
            events[0].delta.files[0].observed_hash.as_deref(),
            Some(hash_content_bytes(b"editor after\n").as_str())
        );
        let delta = events.into_iter().next().expect("delta event").delta;
        let loaded = service
            .load_delta(NativeReviewLoadDeltaInput {
                reference: NativeReviewDeltaReference {
                    delta_id: delta.delta_id.clone(),
                    expected_revision: delta.revision,
                    input_revision: delta.input_revision,
                    observed_hashes: delta.files.clone(),
                    session_id: delta.session_id.clone(),
                    tool_call_id: delta.tool_call_id.clone(),
                    work_cycle_id: delta.work_cycle_id.clone(),
                },
            })
            .expect("load materialized delta");
        assert_eq!(loaded.tracked_files.len(), 1);
        assert!(loaded.tracked_files[0]["hunks"].is_array());
    }

    #[test]
    fn worker_emits_a_preparing_delta_before_materializing_the_same_identity() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "after\n").expect("write file");
        let session = test_session(repo.path(), "s-worker-preparing");
        let mut service = NativeReviewService::default();
        capture_worker_baseline(&mut service, &session, "cycle-1");

        let preparing = service
            .worker_handle()
            .ingest_tool_activity(tool_activity(
                &session,
                "tool-1",
                vec![serde_json::json!({
                    "path": "a.txt",
                    "oldText": "before\n",
                    "newText": "after\n"
                })],
            ))
            .into_iter()
            .next()
            .expect("preparing delta");

        assert_eq!(preparing.delta.state, NativeReviewDeltaState::Preparing);
        assert_eq!(
            preparing.delta.files[0].state,
            NativeReviewDeltaState::Preparing
        );
        assert_eq!(preparing.delta.files[0].observed_hash, None);
        let pending = service
            .load_delta(NativeReviewLoadDeltaInput {
                reference: NativeReviewDeltaReference {
                    delta_id: preparing.delta.delta_id.clone(),
                    expected_revision: preparing.delta.revision,
                    input_revision: preparing.delta.input_revision,
                    observed_hashes: preparing.delta.files.clone(),
                    session_id: preparing.delta.session_id.clone(),
                    tool_call_id: preparing.delta.tool_call_id.clone(),
                    work_cycle_id: preparing.delta.work_cycle_id.clone(),
                },
            })
            .expect("load pending delta");
        assert_eq!(pending.delta, preparing.delta);
        assert_eq!(pending.tracked_files.len(), 1);
        assert_eq!(pending.tracked_files[0]["oldText"], "before\n");
        assert_eq!(pending.tracked_files[0]["newText"], "after\n");
        assert_eq!(pending.tracked_files[0]["hunks"], serde_json::json!([]));

        let materialized = wait_for_worker_events(&mut service)
            .into_iter()
            .next()
            .expect("materialized delta");
        assert_eq!(materialized.delta.delta_id, preparing.delta.delta_id);
        assert_eq!(
            materialized.delta.input_revision,
            preparing.delta.input_revision
        );
        assert!(materialized.delta.revision > preparing.delta.revision);
        assert_eq!(materialized.delta.state, NativeReviewDeltaState::Ready);
    }

    #[test]
    fn worker_reports_a_terminal_delta_when_the_baseline_is_missing() {
        let repo = tempfile::tempdir().expect("tempdir");
        let session = test_session(repo.path(), "s-worker-no-baseline");
        let service = NativeReviewService::default();

        let deltas = service.worker_handle().ingest_tool_activity(tool_activity(
            &session,
            "tool-without-baseline",
            vec![serde_json::json!({
                "path": "a.txt",
                "oldText": "before\n",
                "newText": "after\n"
            })],
        ));

        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0].delta.state, NativeReviewDeltaState::Unavailable);
        assert_eq!(
            deltas[0].delta.files[0].reason.as_deref(),
            Some("baseline_unavailable")
        );
    }

    #[test]
    fn worker_supersedes_a_pending_delta_when_a_newer_edit_replaces_its_files() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "second\n").expect("write file");
        let session = test_session(repo.path(), "s-worker-supersede");
        let mut service = NativeReviewService::default();
        capture_worker_baseline(&mut service, &session, "cycle-1");
        let worker = service.worker_handle();

        let first = worker
            .ingest_tool_activity(tool_activity(
                &session,
                "tool-first",
                vec![serde_json::json!({
                    "path": "a.txt",
                    "oldText": "before\n",
                    "newText": "first\n"
                })],
            ))
            .into_iter()
            .next()
            .expect("first placeholder");
        // Reinsert the pending payload while the test drives the second ingestion, avoiding a
        // race with the asynchronous worker and exercising the supersedence contract directly.
        {
            let mut registry = worker.registry.lock().expect("review worker registry lock");
            let cycle = registry
                .sessions
                .get_mut(&session.session_id)
                .and_then(|entry| entry.cycles.get_mut("cycle-1"))
                .expect("review cycle");
            cycle.pending_deltas.insert(
                first.delta.delta_id.clone(),
                PendingReviewDelta {
                    delta: first.delta.clone(),
                    diffs: Arc::from(vec![NativeReviewRuntimeDiff {
                        path: "a.txt".into(),
                        previous_path: None,
                        old_text: Some("before\n".into()),
                        new_text: Some("first\n".into()),
                        unavailable_reason: None,
                    }]),
                },
            );
        }

        let outputs = worker.ingest_tool_activity(tool_activity(
            &session,
            "tool-second",
            vec![serde_json::json!({
                "path": "a.txt",
                "oldText": "first\n",
                "newText": "second\n"
            })],
        ));

        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0].delta.state, NativeReviewDeltaState::Superseded);
        assert_eq!(outputs[0].delta.delta_id, first.delta.delta_id);
        assert_eq!(outputs[1].delta.state, NativeReviewDeltaState::Preparing);
        assert_ne!(outputs[1].delta.delta_id, first.delta.delta_id);

        let final_delta = wait_for_worker_events(&mut service)
            .into_iter()
            .next()
            .expect("second materialized delta");
        assert_eq!(final_delta.delta.tool_call_id.0, "tool-second");
    }

    #[test]
    fn worker_supersedes_a_materialized_delta_when_a_newer_edit_replaces_its_files() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "first\n").expect("write first");
        let session = test_session(repo.path(), "s-worker-supersede-ready");
        let mut service = NativeReviewService::default();
        capture_worker_baseline(&mut service, &session, "cycle-1");
        let worker = service.worker_handle();

        let first = worker
            .ingest_tool_activity(tool_activity(
                &session,
                "tool-first",
                vec![serde_json::json!({
                    "path": "a.txt",
                    "oldText": "before\n",
                    "newText": "first\n"
                })],
            ))
            .into_iter()
            .next()
            .expect("first placeholder");
        let materialized = wait_for_worker_events(&mut service)
            .into_iter()
            .next()
            .expect("first materialized delta");
        assert_eq!(materialized.delta.delta_id, first.delta.delta_id);

        fs::write(repo.path().join("a.txt"), "second\n").expect("write second");
        let outputs = worker.ingest_tool_activity(tool_activity(
            &session,
            "tool-second",
            vec![serde_json::json!({
                "path": "a.txt",
                "oldText": "first\n",
                "newText": "second\n"
            })],
        ));

        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0].delta.state, NativeReviewDeltaState::Superseded);
        assert_eq!(outputs[0].delta.delta_id, materialized.delta.delta_id);
        assert_eq!(outputs[1].delta.state, NativeReviewDeltaState::Preparing);
    }

    #[test]
    fn worker_preserves_every_file_when_later_tools_overlap_one_path() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "second\n").expect("write a");
        fs::write(repo.path().join("b.txt"), "first\n").expect("write b");
        let session = test_session(repo.path(), "s-worker-overlap");
        let mut service = NativeReviewService::default();
        capture_worker_baseline(&mut service, &session, "cycle-1");

        service.worker_handle().enqueue_tool_activity(tool_activity(
            &session,
            "tool-1",
            vec![
                serde_json::json!({
                    "path": "a.txt",
                    "oldText": "before\n",
                    "newText": "first\n"
                }),
                serde_json::json!({
                    "path": "b.txt",
                    "oldText": "before\n",
                    "newText": "first\n"
                }),
            ],
        ));
        service.worker_handle().enqueue_tool_activity(tool_activity(
            &session,
            "tool-2",
            vec![serde_json::json!({
                "path": "a.txt",
                "oldText": "first\n",
                "newText": "second\n"
            })],
        ));

        let events = wait_for_worker_event_count(&mut service, 2);
        assert_eq!(events.len(), 2);
        assert!(
            events[0]
                .delta
                .files
                .iter()
                .any(|file| file.path == "b.txt")
        );
        assert_eq!(events[1].delta.files[0].path, "a.txt");
    }

    #[test]
    fn worker_inherits_the_parent_baseline_for_subagents() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("child.txt"), "after\n").expect("write child");
        let parent = test_session(repo.path(), "s-parent");
        let child = test_session(repo.path(), "s-child");
        let mut service = NativeReviewService::default();
        capture_worker_baseline(&mut service, &parent, "cycle-1");
        service
            .worker_handle()
            .inherit_session(&parent.session_id, child.session_id.clone());
        capture_worker_baseline(&mut service, &parent, "cycle-2");

        service.worker_handle().enqueue_tool_activity(tool_activity(
            &child,
            "tool-child",
            vec![serde_json::json!({
                "path": "child.txt",
                "oldText": "before\n",
                "newText": "after\n"
            })],
        ));

        let events = wait_for_worker_events(&mut service);
        assert_eq!(events[0].delta.session_id, child.session_id);
        assert_eq!(events[0].delta.work_cycle_id, "cycle-2");
        let delta = events[0].delta.clone();
        let loaded = service
            .load_delta(NativeReviewLoadDeltaInput {
                reference: NativeReviewDeltaReference {
                    delta_id: delta.delta_id.clone(),
                    expected_revision: delta.revision,
                    input_revision: delta.input_revision,
                    observed_hashes: delta.files.clone(),
                    session_id: delta.session_id.clone(),
                    tool_call_id: delta.tool_call_id.clone(),
                    work_cycle_id: delta.work_cycle_id.clone(),
                },
            })
            .expect("load child delta");
        assert_eq!(loaded.tracked_files.len(), 1);
    }

    #[test]
    fn worker_registers_a_subagent_announced_before_its_parent_baseline() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("child.txt"), "after\n").expect("write child");
        let parent = test_session(repo.path(), "s-late-parent");
        let child = test_session(repo.path(), "s-early-child");
        let mut service = NativeReviewService::default();

        service
            .worker_handle()
            .inherit_session(&parent.session_id, child.session_id.clone());
        capture_worker_baseline(&mut service, &parent, "cycle-1");

        service.worker_handle().enqueue_tool_activity(tool_activity(
            &child,
            "tool-child",
            vec![serde_json::json!({
                "path": "child.txt",
                "oldText": "before\n",
                "newText": "after\n"
            })],
        ));

        let events = wait_for_worker_events(&mut service);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].delta.session_id, child.session_id);
        assert_eq!(events[0].delta.work_cycle_id, "cycle-1");
    }

    #[test]
    fn worker_marks_large_diffs_unavailable_without_reading_them() {
        let repo = tempfile::tempdir().expect("tempdir");
        let session = test_session(repo.path(), "s-worker-large");
        let mut service = NativeReviewService::default();
        capture_worker_baseline(&mut service, &session, "cycle-1");

        let preparing = service
            .worker_handle()
            .ingest_tool_activity(tool_activity(
                &session,
                "tool-large",
                vec![serde_json::json!({
                    "path": "large.txt",
                    "oldText": "before",
                    "newText": "x".repeat((MAX_REVIEW_TEXT_BYTES + 1) as usize)
                })],
            ))
            .into_iter()
            .next()
            .expect("preparing large delta");
        let pending = service
            .load_delta(NativeReviewLoadDeltaInput {
                reference: NativeReviewDeltaReference {
                    delta_id: preparing.delta.delta_id.clone(),
                    expected_revision: preparing.delta.revision,
                    input_revision: preparing.delta.input_revision,
                    observed_hashes: preparing.delta.files.clone(),
                    session_id: preparing.delta.session_id.clone(),
                    tool_call_id: preparing.delta.tool_call_id.clone(),
                    work_cycle_id: preparing.delta.work_cycle_id.clone(),
                },
            })
            .expect("load large pending delta");
        assert!(pending.tracked_files.is_empty());

        let events = wait_for_worker_events(&mut service);
        assert_eq!(events[0].delta.state, NativeReviewDeltaState::Unavailable);
        assert_eq!(
            events[0].delta.files[0].state,
            NativeReviewDeltaState::Unavailable
        );
        assert_eq!(
            events[0].delta.files[0].reason.as_deref(),
            Some("too_large")
        );
    }

    #[test]
    fn worker_materializes_create_delete_move_and_partial_files_as_one_delta() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("delete.txt"), "before\n").expect("write delete");
        fs::write(repo.path().join("moved.txt"), "after\n").expect("write move");
        fs::write(repo.path().join("partial.txt"), "user edit\n").expect("write partial");
        let session = test_session(repo.path(), "s-worker-kinds");
        let mut service = NativeReviewService::default();
        capture_worker_baseline(&mut service, &session, "cycle-1");

        service.worker_handle().enqueue_tool_activity(tool_activity(
            &session,
            "tool-kinds",
            vec![
                serde_json::json!({
                    "path": "create.txt",
                    "oldText": null,
                    "newText": "created\n"
                }),
                serde_json::json!({
                    "path": "delete.txt",
                    "oldText": "before\n",
                    "newText": null
                }),
                serde_json::json!({
                    "path": "moved.txt",
                    "previousPath": "old.txt",
                    "oldText": "before\n",
                    "newText": "after\n"
                }),
                serde_json::json!({
                    "path": "partial.txt",
                    "oldText": "before\n",
                    "newText": "after\n"
                }),
            ],
        ));

        let events = wait_for_worker_events(&mut service);
        assert_eq!(events[0].delta.files.len(), 4);
        assert_eq!(events[0].delta.state, NativeReviewDeltaState::Partial);
        assert_eq!(
            events[0].delta.files[0].state,
            NativeReviewDeltaState::Ready
        );
        assert_eq!(
            events[0].delta.files[1].state,
            NativeReviewDeltaState::Ready
        );
        assert_eq!(
            events[0].delta.files[2].state,
            NativeReviewDeltaState::Ready
        );
        assert_eq!(
            events[0].delta.files[3].state,
            NativeReviewDeltaState::Partial
        );
    }

    #[test]
    fn worker_marks_binary_working_tree_files_unavailable() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("binary.bin"), [0xff, 0x00]).expect("write binary");
        let session = test_session(repo.path(), "s-worker-binary");
        let mut service = NativeReviewService::default();
        capture_worker_baseline(&mut service, &session, "cycle-1");

        service.worker_handle().enqueue_tool_activity(tool_activity(
            &session,
            "tool-binary",
            vec![serde_json::json!({
                "path": "binary.bin",
                "oldText": "before",
                "newText": "after"
            })],
        ));

        let events = wait_for_worker_events(&mut service);
        assert_eq!(
            events[0].delta.files[0].state,
            NativeReviewDeltaState::Unavailable
        );
        assert_eq!(events[0].delta.files[0].reason.as_deref(), Some("not_text"));
    }

    #[test]
    fn capture_baseline_records_context_and_an_unavailable_delta() {
        let repo = tempfile::tempdir().expect("tempdir");
        let session = test_session(repo.path(), "s-baseline");
        let mut service = NativeReviewService::default();
        let buffer_path = repo.path().join("open.txt");
        service.notify_file_buffer(NativeReviewFileBufferInput {
            absolute_path: buffer_path.to_string_lossy().to_string(),
            content: Some("editor buffer\n".into()),
        });

        let output = service
            .capture_baseline(
                &session,
                NativeReviewSessionInput {
                    session_id: session.session_id.clone(),
                    work_cycle_id: Some("cycle-1".into()),
                    input_revision: Some(ReviewRevision(4)),
                    tool_call_id: Some(ToolCallId("tool-1".into())),
                },
            )
            .expect("capture baseline");

        assert_eq!(output.work_cycle_id, "cycle-1");
        assert_eq!(output.delta.state, NativeReviewDeltaState::Unavailable);
        let loaded = service
            .load_delta(NativeReviewLoadDeltaInput {
                reference: NativeReviewDeltaReference {
                    delta_id: output.delta.delta_id.clone(),
                    expected_revision: output.delta.revision,
                    input_revision: output.delta.input_revision,
                    observed_hashes: Vec::new(),
                    session_id: session.session_id.clone(),
                    tool_call_id: output.delta.tool_call_id.clone(),
                    work_cycle_id: output.work_cycle_id.clone(),
                },
            })
            .expect("load baseline delta");
        assert_eq!(loaded.delta, output.delta);
    }

    #[test]
    fn stale_delta_reference_returns_a_conflict() {
        let repo = tempfile::tempdir().expect("tempdir");
        let session = test_session(repo.path(), "s-stale-reference");
        let mut service = NativeReviewService::default();
        let output = service
            .capture_baseline(
                &session,
                NativeReviewSessionInput {
                    session_id: session.session_id.clone(),
                    work_cycle_id: Some("cycle-1".into()),
                    input_revision: Some(ReviewRevision(1)),
                    tool_call_id: Some(ToolCallId("tool-1".into())),
                },
            )
            .expect("capture baseline");

        let error = service
            .load_delta(NativeReviewLoadDeltaInput {
                reference: NativeReviewDeltaReference {
                    delta_id: output.delta.delta_id,
                    expected_revision: ReviewRevision(2),
                    input_revision: ReviewRevision(1),
                    observed_hashes: Vec::new(),
                    session_id: session.session_id,
                    tool_call_id: ToolCallId("tool-1".into()),
                    work_cycle_id: "cycle-1".into(),
                },
            })
            .expect_err("stale reference should fail");

        assert_eq!(error.code, NativeErrorCode::Conflict);
        assert_eq!(
            error.details.expect("details")["reviewDelta"]["reason"],
            "stale_revision"
        );
    }

    #[test]
    fn repeated_work_cycle_marks_the_previous_delta_superseded() {
        let repo = tempfile::tempdir().expect("tempdir");
        let session = test_session(repo.path(), "s-superseded-reference");
        let mut service = NativeReviewService::default();
        let first = service
            .capture_baseline(
                &session,
                NativeReviewSessionInput {
                    session_id: session.session_id.clone(),
                    work_cycle_id: Some("cycle-1".into()),
                    input_revision: Some(ReviewRevision(1)),
                    tool_call_id: Some(ToolCallId("tool-1".into())),
                },
            )
            .expect("capture first baseline");
        service
            .capture_baseline(
                &session,
                NativeReviewSessionInput {
                    session_id: session.session_id.clone(),
                    work_cycle_id: Some("cycle-1".into()),
                    input_revision: Some(ReviewRevision(2)),
                    tool_call_id: Some(ToolCallId("tool-2".into())),
                },
            )
            .expect("capture second baseline");

        let error = service
            .load_delta(NativeReviewLoadDeltaInput {
                reference: NativeReviewDeltaReference {
                    delta_id: first.delta.delta_id,
                    expected_revision: first.delta.revision,
                    input_revision: first.delta.input_revision,
                    observed_hashes: Vec::new(),
                    session_id: session.session_id,
                    tool_call_id: first.delta.tool_call_id,
                    work_cycle_id: first.work_cycle_id,
                },
            })
            .expect_err("superseded delta should fail");

        assert_eq!(error.code, NativeErrorCode::Conflict);
        assert_eq!(
            error.details.expect("details")["reviewDelta"]["reason"],
            "superseded"
        );
    }

    #[test]
    fn reject_file_reverts_update_from_tracked_file() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "agent\n").expect("write agent");
        let session = test_session(repo.path(), "s-reject-file");
        let mut service = NativeReviewService::default();
        let tracker = WriteTracker::new();
        let tracked_file = tracked_file(&session, "a.txt", "base\n", "agent\n");

        let output = service
            .reject_file(
                &session,
                NativeReviewFileMutationInput {
                    session_id: session.session_id.clone(),
                    review_root: None,
                    tracked_file,
                    expected_version: None,
                    reference: None,
                },
                &tracker,
            )
            .expect("reject file");

        assert_eq!(output.changed_files, vec!["a.txt"]);
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).expect("read file"),
            "base\n"
        );
    }

    #[test]
    fn reject_file_blocks_external_drift() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "agent + user\n").expect("write drift");
        let session = test_session(repo.path(), "s-reject-drift");
        let mut service = NativeReviewService::default();
        let tracker = WriteTracker::new();
        let tracked_file = tracked_file(&session, "a.txt", "base\n", "agent\n");

        let error = service
            .reject_file(
                &session,
                NativeReviewFileMutationInput {
                    session_id: session.session_id.clone(),
                    review_root: None,
                    tracked_file,
                    expected_version: None,
                    reference: None,
                },
                &tracker,
            )
            .expect_err("reject should block drift");

        assert_eq!(error.code, NativeErrorCode::Conflict);
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).expect("read file"),
            "agent + user\n"
        );
    }

    #[test]
    fn reject_all_blocks_drift_without_partial_writes() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "agent a\n").expect("write a");
        fs::write(repo.path().join("b.txt"), "agent b + user\n").expect("write b");
        let session = test_session(repo.path(), "s-reject-all");
        let mut service = NativeReviewService::default();
        let tracker = WriteTracker::new();

        let error = service
            .reject_all(
                &session,
                NativeReviewRejectAllInput {
                    session_id: session.session_id.clone(),
                    review_root: None,
                    tracked_files: vec![
                        tracked_file(&session, "a.txt", "base a\n", "agent a\n"),
                        tracked_file(&session, "b.txt", "base b\n", "agent b\n"),
                    ],
                    reference: None,
                },
                &tracker,
            )
            .expect_err("reject all should block drift");

        assert_eq!(error.code, NativeErrorCode::Conflict);
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).expect("read a"),
            "agent a\n"
        );
        assert_eq!(
            fs::read_to_string(repo.path().join("b.txt")).expect("read b"),
            "agent b + user\n"
        );
    }

    #[test]
    fn reject_hunks_writes_partially_reverted_text() {
        let repo = tempfile::tempdir().expect("tempdir");
        fs::write(repo.path().join("a.txt"), "ONE\ntwo\nTHREE\nfour\n").expect("write");
        let session = test_session(repo.path(), "s-reject-hunks");
        let mut service = NativeReviewService::default();
        let tracker = WriteTracker::new();
        let tracked_file = tracked_file(
            &session,
            "a.txt",
            "one\ntwo\nthree\nfour\n",
            "ONE\ntwo\nTHREE\nfour\n",
        );
        let hunk_id = tracked_file.hunks[0].id.clone();

        let output = service
            .reject_hunks(
                &session,
                NativeReviewHunkMutationInput {
                    session_id: session.session_id.clone(),
                    review_root: None,
                    tracked_file,
                    hunk_ids: vec![hunk_id],
                    expected_version: None,
                    reference: None,
                },
                &tracker,
            )
            .expect("reject hunk");

        assert_eq!(output.changed_files, vec!["a.txt"]);
        assert_eq!(
            fs::read_to_string(repo.path().join("a.txt")).expect("read file"),
            "one\ntwo\nTHREE\nfour\n"
        );
    }

    #[test]
    fn reject_file_uses_review_root_for_project_relative_paths() {
        let repo = tempfile::tempdir().expect("tempdir");
        let cwd = repo.path().join("packages").join("app");
        fs::create_dir_all(&cwd).expect("create cwd");
        fs::create_dir_all(repo.path().join("src")).expect("create src");
        fs::write(repo.path().join("src").join("foo.ts"), "agent\n").expect("write");
        let session = test_session(&cwd, "s-review-root");
        let mut service = NativeReviewService::default();
        let tracker = WriteTracker::new();
        let tracked_file = tracked_file(&session, "src/foo.ts", "base\n", "agent\n");

        service
            .reject_file(
                &session,
                NativeReviewFileMutationInput {
                    session_id: session.session_id.clone(),
                    review_root: Some(repo.path().to_string_lossy().to_string()),
                    tracked_file,
                    expected_version: None,
                    reference: None,
                },
                &tracker,
            )
            .expect("reject with review root");

        assert_eq!(
            fs::read_to_string(repo.path().join("src").join("foo.ts")).expect("read"),
            "base\n"
        );
        assert!(!cwd.join("src").join("foo.ts").exists());
    }

    fn test_session(cwd: &Path, session_id: &str) -> NativeAiSession {
        NativeAiSession {
            owner_window_id: "window-1".to_string(),
            runtime_id: RuntimeId("opencode".to_string()),
            runtime_session_id: None,
            scope: SessionScope {
                additional_roots: Vec::new(),
                cwd: cwd.to_string_lossy().to_string(),
                project_id: None,
                worktree_id: None,
            },
            session_id: SessionId(session_id.to_string()),
            status: NativeAiSessionStatus::Idle,
            title: "Test".to_string(),
            updated_at: now(),
        }
    }

    fn capture_worker_baseline(
        service: &mut NativeReviewService,
        session: &NativeAiSession,
        work_cycle_id: &str,
    ) {
        service
            .capture_baseline(
                session,
                NativeReviewSessionInput {
                    session_id: session.session_id.clone(),
                    work_cycle_id: Some(work_cycle_id.into()),
                    input_revision: Some(ReviewRevision(1)),
                    tool_call_id: Some(ToolCallId("baseline".into())),
                },
            )
            .expect("capture worker baseline");
    }

    fn tool_activity(
        session: &NativeAiSession,
        tool_call_id: &str,
        diffs: Vec<serde_json::Value>,
    ) -> NativeAiToolActivityPayload {
        NativeAiToolActivityPayload {
            base: NativeAiEventBase {
                runtime_id: session.runtime_id.clone(),
                runtime_session_id: session.runtime_session_id.clone(),
                session_id: session.session_id.clone(),
                updated_at: now(),
            },
            diffs,
            exit_code: Some(0),
            kind: "edit".into(),
            raw_input: None,
            raw_output: None,
            status: "completed".into(),
            summary: None,
            terminal_output: None,
            title: "Edit file".into(),
            tool_call_id: ToolCallId(tool_call_id.into()),
        }
    }

    fn wait_for_worker_events(
        service: &mut NativeReviewService,
    ) -> Vec<NativeAiReviewDeltaReadyPayload> {
        for _ in 0..100 {
            let events = service.drain_worker_events();
            if !events.is_empty() {
                return events;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("review worker did not produce an event");
    }

    fn wait_for_worker_event_count(
        service: &mut NativeReviewService,
        expected: usize,
    ) -> Vec<NativeAiReviewDeltaReadyPayload> {
        let mut events = Vec::new();
        for _ in 0..100 {
            events.extend(service.drain_worker_events());
            if events.len() >= expected {
                return events;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("review worker did not produce {expected} events");
    }

    fn tracked_file(
        session: &NativeAiSession,
        path: &str,
        old_text: &str,
        new_text: &str,
    ) -> ReviewTrackedFile {
        compute_tracked_file_patch(
            &session.session_id.0,
            path,
            None,
            Some(old_text.to_string()),
            Some(new_text.to_string()),
            now(),
        )
        .expect("tracked file")
    }
}
