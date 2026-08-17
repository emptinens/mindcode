//! Fail-fast loop monitor and warm-restart overlay generator (§7.2).
//!
//! Provides deterministic loop detection, stagnation alerts (no progress over N steps),
//! and git-apply patch overlays for warm restarts without conversational anchoring bias.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

const DEFAULT_LOOP_WINDOW: usize = 4;
const DEFAULT_MAX_STAGNANT_STEPS: usize = 6;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MonitorAlert {
    /// Repeated identical tool call and arguments (infinite loop).
    LoopDetected,
    /// No files modified or tests executed over consecutive steps.
    StagnantProgress,
    /// Context or step length exceeds threshold.
    LengthBudgetExceeded,
}

#[derive(Clone, Debug)]
pub struct StepRecord {
    pub tool_name: String,
    pub arguments_hash: u64,
    pub produced_file_write: bool,
    pub produced_test_run: bool,
}

#[derive(Clone, Debug)]
pub struct StepMonitor {
    window_size: usize,
    max_stagnant_steps: usize,
    history: VecDeque<StepRecord>,
    consecutive_stagnant: usize,
}

impl StepMonitor {
    pub fn new() -> Self {
        Self {
            window_size: DEFAULT_LOOP_WINDOW,
            max_stagnant_steps: DEFAULT_MAX_STAGNANT_STEPS,
            history: VecDeque::with_capacity(DEFAULT_LOOP_WINDOW + 1),
            consecutive_stagnant: 0,
        }
    }

    pub fn with_limits(window_size: usize, max_stagnant_steps: usize) -> Self {
        Self {
            window_size,
            max_stagnant_steps,
            history: VecDeque::with_capacity(window_size + 1),
            consecutive_stagnant: 0,
        }
    }

    /// Record a step and check for fail-fast alerts.
    pub fn record_step(
        &mut self,
        tool_name: &str,
        arguments_json: &str,
        produced_file_write: bool,
        produced_test_run: bool,
    ) -> Option<MonitorAlert> {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(arguments_json, &mut hasher);
        let arguments_hash = std::hash::Hasher::finish(&hasher);

        let record = StepRecord {
            tool_name: tool_name.to_owned(),
            arguments_hash,
            produced_file_write,
            produced_test_run,
        };

        if !produced_file_write && !produced_test_run {
            self.consecutive_stagnant += 1;
        } else {
            self.consecutive_stagnant = 0;
        }

        self.history.push_back(record);
        if self.history.len() > self.window_size {
            self.history.pop_front();
        }

        // Check for stagnation
        if self.consecutive_stagnant >= self.max_stagnant_steps {
            return Some(MonitorAlert::StagnantProgress);
        }

        // Check for self-loop (identical calls in window)
        if self.history.len() >= self.window_size {
            let first = &self.history[0];
            let all_identical = self.history.iter().all(|r| {
                r.tool_name == first.tool_name && r.arguments_hash == first.arguments_hash
            });
            if all_identical {
                return Some(MonitorAlert::LoopDetected);
            }
        }

        None
    }
}

impl Default for StepMonitor {
    fn default() -> Self {
        Self::new()
    }
}

/// Create a git-apply edit overlay from a working tree diff (§7.2).
///
/// Strips conversational bias while preserving code modifications for a warm restart.
pub fn create_git_apply_overlay(diff: &str) -> Option<String> {
    let trimmed = diff.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(format!(
        "# Warm restart overlay (git apply)\n```diff\n{}\n```\n",
        trimmed
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_identical_tool_loop() {
        let mut monitor = StepMonitor::with_limits(3, 10);
        assert_eq!(
            monitor.record_step("read_file", r#"{"path":"foo"}"#, false, false),
            None
        );
        assert_eq!(
            monitor.record_step("read_file", r#"{"path":"foo"}"#, false, false),
            None
        );
        assert_eq!(
            monitor.record_step("read_file", r#"{"path":"foo"}"#, false, false),
            Some(MonitorAlert::LoopDetected)
        );
    }

    #[test]
    fn detects_stagnation_after_threshold() {
        let mut monitor = StepMonitor::with_limits(10, 3);
        assert_eq!(
            monitor.record_step("read_file", r#"{"path":"a"}"#, false, false),
            None
        );
        assert_eq!(
            monitor.record_step("read_file", r#"{"path":"b"}"#, false, false),
            None
        );
        assert_eq!(
            monitor.record_step("read_file", r#"{"path":"c"}"#, false, false),
            Some(MonitorAlert::StagnantProgress)
        );
    }

    #[test]
    fn resets_stagnation_on_write_or_test() {
        let mut monitor = StepMonitor::with_limits(10, 3);
        assert_eq!(
            monitor.record_step("read_file", r#"{"path":"a"}"#, false, false),
            None
        );
        assert_eq!(
            monitor.record_step("write_file", r#"{"path":"a"}"#, true, false),
            None
        );
        assert_eq!(
            monitor.record_step("read_file", r#"{"path":"b"}"#, false, false),
            None
        );
        assert_eq!(
            monitor.record_step("read_file", r#"{"path":"c"}"#, false, false),
            None
        );
    }

    #[test]
    fn creates_clean_git_apply_overlay() {
        let diff = "--- a/foo.rs\n+++ b/foo.rs\n+bar";
        let overlay = create_git_apply_overlay(diff).unwrap();
        assert!(overlay.contains("Warm restart overlay"));
        assert!(overlay.contains("```diff\n--- a/foo.rs"));
    }
}
