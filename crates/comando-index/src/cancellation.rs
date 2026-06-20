use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use comando_types::ids::OperationId;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct CancellationToken {
    operation_id: OperationId,
    cancelled: Arc<Mutex<HashSet<String>>>,
}

impl CancellationToken {
    pub fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled
            .lock()
            .expect("cancel registry lock")
            .contains(&self.operation_id.0)
    }
}

#[derive(Debug, Default, Clone)]
pub struct CancellationRegistry {
    cancelled: Arc<Mutex<HashSet<String>>>,
}

impl CancellationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start_operation(&self) -> CancellationToken {
        CancellationToken {
            operation_id: OperationId(format!("operation_{}", Uuid::new_v4().simple())),
            cancelled: Arc::clone(&self.cancelled),
        }
    }

    pub fn cancel(&self, operation_id: &OperationId) -> bool {
        self.cancelled
            .lock()
            .expect("cancel registry lock")
            .insert(operation_id.0.clone())
    }

    pub fn clear(&self, operation_id: &OperationId) {
        self.cancelled
            .lock()
            .expect("cancel registry lock")
            .remove(&operation_id.0);
    }
}
