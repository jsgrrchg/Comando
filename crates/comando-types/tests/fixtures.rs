use std::fs;
use std::path::PathBuf;

use comando_types::ai::{
    NativeAiMessageDeltaPayload, NativeAiSessionCatalogUpdatedPayload, NativeAiSessionSummary,
    NativeAiSubagentBreadcrumbPayload, NativeAiSubagentCreatedPayload, NativeAiToolActivityPayload,
};
use comando_types::capabilities::NativeBackendCapabilitiesOutput;
use comando_types::commands::all_commands;
use comando_types::error::NativeErrorCode;
use comando_types::events::all_events;
use comando_types::fs::NativeFsReadFileResult;
use comando_types::git::{
    NativeGitBranchSummary, NativeGitChangeEntry, NativeGitCommitDetail, NativeGitDiffStatRecord,
    NativeGitFileDiff, NativeGitHistoryListResult, NativeGitOperationResult, NativeGitOriginalFile,
    NativeGitRemoteSummary, NativeGitRepositoryInvalidation, NativeGitRepositoryResolution,
    NativeGitRepositorySnapshot, NativeGitStatusSnapshot, NativeGitWorktreeDiffResult,
    NativeGitWorktreeSummary,
};
use comando_types::index::{
    NativeIndexStatusResult, NativeIndexedProjectEntry, NativeProjectEntrySearchResult,
    NativeSearchCancelled,
};
use comando_types::persistence::{NativePersistenceStorageHealth, NativeWorkspaceSnapshotRef};
use comando_types::projects::{NativeProjectState, NativeProjectSummary, NativeProjectTreeEntry};
use comando_types::protocol::{NativeRpcOutput, NativeRpcRequest};
use comando_types::terminal::{
    NativeTerminalDataEvent, NativeTerminalExitEvent, NativeTerminalSession,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn fixture_path(relative_path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/native-backend")
        .join(relative_path)
}

fn fixture<T: DeserializeOwned>(relative_path: &str) -> T {
    let path = fixture_path(relative_path);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("failed to deserialize {}: {error}", path.display()))
}

fn assert_typed_roundtrip<T>(relative_path: &str)
where
    T: DeserializeOwned + Serialize,
{
    let value: Value = fixture(relative_path);
    let dto: T = serde_json::from_value(value.clone())
        .unwrap_or_else(|error| panic!("failed to parse {relative_path}: {error}"));
    let serialized = serde_json::to_value(dto)
        .unwrap_or_else(|error| panic!("failed to serialize {relative_path}: {error}"));

    assert_eq!(serialized, value, "{relative_path} roundtrip drifted");
}

#[test]
fn protocol_envelope_fixtures_deserialize() {
    let request: NativeRpcRequest = fixture("protocol/request.backend_ping.json");
    assert_eq!(request.command, "backend_ping");
    assert_eq!(
        request.meta.as_ref().map(|meta| meta.protocol_version),
        Some(1)
    );

    let response: NativeRpcOutput = fixture("protocol/response.backend_ping.json");
    let NativeRpcOutput::Response(response) = response else {
        panic!("expected response fixture");
    };
    assert!(response.ok);
    assert_eq!(
        response.meta.as_ref().map(|meta| meta.protocol_version),
        Some(1)
    );

    let error: NativeRpcOutput = fixture("protocol/response.error.unknown_command.json");
    let NativeRpcOutput::Response(error_response) = error else {
        panic!("expected error response fixture");
    };
    assert_eq!(
        error_response.error.map(|error| error.code),
        Some(NativeErrorCode::UnknownCommand)
    );

    let event: NativeRpcOutput = fixture("protocol/event.backend_test.json");
    let NativeRpcOutput::Event(event) = event else {
        panic!("expected event fixture");
    };
    assert_eq!(event.event_name, "backend://test-event");
}

#[test]
fn capability_and_registry_fixtures_match_rust_registries() {
    let capabilities: NativeBackendCapabilitiesOutput = fixture("protocol/capabilities.v1.json");
    let commands: Vec<String> = fixture("protocol/registry.commands.json");
    let events: Vec<String> = fixture("protocol/registry.events.json");
    let rust_commands: Vec<String> = all_commands().into_iter().map(str::to_string).collect();
    let rust_events: Vec<String> = all_events().into_iter().map(str::to_string).collect();

    assert_eq!(commands, rust_commands);
    assert_eq!(events, rust_events);
    assert_eq!(capabilities.capabilities.commands, commands);
    assert_eq!(capabilities.capabilities.events, events);
    assert!(
        capabilities
            .capabilities
            .domains
            .contains(&"search".to_string())
    );
    assert!(
        capabilities
            .capabilities
            .domains
            .contains(&"secret".to_string())
    );
}

