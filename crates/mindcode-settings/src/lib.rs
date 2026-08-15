//! Secret-free native preferences for the Rust-first MindCode migration.
//!
//! Only non-secret, native Worker preferences are stored.  The module does no
//! network I/O, reads no credentials, and rejects credential-shaped top-level
//! JSON keys before any state reaches disk.
//!
//! Since 0.1.3 the settings file also carries the multi-provider profile
//! table.  Profiles are secret-free by construction: a profile stores only a
//! [`CredentialRef`] (an environment variable name or a secret-store key),
//! never a credential value.  Credential values live exclusively in the on-disk
//! secret store owned by `mindcode-provider`.

#![forbid(unsafe_code)]

pub use mindcode_provider::{CredentialRef, ModelId, Protocol, ProviderConfig, ProviderId};

pub mod cred_state;
pub use cred_state::{transition as transition_cred_state, CredEvent, CredState};

pub mod system_prompt;
pub use system_prompt::{
    SystemPromptError, SystemPromptOverrides, DEFAULT_LEADER_PROMPT, DEFAULT_WORKER_PROMPT,
};

use mindcode_vexzy::WorkerEffort;
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    fmt, fs,
    fs::OpenOptions,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub const SETTINGS_FILE_NAME: &str = "settings.json";
const SETTINGS_DIR_NAME: &str = "mindcode";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Provider id of the built-in VEXZY profile.  Any profile with this id is
/// resolved catalog-driven by [`eligible_worker_models`]; it is a plain
/// profile in every other respect (editable, removable, never special-cased
/// in storage).
pub const BUILTIN_VEXZY_PROVIDER_ID: &str = "vexzy";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeSettings {
    pub global_worker_model: Option<String>,
    pub worker_effort_lock: Option<WorkerEffort>,
    /// Maximum model/tool iterations for one Worker run (§5.1.2).
    pub worker_max_iterations: usize,
    /// Conversation-memory budget override in estimated tokens (§11.3).  When
    /// `None` the caller falls back to the 200K base.  Secret-free.
    pub context_token_budget: Option<usize>,
    /// Custom `/colors` overrides (§11.6): role label → `#rrggbb`.  Metadata
    /// only — never a credential, never a secret.
    pub color_overrides: Option<BTreeMap<String, String>>,
    /// Editable Leader/Worker system prompts (§13.3).  Secret-free metadata;
    /// `None` fields fall back to the built-in defaults.
    pub system_prompt: SystemPromptOverrides,
    /// The multi-provider profile table (0.1.3).  Secret-free: every profile
    /// references its credential by name instead of carrying a value.
    pub providers: Vec<ProviderConfig>,
    /// The id of the currently active profile.  Every mutator on this type
    /// keeps it consistent with the per-profile `active` flags, and loading
    /// normalizes both representations so the invariant survives hand-edited
    /// files.
    pub active_provider: Option<ProviderId>,
    /// Unknown non-secret keys survive load/save untouched for forward
    /// compatibility with the legacy state migration.
    pub unknown: BTreeMap<String, Value>,
}

impl Default for NativeSettings {
    fn default() -> Self {
        Self {
            global_worker_model: None,
            worker_effort_lock: None,
            worker_max_iterations: 52,
            context_token_budget: None,
            color_overrides: None,
            system_prompt: SystemPromptOverrides::default(),
            providers: Vec::new(),
            active_provider: None,
            unknown: BTreeMap::new(),
        }
    }
}

#[derive(Debug)]
pub enum SettingsError {
    HomeUnavailable,
    Io(io::Error),
    Json(serde_json::Error),
    RootMustBeObject,
    InvalidWorkerModel,
    InvalidWorkerEffortLock,
    InvalidWorkerMaxIterations,
    InvalidContextBudget,
    InvalidColorOverrides,
    InvalidSystemPrompt,
    InvalidProviders,
    InvalidActiveProvider,
    ProviderNotFound(String),
    DuplicateProviderId(String),
    CredentialKey(String),
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HomeUnavailable => f.write_str("MindCode config home is unavailable"),
            Self::Io(error) => write!(f, "MindCode settings I/O failed: {error}"),
            Self::Json(error) => write!(f, "MindCode settings JSON is invalid: {error}"),
            Self::RootMustBeObject => f.write_str("MindCode settings root must be a JSON object"),
            Self::InvalidWorkerModel => {
                f.write_str("global_worker_model must be a non-empty string or null")
            }
            Self::InvalidWorkerEffortLock => f.write_str(
                "worker_effort_lock must be null or one of none, low, medium, high, xhigh, max",
            ),
            Self::InvalidWorkerMaxIterations => {
                f.write_str("worker_max_iterations must be an integer in 1..=200")
            }
            Self::InvalidContextBudget => {
                f.write_str("context_token_budget must be a positive integer or null")
            }
            Self::InvalidColorOverrides => {
                f.write_str("color_overrides must be an object of role → #rrggbb")
            }
            Self::InvalidSystemPrompt => {
                f.write_str("system_prompt must be an object with optional leader/worker strings")
            }
            Self::InvalidProviders => {
                f.write_str("providers must be an array of provider profiles")
            }
            Self::InvalidActiveProvider => {
                f.write_str("active_provider must be a provider id string or null")
            }
            Self::ProviderNotFound(id) => write!(f, "provider profile not found ({id})"),
            Self::DuplicateProviderId(id) => write!(f, "duplicate provider id ({id})"),
            // Do not include the associated value; it may have been a secret.
            Self::CredentialKey(key) => {
                write!(f, "credentials are not allowed in native settings ({key})")
            }
        }
    }
}

