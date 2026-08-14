//! Soft interrupt queue and injection policy (§11.7).
//!
//! While a chat turn streams, user input must not be discarded — but it also
//! must not be spliced into a connection the transport still owns. This module
//! owns the queue and the *when*: input typed mid-stream is buffered and
//! injected only at a safe point, where the provider connection is quiescent
//! and the KV-cache prefix stays intact. Hard interrupt (`Ctrl+C`) remains a
//! separate, unconditional reset and is deliberately not modeled here.

use super::ChatMessage;
use std::collections::VecDeque;

/// A point in the agent loop where the provider connection is quiescent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoopPoint {
    /// (B) The turn completed and no tools were produced.
    TurnCompleted,
    /// (C) Between tool executions (only urgent input, skipping tool_results).
    BetweenToolExecutions,
    /// (D) All tools have finished, before the next provider API call.
    AllToolsDone,
    /// Mid-stream or otherwise unsafe: no injection is allowed.
    MidStream,
}

/// What a given loop point permits.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InterruptMode {
    None,
    UrgentOnly,
    Queued,
}

pub fn injection_mode(point: LoopPoint) -> InterruptMode {
    match point {
        LoopPoint::TurnCompleted | LoopPoint::AllToolsDone => InterruptMode::Queued,
        LoopPoint::BetweenToolExecutions => InterruptMode::UrgentOnly,
        LoopPoint::MidStream => InterruptMode::None,
    }
}

/// Buffers soft-interrupt messages.  Urgent messages jump the queue; queued
/// messages are strictly FIFO.
#[derive(Clone, Debug, Default)]
pub struct SoftInterruptQueue {
    queued: VecDeque<String>,
    urgent: VecDeque<String>,
}

impl SoftInterruptQueue {
    pub fn push(&mut self, urgent: bool, text: impl Into<String>) {
        let target = if urgent {
            &mut self.urgent
        } else {
            &mut self.queued
        };
        target.push_back(text.into());
    }

    pub fn is_empty(&self) -> bool {
        self.queued.is_empty() && self.urgent.is_empty()
    }

    pub fn len(&self) -> usize {
        self.queued.len() + self.urgent.len()
    }

    /// Drain the messages permitted at `point` in FIFO order, urgent first.
    /// Messages that are not permitted at this point remain queued.
    pub fn drain(&mut self, point: LoopPoint) -> Vec<String> {
        match injection_mode(point) {
            InterruptMode::None => Vec::new(),
            InterruptMode::UrgentOnly => self.urgent.drain(..).collect(),
            InterruptMode::Queued => {
                let mut drained = self.urgent.drain(..).collect::<Vec<_>>();
                drained.extend(self.queued.drain(..));
                drained
            }
        }
    }
}

/// Append the assistant's in-flight text to the history, then the injected
/// user message, preserving order and the cache prefix (§11.7).  The assistant
/// text lands *before* the injection so the provider sees the same prefix it
/// was already streaming against.
pub fn inject_user_message(
    messages: &mut Vec<ChatMessage>,
    assistant_text: impl Into<String>,
    injection: impl Into<String>,
) {
    let assistant_text = assistant_text.into();
    let injection = injection.into();
    if let Some(last) = messages.last_mut() {
        if last.role == "assistant" {
            last.content.push_str(&assistant_text);
        } else if !assistant_text.is_empty() {
            messages.push(ChatMessage {
                role: "assistant".to_owned(),
                content: assistant_text,
                tool_calls: Vec::new(),
                tool_result_id: None,
            });
        }
    } else if !assistant_text.is_empty() {
        messages.push(ChatMessage {
            role: "assistant".to_owned(),
            content: assistant_text,
            tool_calls: Vec::new(),
            tool_result_id: None,
        });
    }
    messages.push(ChatMessage {
        role: "user".to_owned(),
        content: injection,
        tool_calls: Vec::new(),
        tool_result_id: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_owned(),
            content: content.to_owned(),
            tool_calls: Vec::new(),
            tool_result_id: None,
        }
    }

    #[test]
    fn queued_input_waits_for_a_safe_point() {
        let mut queue = SoftInterruptQueue::default();
        queue.push(false, "first");
        queue.push(false, "second");
        assert!(queue.drain(LoopPoint::MidStream).is_empty());
        assert!(queue.drain(LoopPoint::BetweenToolExecutions).is_empty());
        assert_eq!(queue.len(), 2);
        assert_eq!(
            queue.drain(LoopPoint::AllToolsDone),
            vec!["first".to_owned(), "second".to_owned()]
        );
        assert!(queue.is_empty());
    }

    #[test]
    fn urgent_skips_the_queue_and_between_tools() {
        let mut queue = SoftInterruptQueue::default();
        queue.push(false, "queued");
        queue.push(true, "urgent");
        assert_eq!(
            queue.drain(LoopPoint::BetweenToolExecutions),
            vec!["urgent".to_owned()]
        );
        // The queued message was not drained early.
        assert_eq!(queue.len(), 1);
        assert_eq!(
            queue.drain(LoopPoint::TurnCompleted),
            vec!["queued".to_owned()]
        );
    }

    #[test]
    fn injection_preserves_order_and_prefix() {
        let mut messages = vec![
            message("user", "fix the bug"),
            message("assistant", "I will look "),
        ];
        inject_user_message(&mut messages, "into it", "also check the tests");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "I will look into it");
        assert_eq!(messages[2].role, "user");
        assert_eq!(messages[2].content, "also check the tests");
    }

    #[test]
    fn injection_with_no_assistant_tail_still_appends_user() {
        let mut messages = vec![message("user", "hello")];
        inject_user_message(&mut messages, "", "soft interrupt");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages.last().unwrap().role, "user");
        assert_eq!(messages.last().unwrap().content, "soft interrupt");
    }
}
