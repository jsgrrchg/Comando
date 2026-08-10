use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AiStorageWorkMetricsSnapshot {
    pub checkpoint_count: u64,
    pub durable_write_bytes: u64,
    pub serialized_bytes: u64,
    pub sync_count: u64,
    pub tool_activity_detail_write_count: u64,
}

#[derive(Debug, Default)]
pub(crate) struct StorageWorkMetrics {
    checkpoint_count: AtomicU64,
    durable_write_bytes: AtomicU64,
    enabled: AtomicBool,
    serialized_bytes: AtomicU64,
    sync_count: AtomicU64,
    tool_activity_detail_write_count: AtomicU64,
}

impl StorageWorkMetrics {
    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub(crate) fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub(crate) fn record_checkpoint(&self) {
        self.add(&self.checkpoint_count, 1);
    }

    pub(crate) fn record_durable_write(&self, bytes: usize) {
        self.add(&self.durable_write_bytes, bytes as u64);
    }

    pub(crate) fn record_serialized(&self, bytes: usize) {
        self.add(&self.serialized_bytes, bytes as u64);
    }

    pub(crate) fn record_sync(&self) {
        self.add(&self.sync_count, 1);
    }

    pub(crate) fn record_tool_activity_detail_write(&self) {
        self.add(&self.tool_activity_detail_write_count, 1);
    }

    pub(crate) fn reset(&self) {
        self.checkpoint_count.store(0, Ordering::Relaxed);
        self.durable_write_bytes.store(0, Ordering::Relaxed);
        self.serialized_bytes.store(0, Ordering::Relaxed);
        self.sync_count.store(0, Ordering::Relaxed);
        self.tool_activity_detail_write_count
            .store(0, Ordering::Relaxed);
    }

    pub(crate) fn snapshot(&self) -> AiStorageWorkMetricsSnapshot {
        AiStorageWorkMetricsSnapshot {
            checkpoint_count: self.checkpoint_count.load(Ordering::Relaxed),
            durable_write_bytes: self.durable_write_bytes.load(Ordering::Relaxed),
            serialized_bytes: self.serialized_bytes.load(Ordering::Relaxed),
            sync_count: self.sync_count.load(Ordering::Relaxed),
            tool_activity_detail_write_count: self
                .tool_activity_detail_write_count
                .load(Ordering::Relaxed),
        }
    }

    fn add(&self, counter: &AtomicU64, amount: u64) {
        if self.is_enabled() {
            counter.fetch_add(amount, Ordering::Relaxed);
        }
    }
}
