//! The three-tier permission model (§10.4.2): how far a worker may reach
//! without asking the user, and when a tool call must prompt for approval.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// Session-scoped access tier for every worker.
///
/// - `AskEverything` (default): every tool call needs user approval.
/// - `Workspace`: auto-allowed inside the launch folder; leaving it prompts.
/// - `FullAccess`: no prompts; only the credential store stays unreachable.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionTier {
    #[default]
    AskEverything,
    Workspace,
    FullAccess,
}

impl PermissionTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AskEverything => "ask-everything",
            Self::Workspace => "workspace",
            Self::FullAccess => "full-access",
        }
    }
}

impl fmt::Display for PermissionTier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for PermissionTier {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "ask-everything" | "ask" | "ask_everything" => Ok(Self::AskEverything),
            "workspace" | "workdir" => Ok(Self::Workspace),
            "full-access" | "full" | "full_access" => Ok(Self::FullAccess),
            other => Err(format!(
                "invalid permission tier '{other}'; expected ask-everything|workspace|full-access"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_ask_everything() {
        assert_eq!(PermissionTier::default(), PermissionTier::AskEverything);
    }

    #[test]
    fn parses_canonical_and_short_forms() {
        assert_eq!("ask-everything".parse(), Ok(PermissionTier::AskEverything));
        assert_eq!("workspace".parse(), Ok(PermissionTier::Workspace));
        assert_eq!("full-access".parse(), Ok(PermissionTier::FullAccess));
        assert_eq!("ASK-EVERYTHING".parse(), Ok(PermissionTier::AskEverything));
        assert_eq!("ask_everything".parse(), Ok(PermissionTier::AskEverything));
        assert_eq!("full".parse(), Ok(PermissionTier::FullAccess));
        assert!("everything".parse::<PermissionTier>().is_err());
    }

    #[test]
    fn serde_round_trips_kebab_case() {
        assert_eq!(
            serde_json::to_value(PermissionTier::AskEverything).unwrap(),
            serde_json::json!("ask-everything")
        );
        assert_eq!(
            serde_json::from_str::<PermissionTier>("\"workspace\"").unwrap(),
            PermissionTier::Workspace
        );
        assert_eq!(
            serde_json::from_str::<PermissionTier>("\"full-access\"").unwrap(),
            PermissionTier::FullAccess
        );
    }
}
