//! The structured report a worker returns to the Leader. Full transcripts
//! never enter Leader context; only this compact, typed shape does (§10.4.5).

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    #[default]
    Success,
    Failed,
    Cancelled,
    Timeout,
}

/// One shell/git command the worker ran, recorded without its output.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommandRun {
    pub command: String,
    pub exit_code: Option<i32>,
    pub output_len: u64,
}

/// Structured evidence from one bounded test-runner invocation (§5.1.3).
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct TestRun {
    pub command: String,
    pub exit_code: Option<i32>,
    pub passed: u64,
    pub failed: u64,
    pub skipped: u64,
    pub summary_lines: Vec<String>,
}

/// Token/cost counters attributed to one worker (§10.3).
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct WorkerUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub cost: f64,
    /// Whether every settled model turn reported usage sufficient to estimate
    /// cost. False is rendered as unknown, never as a fabricated zero.
    #[serde(default)]
    pub cost_known: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct WorkerReport {
    pub id: String,
    pub status: WorkerStatus,
    pub summary: String,
    pub files_read: Vec<String>,
    pub files_changed: Vec<String>,
    pub commands_run: Vec<CommandRun>,
    pub test_runs: Vec<TestRun>,
    pub findings: Vec<String>,
    pub deviations: Vec<String>,
    pub risks: Vec<String>,
    pub usage: WorkerUsage,
    pub elapsed_ms: u64,
}

impl WorkerReport {
    pub fn timed_out(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            status: WorkerStatus::Timeout,
            ..Default::default()
        }
    }

    pub fn cancelled(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            status: WorkerStatus::Cancelled,
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_round_trips_the_contract() {
        let report = WorkerReport {
            id: "w-1".into(),
            status: WorkerStatus::Success,
            summary: "migrated the crate".into(),
            files_read: vec!["src/lib.rs".into()],
            files_changed: vec!["src/lib.rs".into()],
            commands_run: vec![CommandRun {
                command: "cargo fmt".into(),
                exit_code: Some(0),
                output_len: 0,
            }],
            test_runs: vec![TestRun {
                command: "cargo test".into(),
                exit_code: Some(0),
                passed: 3,
                failed: 0,
                skipped: 1,
                summary_lines: vec!["3 passed".into()],
            }],
            findings: vec!["build is green".into()],
            deviations: Vec::new(),
            risks: Vec::new(),
            usage: WorkerUsage {
                input_tokens: 120,
                output_tokens: 30,
                cached_tokens: 90,
                cost: 0.0002,
                cost_known: true,
            },
            elapsed_ms: 45,
        };
        let encoded = serde_json::to_value(&report).unwrap();
        assert_eq!(encoded["status"], serde_json::json!("success"));
        let decoded: WorkerReport = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded, report);
    }
}
