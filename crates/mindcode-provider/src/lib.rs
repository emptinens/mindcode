//! Multi-provider profile model and on-disk secret store for MindCode.
//!
//! Owns the provider profile types used by the 0.1.3 multi-provider contract
//! (`Protocol`, `ModelId`, `ProviderId`, `CredentialRef`, `ProviderConfig`)
//! plus the on-disk secret store at
//! `~/.config/mindcode/credentials.json`. The store is the only place a
//! credential value may be persisted; it is deliberately separate from the
//! secret-free `settings.json`. Every public error, status, and diagnostic
//! surface is guaranteed secret-free: no credential value can ever appear in
//! `Debug`, `Display`, or serialized diagnostics.

#![forbid(unsafe_code)]

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    fmt, fs,
    fs::OpenOptions,
    io::{self, Write},
    path::{Path, PathBuf},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

/// On-disk secret store file name inside the MindCode config directory.
pub const CREDENTIALS_FILE_NAME: &str = "credentials.json";
const CREDENTIALS_DIR_NAME: &str = "mindcode";
/// Secret-free placeholder returned by every masking/redaction helper. It
/// never contains a credential value.
pub const REDACTED_SECRET: &str = "***";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The wire protocol a provider speaks.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Protocol {
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
    #[serde(rename = "anthropic-compatible")]
    AnthropicCompatible,
}

impl Protocol {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "openai-compatible",
            Self::AnthropicCompatible => "anthropic-compatible",
        }
    }
}

impl fmt::Display for Protocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
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

/// Neutral Worker reasoning-effort ladder, shared by both wire protocols.
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

impl FromStr for Protocol {
    type Err = ProviderConfigError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "openai-compatible" => Ok(Self::OpenAiCompatible),
            "anthropic-compatible" => Ok(Self::AnthropicCompatible),
            _ => Err(ProviderConfigError::InvalidProtocol),
        }
    }
}

/// A validated provider model identifier: non-empty and free of whitespace.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(try_from = "String")]
pub struct ModelId(String);

/// A validated provider profile identifier: non-empty and free of whitespace.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(try_from = "String")]
pub struct ProviderId(String);

fn validate_id(value: &str, error: ProviderConfigError) -> Result<String, ProviderConfigError> {
    if value.trim().is_empty() || value.chars().any(char::is_whitespace) {
        return Err(error);
    }
    Ok(value.to_owned())
}

impl ModelId {
    pub fn new(value: String) -> Result<Self, ProviderConfigError> {
        validate_id(&value, ProviderConfigError::InvalidModelId).map(Self)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ModelId {
    type Error = ProviderConfigError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl FromStr for ModelId {
    type Err = ProviderConfigError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value.to_owned())
    }
}

impl fmt::Display for ModelId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl ProviderId {
    pub fn new(value: String) -> Result<Self, ProviderConfigError> {
        validate_id(&value, ProviderConfigError::InvalidProviderId).map(Self)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ProviderId {
    type Error = ProviderConfigError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl FromStr for ProviderId {
    type Err = ProviderConfigError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value.to_owned())
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderConfigError {
    InvalidModelId,
    InvalidProviderId,
    InvalidProtocol,
}

impl fmt::Display for ProviderConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidModelId => {
                f.write_str("model id must be a non-empty string without whitespace")
            }
            Self::InvalidProviderId => {
                f.write_str("provider id must be a non-empty string without whitespace")
            }
            Self::InvalidProtocol => {
                f.write_str("protocol must be openai-compatible or anthropic-compatible")
            }
        }
    }
}

impl std::error::Error for ProviderConfigError {}

/// How a provider's credential is referenced: an environment variable name or
/// a key in the on-disk secret store. The referenced name is consulted in the
/// environment first and the secret store second; resolution fails closed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialRef {
    Env(String),
    Store(String),
}

impl CredentialRef {
    pub fn env(name: impl Into<String>) -> Self {
        Self::Env(name.into())
    }

    pub fn store(key: impl Into<String>) -> Self {
        Self::Store(key.into())
    }

    /// The name used for both the environment lookup and the store lookup.
    pub fn name(&self) -> &str {
        match self {
            Self::Env(name) | Self::Store(name) => name,
        }
    }
}

