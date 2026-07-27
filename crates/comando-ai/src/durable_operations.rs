use std::sync::Arc;

use crate::error::AiResult;

/// Durable boundaries that can be deterministically delayed or failed by tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableOperation {
    Append,
    AtomicWrite,
    RemoveTemporary,
    Rename,
    SqliteTransaction,
    Sync,
}

pub trait DurableOperationInterceptor: Send + Sync {
    fn before(&self, operation: DurableOperation) -> AiResult<()>;
}

pub type DurableOperationInterceptorRef = Arc<dyn DurableOperationInterceptor>;

pub(crate) fn before(
    interceptor: Option<&DurableOperationInterceptorRef>,
    operation: DurableOperation,
) -> AiResult<()> {
    if let Some(interceptor) = interceptor {
        interceptor.before(operation)?;
    }
    Ok(())
}
