//! Onboarding credential state machine (§12.4).
//!
//! Tracks how far a provider credential has progressed through first-run
//! seeding: `Absent → Present → Verified → Stale → Rejected`. The machine is
//! secret-free and pure: it stores no credential value, only the state name.
//! `Rejected` is a terminal "permanently rejected" state that callers reach
//! after N consecutive `ProviderRejected` events (the retry counter is held by
//! the caller, not by this module).

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CredState {
    Absent,
    Present,
    Verified,
    Stale,
    Rejected,
}

impl CredState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Present => "present",
            Self::Verified => "verified",
            Self::Stale => "stale",
            Self::Rejected => "rejected",
        }
    }
}

/// An observable credential event that advances the state machine.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredEvent {
    /// No credential resolves from env or the secret store.
    KeyMissing,
    /// A credential resolves from env or the secret store.
    KeyResolved,
    /// The provider accepted the credential (e.g. `/v1/models` 200).
    ProviderAccepted,
    /// The provider rejected the credential (401/403).
    ProviderRejected,
}

/// Deterministic transition. `Rejected` is terminal; every other state moves
/// as documented in §12.4.
pub fn transition(state: CredState, event: CredEvent) -> CredState {
    if state == CredState::Rejected {
        return CredState::Rejected;
    }
    match event {
        CredEvent::KeyMissing => CredState::Absent,
        CredEvent::KeyResolved => {
            if state == CredState::Absent {
                CredState::Present
            } else {
                state
            }
        }
        CredEvent::ProviderAccepted => CredState::Verified,
        CredEvent::ProviderRejected => CredState::Stale,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_cycle_absent_to_verified_and_back() {
        assert_eq!(
            transition(CredState::Absent, CredEvent::KeyResolved),
            CredState::Present
        );
        assert_eq!(
            transition(CredState::Present, CredEvent::ProviderAccepted),
            CredState::Verified
        );
        assert_eq!(
            transition(CredState::Verified, CredEvent::ProviderRejected),
            CredState::Stale
        );
        assert_eq!(
            transition(CredState::Stale, CredEvent::ProviderAccepted),
            CredState::Verified
        );
        assert_eq!(
            transition(CredState::Stale, CredEvent::KeyMissing),
            CredState::Absent
        );
    }

    #[test]
    fn rejected_is_terminal() {
        for event in [
            CredEvent::KeyMissing,
            CredEvent::KeyResolved,
            CredEvent::ProviderAccepted,
            CredEvent::ProviderRejected,
        ] {
            assert_eq!(transition(CredState::Rejected, event), CredState::Rejected);
        }
    }

    #[test]
    fn serde_round_trips_kebab_case() {
        let value = serde_json::to_string(&CredState::Present).unwrap();
        assert_eq!(value, "\"present\"");
        let back: CredState = serde_json::from_str(&value).unwrap();
        assert_eq!(back, CredState::Present);
    }
}