impl Serialize for CredentialRef {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut object = Map::new();
        match self {
            Self::Env(name) => {
                object.insert("env".to_owned(), Value::String(name.clone()));
            }
            Self::Store(key) => {
                object.insert("store".to_owned(), Value::String(key.clone()));
            }
        }
        Value::Object(object).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CredentialRef {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let object = Map::<String, Value>::deserialize(deserializer)?;
        let invalid =
            || de::Error::custom(r#"credential must be exactly {"env":"..."} or {"store":"..."}"#);
        if object.len() != 1 {
            return Err(invalid());
        }
        if let Some(Value::String(name)) = object.get("env") {
            return Ok(Self::Env(name.clone()));
        }
        if let Some(Value::String(key)) = object.get("store") {
            return Ok(Self::Store(key.clone()));
        }
        Err(invalid())
    }
}

/// One provider profile. The allowlist defaults to empty so a custom provider
/// fails closed until models are explicitly permitted.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfig {
    pub id: ProviderId,
    pub name: String,
    pub protocol: Protocol,
    pub base_url: String,
    pub credential: CredentialRef,
    #[serde(default)]
    pub allowlist: Vec<ModelId>,
    pub active: bool,
}

impl ProviderConfig {
    /// A custom provider fails closed: only allowlisted models are eligible,
    /// and an empty allowlist permits no model.
    pub fn allows_model(&self, model: &ModelId) -> bool {
        self.allowlist.contains(model)
    }
}

/// An opaque in-memory credential.
///
/// It intentionally has no `Debug`, `Display`, or serialization implementation
/// so common diagnostics and state paths cannot accidentally expose its value.
#[derive(Clone, Eq, PartialEq)]
pub struct SecretKey(String);

impl SecretKey {
    /// Wrap a raw credential value. The value is held privately and only ever
    /// leaves through [`Self::as_secret`], which callers must not log or
    /// persist.
    pub fn new(value: String) -> Self {
        Self(value)
    }

    /// Stable secret-free status used by diagnostics.
    pub const fn status(&self) -> &'static str {
        "configured"
    }

    /// Secret-free placeholder that never contains the credential value.
    pub const fn mask(&self) -> &'static str {
        REDACTED_SECRET
    }

    /// Borrow the credential solely for building an authorization header.
    /// Callers must not log, report, or persist the returned value.
    pub fn as_secret(&self) -> &str {
        &self.0
    }
}

/// Secret-free redaction for any raw credential value. Never returns the input.
pub const fn redact_secret(_: &str) -> &'static str {
    REDACTED_SECRET
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialError {
    Missing,
    Invalid,
}

impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => f.write_str("credential is not configured"),
            Self::Invalid => f.write_str("credential value is invalid"),
        }
    }
}

impl std::error::Error for CredentialError {}

/// The on-disk secret store: `provider id -> raw value`, persisted at
/// `~/.config/mindcode/credentials.json`. A missing file is an empty store.
#[derive(Clone, Eq, PartialEq)]
pub struct SecretStore {
    keys: BTreeMap<ProviderId, SecretKey>,
}

