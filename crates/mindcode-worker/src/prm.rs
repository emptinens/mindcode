//! PRM (Process Reward Model) coarse taxonomic error classification (§7.1).
//!
//! Provides deterministic taxonomy triage based on artifact analysis (not LLM)
//! across error classes: `WrongFix`, `NoBuild`, `PatchBrokeTests`, `BudgetExceeded`,
//! and `ReflectionNeeded`.

use crate::{TestRun, WorkerReport, WorkerStatus};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrmClass {
    /// All verification criteria passed cleanly.
    Pass,
    /// Build/compilation failure before test execution or in test compilation.
    NoBuild,
    /// Existing or newly added tests failed after applying the patch.
    PatchBrokeTests,
    /// The patch did not address the issue or produced no relevant modifications.
    WrongFix,
    /// Token budget, timeout, or iteration limit exceeded.
    BudgetExceeded,
    /// Shell command or write action triggered a security/risk gate.
    ReflectionNeeded,
}

impl PrmClass {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::NoBuild => "no_build",
            Self::PatchBrokeTests => "patch_broke_tests",
            Self::WrongFix => "wrong_fix",
            Self::BudgetExceeded => "budget_exceeded",
            Self::ReflectionNeeded => "reflection_needed",
        }
    }

    pub const fn is_pass(self) -> bool {
        matches!(self, Self::Pass)
    }
}

/// Deterministically triage a completed [`WorkerReport`] into a [`PrmClass`].
pub fn triage_worker_report(report: &WorkerReport) -> PrmClass {
    if report.status == WorkerStatus::Cancelled
        || report
            .risks
            .iter()
            .any(|r| r.contains("iteration limit") || r.contains("timeout"))
    {
        return PrmClass::BudgetExceeded;
    }

    if report
        .risks
        .iter()
        .any(|r| r.contains("denied") || r.contains("reflection"))
    {
        return PrmClass::ReflectionNeeded;
    }

    // Inspect test run evidence
    if let Some(failed_test) = report.test_runs.iter().find(|t| !test_passed(t)) {
        if is_build_failure(failed_test) {
            return PrmClass::NoBuild;
        }
        return PrmClass::PatchBrokeTests;
    }

    if report.status == WorkerStatus::Success {
        PrmClass::Pass
    } else if report.files_changed.is_empty() {
        PrmClass::WrongFix
    } else {
        PrmClass::PatchBrokeTests
    }
}

fn test_passed(test: &TestRun) -> bool {
    test.exit_code == Some(0) && test.failed == 0
}

fn is_build_failure(test: &TestRun) -> bool {
    test.summary_lines.iter().any(|line| {
        let l = line.to_ascii_lowercase();
        l.contains("could not compile")
            || l.contains("syntaxerror")
            || l.contains("compilation error")
            || l.contains("build failed")
            || l.contains("undefined reference")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WorkerUsage;

    fn base_report() -> WorkerReport {
        WorkerReport {
            id: "w-1".into(),
            status: WorkerStatus::Success,
            summary: "fixed".into(),
            files_read: vec![],
            files_changed: vec!["src/lib.rs".into()],
            commands_run: vec![],
            test_runs: vec![],
            findings: vec![],
            deviations: vec![],
            risks: vec![],
            elapsed_ms: 100,
            usage: WorkerUsage::default(),
        }
    }

    #[test]
    fn triage_pass_on_successful_report() {
        let mut report = base_report();
        report.test_runs.push(TestRun {
            command: "cargo test".into(),
            exit_code: Some(0),
            passed: 4,
            failed: 0,
            skipped: 0,
            summary_lines: vec![],
        });
        assert_eq!(triage_worker_report(&report), PrmClass::Pass);
    }

    #[test]
    fn triage_no_build_on_compilation_error() {
        let mut report = base_report();
        report.test_runs.push(TestRun {
            command: "cargo test".into(),
            exit_code: Some(101),
            passed: 0,
            failed: 1,
            skipped: 0,
            summary_lines: vec!["error: could not compile `foo`".into()],
        });
        assert_eq!(triage_worker_report(&report), PrmClass::NoBuild);
    }

    #[test]
    fn triage_patch_broke_tests_on_failed_test() {
        let mut report = base_report();
        report.test_runs.push(TestRun {
            command: "cargo test".into(),
            exit_code: Some(1),
            passed: 3,
            failed: 1,
            skipped: 0,
            summary_lines: vec!["test foo ... FAILED".into()],
        });
        assert_eq!(triage_worker_report(&report), PrmClass::PatchBrokeTests);
    }

    #[test]
    fn triage_budget_exceeded_on_iteration_limit() {
        let mut report = base_report();
        report.status = WorkerStatus::Failed;
        report
            .risks
            .push("iteration limit reached without a final answer".into());
        assert_eq!(triage_worker_report(&report), PrmClass::BudgetExceeded);
    }

    #[test]
    fn triage_reflection_needed_on_denied_risk() {
        let mut report = base_report();
        report.risks.push("denied: catastrophic shell risk".into());
        assert_eq!(triage_worker_report(&report), PrmClass::ReflectionNeeded);
    }
}
