//! Bounded local persistence for TUI preferences.
//!
//! The on-disk format deliberately contains only presentation settings.  It
//! has no field for transcripts, prompts, tool output, credentials, tokens,
//! or any other session data.  Writes use a same-directory temporary file and
//! rename so readers observe either the old complete record or the new
//! complete record.

use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::ui::{MotionMode, PaneRatios, ThemeKind};

/// Version of the private, binary preferences record.
pub const PREFERENCES_FORMAT_VERSION: u8 = 1;
/// Maximum encoded preferences file size accepted by the loader.
pub const MAX_PREFERENCES_BYTES: usize = 64 * 1024;
/// Maximum number of workspace-specific records.
pub const MAX_WORKSPACES: usize = 128;
/// Maximum UTF-8 byte length of a workspace identifier.
pub const MAX_WORKSPACE_ID_BYTES: usize = 256;
/// Maximum persisted weight for an individual pane.
pub const MAX_PANE_RATIO: u16 = 10_000;

const MAGIC: &[u8] = b"MINDCODE-PREFERENCES\0";
const MAX_TEMP_ATTEMPTS: usize = 32;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Global and workspace-local settings persisted by the native TUI.
///
/// The fields are intentionally limited to rendering preferences.  In
/// particular, this type has no session, message, prompt, API-key, or token
/// storage field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preferences {
    /// The global color theme.
    pub theme: ThemeKind,
    /// An explicit motion override. `None` means use the platform/default
    /// motion policy.
    pub motion_override: Option<MotionMode>,
    /// Pane weights keyed by a caller-provided workspace identifier.
    pub pane_ratios: BTreeMap<String, PaneRatios>,
}

/// Compatibility alias for callers that prefer the more explicit name.
pub type UiPreferences = Preferences;

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: ThemeKind::GraphiteSakura,
            motion_override: None,
            pane_ratios: BTreeMap::new(),
        }
    }
}

impl Preferences {
    /// Construct preferences with no workspace overrides.
    pub fn new(theme: ThemeKind, motion_override: Option<MotionMode>) -> Self {
        Self {
            theme,
            motion_override,
            pane_ratios: BTreeMap::new(),
        }
    }

    /// Read preferences from `path`.
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self, PreferencesError> {
        load(path)
    }

    /// Read preferences, returning defaults when the file does not exist.
    pub fn load_or_default<P: AsRef<Path>>(path: P) -> Result<Self, PreferencesError> {
        match Self::load(path) {
            Ok(preferences) => Ok(preferences),
            Err(PreferencesError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                Ok(Self::default())
            }
            Err(error) => Err(error),
        }
    }

    /// Validate and atomically write preferences to `path`.
    pub fn save<P: AsRef<Path>>(&self, path: P) -> Result<(), PreferencesError> {
        save(path, self)
    }

    /// Validate this value without performing I/O.
    pub fn validate(&self) -> Result<(), PreferencesError> {
        validate_preferences(self)
    }

    /// Return the workspace override or the standard three-pane defaults.
    pub fn ratios_for(&self, workspace: &str) -> PaneRatios {
        self.pane_ratios
            .get(workspace)
            .copied()
            .unwrap_or(PaneRatios::DEFAULT)
    }

    /// Insert or replace a workspace pane override after validating its
    /// bounded identifier and ratios.
    pub fn set_pane_ratios(
        &mut self,
        workspace: impl Into<String>,
        ratios: PaneRatios,
    ) -> Result<(), PreferencesError> {
        let workspace = workspace.into();
        validate_workspace_id(&workspace)?;
        validate_pane_ratios(ratios)?;
        if !self.pane_ratios.contains_key(&workspace) && self.pane_ratios.len() >= MAX_WORKSPACES {
            return Err(PreferencesError::LimitExceeded(
                "too many workspace preference records",
            ));
        }
        self.pane_ratios.insert(workspace, ratios);
        Ok(())
    }

    /// Remove one workspace override and report whether it existed.
    pub fn remove_pane_ratios(&mut self, workspace: &str) -> bool {
        self.pane_ratios.remove(workspace).is_some()
    }
}

/// Errors produced while validating, reading, encoding, or atomically
/// replacing a preferences file.
#[derive(Debug)]
pub enum PreferencesError {
    Io(io::Error),
    Invalid(&'static str),
    UnsupportedVersion(u8),
    LimitExceeded(&'static str),
}

impl fmt::Display for PreferencesError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "preferences I/O error: {error}"),
            Self::Invalid(message) => write!(formatter, "invalid preferences record: {message}"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported preferences version: {version}")
            }
            Self::LimitExceeded(message) => {
                write!(formatter, "preferences limit exceeded: {message}")
            }
        }
    }
}