impl std::error::Error for SettingsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for SettingsError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for SettingsError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// Resolve `XDG_CONFIG_HOME/mindcode/settings.json`, falling back to
/// `$HOME/.config/mindcode/settings.json`. The helper takes explicit inputs so
/// callers and tests never need to mutate the process environment.
pub fn settings_path_from_homes(
    xdg_config_home: Option<&Path>,
    home: Option<&Path>,
) -> Result<PathBuf, SettingsError> {
    let base = match xdg_config_home.filter(|path| !path.as_os_str().is_empty()) {
        Some(path) => path.to_path_buf(),
        None => home
            .filter(|path| !path.as_os_str().is_empty())
            .map(|path| path.join(".config"))
            .ok_or(SettingsError::HomeUnavailable)?,
    };
    Ok(base.join(SETTINGS_DIR_NAME).join(SETTINGS_FILE_NAME))
}

/// Resolve the current process' XDG/HOME settings location without reading or
/// interpreting any credential variable.
pub fn default_settings_path() -> Result<PathBuf, SettingsError> {
    settings_path_from_homes(
        std::env::var_os("XDG_CONFIG_HOME")
            .as_deref()
            .map(Path::new),
        std::env::var_os("HOME").as_deref().map(Path::new),
    )
}

pub fn load_settings(path: &Path) -> Result<NativeSettings, SettingsError> {
    match fs::read_to_string(path) {
        Ok(input) => parse_settings(&input),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(first_run_settings()),
        Err(error) => Err(SettingsError::Io(error)),
    }
}

/// First-run state: the built-in VEXZY profile is present and active.  This
/// is returned only when no settings file exists yet.  Once a file is written
/// — even an empty profile table after VEXZY is removed — the file is respected
/// and VEXZY is never resurrected.
pub fn first_run_settings() -> NativeSettings {
    let mut settings = NativeSettings::default();
    let vexzy = builtin_vexzy_provider();
    settings
        .add_provider(vexzy)
        .expect("first-run settings start empty, so the built-in id cannot collide");
    settings
        .set_active_provider(
            &ProviderId::new(BUILTIN_VEXZY_PROVIDER_ID.to_owned())
                .expect("the built-in vexzy provider id is valid"),
        )
        .expect("the built-in vexzy provider was just added");
    settings
}

pub fn parse_settings(input: &str) -> Result<NativeSettings, SettingsError> {
    let value: Value = serde_json::from_str(input)?;
    settings_from_value(value)
}

