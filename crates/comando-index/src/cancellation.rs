use std::collections::{HashMap, HashSet};
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
    active: Arc<Mutex<HashSet<String>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
    contexts: Arc<Mutex<HashMap<String, String>>>,
}

impl CancellationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start_operation(&self, context_key: Option<&str>) -> CancellationToken {
        let operation_id = OperationId(format!("operation_{}", Uuid::new_v4().simple()));
        self.active
            .lock()
            .expect("cancel registry lock")
            .insert(operation_id.0.clone());
        if let Some(context_key) = context_key
            && let Some(previous_operation_id) = self
                .contexts
                .lock()
                .expect("cancel registry lock")
                .insert(context_key.to_string(), operation_id.0.clone())
        {
            self.cancelled
                .lock()
                .expect("cancel registry lock")
                .insert(previous_operation_id);
        }
        CancellationToken {
            operation_id,
            cancelled: Arc::clone(&self.cancelled),
        }
    }

    pub fn token_for_operation(&self, operation_id: OperationId) -> CancellationToken {
        self.active
            .lock()
            .expect("cancel registry lock")
            .insert(operation_id.0.clone());
        CancellationToken {
            operation_id,
            cancelled: Arc::clone(&self.cancelled),
        }
    }

    pub fn cancel(&self, operation_id: &OperationId) -> bool {
        if !self
            .active
            .lock()
            .expect("cancel registry lock")
            .contains(&operation_id.0)
        {
            return false;
        }

        self.cancelled
            .lock()
            .expect("cancel registry lock")
            .insert(operation_id.0.clone())
    }

    pub fn clear(&self, operation_id: &OperationId) {
        self.active
            .lock()
            .expect("cancel registry lock")
            .remove(&operation_id.0);
        self.contexts
            .lock()
            .expect("cancel registry lock")
            .retain(|_, active_operation_id| active_operation_id != &operation_id.0);
        self.cancelled
            .lock()
            .expect("cancel registry lock")
            .remove(&operation_id.0);
    }
}