impl Default for SecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore {
    pub fn new() -> Self {
        Self {
            keys: BTreeMap::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn read(&self, id: &ProviderId) -> Option<&SecretKey> {
        self.keys.get(id)
    }

    pub fn write(&mut self, id: ProviderId, key: SecretKey) {
        self.keys.insert(id, key);
    }

    pub fn remove(&mut self, id: &ProviderId) -> Option<SecretKey> {
        self.keys.remove(id)
    }

    pub fn ids(&self) -> impl Iterator<Item = &ProviderId> {
        self.keys.keys()
    }

    /// Resolve a credential against this store, environment first.
    pub fn resolve(
        &self,
        credential_ref: &CredentialRef,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<SecretKey, CredentialError> {
        resolve_credential(credential_ref, self, env)
    }
}

impl Serialize for SecretStore {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut object = Map::new();
        for (id, key) in &self.keys {
            object.insert(id.0.clone(), Value::String(key.0.clone()));
        }
        Value::Object(object).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SecretStore {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let object = Map::<String, Value>::deserialize(deserializer)?;
        let mut keys = BTreeMap::new();
        for (id, value) in object {
            let id = ProviderId::new(id).map_err(de::Error::custom)?;
            let Value::String(raw) = value else {
                return Err(de::Error::custom("secret store values must be strings"));
            };
            keys.insert(id, SecretKey::new(raw));
        }
        Ok(Self { keys })
    }
}

#[derive(Debug)]
pub enum StoreError {
    HomeUnavailable,
    Io(io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HomeUnavailable => f.write_str("MindCode config home is unavailable"),
            Self::Io(error) => write!(f, "MindCode secret store I/O failed: {error}"),
            Self::Json(error) => write!(f, "MindCode secret store JSON is invalid: {error}"),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// Resolve `XDG_CONFIG_HOME/mindcode/credentials.json`, falling back to
/// `$HOME/.config/mindcode/credentials.json`. The helper takes explicit inputs
/// so callers and tests never need to mutate the process environment.
pub fn store_path_from_homes(
    xdg_config_home: Option<&Path>,
    home: Option<&Path>,
) -> Result<PathBuf, StoreError> {
    let base = match xdg_config_home.filter(|path| !path.as_os_str().is_empty()) {
        Some(path) => path.to_path_buf(),
        None => home
            .filter(|path| !path.as_os_str().is_empty())
            .map(|path| path.join(".config"))
            .ok_or(StoreError::HomeUnavailable)?,
    };
    Ok(base.join(CREDENTIALS_DIR_NAME).join(CREDENTIALS_FILE_NAME))
}

/// Resolve the current process' XDG/HOME secret store location.
pub fn default_store_path() -> Result<PathBuf, StoreError> {
    store_path_from_homes(
        std::env::var_os("XDG_CONFIG_HOME")
            .as_deref()
            .map(Path::new),
        std::env::var_os("HOME").as_deref().map(Path::new),
    )
}

/// Load a secret store. A missing file is an empty store, never an error.
pub fn load_store(path: &Path) -> Result<SecretStore, StoreError> {
    match fs::read_to_string(path) {
        Ok(input) => Ok(serde_json::from_str(&input)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(SecretStore::new()),
        Err(error) => Err(StoreError::Io(error)),
    }
}

/// Atomically persist a secret store. On Unix, both the directory and final
/// file receive restrictive owner-only modes (0700/0600).
pub fn save_store(path: &Path, store: &SecretStore) -> Result<(), StoreError> {
    let serialized = serde_json::to_vec_pretty(store)?;
    let parent = path.parent().ok_or(StoreError::HomeUnavailable)?;
    fs::create_dir_all(parent)?;
    set_directory_permissions(parent)?;

    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{CREDENTIALS_FILE_NAME}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let write_result = (|| -> Result<(), StoreError> {
        let mut file = options.open(&temporary)?;
        file.write_all(&serialized)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        set_file_permissions(&temporary)?;
        fs::rename(&temporary, path)?;
        set_file_permissions(path)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn set_file_permissions(path: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn set_directory_permissions(path: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Resolve a credential with precedence environment -> secret store -> fail
/// closed. The referenced name is consulted in the environment first; when the
/// variable is absent, the store is consulted under the same name. When both
/// are absent the call returns [`CredentialError::Missing`]; an environment
/// variable that is present but empty returns [`CredentialError::Invalid`]
/// without falling back. This function never panics.
///
/// `env` is an explicit injectable environment lookup so callers and tests
/// never need to mutate process state.
pub fn resolve_credential(
    credential_ref: &CredentialRef,
    store: &SecretStore,
    env: impl Fn(&str) -> Option<String>,
) -> Result<SecretKey, CredentialError> {
    let name = credential_ref.name();
    match env(name) {
        Some(value) if !value.trim().is_empty() => Ok(SecretKey::new(value)),
        Some(_) => Err(CredentialError::Invalid),
        None => {
            let id = ProviderId::new(name.to_owned()).map_err(|_| CredentialError::Invalid)?;
            match store.read(&id) {
                Some(secret) => Ok(secret.clone()),
                None => Err(CredentialError::Missing),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use tempfile::tempdir;

    fn env_from(map: HashMap<&'static str, &'static str>) -> impl Fn(&str) -> Option<String> {
        move |name| map.get(name).map(|value| (*value).to_owned())
    }

    #[test]
    fn protocol_serde_uses_contract_renames() {
        assert_eq!(
            serde_json::to_string(&Protocol::OpenAiCompatible).unwrap(),
            "\"openai-compatible\""
        );
        assert_eq!(
            serde_json::to_string(&Protocol::AnthropicCompatible).unwrap(),
            "\"anthropic-compatible\""
        );
        assert_eq!(
            serde_json::from_str::<Protocol>("\"openai-compatible\"").unwrap(),
            Protocol::OpenAiCompatible
        );
        assert_eq!(
            serde_json::from_str::<Protocol>("\"anthropic-compatible\"").unwrap(),
            Protocol::AnthropicCompatible
        );
        assert!(serde_json::from_str::<Protocol>("\"openai\"").is_err());
    }

    #[test]
    fn rejects_blank_and_whitespace_ids() {
        for invalid in ["", "   ", "has space", "has\ttab", "has\nnewline"] {
            assert!(matches!(
                ModelId::new(invalid.to_owned()),
                Err(ProviderConfigError::InvalidModelId)
            ));
            assert!(matches!(
                ProviderId::new(invalid.to_owned()),
                Err(ProviderConfigError::InvalidProviderId)
            ));
            assert!(serde_json::from_str::<ModelId>(&json!(invalid).to_string()).is_err());
            assert!(serde_json::from_str::<ProviderId>(&json!(invalid).to_string()).is_err());
        }
        let model = ModelId::new("gpt-5.6-luna".to_owned()).unwrap();
        assert_eq!(model.as_str(), "gpt-5.6-luna");
        let provider = ProviderId::new("custom-a".to_owned()).unwrap();
        assert_eq!(provider.as_str(), "custom-a");
        assert_eq!(model.to_string(), "gpt-5.6-luna");
        assert_eq!(provider.to_string(), "custom-a");
    }

    #[test]
    fn credential_ref_serde_shapes_are_exact() {
        let env_ref: CredentialRef = serde_json::from_str(r#"{"env":"CUSTOM_API_KEY"}"#).unwrap();
        assert_eq!(env_ref, CredentialRef::Env("CUSTOM_API_KEY".to_owned()));
        let store_ref: CredentialRef = serde_json::from_str(r#"{"store":"custom-a"}"#).unwrap();
        assert_eq!(store_ref, CredentialRef::Store("custom-a".to_owned()));
        assert_eq!(
            serde_json::to_string(&env_ref).unwrap(),
            r#"{"env":"CUSTOM_API_KEY"}"#
        );
        assert_eq!(
            serde_json::to_string(&store_ref).unwrap(),
            r#"{"store":"custom-a"}"#
        );
        for invalid in [
            r#"{}"#,
            r#"{"env":"a","store":"b"}"#,
            r#"{"other":"a"}"#,
            r#"{"env":1}"#,
        ] {
            assert!(
                serde_json::from_str::<CredentialRef>(invalid).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn provider_config_allowlist_defaults_empty_and_denies_unknown_fields() {
        let config: ProviderConfig = serde_json::from_str(
            r#"{
                "id": "custom-a",
                "name": "Custom A",
                "protocol": "openai-compatible",
                "base_url": "https://custom.example/v1",
                "credential": {"env": "CUSTOM_API_KEY"},
                "active": true
            }"#,
        )
        .unwrap();
        assert!(config.allowlist.is_empty());
        let model = ModelId::new("gpt-5.6-luna".to_owned()).unwrap();
        assert!(!config.allows_model(&model));
        assert_eq!(config.protocol, Protocol::OpenAiCompatible);
        assert!(serde_json::from_str::<ProviderConfig>(
            r#"{
                "id": "a", "name": "b", "protocol": "anthropic-compatible",
                "base_url": "x", "credential": {"env": "K"}, "active": true,
                "surprise": 1
            }"#,
        )
        .is_err());
    }

    #[test]
    fn provider_config_round_trips_allowlist_and_store_credential() {
        let input = r#"{
            "id": "p1",
            "name": "Provider One",
            "protocol": "anthropic-compatible",
            "base_url": "https://example.com/v1",
            "credential": {"store": "p1"},
            "allowlist": ["model-a", "model-b"],
            "active": true
        }"#;
        let config: ProviderConfig = serde_json::from_str(input).unwrap();
        assert_eq!(config.allowlist.len(), 2);
        assert!(config.allows_model(&ModelId::new("model-a".to_owned()).unwrap()));
        assert!(!config.allows_model(&ModelId::new("model-c".to_owned()).unwrap()));
        let reparsed: ProviderConfig =
            serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(reparsed, config);
        assert!(serde_json::from_str::<ProviderConfig>(
            &json!({
                "id": "a", "name": "b", "protocol": "openai-compatible", "base_url": "x",
                "credential": {"env": "K"}, "active": false, "allowlist": ["has space"]
            })
            .to_string()
        )
        .is_err());
    }

    #[test]
    fn secret_key_status_and_redaction_never_leak_value() {
        let raw = "super-secret-value-12345";
        let key = SecretKey::new(raw.to_owned());
        assert_eq!(key.status(), "configured");
        assert_eq!(key.mask(), REDACTED_SECRET);
        assert_eq!(redact_secret(raw), REDACTED_SECRET);
        assert!(!key.status().contains(raw));
        assert!(!key.mask().contains(raw));
        assert!(!redact_secret(raw).contains(raw));
        assert_eq!(key.as_secret(), raw);
    }

    #[test]
    fn resolution_prefers_env_then_store_then_fails_closed() {
        let mut store = SecretStore::new();
        store.write(
            ProviderId::new("E".to_owned()).unwrap(),
            SecretKey::new("stored-value".to_owned()),
        );

        let env = HashMap::from([("E", "env-value")]);
        let env_set = env_from(env);
        let resolved =
            resolve_credential(&CredentialRef::Env("E".to_owned()), &store, env_set).unwrap();
        assert_eq!(resolved.as_secret(), "env-value");

        let env_empty = env_from(HashMap::new());
        let resolved =
            resolve_credential(&CredentialRef::Env("E".to_owned()), &store, env_empty).unwrap();
        assert_eq!(resolved.as_secret(), "stored-value");

        assert_eq!(
            resolve_credential(
                &CredentialRef::Env("NEITHER".to_owned()),
                &store,
                env_from(HashMap::new()),
            )
            .err()
            .unwrap(),
            CredentialError::Missing
        );
        assert_eq!(
            resolve_credential(
                &CredentialRef::Store("NEITHER".to_owned()),
                &store,
                env_from(HashMap::new()),
            )
            .err()
            .unwrap(),
            CredentialError::Missing
        );
        assert_eq!(
            resolve_credential(
                &CredentialRef::Env("E".to_owned()),
                &store,
                env_from(HashMap::from([("E", "")])),
            )
            .err()
            .unwrap(),
            CredentialError::Invalid
        );
    }

    #[test]
    fn secret_store_json_round_trip_keeps_values_private() {
        let mut store = SecretStore::new();
        store.write(
            ProviderId::new("a".to_owned()).unwrap(),
            SecretKey::new("secret-a".to_owned()),
        );
        store.write(
            ProviderId::new("b".to_owned()).unwrap(),
            SecretKey::new("secret-b".to_owned()),
        );
        let serialized = serde_json::to_string(&store).unwrap();
        let reparsed: SecretStore = serde_json::from_str(&serialized).unwrap();
        assert_eq!(reparsed.len(), store.len());
        assert_eq!(
            reparsed
                .read(&ProviderId::new("a".to_owned()).unwrap())
                .unwrap()
                .as_secret(),
            "secret-a"
        );
    }

    #[test]
    fn store_path_resolves_xdg_then_home_config_locations() {
        assert_eq!(
            store_path_from_homes(Some(Path::new("/xdg")), Some(Path::new("/home/a"))).unwrap(),
            PathBuf::from("/xdg/mindcode/credentials.json")
        );
        assert_eq!(
            store_path_from_homes(None, Some(Path::new("/home/a"))).unwrap(),
            PathBuf::from("/home/a/.config/mindcode/credentials.json")
        );
        assert!(matches!(
            store_path_from_homes(None, None),
            Err(StoreError::HomeUnavailable)
        ));
    }

    #[test]
    fn missing_store_file_loads_as_empty_store() {
        let temp = tempdir().unwrap();
        let store = load_store(&temp.path().join("missing/credentials.json")).unwrap();
        assert!(store.is_empty());
    }
}
