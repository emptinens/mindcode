//! VEXZY-only primitives for the Rust-first MindCode migration.
//!
//! This crate deliberately performs no network I/O. It owns only fixed VEXZY
//! endpoint constants, environment-only credential validation/redaction, and
//! fail-closed parsing of the dynamic model catalog used for Worker selection.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::{collections::HashSet, env, fmt, str::FromStr};

/// The only provider origin permitted by the 0.1.3 contract.
pub const VEXZY_BASE_URL: &str = "https://api.echogate.one";
/// The OpenAI-compatible VEXZY API prefix.
pub const VEXZY_OPENAI_BASE_URL: &str = "https://api.echogate.one/v1";
pub const VEXZY_MODELS_ENDPOINT: &str = "https://api.echogate.one/v1/models";
pub const VEXZY_CHAT_COMPLETIONS_ENDPOINT: &str = "https://api.echogate.one/v1/chat/completions";
pub const VEXZY_MESSAGES_ENDPOINT: &str = "https://api.echogate.one/v1/messages";

/// The sole environment variable from which a VEXZY credential may be read.
pub const VEXZY_API_KEY_ENV: &str = "VEXZY_API_KEY";
/// Stable redaction used by user-facing output and diagnostics.
pub const REDACTED_VEXZY_API_KEY: &str = "forge-…";
const VEXZY_API_KEY_PREFIX: &str = "forge-";

/// An in-memory VEXZY credential.
///
/// It intentionally has no `Debug`, `Display`, or serialization implementation
/// so common diagnostics and state paths cannot accidentally expose its value.
#[derive(Clone, Eq, PartialEq)]
pub struct VexzyApiKey(String);

impl VexzyApiKey {
    /// Validate a raw environment value without persisting it.
    pub fn new(value: String) -> Result<Self, VexzyApiKeyError> {
        validate_vexzy_api_key(&value)?;
        Ok(Self(value))
    }

    /// Read only `VEXZY_API_KEY` from the current process environment.
    pub fn from_environment() -> Result<Self, VexzyApiKeyError> {
        let value = env::var(VEXZY_API_KEY_ENV).map_err(|_| VexzyApiKeyError::Missing)?;
        Self::new(value)
    }

    /// Borrow the credential solely for building an authorization header.
    /// Callers must not log or persist the returned value.
    pub fn as_secret(&self) -> &str {
        &self.0
    }

    /// Return the stable secret-free diagnostic form.
    pub const fn redacted(&self) -> &'static str {
        REDACTED_VEXZY_API_KEY
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VexzyApiKeyError {
    Missing,
    Invalid,
}

impl fmt::Display for VexzyApiKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => write!(f, "{VEXZY_API_KEY_ENV} is not configured"),
            Self::Invalid => write!(
                f,
                "{VEXZY_API_KEY_ENV} must be a non-empty forge- key without whitespace"
            ),
        }
    }
}

impl std::error::Error for VexzyApiKeyError {}

/// Validate a key without including any caller-supplied value in an error.
pub fn validate_vexzy_api_key(value: &str) -> Result<(), VexzyApiKeyError> {
    let Some(suffix) = value.strip_prefix(VEXZY_API_KEY_PREFIX) else {
        return Err(VexzyApiKeyError::Invalid);
    };
    if suffix.is_empty() || value.chars().any(char::is_whitespace) {
        return Err(VexzyApiKeyError::Invalid);
    }
    Ok(())
}

pub fn is_valid_vexzy_api_key(value: &str) -> bool {
    validate_vexzy_api_key(value).is_ok()
}

/// Redact any supplied key value. This function never returns an input slice.
pub const fn redact_vexzy_api_key(_: &str) -> &'static str {
    REDACTED_VEXZY_API_KEY
}