pub fn settings_from_value(value: Value) -> Result<NativeSettings, SettingsError> {
    let object = value.as_object().ok_or(SettingsError::RootMustBeObject)?;
    reject_credential_keys(object)?;

    let global_worker_model = match object.get("global_worker_model") {
        None | Some(Value::Null) => None,
        Some(Value::String(model)) if !model.trim().is_empty() && model == model.trim() => {
            Some(model.clone())
        }
        Some(_) => return Err(SettingsError::InvalidWorkerModel),
    };

    let worker_effort_lock = match object.get("worker_effort_lock") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => value
            .parse::<WorkerEffort>()
            .map(Some)
            .map_err(|_| SettingsError::InvalidWorkerEffortLock)?,
        Some(_) => return Err(SettingsError::InvalidWorkerEffortLock),
    };

    let worker_max_iterations = match object.get("worker_max_iterations") {
        None | Some(Value::Null) => 52,
        Some(Value::Number(value)) => value
            .as_u64()
            .filter(|value| (1..=200).contains(value))
            .map(|value| value as usize)
            .ok_or(SettingsError::InvalidWorkerMaxIterations)?,
        Some(_) => return Err(SettingsError::InvalidWorkerMaxIterations),
    };

    let context_token_budget = match object.get("context_token_budget") {
        None | Some(Value::Null) => None,
        Some(Value::Number(value)) => Some(
            value
                .as_u64()
                .filter(|value| *value > 0)
                .ok_or(SettingsError::InvalidContextBudget)? as usize,
        ),
        Some(_) => return Err(SettingsError::InvalidContextBudget),
    };

    let color_overrides = match object.get("color_overrides") {
        None | Some(Value::Null) => None,
        Some(Value::Object(entries)) => {
            let mut overrides = BTreeMap::new();
            for (role, value) in entries {
                let Some(hex) = value.as_str() else {
                    return Err(SettingsError::InvalidColorOverrides);
                };
                if !is_valid_hex_color(hex) {
                    return Err(SettingsError::InvalidColorOverrides);
                }
                overrides.insert(role.clone(), hex.to_ascii_lowercase());
            }
            Some(overrides)
        }
        Some(_) => return Err(SettingsError::InvalidColorOverrides),
    };

    let system_prompt = match object.get("system_prompt") {
        None | Some(Value::Null) => SystemPromptOverrides::default(),
        // Reject non-object shapes explicitly: serde derives deserialize JSON
        // arrays positionally into struct fields, which we do not want.
        Some(system_prompt_value @ Value::Object(_)) => {
            let overrides: SystemPromptOverrides =
                serde_json::from_value(system_prompt_value.clone())
                    .map_err(|_| SettingsError::InvalidSystemPrompt)?;
            overrides
                .validate()
                .map_err(|_| SettingsError::InvalidSystemPrompt)?;
            overrides
        }
        Some(_) => return Err(SettingsError::InvalidSystemPrompt),
    };

    let active_provider = match object.get("active_provider") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => {
            Some(ProviderId::new(value.clone()).map_err(|_| SettingsError::InvalidActiveProvider)?)
        }
        Some(_) => return Err(SettingsError::InvalidActiveProvider),
    };

    let providers = match object.get("providers") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut providers = Vec::with_capacity(items.len());
            for item in items {
                providers.push(
                    serde_json::from_value(item.clone())
                        .map_err(|_| SettingsError::InvalidProviders)?,
                );
            }
            providers
        }
        Some(_) => return Err(SettingsError::InvalidProviders),
    };

    let (providers, active_provider) = normalize_provider_state(providers, active_provider);

    let unknown = object
        .iter()
        .filter(|(key, _)| !is_known_settings_key(key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();

    Ok(NativeSettings {
        global_worker_model,
        worker_effort_lock,
        worker_max_iterations,
        context_token_budget,
        color_overrides,
        system_prompt,
        providers,
        active_provider,
        unknown,
    })
}

pub fn settings_to_value(settings: &NativeSettings) -> Result<Value, SettingsError> {
    let mut object = Map::new();
    if let Some(model) = &settings.global_worker_model {
        if model.trim().is_empty() || model != model.trim() {
            return Err(SettingsError::InvalidWorkerModel);
        }
        object.insert(
            "global_worker_model".to_owned(),
            Value::String(model.clone()),
        );
    } else {
        object.insert("global_worker_model".to_owned(), Value::Null);
    }
    object.insert(
        "worker_effort_lock".to_owned(),
        settings
            .worker_effort_lock
            .map(|effort| Value::String(effort.to_string()))
            .unwrap_or(Value::Null),
    );
    object.insert(
        "worker_max_iterations".to_owned(),
        Value::from(settings.worker_max_iterations),
    );
    object.insert(
        "context_token_budget".to_owned(),
        settings
            .context_token_budget
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    object.insert(
        "color_overrides".to_owned(),
        settings
            .color_overrides
            .as_ref()
            .map(|overrides| serde_json::to_value(overrides).unwrap_or(Value::Null))
            .unwrap_or(Value::Null),
    );
    if settings.system_prompt.validate().is_err() {
        return Err(SettingsError::InvalidSystemPrompt);
    }
    object.insert(
        "system_prompt".to_owned(),
        serde_json::to_value(&settings.system_prompt).map_err(SettingsError::Json)?,
    );
    object.insert(
        "active_provider".to_owned(),
        settings
            .active_provider
            .as_ref()
            .map(|id| Value::String(id.to_string()))
            .unwrap_or(Value::Null),
    );
    object.insert(
        "providers".to_owned(),
        serde_json::to_value(&settings.providers).map_err(SettingsError::Json)?,
    );
    for (key, value) in &settings.unknown {
        if is_known_settings_key(key) {
            continue;
        }
        if is_credential_key(key) {
            return Err(SettingsError::CredentialKey(key.clone()));
        }
        object.insert(key.clone(), value.clone());
    }
    reject_credential_keys(&object)?;
    Ok(Value::Object(object))
}

impl NativeSettings {
    /// Append a profile.  A duplicate id is rejected, and the new profile
    /// never becomes active: activation happens only through
    /// [`Self::set_active_provider`].
    pub fn add_provider(&mut self, mut provider: ProviderConfig) -> Result<(), SettingsError> {
        if self
            .providers
            .iter()
            .any(|existing| existing.id == provider.id)
        {
            return Err(SettingsError::DuplicateProviderId(provider.id.to_string()));
        }
        provider.active = false;
        self.providers.push(provider);
        Ok(())
    }

    /// Replace the profile with the same id as `provider`.  The id cannot be
    /// changed by editing, and the profile's active state is preserved
    /// regardless of the value supplied in `provider.active`.
    pub fn edit_provider(&mut self, provider: ProviderConfig) -> Result<(), SettingsError> {
        let index = self
            .providers
            .iter()
            .position(|existing| existing.id == provider.id)
            .ok_or_else(|| SettingsError::ProviderNotFound(provider.id.to_string()))?;
        let mut edited = provider;
        edited.active = self.providers[index].active;
        self.providers[index] = edited;
        Ok(())
    }

    /// Remove a profile by id.  Removing the active profile clears
    /// `active_provider`; no other profile is auto-activated.
    pub fn remove_provider(&mut self, id: &ProviderId) -> Result<(), SettingsError> {
        let index = self
            .providers
            .iter()
            .position(|existing| &existing.id == id)
            .ok_or_else(|| SettingsError::ProviderNotFound(id.to_string()))?;
        self.providers.remove(index);
        if self.active_provider.as_ref() == Some(id) {
            self.active_provider = None;
        }
        Ok(())
    }

    /// Activate exactly one profile: its `active` flag is set, every other
    /// profile's flag is cleared, and `active_provider` is updated to match.
    pub fn set_active_provider(&mut self, id: &ProviderId) -> Result<(), SettingsError> {
        let index = self
            .providers
            .iter()
            .position(|existing| &existing.id == id)
            .ok_or_else(|| SettingsError::ProviderNotFound(id.to_string()))?;
        for provider in &mut self.providers {
            provider.active = false;
        }
        self.providers[index].active = true;
        self.active_provider = Some(id.clone());
        Ok(())
    }

    /// Replace the Worker model allowlist of one profile.  An empty allowlist
    /// makes the profile eligible for no model (fail closed).
    pub fn set_allowlist(
        &mut self,
        id: &ProviderId,
        allowlist: Vec<ModelId>,
    ) -> Result<(), SettingsError> {
        let provider = self
            .providers
            .iter_mut()
            .find(|existing| &existing.id == id)
            .ok_or_else(|| SettingsError::ProviderNotFound(id.to_string()))?;
        provider.allowlist = allowlist;
        Ok(())
    }

    pub fn providers(&self) -> &[ProviderConfig] {
        &self.providers
    }

    pub fn provider(&self, id: &ProviderId) -> Option<&ProviderConfig> {
        self.providers.iter().find(|provider| &provider.id == id)
    }

    pub fn active_provider_config(&self) -> Option<&ProviderConfig> {
        let id = self.active_provider.as_ref()?;
        self.provider(id)
    }

    /// Worker-model eligibility under the currently active profile.  When no
    /// profile is active, no model is eligible.
    pub fn eligible_worker_models(&self, vexzy_catalog_json: &str) -> Vec<ModelId> {
        match self.active_provider_config() {
            Some(provider) => eligible_worker_models(provider, vexzy_catalog_json),
            None => Vec::new(),
        }
    }
}

/// The built-in VEXZY profile per the 0.1.3 contract.  It is a plain profile
/// like any other: editable, removable, and never special-cased in storage.
/// Only the eligibility resolver treats the `vexzy` id specially (catalog
/// driven).
pub fn builtin_vexzy_provider() -> ProviderConfig {
    ProviderConfig {
        id: ProviderId::new(BUILTIN_VEXZY_PROVIDER_ID.to_owned())
            .expect("the built-in vexzy provider id is valid"),
        name: "VEXZY".to_owned(),
        protocol: Protocol::OpenAiCompatible,
        base_url: mindcode_vexzy::VEXZY_OPENAI_BASE_URL.to_owned(),
        credential: CredentialRef::Env(mindcode_vexzy::VEXZY_API_KEY_ENV.to_owned()),
        allowlist: Vec::new(),
        active: false,
    }
}

/// Resolve the Worker-eligible model ids under the supplied provider.
///
/// - A profile with id [`BUILTIN_VEXZY_PROVIDER_ID`] is catalog-driven:
///   `vexzy_catalog_json` is parsed through
///   `mindcode_vexzy::parse_vexzy_model_catalog` and filtered by the VEXZY
///   eligibility rule (available, tools-capable, at least one supported Worker
///   effort).  A malformed catalog fails closed to an empty selection.
/// - Every custom profile is allowlist-driven: exactly the profile's
///   allowlist is returned, and an empty allowlist selects no model (fail
///   closed).
pub fn eligible_worker_models(
    active_provider: &ProviderConfig,
    vexzy_catalog_json: &str,
) -> Vec<ModelId> {
    if active_provider.id.as_str() != BUILTIN_VEXZY_PROVIDER_ID {
        return active_provider.allowlist.clone();
    }
    let catalog = match mindcode_vexzy::parse_vexzy_model_catalog(vexzy_catalog_json) {
        Ok(catalog) => catalog,
        Err(_) => return Vec::new(),
    };
    mindcode_vexzy::eligible_worker_models(&catalog)
        .into_iter()
        .filter_map(|model| ModelId::new(model.id.clone()).ok())
        .collect()
}

/// Enforce the provider invariants on load: at most one profile is active,
/// and `active_provider` references an existing profile.  `active_provider`
/// is the source of truth; the per-profile `active` flags are derived from
/// it, so a dangling reference and any `active` flags without a matching
/// reference are dropped.
fn normalize_provider_state(
    providers: Vec<ProviderConfig>,
    active_provider: Option<ProviderId>,
) -> (Vec<ProviderConfig>, Option<ProviderId>) {
    let active = active_provider.filter(|id| providers.iter().any(|p| &p.id == id));
    let providers = providers
        .into_iter()
        .map(|mut provider| {
            provider.active = matches!(active.as_ref(), Some(id) if &provider.id == id);
            provider
        })
        .collect();
    (providers, active)
}

fn is_known_settings_key(key: &str) -> bool {
    matches!(
        key,
        "global_worker_model"
            | "worker_effort_lock"
            | "worker_max_iterations"
            | "context_token_budget"
            | "color_overrides"
            | "system_prompt"
            | "providers"
            | "active_provider"
    )
}

/// A `#rrggbb` hex color (case-insensitive).  Only six hex digits are accepted
/// so a credential value can never masquerade as a color.
fn is_valid_hex_color(hex: &str) -> bool {
    let value = hex.trim().trim_start_matches('#');
    value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Atomically replace one settings file after validation.  On Unix, both the
/// directory and final file receive restrictive owner-only modes.
pub fn save_settings(path: &Path, settings: &NativeSettings) -> Result<(), SettingsError> {
    let value = settings_to_value(settings)?;
    let serialized = serde_json::to_vec_pretty(&value)?;
    let parent = path.parent().ok_or(SettingsError::HomeUnavailable)?;
    fs::create_dir_all(parent)?;
    set_directory_permissions(parent)?;

    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{SETTINGS_FILE_NAME}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let write_result = (|| -> Result<(), SettingsError> {
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

fn reject_credential_keys(object: &Map<String, Value>) -> Result<(), SettingsError> {
    for key in object.keys() {
        if is_credential_key(key) {
            return Err(SettingsError::CredentialKey(key.clone()));
        }
    }
    Ok(())
}

fn is_credential_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "vexzy_api_key" | "apikey" | "api_key" | "token" | "secret" | "password"
    )
}

fn set_file_permissions(path: &Path) -> Result<(), SettingsError> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn set_directory_permissions(path: &Path) -> Result<(), SettingsError> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn resolves_xdg_then_home_config_locations() {
        assert_eq!(
            settings_path_from_homes(Some(Path::new("/xdg")), Some(Path::new("/home/a"))).unwrap(),
            PathBuf::from("/xdg/mindcode/settings.json")
        );
        assert_eq!(
            settings_path_from_homes(None, Some(Path::new("/home/a"))).unwrap(),
            PathBuf::from("/home/a/.config/mindcode/settings.json")
        );
        assert!(matches!(
            settings_path_from_homes(None, None),
            Err(SettingsError::HomeUnavailable)
        ));
    }

    #[test]
    fn valid_settings_round_trip_and_preserve_unknown_keys() {
        let input = r#"{"global_worker_model":"gpt-5.6-luna","worker_effort_lock":"max","ui_density":"dense","nested":{"future":true}}"#;
        let settings = parse_settings(input).unwrap();
        assert_eq!(
            settings.global_worker_model.as_deref(),
            Some("gpt-5.6-luna")
        );
        assert_eq!(settings.worker_effort_lock, Some(WorkerEffort::Max));
        assert_eq!(settings.unknown["ui_density"], "dense");
        let reparsed = settings_from_value(settings_to_value(&settings).unwrap()).unwrap();
        assert_eq!(reparsed, settings);
    }

    #[test]
    fn color_overrides_parse_round_trip_and_reject_non_hex() {
        let settings =
            parse_settings(r##"{"color_overrides":{"accent":"#FF4FA3","background":"#0b0b0d"}}"##)
                .unwrap();
        let overrides = settings.color_overrides.clone().unwrap();
        assert_eq!(overrides["accent"], "#ff4fa3");
        assert_eq!(overrides["background"], "#0b0b0d");
        let reparsed = settings_from_value(settings_to_value(&settings).unwrap()).unwrap();
        assert_eq!(reparsed.color_overrides, settings.color_overrides);

        let unset = parse_settings(r#"{"color_overrides":null}"#).unwrap();

        assert!(matches!(
            parse_settings(r##"{"color_overrides":{"accent":"sk-1234"}}"##),
            Err(SettingsError::InvalidColorOverrides)
        ));
        assert!(matches!(
            parse_settings(r##"{"color_overrides":{"accent":"#fff"}}"##),
            Err(SettingsError::InvalidColorOverrides)
        ));
        assert!(matches!(
            parse_settings(r##"{"color_overrides":["#ff4fa3"]}"##),
            Err(SettingsError::InvalidColorOverrides)
        ));
        assert_eq!(unset.color_overrides, None);
    }

    #[test]
    fn system_prompt_round_trips_and_rejects_invalid() {
        let settings =
            parse_settings(r##"{"system_prompt":{"leader":"Be brief","worker":"Do the task"}}"##)
                .unwrap();
        assert_eq!(settings.system_prompt.leader.as_deref(), Some("Be brief"));
        assert_eq!(settings.system_prompt.worker_prompt(), "Do the task");
        let reparsed = settings_from_value(settings_to_value(&settings).unwrap()).unwrap();
        assert_eq!(reparsed.system_prompt, settings.system_prompt);

        // Unset → defaults.
        let unset = parse_settings(r#"{"system_prompt":null}"#).unwrap();
        assert_eq!(unset.system_prompt, SystemPromptOverrides::default());

        // Non-object shapes and unknown fields are rejected at the settings
        // layer; oversized/control-character rejection is covered in the
        // system_prompt.rs unit tests.
        assert!(matches!(
            parse_settings(r#"{"system_prompt":["x"]}"#),
            Err(SettingsError::InvalidSystemPrompt)
        ));
        assert!(matches!(
            parse_settings(r#"{"system_prompt":{"nope":1}}"#),
            Err(SettingsError::InvalidSystemPrompt)
        ));
    }

    #[test]
    fn rejects_malformed_and_invalid_known_values() {
        assert!(matches!(parse_settings("{"), Err(SettingsError::Json(_))));
        assert!(matches!(
            parse_settings("[]"),
            Err(SettingsError::RootMustBeObject)
        ));
        assert!(matches!(
            parse_settings(r#"{"global_worker_model":" "}"#),
            Err(SettingsError::InvalidWorkerModel)
        ));
        assert!(matches!(
            parse_settings(r#"{"worker_effort_lock":"auto"}"#),
            Err(SettingsError::InvalidWorkerEffortLock)
        ));
    }

    #[test]
    fn context_token_budget_parse_and_reject_invalid() {
        let settings = parse_settings(r#"{"context_token_budget":300000}"#).unwrap();
        assert_eq!(settings.context_token_budget, Some(300_000));
        let reparsed = settings_from_value(settings_to_value(&settings).unwrap()).unwrap();
        assert_eq!(reparsed.context_token_budget, Some(300_000));

        let unset = parse_settings(r#"{"context_token_budget":null}"#).unwrap();
        assert_eq!(unset.context_token_budget, None);

        assert!(matches!(
            parse_settings(r#"{"context_token_budget":0}"#),
            Err(SettingsError::InvalidContextBudget)
        ));
        assert!(matches!(
            parse_settings(r#"{"context_token_budget":"big"}"#),
            Err(SettingsError::InvalidContextBudget)
        ));
    }

    #[test]
    fn worker_max_iterations_defaults_and_validates_bounds() {
        assert_eq!(parse_settings("{}").unwrap().worker_max_iterations, 52);
        let settings = parse_settings(r#"{"worker_max_iterations":120}"#).unwrap();
        assert_eq!(settings.worker_max_iterations, 120);
        let reparsed = settings_from_value(settings_to_value(&settings).unwrap()).unwrap();
        assert_eq!(reparsed.worker_max_iterations, 120);
        for value in ["0", "201", "-1", "\"many\""] {
            assert!(matches!(
                parse_settings(&format!(r#"{{"worker_max_iterations":{value}}}"#)),
                Err(SettingsError::InvalidWorkerMaxIterations)
            ));
        }
    }

    #[test]
    fn rejects_credential_like_top_level_keys() {
        for key in [
            "VEXZY_API_KEY",
            "apiKey",
            "api_key",
            "token",
            "secret",
            "password",
        ] {
            let input = format!(r#"{{"{key}":"forge-secret"}}"#);
            assert!(matches!(
                parse_settings(&input),
                Err(SettingsError::CredentialKey(_))
            ));
        }
    }

    #[test]
    fn save_is_atomic_restrictive_and_loadable() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("config/mindcode/settings.json");
        let settings = NativeSettings {
            global_worker_model: Some("gpt-5.6-luna".to_owned()),
            worker_effort_lock: Some(WorkerEffort::Medium),
            unknown: BTreeMap::from([("ui_density".to_owned(), Value::String("dense".to_owned()))]),
            ..Default::default()
        };
        save_settings(&path, &settings).unwrap();
        assert_eq!(load_settings(&path).unwrap(), settings);
        assert!(!temp
            .path()
            .join("config/mindcode/.settings.json.0.0.tmp")
            .exists());
        #[cfg(unix)]
        {
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }
}

#[cfg(test)]
mod provider_tests {
    use super::*;
    use mindcode_provider::{save_store, SecretKey, SecretStore};
    use tempfile::tempdir;

    fn profile(id: &str) -> ProviderConfig {
        ProviderConfig {
            id: ProviderId::new(id.to_owned()).unwrap(),
            name: format!("Provider {id}"),
            protocol: Protocol::OpenAiCompatible,
            base_url: format!("https://{id}.example.com/v1"),
            credential: CredentialRef::Env(format!("KEY_{id}")),
            allowlist: Vec::new(),
            active: false,
        }
    }

    #[test]
    fn builtin_vexzy_profile_matches_contract_and_is_not_special_cased() {
        let vexzy = builtin_vexzy_provider();
        assert_eq!(vexzy.id.as_str(), BUILTIN_VEXZY_PROVIDER_ID);
        assert_eq!(vexzy.name, "VEXZY");
        assert_eq!(vexzy.protocol, Protocol::OpenAiCompatible);
        assert_eq!(vexzy.base_url, mindcode_vexzy::VEXZY_OPENAI_BASE_URL);
        assert_eq!(vexzy.base_url, "https://api.echogate.one/v1");
        assert_eq!(
            vexzy.credential,
            CredentialRef::Env(mindcode_vexzy::VEXZY_API_KEY_ENV.to_owned())
        );
        assert!(vexzy.allowlist.is_empty());
        assert!(!vexzy.active);

        let temp = tempdir().unwrap();
        let path = temp.path().join("config/mindcode/settings.json");
        let vexzy_id = ProviderId::new("vexzy".to_owned()).unwrap();
        let mut settings = NativeSettings::default();
        settings.add_provider(vexzy.clone()).unwrap();
        settings.set_active_provider(&vexzy_id).unwrap();
        settings
            .set_allowlist(
                &vexzy_id,
                vec![ModelId::new("gpt-5.6-luna".to_owned()).unwrap()],
            )
            .unwrap();
        save_settings(&path, &settings).unwrap();
        let loaded = load_settings(&path).unwrap();
        assert_eq!(loaded, settings);
        let mut removable = loaded;
        removable.remove_provider(&vexzy_id).unwrap();
        assert!(removable.providers().is_empty());
        assert_eq!(removable.active_provider, None);
    }

    #[test]
    fn load_missing_file_seeds_builtin_vexzy_active() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("config/mindcode/settings.json");
        let settings = load_settings(&path).unwrap();
        assert_eq!(settings.providers().len(), 1);
        let vexzy = settings
            .provider(&ProviderId::new(BUILTIN_VEXZY_PROVIDER_ID.to_owned()).unwrap())
            .unwrap();
        assert_eq!(vexzy.name, "VEXZY");
        assert!(vexzy.active);
        assert_eq!(
            settings.active_provider.as_ref().map(ProviderId::as_str),
            Some(BUILTIN_VEXZY_PROVIDER_ID)
        );
        // Reading never writes: first-run seeding is in-memory until the user
        // actually saves a change.
        assert!(!path.exists());
    }

    #[test]
    fn removed_vexzy_is_not_resurrected_on_reload() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("config/mindcode/settings.json");
        let vexzy_id = ProviderId::new(BUILTIN_VEXZY_PROVIDER_ID.to_owned()).unwrap();

        let mut settings = first_run_settings();
        settings.remove_provider(&vexzy_id).unwrap();
        save_settings(&path, &settings).unwrap();

        let loaded = load_settings(&path).unwrap();
        assert!(loaded.providers().is_empty());
        assert_eq!(loaded.active_provider, None);
    }

    #[test]
    fn provider_crud_round_trips_through_save_and_load() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("config/mindcode/settings.json");
        let vexzy_id = ProviderId::new("vexzy".to_owned()).unwrap();
        let custom_id = ProviderId::new("custom-a".to_owned()).unwrap();

        let mut settings = NativeSettings::default();
        settings.add_provider(builtin_vexzy_provider()).unwrap();
        let mut custom = profile("custom-a");
        custom.credential = CredentialRef::Store("custom-a".to_owned());
        custom.allowlist = vec![
            ModelId::new("model-a".to_owned()).unwrap(),
            ModelId::new("model-b".to_owned()).unwrap(),
        ];
        settings.add_provider(custom).unwrap();
        assert!(matches!(
            settings.add_provider(builtin_vexzy_provider()),
            Err(SettingsError::DuplicateProviderId(_))
        ));
        settings
            .set_allowlist(
                &vexzy_id,
                vec![ModelId::new("gpt-5.6-luna".to_owned()).unwrap()],
            )
            .unwrap();
        settings.set_active_provider(&custom_id).unwrap();
        save_settings(&path, &settings).unwrap();
        let loaded = load_settings(&path).unwrap();
        assert_eq!(loaded, settings);

        let mut cleared = loaded;
        cleared.remove_provider(&custom_id).unwrap();
        assert_eq!(cleared.active_provider, None);
        assert!(cleared.providers().iter().all(|p| !p.active));
        save_settings(&path, &cleared).unwrap();
        assert_eq!(load_settings(&path).unwrap(), cleared);
    }

    #[test]
    fn active_provider_invariants_on_crud() {
        let a = ProviderId::new("a".to_owned()).unwrap();
        let b = ProviderId::new("b".to_owned()).unwrap();
        let mut settings = NativeSettings::default();
        settings.add_provider(profile("a")).unwrap();
        settings.add_provider(profile("b")).unwrap();
        assert_eq!(settings.active_provider, None);
        assert!(settings.providers().iter().all(|p| !p.active));

        settings.set_active_provider(&a).unwrap();
        assert_eq!(settings.active_provider.as_ref(), Some(&a));
        assert!(settings.provider(&a).unwrap().active);
        assert!(!settings.provider(&b).unwrap().active);

        settings.set_active_provider(&b).unwrap();
        assert_eq!(settings.active_provider.as_ref(), Some(&b));
        assert!(!settings.provider(&a).unwrap().active);
        assert!(settings.provider(&b).unwrap().active);
        assert_eq!(settings.providers().iter().filter(|p| p.active).count(), 1);

        let mut edited = profile("b");
        edited.name = "B edited".to_owned();
        edited.active = false;
        settings.edit_provider(edited).unwrap();
        assert!(settings.provider(&b).unwrap().active);
        assert_eq!(settings.provider(&b).unwrap().name, "B edited");

        settings.remove_provider(&b).unwrap();
        assert_eq!(settings.active_provider, None);
        assert!(settings.providers().iter().all(|p| !p.active));

        assert!(matches!(
            settings.remove_provider(&b),
            Err(SettingsError::ProviderNotFound(_))
        ));
        assert!(matches!(
            settings.set_active_provider(&b),
            Err(SettingsError::ProviderNotFound(_))
        ));
        assert!(matches!(
            settings.set_allowlist(&b, Vec::new()),
            Err(SettingsError::ProviderNotFound(_))
        ));
        assert!(matches!(
            settings.edit_provider(profile("b")),
            Err(SettingsError::ProviderNotFound(_))
        ));
    }

    #[test]
    fn settings_never_serialize_credential_values() {
        let temp = tempdir().unwrap();
        let dir = temp.path();
        let settings_path = dir.join("config/mindcode/settings.json");
        let store_path = dir.join("config/mindcode/credentials.json");

        let mut store = SecretStore::new();
        store.write(
            ProviderId::new("custom-a".to_owned()).unwrap(),
            SecretKey::new("provider-secret-value".to_owned()),
        );
        save_store(&store_path, &store).unwrap();

        let mut settings = NativeSettings::default();
        let mut custom = profile("custom-a");
        custom.credential = CredentialRef::Store("custom-a".to_owned());
        settings.add_provider(custom).unwrap();
        settings
            .set_active_provider(&ProviderId::new("custom-a".to_owned()).unwrap())
            .unwrap();
        settings.add_provider(builtin_vexzy_provider()).unwrap();
        save_settings(&settings_path, &settings).unwrap();

        let raw = fs::read_to_string(&settings_path).unwrap();
        assert!(!raw.contains("provider-secret-value"));
        assert!(raw.contains("custom-a"));
        assert!(raw.contains("VEXZY_API_KEY"));
        assert!(fs::read_to_string(&store_path)
            .unwrap()
            .contains("provider-secret-value"));
        assert_eq!(load_settings(&settings_path).unwrap(), settings);
    }

    #[test]
    fn eligibility_builtin_vexzy_is_catalog_driven() {
        let catalog = r#"{
            "object": "list",
            "data": [
                {"id": "gpt-5.6-luna", "available": true, "capabilities": {"tools": true, "reasoning": true, "vision": false}, "supported_reasoning_efforts": ["none", "max"]},
                {"id": "stale-model", "available": false, "capabilities": {"tools": true, "reasoning": true}, "supported_reasoning_efforts": ["none"]},
                {"id": "no-tools-model", "available": true, "capabilities": {"tools": false, "reasoning": true}, "supported_reasoning_efforts": ["none"]},
                {"id": "no-effort-model", "available": true, "capabilities": {"tools": true, "reasoning": true}, "supported_reasoning_efforts": []},
                {"id": "odd id", "available": true, "capabilities": {"tools": true, "reasoning": true}, "supported_reasoning_efforts": ["none"]}
            ]
        }"#;
        let vexzy = builtin_vexzy_provider();
        let eligible = eligible_worker_models(&vexzy, catalog);
        let ids: Vec<_> = eligible.iter().map(ModelId::as_str).collect();
        assert_eq!(ids, ["gpt-5.6-luna"]);
        assert_eq!(
            eligible_worker_models(&vexzy, "{\"object\":\"list\",\"data\":[]}"),
            Vec::<ModelId>::new()
        );
    }

    #[test]
    fn eligibility_custom_provider_is_allowlist_driven_and_fails_closed() {
        let mut custom = profile("custom-a");
        custom.allowlist = vec![
            ModelId::new("model-a".to_owned()).unwrap(),
            ModelId::new("model-b".to_owned()).unwrap(),
        ];
        let eligible = eligible_worker_models(&custom, "{");
        let ids: Vec<_> = eligible.iter().map(ModelId::as_str).collect();
        assert_eq!(ids, ["model-a", "model-b"]);

        let empty = profile("custom-empty");
        assert_eq!(
            eligible_worker_models(&empty, "{\"object\":\"list\",\"data\":[]}"),
            Vec::<ModelId>::new()
        );
        let empty_ids: Vec<_> = empty.allowlist.iter().map(ModelId::as_str).collect();
        assert!(empty_ids.is_empty());
    }

    #[test]
    fn eligibility_malformed_catalog_fails_closed_for_vexzy() {
        let vexzy = builtin_vexzy_provider();
        for malformed in ["{", r#"{"object":"model","data":[]}"#] {
            assert_eq!(
                eligible_worker_models(&vexzy, malformed),
                Vec::<ModelId>::new(),
                "{malformed}"
            );
        }
    }

    #[test]
    fn settings_reject_invalid_provider_shapes_and_ids() {
        assert!(matches!(
            parse_settings(
                r#"{"providers":[{"id":"a","name":"A","protocol":"openai-compatible","base_url":"x","credential":{"env":"K"},"active":false,"surprise":1}]}"#
            ),
            Err(SettingsError::InvalidProviders)
        ));
        assert!(matches!(
            parse_settings(
                r#"{"providers":[{"id":"has space","name":"A","protocol":"openai-compatible","base_url":"x","credential":{"env":"K"},"active":false}]}"#
            ),
            Err(SettingsError::InvalidProviders)
        ));
        assert!(matches!(
            parse_settings(r#"{"providers":5}"#),
            Err(SettingsError::InvalidProviders)
        ));
        assert!(matches!(
            parse_settings(r#"{"active_provider":5}"#),
            Err(SettingsError::InvalidActiveProvider)
        ));
    }

    #[test]
    fn load_normalizes_active_state_and_dangling_references() {
        let input = r#"{
            "global_worker_model": null,
            "worker_effort_lock": null,
            "active_provider": "b",
            "providers": [
                {"id": "a", "name": "A", "protocol": "openai-compatible", "base_url": "https://a.example/v1", "credential": {"env": "K_A"}, "active": true},
                {"id": "b", "name": "B", "protocol": "openai-compatible", "base_url": "https://b.example/v1", "credential": {"env": "K_B"}, "active": false}
            ]
        }"#;
        let settings = parse_settings(input).unwrap();
        let a = ProviderId::new("a".to_owned()).unwrap();
        let b = ProviderId::new("b".to_owned()).unwrap();
        assert_eq!(settings.active_provider.as_ref(), Some(&b));
        assert!(!settings.provider(&a).unwrap().active);
        assert!(settings.provider(&b).unwrap().active);

        let dangling = r#"{"active_provider":"ghost","providers":[{"id":"a","name":"A","protocol":"openai-compatible","base_url":"https://a.example/v1","credential":{"env":"K"},"active":true}]}"#;
        let settings = parse_settings(dangling).unwrap();
        assert_eq!(settings.active_provider, None);
        assert!(!settings.provider(&a).unwrap().active);

        let mut settings = NativeSettings::default();
        settings.add_provider(builtin_vexzy_provider()).unwrap();
        let reparsed = settings_from_value(settings_to_value(&settings).unwrap()).unwrap();
        assert_eq!(reparsed, settings);
    }

    #[test]
    fn provider_keys_are_not_treated_as_unknown() {
        let input = r#"{"active_provider":null,"providers":[],"ui_density":"dense"}"#;
        let settings = parse_settings(input).unwrap();
        assert!(settings.providers().is_empty());
        assert_eq!(settings.active_provider, None);
        assert_eq!(settings.unknown.len(), 1);
        assert_eq!(settings.unknown["ui_density"], "dense");
        let reparsed = settings_from_value(settings_to_value(&settings).unwrap()).unwrap();
        assert_eq!(reparsed, settings);
        assert_eq!(reparsed.unknown.len(), 1);
    }
}
