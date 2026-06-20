use std::collections::HashMap;

use crate::error::{AiError, AiResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserInputWaiter {
    pub request_id: String,
    pub session_id: String,
}

#[derive(Debug, Default)]
pub struct UserInputWaiters {
    waiters: HashMap<String, UserInputWaiter>,
}

impl UserInputWaiters {
    pub fn insert(&mut self, waiter: UserInputWaiter) {
        self.waiters.insert(waiter.request_id.clone(), waiter);
    }

    pub fn take(&mut self, request_id: &str) -> AiResult<UserInputWaiter> {
        self.waiters
            .remove(request_id)
            .ok_or_else(|| AiError::UserInputNotFound {
                request_id: request_id.to_string(),
            })
    }

    pub fn cancel_session(&mut self, session_id: &str) -> usize {
        let keys = self
            .waiters
            .iter()
            .filter_map(|(key, waiter)| (waiter.session_id == session_id).then(|| key.clone()))
            .collect::<Vec<_>>();
        let count = keys.len();
        for key in keys {
            self.waiters.remove(&key);
        }
        count
    }

    pub fn len(&self) -> usize {
        self.waiters.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_and_clears_user_input_waiter() {
        let mut waiters = UserInputWaiters::default();
        waiters.insert(UserInputWaiter {
            request_id: "r1".to_string(),
            session_id: "s1".to_string(),
        });

        assert_eq!(waiters.take("r1").unwrap().session_id, "s1");
        assert!(matches!(
            waiters.take("r1"),
            Err(AiError::UserInputNotFound { .. })
        ));
    }
}
