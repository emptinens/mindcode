//! RETRACE forward-backward dual-worker reconciliation (§7.1).
//!
//! Performs backward reconstruction from a patch/diff and changes without access
//! to the original issue description, then reconciles forward-backward
//! intent to produce an actionable `Submit`, `RevisePatch`, or `RevisitReasoning` verdict.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RetraceReconciliation {
    /// Backward reconstruction matches the forward issue intent.
    Same,
    /// Backward reconstruction partially addresses the issue but missed edge cases.
    Partial,
    /// Backward reconstruction diverged into an unrelated or incorrect problem.
    Different,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum RetraceVerdict {
    /// Safe to submit/commit to the branch.
    Submit,
    /// Revise the patch to address missing aspects.
    RevisePatch { reason: String },
    /// Patch fundamentally diverged; revisit reasoning and plan.
    RevisitReasoning { reason: String },
}

impl RetraceVerdict {
    pub fn is_submit(&self) -> bool {
        matches!(self, Self::Submit)
    }
}

/// Backward issue reconstruction from code diff and modified files (withheld issue).
pub fn reconstruct_problem_intent(patch_diff: &str, files_modified: &[String]) -> String {
    let mut modified_symbols = Vec::new();
    let mut test_hints = Vec::new();

    for line in patch_diff.lines() {
        let trimmed = line.trim();
        let content_line = if trimmed.starts_with('+') || trimmed.starts_with('-') {
            trimmed[1..].trim()
        } else {
            trimmed
        };
        if content_line.starts_with("fn ")
            || content_line.starts_with("pub fn ")
            || content_line.starts_with("async fn ")
            || content_line.starts_with("def ")
            || content_line.starts_with("class ")
        {
            modified_symbols.push(content_line);
        } else if (trimmed.starts_with('+') || trimmed.starts_with('-'))
            && (content_line.contains("assert") || content_line.contains("test"))
        {
            test_hints.push(content_line);
        }
    }

    let files_summary = files_modified.join(", ");
    let symbols_summary = if modified_symbols.is_empty() {
        "unspecified functions"
    } else {
        modified_symbols[0]
    };

    let test_summary = if test_hints.is_empty() {
        "no explicit test assertions added"
    } else {
        test_hints[0]
    };

    format!("Modified [{files_summary}] at [{symbols_summary}] to verify [{test_summary}]")
}

/// Reconcile forward issue statement with backward reconstructed intent.
pub fn reconcile_forward_backward(
    original_issue: &str,
    reconstructed_intent: &str,
    test_passed: bool,
) -> (RetraceReconciliation, RetraceVerdict) {
    if !test_passed {
        return (
            RetraceReconciliation::Partial,
            RetraceVerdict::RevisePatch {
                reason: "Tests did not pass during verification".to_owned(),
            },
        );
    }

    let extract_terms = |text: &str| -> std::collections::HashSet<String> {
        text.split(|c: char| !c.is_alphanumeric())
            .map(|w| w.to_ascii_lowercase())
            .filter(|w| w.len() > 2)
            .collect()
    };

    let issue_words = extract_terms(original_issue);
    let intent_words = extract_terms(reconstructed_intent);

    if issue_words.is_empty() || intent_words.is_empty() {
        return (RetraceReconciliation::Same, RetraceVerdict::Submit);
    }

    let intersection_count = issue_words
        .iter()
        .filter(|w| {
            intent_words.contains(*w)
                || intent_words
                    .iter()
                    .any(|iw| iw.starts_with(&w[..w.len().min(4)]))
        })
        .count();
    let overlap_ratio = (intersection_count as f64) / (issue_words.len() as f64);

    if overlap_ratio >= 0.25 {
        (RetraceReconciliation::Same, RetraceVerdict::Submit)
    } else if overlap_ratio >= 0.10 {
        (
            RetraceReconciliation::Partial,
            RetraceVerdict::RevisePatch {
                reason: format!(
                    "Patch addresses related areas but only partially matches issue terms (overlap={:.2})",
                    overlap_ratio
                ),
            },
        )
    } else {
        (
            RetraceReconciliation::Different,
            RetraceVerdict::RevisitReasoning {
                reason: format!(
                    "Backward reconstructed intent diverged from forward issue (overlap={:.2})",
                    overlap_ratio
                ),
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconstructs_intent_from_diff() {
        let diff = r#"
--- a/src/auth.rs
+++ b/src/auth.rs
@@ -10,3 +10,4 @@
+pub fn validate_token(token: &str) -> bool {
+    assert!(!token.is_empty());
"#;
        let files = vec!["src/auth.rs".to_owned()];
        let intent = reconstruct_problem_intent(diff, &files);
        assert!(intent.contains("src/auth.rs"));
        assert!(intent.contains("validate_token"));
    }

    #[test]
    fn reconciles_same_intent_to_submit() {
        let issue = "Add token validation in src/auth.rs for empty tokens";
        let intent = "Modified [src/auth.rs] at [pub fn validate_token] to verify [assert!(!token.is_empty())]";
        let (recon, verdict) = reconcile_forward_backward(issue, intent, true);
        assert_eq!(recon, RetraceReconciliation::Same);
        assert_eq!(verdict, RetraceVerdict::Submit);
    }

    #[test]
    fn reconciles_diverged_intent_to_revisit_reasoning() {
        let issue = "Fix database memory leak on high concurrency query engine";
        let intent = "Modified [ui/styles.css] at [unspecified functions] to verify [no explicit test assertions added]";
        let (recon, verdict) = reconcile_forward_backward(issue, intent, true);
        assert_eq!(recon, RetraceReconciliation::Different);
        assert!(matches!(verdict, RetraceVerdict::RevisitReasoning { .. }));
    }
}