/// The fixed set of reasoning efforts valid for a Worker.
pub const SUPPORTED_WORKER_EFFORTS: [WorkerEffort; 6] = [
    WorkerEffort::None,
    WorkerEffort::Low,
    WorkerEffort::Medium,
    WorkerEffort::High,
    WorkerEffort::Xhigh,
    WorkerEffort::Max,
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkerEffort {
    None,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl WorkerEffort {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

impl fmt::Display for WorkerEffort {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerEffortParseError;

impl fmt::Display for WorkerEffortParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("unsupported Worker effort")
    }
}

impl std::error::Error for WorkerEffortParseError {}

impl FromStr for WorkerEffort {
    type Err = WorkerEffortParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "none" => Ok(Self::None),
            "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "xhigh" => Ok(Self::Xhigh),
            "max" => Ok(Self::Max),
            _ => Err(WorkerEffortParseError),
        }
    }
}

/// Capability fields the Worker-selection boundary consumes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VexzyModelCapabilities {
    pub tools: bool,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub vision: bool,
}

/// A typed, provider-originated row from `GET /v1/models`.
///
/// Unrecognized effort strings remain in their raw provider form so a future
/// provider addition cannot make the entire catalog unparsable. Eligibility
/// still accepts only the six values represented by [`WorkerEffort`].
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VexzyModel {
    pub id: String,
    pub available: bool,
    pub capabilities: VexzyModelCapabilities,
    #[serde(default)]
    pub supported_reasoning_efforts: Vec<String>,
}

impl VexzyModel {
    /// Enumerate valid Worker efforts in the provider's original order.
    pub fn supported_worker_efforts(&self) -> Vec<WorkerEffort> {
        let mut efforts = Vec::new();
        for raw in &self.supported_reasoning_efforts {
            let Ok(effort) = raw.parse() else {
                continue;
            };
            if !efforts.contains(&effort) {
                efforts.push(effort);
            }
        }
        efforts
    }

    pub fn supports_worker_effort(&self, effort: WorkerEffort) -> bool {
        self.supported_worker_efforts().contains(&effort)
    }

    /// A model is eligible only if it is live, tools-capable, and supports at
    /// least one of the six Worker efforts. No model alias or fallback exists.
    pub fn is_worker_eligible(&self) -> bool {
        !self.id.trim().is_empty()
            && self.available
            && self.capabilities.tools
            && !self.supported_worker_efforts().is_empty()
    }
}

/// A typed VEXZY `/v1/models` response.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VexzyModelCatalog {
    pub object: String,
    pub data: Vec<VexzyModel>,
}

impl VexzyModelCatalog {
    pub fn eligible_worker_models(&self) -> Vec<&VexzyModel> {
        eligible_worker_models(self)
    }

    pub fn eligible_worker_models_for_effort(&self, effort: WorkerEffort) -> Vec<&VexzyModel> {
        eligible_worker_models_for_effort(self, effort)
    }
}

#[derive(Debug)]
pub enum VexzyCatalogError {
    Json(serde_json::Error),
    UnexpectedObject,
    EmptyModelId { index: usize },
    DuplicateModelId(String),
}

impl fmt::Display for VexzyCatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(f, "invalid VEXZY model catalog JSON: {error}"),
            Self::UnexpectedObject => f.write_str("VEXZY model catalog object must be list"),
            Self::EmptyModelId { index } => {
                write!(f, "VEXZY model catalog entry {index} has an empty id")
            }
            Self::DuplicateModelId(_) => f.write_str("VEXZY model catalog contains duplicate ids"),
        }
    }
}

impl std::error::Error for VexzyCatalogError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

/// Parse and structurally validate one dynamic VEXZY catalog snapshot.
pub fn parse_vexzy_model_catalog(input: &str) -> Result<VexzyModelCatalog, VexzyCatalogError> {
    let catalog: VexzyModelCatalog =
        serde_json::from_str(input).map_err(VexzyCatalogError::Json)?;
    if catalog.object != "list" {
        return Err(VexzyCatalogError::UnexpectedObject);
    }

    let mut ids = HashSet::with_capacity(catalog.data.len());
    for (index, model) in catalog.data.iter().enumerate() {
        if model.id.trim().is_empty() {
            return Err(VexzyCatalogError::EmptyModelId { index });
        }
        if !ids.insert(model.id.clone()) {
            return Err(VexzyCatalogError::DuplicateModelId(model.id.clone()));
        }
    }
    Ok(catalog)
}

pub fn eligible_worker_models(catalog: &VexzyModelCatalog) -> Vec<&VexzyModel> {
    catalog
        .data
        .iter()
        .filter(|model| model.is_worker_eligible())
        .collect()
}