impl std::error::Error for PreferencesError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Invalid(_) | Self::UnsupportedVersion(_) | Self::LimitExceeded(_) => None,
        }
    }
}

impl From<io::Error> for PreferencesError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Load a bounded preferences record from a caller-provided path.
pub fn load<P: AsRef<Path>>(path: P) -> Result<Preferences, PreferencesError> {
    let path = path.as_ref();
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    if length > MAX_PREFERENCES_BYTES as u64 {
        return Err(PreferencesError::LimitExceeded(
            "preferences file is too large",
        ));
    }

    let mut bytes = Vec::with_capacity(length as usize);
    file.read_to_end(&mut bytes)?;
    if bytes.len() > MAX_PREFERENCES_BYTES {
        return Err(PreferencesError::LimitExceeded(
            "preferences file grew beyond the size limit",
        ));
    }
    decode(&bytes)
}

/// Validate and atomically replace a preferences record at a caller-provided
/// path.  The temporary file is created in the target directory, written,
/// flushed, and renamed only after the complete record is available.
pub fn save<P: AsRef<Path>>(path: P, preferences: &Preferences) -> Result<(), PreferencesError> {
    let path = path.as_ref();
    let bytes = encode(preferences)?;
    let (temporary_path, mut temporary_file) = create_temporary_file(path)?;

    let result = (|| -> Result<(), PreferencesError> {
        temporary_file.write_all(&bytes)?;
        temporary_file.sync_all()?;
        drop(temporary_file);
        fs::rename(&temporary_path, path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn validate_preferences(preferences: &Preferences) -> Result<(), PreferencesError> {
    if preferences.pane_ratios.len() > MAX_WORKSPACES {
        return Err(PreferencesError::LimitExceeded(
            "too many workspace preference records",
        ));
    }
    for (workspace, ratios) in &preferences.pane_ratios {
        validate_workspace_id(workspace)?;
        validate_pane_ratios(*ratios)?;
    }
    Ok(())
}

fn validate_workspace_id(workspace: &str) -> Result<(), PreferencesError> {
    if workspace.is_empty() {
        return Err(PreferencesError::Invalid("workspace identifier is empty"));
    }
    if workspace.len() > MAX_WORKSPACE_ID_BYTES {
        return Err(PreferencesError::LimitExceeded(
            "workspace identifier is too long",
        ));
    }
    if workspace.chars().any(char::is_control) {
        return Err(PreferencesError::Invalid(
            "workspace identifier contains a control character",
        ));
    }
    Ok(())
}

fn validate_pane_ratios(ratios: PaneRatios) -> Result<(), PreferencesError> {
    if ratios.sidebar == 0 || ratios.chat == 0 || ratios.inspector == 0 {
        return Err(PreferencesError::Invalid("pane ratios must be non-zero"));
    }
    if ratios.sidebar > MAX_PANE_RATIO
        || ratios.chat > MAX_PANE_RATIO
        || ratios.inspector > MAX_PANE_RATIO
    {
        return Err(PreferencesError::LimitExceeded("pane ratio is too large"));
    }
    Ok(())
}

fn encode(preferences: &Preferences) -> Result<Vec<u8>, PreferencesError> {
    validate_preferences(preferences)?;

    let mut encoded_len = MAGIC
        .len()
        .checked_add(1 + 1 + 1 + 2)
        .ok_or(PreferencesError::LimitExceeded("encoded record overflow"))?;
    for workspace in preferences.pane_ratios.keys() {
        encoded_len = encoded_len
            .checked_add(2 + workspace.len() + 2 + 2 + 2)
            .ok_or(PreferencesError::LimitExceeded("encoded record overflow"))?;
    }
    if encoded_len > MAX_PREFERENCES_BYTES {
        return Err(PreferencesError::LimitExceeded(
            "encoded preferences record is too large",
        ));
    }

    let workspace_count = u16::try_from(preferences.pane_ratios.len())
        .map_err(|_| PreferencesError::LimitExceeded("workspace count does not fit format"))?;
    let mut output = Vec::with_capacity(encoded_len);
    output.extend_from_slice(MAGIC);
    output.push(PREFERENCES_FORMAT_VERSION);
    output.push(theme_to_byte(preferences.theme));
    output.push(motion_to_byte(preferences.motion_override));
    output.extend_from_slice(&workspace_count.to_be_bytes());

    for (workspace, ratios) in &preferences.pane_ratios {
        let length = u16::try_from(workspace.len())
            .map_err(|_| PreferencesError::LimitExceeded("workspace identifier is too long"))?;
        output.extend_from_slice(&length.to_be_bytes());
        output.extend_from_slice(workspace.as_bytes());
        output.extend_from_slice(&ratios.sidebar.to_be_bytes());
        output.extend_from_slice(&ratios.chat.to_be_bytes());
        output.extend_from_slice(&ratios.inspector.to_be_bytes());
    }
    Ok(output)
}

fn decode(bytes: &[u8]) -> Result<Preferences, PreferencesError> {
    if bytes.len() > MAX_PREFERENCES_BYTES {
        return Err(PreferencesError::LimitExceeded(
            "preferences file is too large",
        ));
    }

    let mut cursor = Cursor::new(bytes);
    if cursor.take(MAGIC.len())? != MAGIC {
        return Err(PreferencesError::Invalid("bad preferences magic"));
    }
    let version = cursor.u8()?;
    if version != PREFERENCES_FORMAT_VERSION {
        return Err(PreferencesError::UnsupportedVersion(version));
    }
    let theme = theme_from_byte(cursor.u8()?)?;
    let motion_override = motion_from_byte(cursor.u8()?)?;
    let workspace_count = cursor.u16()? as usize;
    if workspace_count > MAX_WORKSPACES {
        return Err(PreferencesError::LimitExceeded(
            "too many workspace preference records",
        ));
    }

    let mut pane_ratios = BTreeMap::new();
    for _ in 0..workspace_count {
        let length = cursor.u16()? as usize;
        if length == 0 {
            return Err(PreferencesError::Invalid("workspace identifier is empty"));
        }
        if length > MAX_WORKSPACE_ID_BYTES {
            return Err(PreferencesError::LimitExceeded(
                "workspace identifier is too long",
            ));
        }
        let workspace_bytes = cursor.take(length)?.to_vec();
        let workspace = String::from_utf8(workspace_bytes)
            .map_err(|_| PreferencesError::Invalid("workspace identifier is not UTF-8"))?;
        validate_workspace_id(&workspace)?;

        let sidebar = cursor.u16()?;
        let chat = cursor.u16()?;
        let inspector = cursor.u16()?;
        // PaneRatios::new normalizes zero values for layout callers; persisted
        // data must not silently normalize malformed records.
        if sidebar == 0 || chat == 0 || inspector == 0 {
            return Err(PreferencesError::Invalid("pane ratios must be non-zero"));
        }
        let ratios = PaneRatios::new(sidebar, chat, inspector);
        validate_pane_ratios(ratios)?;
        if pane_ratios.insert(workspace, ratios).is_some() {
            return Err(PreferencesError::Invalid(
                "duplicate workspace preference record",
            ));
        }
    }

    if !cursor.is_empty() {
        return Err(PreferencesError::Invalid(
            "trailing bytes after preferences record",
        ));
    }

    let preferences = Preferences {
        theme,
        motion_override,
        pane_ratios,
    };
    preferences.validate()?;
    Ok(preferences)
}

fn theme_to_byte(theme: ThemeKind) -> u8 {
    match theme {
        ThemeKind::GraphiteSakura => 0,
        ThemeKind::Light => 1,
        ThemeKind::Monochrome => 2,
    }
}

fn theme_from_byte(value: u8) -> Result<ThemeKind, PreferencesError> {
    match value {
        0 => Ok(ThemeKind::GraphiteSakura),
        1 => Ok(ThemeKind::Light),
        2 => Ok(ThemeKind::Monochrome),
        _ => Err(PreferencesError::Invalid("unknown theme")),
    }
}

fn motion_to_byte(motion: Option<MotionMode>) -> u8 {
    match motion {
        None => 0,
        Some(MotionMode::Full) => 1,
        Some(MotionMode::Reduced) => 2,
    }
}

fn motion_from_byte(value: u8) -> Result<Option<MotionMode>, PreferencesError> {
    match value {
        0 => Ok(None),
        1 => Ok(Some(MotionMode::Full)),
        2 => Ok(Some(MotionMode::Reduced)),
        _ => Err(PreferencesError::Invalid("unknown motion override")),
    }
}

fn create_temporary_file(path: &Path) -> Result<(PathBuf, File), PreferencesError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or(PreferencesError::Invalid(
            "preferences path has no file name",
        ))?
        .to_string_lossy();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    for attempt in 0..MAX_TEMP_ATTEMPTS {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temporary_path = parent.join(format!(
            ".{file_name}.tmp-{}-{stamp}-{counter}-{attempt}",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temporary_path) {
            Ok(file) => return Ok((temporary_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(PreferencesError::Io(error)),
        }
    }

    Err(PreferencesError::LimitExceeded(
        "could not allocate a unique temporary preferences path",
    ))
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], PreferencesError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(PreferencesError::Invalid("record offset overflow"))?;
        if end > self.bytes.len() {
            return Err(PreferencesError::Invalid("truncated preferences record"));
        }
        let value = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, PreferencesError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, PreferencesError> {
        let bytes = self.take(2)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempPath(PathBuf);

    impl TempPath {
        fn new(label: &str) -> Self {
            let id = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            Self(std::env::temp_dir().join(format!(
                "mindcode-preferences-test-{label}-{}-{stamp}-{id}",
                std::process::id()
            )))
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempPath {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn sample() -> Preferences {
        let mut preferences = Preferences::new(ThemeKind::Light, Some(MotionMode::Reduced));
        preferences
            .set_pane_ratios("workspace-a", PaneRatios::new(30, 50, 20))
            .expect("sample workspace is valid");
        preferences
            .set_pane_ratios("/Users/example/project", PaneRatios::new(10, 70, 20))
            .expect("path workspace is valid");
        preferences
    }

    #[test]
    fn round_trip_preserves_only_preferences() {
        let path = TempPath::new("round-trip");
        let expected = sample();
        expected.save(path.path()).expect("save preferences");
        let actual = Preferences::load(path.path()).expect("load preferences");
        assert_eq!(actual, expected);

        let raw = fs::read(path.path()).expect("read preferences");
        assert!(!raw
            .windows(b"session-secret".len())
            .any(|window| { window == b"session-secret" }));
        assert!(!raw
            .windows(b"Authorization".len())
            .any(|window| { window == b"Authorization" }));
    }

    #[test]
    fn missing_file_loads_as_default() {
        let path = TempPath::new("missing");
        assert_eq!(
            Preferences::load_or_default(path.path()).unwrap(),
            Preferences::default()
        );
    }

    #[test]
    fn malformed_and_trailing_records_are_rejected() {
        let path = TempPath::new("malformed");
        let mut bytes = encode(&Preferences::default()).expect("encode default");
        bytes.push(0xFF);
        fs::write(path.path(), bytes).expect("write malformed record");
        assert!(matches!(
            Preferences::load(path.path()),
            Err(PreferencesError::Invalid(
                "trailing bytes after preferences record"
            ))
        ));

        fs::write(path.path(), vec![0; MAX_PREFERENCES_BYTES + 1]).expect("write oversized record");
        assert!(matches!(
            Preferences::load(path.path()),
            Err(PreferencesError::LimitExceeded(
                "preferences file is too large"
            ))
        ));
    }

    #[test]
    fn invalid_values_are_rejected_before_replacing_existing_file() {
        let path = TempPath::new("atomic");
        let expected = sample();
        expected
            .save(path.path())
            .expect("save initial preferences");

        let mut invalid = expected.clone();
        invalid
            .pane_ratios
            .insert("bad\nworkspace".to_owned(), PaneRatios::DEFAULT);
        assert!(matches!(
            invalid.save(path.path()),
            Err(PreferencesError::Invalid(
                "workspace identifier contains a control character"
            ))
        ));
        assert_eq!(Preferences::load(path.path()).unwrap(), expected);
    }

    #[test]
    fn setters_enforce_workspace_and_record_limits() {
        let mut preferences = Preferences::default();
        assert!(matches!(
            preferences.set_pane_ratios("", PaneRatios::DEFAULT),
            Err(PreferencesError::Invalid("workspace identifier is empty"))
        ));
        assert!(matches!(
            preferences
                .set_pane_ratios("x".repeat(MAX_WORKSPACE_ID_BYTES + 1), PaneRatios::DEFAULT),
            Err(PreferencesError::LimitExceeded(
                "workspace identifier is too long"
            ))
        ));
        assert!(matches!(
            preferences.set_pane_ratios(
                "zero",
                PaneRatios {
                    sidebar: 0,
                    chat: 2,
                    inspector: 3,
                }
            ),
            Err(PreferencesError::Invalid("pane ratios must be non-zero"))
        ));
    }

    #[test]
    fn temporary_test_paths_are_cleaned_up() {
        let path = TempPath::new("cleanup");
        Preferences::default()
            .save(path.path())
            .expect("save preferences");
        assert!(path.path().exists());
        let owned = path.0.clone();
        drop(path);
        assert!(!owned.exists());
    }
}
