//! Secret-free native preferences for the Rust-first MindCode migration.
//!
//! Only non-secret, native Worker preferences are stored.  The module does no
//! network I/O, reads no credentials, and rejects credential-shaped top-level
//! JSON keys before any state reaches disk.

#![forbid(unsafe_code)]

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

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct NativeSettings {
    pub global_worker_model: Option<String>,
    pub worker_effort_lock: Option<WorkerEffort>,
    /// Unknown non-secret keys survive load/save untouched for forward
    /// compatibility with the legacy state migration.
    pub unknown: BTreeMap<String, Value>,
}

#[derive(Debug)]
pub enum SettingsError {
    HomeUnavailable,
    Io(io::Error),
    Json(serde_json::Error),
    RootMustBeObject,
    InvalidWorkerModel,
    InvalidWorkerEffortLock,
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
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(NativeSettings::default()),
        Err(error) => Err(SettingsError::Io(error)),
    }
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

    let unknown = object
        .iter()
        .filter(|(key, _)| {
            key.as_str() != "global_worker_model" && key.as_str() != "worker_effort_lock"
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();

    Ok(NativeSettings {
        global_worker_model,
        worker_effort_lock,
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
    for (key, value) in &settings.unknown {
        if key == "global_worker_model" || key == "worker_effort_lock" {
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