#[test]
fn ai_fixtures_deserialize() {
    let message_delta: NativeRpcOutput = fixture("ai/event.message_delta.json");
    let NativeRpcOutput::Event(message_delta) = message_delta else {
        panic!("expected AI event fixture");
    };
    assert_eq!(message_delta.event_name, "ai://message-delta");
    let payload: NativeAiMessageDeltaPayload =
        serde_json::from_value(message_delta.payload).expect("payload should deserialize");
    assert_eq!(payload.delta, "Hello");

    let tool_activity: NativeRpcOutput = fixture("ai/event.tool_activity.json");
    let NativeRpcOutput::Event(tool_activity) = tool_activity else {
        panic!("expected AI tool event fixture");
    };
    let payload: NativeAiToolActivityPayload =
        serde_json::from_value(tool_activity.payload).expect("payload should deserialize");
    assert_eq!(payload.tool_call_id.0, "tool_1");

    let catalog: NativeRpcOutput = fixture("ai/event.session_catalog_updated.json");
    let NativeRpcOutput::Event(catalog) = catalog else {
        panic!("expected AI catalog event fixture");
    };
    let payload: NativeAiSessionCatalogUpdatedPayload =
        serde_json::from_value(catalog.payload).expect("payload should deserialize");
    assert_eq!(payload.config_options.expect("config options").len(), 2);

    let subagent_created: NativeRpcOutput = fixture("ai/event.subagent_created.json");
    let NativeRpcOutput::Event(subagent_created) = subagent_created else {
        panic!("expected AI subagent event fixture");
    };
    let payload: NativeAiSubagentCreatedPayload =
        serde_json::from_value(subagent_created.payload).expect("payload should deserialize");
    assert_eq!(payload.title, "Aristotle");

    let subagent_breadcrumb: NativeRpcOutput = fixture("ai/event.subagent_breadcrumb.json");
    let NativeRpcOutput::Event(subagent_breadcrumb) = subagent_breadcrumb else {
        panic!("expected AI subagent breadcrumb fixture");
    };
    let payload: NativeAiSubagentBreadcrumbPayload =
        serde_json::from_value(subagent_breadcrumb.payload).expect("payload should deserialize");
    assert_eq!(payload.tool_call_id.0, "tool_1");

    let summary: NativeAiSessionSummary = fixture("ai/session.summary.json");
    assert_eq!(summary.session_id.0, "session_1");
}

#[test]
fn local_domain_fixtures_deserialize() {
    let project: NativeProjectSummary = fixture("projects/project.summary.json");
    assert_eq!(project.id.0, "project_1");
    let project_state: NativeProjectState = fixture("projects/project.state.json");
    assert_eq!(project_state.worktrees[0].id.0, "project_1:primary");
    let tree_entry: NativeProjectTreeEntry = fixture("projects/project.tree_entry.json");
    assert_eq!(tree_entry.relative_path, "src/main.ts");

    let text_file: NativeFsReadFileResult = fixture("fs/file.read_result.text.json");
    assert!(!text_file.is_binary);
    let binary_file: NativeFsReadFileResult = fixture("fs/file.read_result.binary.json");
    assert!(binary_file.is_binary);
    assert!(binary_file.is_too_large);

    let git_resolution: NativeGitRepositoryResolution = fixture("git/repository.resolution.json");
    assert_eq!(git_resolution.state, "ready");
    let git_snapshot: NativeGitRepositorySnapshot = fixture("git/repository.snapshot.json");
    assert_eq!(git_snapshot.status.summary.changed_count, 1);
    let git_status: NativeGitStatusSnapshot = fixture("git/status.snapshot.json");
    assert_eq!(git_status.entries.len(), 1);
    let git_change: NativeGitChangeEntry = fixture("git/change.entry.json");
    assert_eq!(git_change.path, "src/main.ts");
    let git_branch: NativeGitBranchSummary = fixture("git/branch.summary.json");
    assert!(git_branch.is_current);
    let git_remote: NativeGitRemoteSummary = fixture("git/remote.summary.json");
    assert!(git_remote.is_default);
    let git_worktree: NativeGitWorktreeSummary = fixture("git/worktree.summary.json");
    assert!(git_worktree.is_primary);
    let git_stat: NativeGitDiffStatRecord = fixture("git/diff.stat.json");
    assert_eq!(git_stat.key, "unstaged:src/main.ts");
    let git_diff: NativeGitFileDiff = fixture("git/diff.file.json");
    assert_eq!(git_diff.hunks.len(), 1);
    let original_file: NativeGitOriginalFile = fixture("git/original_file.json");
    assert!(original_file.is_text);
    let history: NativeGitHistoryListResult = fixture("git/history.list.json");
    assert_eq!(history.total_count, 1);
    let commit_detail: NativeGitCommitDetail = fixture("git/commit.detail.json");
    assert_eq!(commit_detail.changed_file_count, 1);
    let worktree_diff: NativeGitWorktreeDiffResult = fixture("git/worktree.diff.json");
    assert_eq!(worktree_diff.sections.len(), 1);
    let invalidation: NativeGitRepositoryInvalidation = fixture("git/repository.invalidation.json");
    assert_eq!(invalidation.reason, "status");
    let operation: NativeGitOperationResult = fixture("git/operation.result.json");
    assert!(operation.ok);

    let index_status: NativeIndexStatusResult = fixture("index/index.status.json");
    assert_eq!(index_status.generation, 3);
    let indexed_entry: NativeIndexedProjectEntry = fixture("index/indexed.entry.json");
    assert_eq!(indexed_entry.relative_path.0, "src/main.ts");
    let search_result: NativeProjectEntrySearchResult = fixture("index/search.entries_result.json");
    assert_eq!(search_result.entries.len(), 1);
    let cancelled: NativeSearchCancelled = fixture("index/search.cancelled.json");
    assert!(cancelled.cancelled);

    let terminal: NativeTerminalSession = fixture("terminal/terminal.session.json");
    assert_eq!(terminal.cols, 120);
    let terminal_event: NativeTerminalDataEvent = fixture("terminal/terminal.data_event.json");
    assert_eq!(terminal_event.data, "ready\n");
    let terminal_exit: NativeTerminalExitEvent = fixture("terminal/terminal.exit_event.json");
    assert_eq!(terminal_exit.exit_code, Some(0));

    let workspace_ref: NativeWorkspaceSnapshotRef =
        fixture("persistence/workspace.snapshot_ref.json");
    assert_eq!(workspace_ref.storage_key, "workspace:workspace_1");
    let storage_health: NativePersistenceStorageHealth = fixture("persistence/storage.health.json");
    assert!(storage_health.schema_compatible);
}

