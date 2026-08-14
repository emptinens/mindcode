//! Preference learning from reinforcement breadcrumbs (§14.2).
//!
//! Reinforcement signals (§12.2) are passive by default: they only bump a
//! record's `reinforcement` counter. This module aggregates repeated signals of
//! the *same* preference and promotes them into a stable
//! [`MemoryType::Preference`] record only once they cross an observation
//! threshold, so a one-off remark does not become a durable preference but a
//! repeated pattern does. Promoted preferences live in the shared
//! [`MemoryStore`]; pending breadcrumbs are in-memory per session.

use crate::memory_graph::{
    contains_credential_shaped, fnv1a, MemoryError, MemoryRecord, MemoryScope, MemoryStore,
    MemoryType,
};
use std::collections::BTreeMap;

/// Minimum number of observations before a breadcrumb is promoted (default 2).
pub const DEFAULT_MIN_OBSERVATIONS: u32 = 2;

/// Aggregates reinforcement breadcrumbs and promotes the confident ones.
pub struct PreferenceLearner {
    min_observations: u32,
    pending: BTreeMap<String, PendingBreadcrumb>,
}

#[derive(Debug, Clone, Copy)]
struct PendingBreadcrumb {
    occurrences: u32,
    last_seen_ms: u64,
}

/// Outcome of observing one breadcrumb.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreferenceSignal {
    /// Empty input; nothing was learned.
    Ignored,
    /// Below the threshold, still accumulating.
    Pending { occurrences: u32, needed: u32 },
    /// Crossed the threshold and was written into the store as a `Preference`.
    Promoted { id: String },
    /// Already promoted; the existing record was reinforced.
    Reinforced { id: String },
}

impl PreferenceLearner {
    pub fn new(min_observations: u32) -> Self {
        Self {
            min_observations: min_observations.max(1),
            pending: BTreeMap::new(),
        }
    }

    /// Number of breadcrumbs still below the promotion threshold.
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// Observe one preference signal. Text is whitespace-normalized so the
    /// same preference phrased slightly differently collapses to one record.
    /// Credential-shaped text is refused (never learned).
    pub fn observe(
        &mut self,
        text: &str,
        now_ms: u64,
        store: &mut MemoryStore,
    ) -> Result<PreferenceSignal, MemoryError> {
        let normalized = normalize(text);
        if normalized.is_empty() {
            return Ok(PreferenceSignal::Ignored);
        }
        if contains_credential_shaped(&normalized) {
            return Err(MemoryError::CredentialShaped);
        }
        let id = preference_id(&normalized);
        if store.get(&id).is_some() {
            store.reinforce(&id, now_ms);
            return Ok(PreferenceSignal::Reinforced { id });
        }
        let entry = self
            .pending
            .entry(normalized.clone())
            .or_insert(PendingBreadcrumb {
                occurrences: 0,
                last_seen_ms: now_ms,
            });
        entry.occurrences += 1;
        entry.last_seen_ms = now_ms;
        if entry.occurrences >= self.min_observations {
            let confidence = confidence_for(entry.occurrences);
            let record = MemoryRecord {
                id: id.clone(),
                memory_type: MemoryType::Preference,
                scope: MemoryScope::Global,
                text: normalized.clone(),
                provenance: "preference-learner".to_owned(),
                created_at_ms: now_ms,
                reinforced_at_ms: now_ms,
                reinforcement: entry.occurrences - self.min_observations,
                confidence,
                private: false,
            };
            store.insert(record)?;
            self.pending.remove(&normalized);
            Ok(PreferenceSignal::Promoted { id })
        } else {
            Ok(PreferenceSignal::Pending {
                occurrences: entry.occurrences,
                needed: self.min_observations,
            })
        }
    }
}

impl Default for PreferenceLearner {
    fn default() -> Self {
        Self::new(DEFAULT_MIN_OBSERVATIONS)
    }
}

/// Collapse runs of whitespace so minor phrasing differences aggregate.
fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Stable id derived from the normalized text: repeated observations of the
/// same preference promote the same record.
fn preference_id(normalized: &str) -> String {
    format!("pref-{:016x}", fnv1a(normalized.as_bytes()))
}

/// Confidence saturates toward 1.0 as observations accumulate (2 → 0.67,
/// 3 → 0.75, 5 → 0.83). Two observations already clear the default threshold,
/// but more observations produce a stronger, longer-lived record.
fn confidence_for(occurrences: u32) -> f64 {
    let value = occurrences as f64 / (occurrences as f64 + 1.0);
    value.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_observations_promote_one_observation_stays_pending() {
        let mut store = MemoryStore::default();
        let mut learner = PreferenceLearner::default();

        let first = learner.observe("commit without pushing", 1, &mut store).unwrap();
        assert_eq!(
            first,
            PreferenceSignal::Pending {
                occurrences: 1,
                needed: 2
            }
        );
        assert_eq!(store.len(), 0);
        assert_eq!(learner.pending_count(), 1);

        let second = learner.observe("commit without pushing", 2, &mut store).unwrap();
        assert!(matches!(second, PreferenceSignal::Promoted { .. }));
        assert_eq!(store.len(), 1);
        assert_eq!(learner.pending_count(), 0);
        let promoted = store.search("commit without pushing", 1, 0.0)[0].0.clone();
        assert_eq!(promoted.memory_type, MemoryType::Preference);
        assert_eq!(promoted.scope, MemoryScope::Global);
    }

    #[test]
    fn normalization_aggregates_phrasing_differences() {
        let mut store = MemoryStore::default();
        let mut learner = PreferenceLearner::default();
        learner.observe("comments  in   english", 1, &mut store).unwrap();
        let signal = learner.observe("comments in english", 2, &mut store).unwrap();
        assert!(matches!(signal, PreferenceSignal::Promoted { .. }));
    }

    #[test]
    fn promotion_reinforces_on_later_observations() {
        let mut store = MemoryStore::default();
        let mut learner = PreferenceLearner::default();
        learner.observe("prefer snake_case", 1, &mut store).unwrap();
        learner.observe("prefer snake_case", 2, &mut store).unwrap();
        let signal = learner.observe("prefer snake_case", 3, &mut store).unwrap();
        assert!(matches!(signal, PreferenceSignal::Reinforced { .. }));
    }

    #[test]
    fn credential_shaped_text_is_never_learned() {
        let mut store = MemoryStore::default();
        let mut learner = PreferenceLearner::default();
        assert!(matches!(
            learner.observe("api_key = sk-abcdef1234567890", 1, &mut store),
            Err(MemoryError::CredentialShaped)
        ));
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn confidence_saturates_toward_one() {
        assert!(confidence_for(2) > 0.6 && confidence_for(2) < 0.7);
        assert!(confidence_for(5) > confidence_for(3));
        assert!(confidence_for(1000) < 1.0);
    }
}