pub fn eligible_worker_models_for_effort(
    catalog: &VexzyModelCatalog,
    effort: WorkerEffort,
) -> Vec<&VexzyModel> {
    eligible_worker_models(catalog)
        .into_iter()
        .filter(|model| model.supports_worker_effort(effort))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, available: bool, tools: bool, efforts: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "available": available,
            "capabilities": {"tools": tools, "reasoning": true, "vision": false},
            "supported_reasoning_efforts": efforts,
        })
    }

    #[test]
    fn exports_only_fixed_vexzy_endpoints() {
        assert_eq!(VEXZY_BASE_URL, "https://api.echogate.one");
        assert_eq!(VEXZY_MODELS_ENDPOINT, "https://api.echogate.one/v1/models");
        assert_eq!(
            VEXZY_CHAT_COMPLETIONS_ENDPOINT,
            "https://api.echogate.one/v1/chat/completions"
        );
        assert_eq!(
            VEXZY_MESSAGES_ENDPOINT,
            "https://api.echogate.one/v1/messages"
        );
    }

    #[test]
    fn validates_and_redacts_api_keys_without_echoing_secrets() {
        let secret = "forge-this-is-a-secret";
        let key = VexzyApiKey::new(secret.to_owned()).unwrap();
        assert_eq!(key.as_secret(), secret);
        assert_eq!(key.redacted(), "forge-…");
        assert_eq!(redact_vexzy_api_key(secret), "forge-…");
        for invalid in [
            "",
            "forge-",
            "not-forge",
            "forge-has space",
            "forge-has\nnewline",
        ] {
            let error = validate_vexzy_api_key(invalid).unwrap_err().to_string();
            assert!(!error.contains("not-forge"));
            assert!(!error.contains("has space"));
            assert!(!error.contains("has\nnewline"));
            assert!(!is_valid_vexzy_api_key(invalid));
        }
    }

    #[test]
    fn defines_exactly_all_supported_worker_efforts() {
        let values = SUPPORTED_WORKER_EFFORTS.map(WorkerEffort::as_str);
        assert_eq!(values, ["none", "low", "medium", "high", "xhigh", "max"]);
        for effort in SUPPORTED_WORKER_EFFORTS {
            assert_eq!(effort.to_string().parse::<WorkerEffort>().unwrap(), effort);
        }
        assert!("auto".parse::<WorkerEffort>().is_err());
    }

    #[test]
    fn filters_unavailable_toolless_and_unsupported_models() {
        let source = serde_json::json!({
            "object": "list",
            "data": [
                row("eligible", true, true, &["none", "max"]),
                row("stale", false, true, &["none"]),
                row("no-tools", true, false, &["none"]),
                row("unknown-effort", true, true, &["auto"])
            ]
        })
        .to_string();
        let catalog = parse_vexzy_model_catalog(&source).unwrap();
        let eligible = eligible_worker_models(&catalog);
        assert_eq!(
            eligible
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["eligible"]
        );
        assert_eq!(
            eligible_worker_models_for_effort(&catalog, WorkerEffort::Max)[0].id,
            "eligible"
        );
    }

    #[test]
    fn rejects_malformed_wrong_shape_empty_and_duplicate_catalog_rows() {
        assert!(matches!(
            parse_vexzy_model_catalog("{"),
            Err(VexzyCatalogError::Json(_))
        ));
        assert!(matches!(
            parse_vexzy_model_catalog(r#"{"object":"model","data":[]}"#),
            Err(VexzyCatalogError::UnexpectedObject)
        ));
        let empty = serde_json::json!({"object":"list","data":[row("", true, true, &["none"])]});
        assert!(matches!(
            parse_vexzy_model_catalog(&empty.to_string()),
            Err(VexzyCatalogError::EmptyModelId { .. })
        ));
        let duplicate = serde_json::json!({"object":"list","data":[row("same", true, true, &["none"]), row("same", true, true, &["none"])]});
        assert!(matches!(
            parse_vexzy_model_catalog(&duplicate.to_string()),
            Err(VexzyCatalogError::DuplicateModelId(_))
        ));
    }
}
