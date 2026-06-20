use comando_types::ids::MessageId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamDelta {
    pub message_id: MessageId,
    pub delta: String,
    pub content: String,
}

#[derive(Debug, Default)]
pub struct StreamCoalescer {
    message_id: Option<MessageId>,
    content: String,
}

impl StreamCoalescer {
    pub fn push(&mut self, message_id: MessageId, delta: impl AsRef<str>) -> StreamDelta {
        if self.message_id.as_ref() != Some(&message_id) {
            self.message_id = Some(message_id.clone());
            self.content.clear();
        }

        let delta = delta.as_ref().to_string();
        self.content.push_str(&delta);
        StreamDelta {
            message_id,
            delta,
            content: self.content.clone(),
        }
    }

    pub fn clear(&mut self) {
        self.message_id = None;
        self.content.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_content_per_message() {
        let mut coalescer = StreamCoalescer::default();
        let id = MessageId("m1".to_string());

        assert_eq!(coalescer.push(id.clone(), "he").content, "he");
        assert_eq!(coalescer.push(id, "llo").content, "hello");
    }
}