#[test]
fn key_dtos_roundtrip_without_losing_required_fields() {
    assert_typed_roundtrip::<NativeRpcRequest>("protocol/request.backend_ping.json");
    assert_typed_roundtrip::<NativeRpcOutput>("protocol/response.backend_ping.json");
    assert_typed_roundtrip::<NativeRpcOutput>("protocol/response.error.unknown_command.json");
    assert_typed_roundtrip::<NativeRpcOutput>("protocol/event.backend_test.json");
    assert_typed_roundtrip::<NativeBackendCapabilitiesOutput>("protocol/capabilities.v1.json");
    assert_typed_roundtrip::<NativeAiSessionSummary>("ai/session.summary.json");
    assert_typed_roundtrip::<NativeProjectSummary>("projects/project.summary.json");
    assert_typed_roundtrip::<NativeProjectState>("projects/project.state.json");
    assert_typed_roundtrip::<NativeProjectTreeEntry>("projects/project.tree_entry.json");
    assert_typed_roundtrip::<NativeFsReadFileResult>("fs/file.read_result.text.json");
    assert_typed_roundtrip::<NativeFsReadFileResult>("fs/file.read_result.binary.json");
    assert_typed_roundtrip::<NativeGitRepositoryResolution>("git/repository.resolution.json");
    assert_typed_roundtrip::<NativeGitRepositorySnapshot>("git/repository.snapshot.json");
    assert_typed_roundtrip::<NativeGitStatusSnapshot>("git/status.snapshot.json");
    assert_typed_roundtrip::<NativeGitChangeEntry>("git/change.entry.json");
    assert_typed_roundtrip::<NativeGitBranchSummary>("git/branch.summary.json");
    assert_typed_roundtrip::<NativeGitRemoteSummary>("git/remote.summary.json");
    assert_typed_roundtrip::<NativeGitWorktreeSummary>("git/worktree.summary.json");
    assert_typed_roundtrip::<NativeGitDiffStatRecord>("git/diff.stat.json");
    assert_typed_roundtrip::<NativeGitFileDiff>("git/diff.file.json");
    assert_typed_roundtrip::<NativeGitOriginalFile>("git/original_file.json");
    assert_typed_roundtrip::<NativeGitHistoryListResult>("git/history.list.json");
    assert_typed_roundtrip::<NativeGitCommitDetail>("git/commit.detail.json");
    assert_typed_roundtrip::<NativeGitWorktreeDiffResult>("git/worktree.diff.json");
    assert_typed_roundtrip::<NativeGitRepositoryInvalidation>("git/repository.invalidation.json");
    assert_typed_roundtrip::<NativeGitOperationResult>("git/operation.result.json");
    assert_typed_roundtrip::<NativeIndexStatusResult>("index/index.status.json");
    assert_typed_roundtrip::<NativeIndexedProjectEntry>("index/indexed.entry.json");
    assert_typed_roundtrip::<NativeProjectEntrySearchResult>("index/search.entries_result.json");
    assert_typed_roundtrip::<NativeSearchCancelled>("index/search.cancelled.json");
    assert_typed_roundtrip::<NativeRpcOutput>("index/event.index_ready.json");
    assert_typed_roundtrip::<NativeTerminalSession>("terminal/terminal.session.json");
    assert_typed_roundtrip::<NativeTerminalDataEvent>("terminal/terminal.data_event.json");
    assert_typed_roundtrip::<NativeTerminalExitEvent>("terminal/terminal.exit_event.json");
    assert_typed_roundtrip::<NativeWorkspaceSnapshotRef>("persistence/workspace.snapshot_ref.json");
    assert_typed_roundtrip::<NativePersistenceStorageHealth>("persistence/storage.health.json");
}
