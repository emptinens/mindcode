//! Deterministic Ares-style effort classifier for TaskGraph steps (§6.3).
//!
//! This is a local, bounded heuristic: it never asks an LLM to choose effort.
//! It routes verification-bound and mutation-heavy steps up and trivial
//! read-only steps down so the honest cost ledger can attribute the right
//! effort to a step *before* a worker is dispatched. The global effort lock is
//! applied by the caller and always wins over this classifier.

use super::{TaskEffort, TaskKind};

/// Structural signals available at task-route time. The runtime-only signals
/// (live diff bytes, tool-call count, shell risk) are deliberately absent:
/// those are collected later by the worker loop and the per-step classifier
/// must stay deterministic and free of provider input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AresSignals {
    pub kind: TaskKind,
    pub read_set_len: usize,
    pub write_set_len: usize,
    pub blocked_by_len: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AresDecision {
    pub effort: TaskEffort,
    pub score: u8,
}

/// Classify a step from structural signals only.
///
/// Scoring:
/// - kind: research 0, implement/integrate 1, verify 2 (verification-bound work
///   is never routed down — "route around the step, not through it");
/// - mutation: +1 when the step declares a write set;
/// - scope: +0/+1/+2 by combined read/write set size;
/// - coupling: +0/+1/+2 by the number of blocking dependencies.
///
/// Mapping: 0 → low, 1..=2 → medium, 3..=4 → high, 5 → xhigh, 6+ → max.
/// A bare `implement` step with no sets or dependencies scores 1 and therefore
/// keeps the historical `medium` default, so existing consumers are unchanged.
pub fn ares_classify(signals: AresSignals) -> AresDecision {
    let kind_score = match signals.kind {
        TaskKind::Research => 0_u8,
        TaskKind::Implement | TaskKind::Integrate => 1,
        TaskKind::Verify => 2,
    };
    let mutation_score = u8::from(signals.write_set_len > 0);
    let scope_score = match signals.read_set_len.saturating_add(signals.write_set_len) {
        0 => 0_u8,
        1..=4 => 1,
        _ => 2,
    };
    let coupling_score = match signals.blocked_by_len {
        0 => 0_u8,
        1..=2 => 1,
        _ => 2,
    };
    let score = kind_score
        .saturating_add(mutation_score)
        .saturating_add(scope_score)
        .saturating_add(coupling_score);
    let effort = match score {
        0 => TaskEffort::Low,
        1..=2 => TaskEffort::Medium,
        3..=4 => TaskEffort::High,
        5 => TaskEffort::Xhigh,
        _ => TaskEffort::Max,
    };
    AresDecision { effort, score }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify(
        kind: TaskKind,
        read_set_len: usize,
        write_set_len: usize,
        blocked_by_len: usize,
    ) -> AresDecision {
        ares_classify(AresSignals {
            kind,
            read_set_len,
            write_set_len,
            blocked_by_len,
        })
    }

    #[test]
    fn bare_implement_keeps_the_historical_medium_default() {
        let decision = classify(TaskKind::Implement, 0, 0, 0);
        assert_eq!(decision.effort, TaskEffort::Medium);
        assert_eq!(decision.score, 1);
    }

    #[test]
    fn trivial_research_routes_down_to_low() {
        let decision = classify(TaskKind::Research, 0, 0, 0);
        assert_eq!(decision.effort, TaskEffort::Low);
        assert_eq!(decision.score, 0);
    }

    #[test]
    fn verify_with_mutation_and_coupling_routes_up_to_max() {
        let decision = classify(TaskKind::Verify, 8, 3, 3);
        assert_eq!(decision.effort, TaskEffort::Max);
        assert_eq!(decision.score, 7);
    }

    #[test]
    fn mutation_and_scope_raise_a_research_step() {
        let decision = classify(TaskKind::Research, 5, 2, 0);
        assert_eq!(decision.effort, TaskEffort::High);
        assert_eq!(decision.score, 3);
    }

    #[test]
    fn score_is_monotonic_across_every_axis() {
        let base = classify(TaskKind::Implement, 0, 0, 0);
        assert!(classify(TaskKind::Verify, 0, 0, 0).score > base.score);
        assert!(classify(TaskKind::Implement, 0, 1, 0).score > base.score);
        assert!(classify(TaskKind::Implement, 5, 0, 0).score > base.score);
        assert!(classify(TaskKind::Implement, 0, 0, 3).score > base.score);
    }
}
