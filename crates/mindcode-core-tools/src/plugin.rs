//! Plugin manifest and sandboxed execution (§14.3).
//!
//! JS plugins are optional, on-demand extensions (AGENTS.md contract: Bun
//! first, then Node, never a silent core fallback). A plugin ships a
//! `plugin.json` manifest that declares only the hooks and tools it uses; the
//! manifest is validated against a fixed allowlist and API version before the
//! plugin runs. Execution always goes through the bwrap sandbox so the plugin
//! can never read the credential store, whichever hook or tool it claims.

use crate::js_runtime::JsRuntime;
use crate::sandbox::{run_sandboxed, SandboxConfig};
use crate::{CoreToolError, CoreToolErrorCode, CoreToolResult, ProcessRunResult};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::{Component, Path};
use tokio_util::sync::CancellationToken;

/// The only API version this build accepts.
pub const PLUGIN_API_VERSION: u32 = 1;
/// Hooks a plugin may declare (§14.3). The set is closed by design.
pub const ALLOWED_HOOKS: &[&str] = &["pre_tool", "post_tool"];
const MAX_HOOKS: usize = 16;
const MAX_TOOLS: usize = 32;
const MAX_NAME_BYTES: usize = 128;
const MAX_ENTRY_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub name: String,
    #[serde(default = "default_api_version")]
    pub api_version: u32,
    pub entry: String,
    #[serde(default)]
    pub hooks: Vec<String>,
    #[serde(default)]
    pub tools: Vec<String>,
}

fn default_api_version() -> u32 {
    PLUGIN_API_VERSION
}

impl PluginManifest {
    pub fn from_json(json: &str) -> Result<Self, PluginError> {
        serde_json::from_str(json).map_err(|error| PluginError::Json(error.to_string()))
    }

    /// Validate the manifest against the fixed allowlist and API version. A
    /// plugin that declares an unknown hook or tool is rejected fail-closed.
    pub fn validate(&self) -> Result<(), PluginError> {
        if self.name.is_empty()
            || self.name.len() > MAX_NAME_BYTES
            || !self
                .name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(PluginError::InvalidName);
        }
        if self.api_version != PLUGIN_API_VERSION {
            return Err(PluginError::UnsupportedApiVersion(self.api_version));
        }
        validate_entry(&self.entry)?;
        if self.hooks.len() > MAX_HOOKS {
            return Err(PluginError::TooManyHooks);
        }
        let mut seen = std::collections::HashSet::new();
        for hook in &self.hooks {
            if !ALLOWED_HOOKS.contains(&hook.as_str()) {
                return Err(PluginError::UnknownHook(hook.clone()));
            }
            if !seen.insert(hook.as_str()) {
                return Err(PluginError::UnknownHook(format!("duplicate hook: {hook}")));
            }
        }
        if self.tools.len() > MAX_TOOLS {
            return Err(PluginError::TooManyTools);
        }
        for tool in &self.tools {
            if !is_identifier(tool) {
                return Err(PluginError::InvalidTool(tool.clone()));
            }
        }
        Ok(())
    }
}

/// Reject absolute paths, `..` traversal, and control bytes in a plugin entry.
fn validate_entry(entry: &str) -> Result<(), PluginError> {
    if entry.is_empty() || entry.len() > MAX_ENTRY_BYTES || entry.contains('\0') {
        return Err(PluginError::InvalidEntry);
    }
    let path = Path::new(entry);
    if path.is_absolute() {
        return Err(PluginError::InvalidEntry);
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(PluginError::InvalidEntry);
    }
    Ok(())
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

/// Run a plugin's entry script under the bwrap sandbox using the resolved JS
/// runtime. `sandbox` must hide the credential store (the caller builds it with
/// the real config home). Never runs unsandboxed; fails closed when bwrap is
/// unavailable.
pub async fn run_plugin_sandboxed(
    runtime: &JsRuntime,
    manifest: &PluginManifest,
    sandbox: &SandboxConfig,
    args: &[String],
    cancel: &CancellationToken,
) -> CoreToolResult<ProcessRunResult> {
    manifest.validate().map_err(|error| {
        CoreToolError::new(CoreToolErrorCode::InvalidArgv, error.static_message())
    })?;
    let mut argv = vec![runtime.path.to_string_lossy().into_owned()];
    argv.extend(runtime.args_for_script(Path::new(&manifest.entry)));
    argv.extend(args.iter().cloned());
    run_sandboxed(sandbox, &argv, cancel).await
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginError {
    Json(String),
    InvalidName,
    UnsupportedApiVersion(u32),
    InvalidEntry,
    UnknownHook(String),
    TooManyHooks,
    TooManyTools,
    InvalidTool(String),
}

impl PluginError {
    /// A `'static` message for the core-tools error type (which only stores
    /// static strings); the dynamic detail is surfaced through `Display`.
    fn static_message(&self) -> &'static str {
        match self {
            Self::Json(_) => "plugin manifest is not valid JSON",
            Self::InvalidName => "plugin name must be a short path-safe identifier",
            Self::UnsupportedApiVersion(_) => "plugin api_version is not supported",
            Self::InvalidEntry => "plugin entry must be a workspace-relative path",
            Self::UnknownHook(_) => "plugin declares an unknown hook",
            Self::TooManyHooks => "plugin declares too many hooks",
            Self::TooManyTools => "plugin declares too many tools",
            Self::InvalidTool(_) => "plugin declares an invalid tool name",
        }
    }
}

impl fmt::Display for PluginError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(message) => write!(formatter, "plugin manifest JSON error: {message}"),
            Self::InvalidName => formatter.write_str(self.static_message()),
            Self::UnsupportedApiVersion(version) => {
                write!(formatter, "unsupported plugin api_version {version}")
            }
            Self::InvalidEntry => formatter.write_str(self.static_message()),
            Self::UnknownHook(hook) => write!(formatter, "plugin declares unknown hook: {hook}"),
            Self::TooManyHooks => formatter.write_str(self.static_message()),
            Self::TooManyTools => formatter.write_str(self.static_message()),
            Self::InvalidTool(tool) => write!(formatter, "plugin declares invalid tool: {tool}"),
        }
    }
}

impl std::error::Error for PluginError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_manifest_json() -> String {
        r#"{
            "name": "my-plugin",
            "api_version": 1,
            "entry": "dist/index.js",
            "hooks": ["pre_tool"],
            "tools": ["summarize"]
        }"#
        .to_owned()
    }

    #[test]
    fn valid_manifest_passes_validation() {
        let manifest = PluginManifest::from_json(&valid_manifest_json()).unwrap();
        assert!(manifest.validate().is_ok());
        assert_eq!(manifest.hooks, vec!["pre_tool".to_owned()]);
    }

    #[test]
    fn unknown_hook_and_tool_are_rejected() {
        let manifest = PluginManifest::from_json(&valid_manifest_json()).unwrap();
        assert!(manifest.validate().is_ok());

        let mut unknown_hook = manifest.clone();
        unknown_hook.hooks = vec!["arbitrary_code_exec".to_owned()];
        assert!(matches!(
            unknown_hook.validate(),
            Err(PluginError::UnknownHook(_))
        ));

        let mut bad_tool = manifest.clone();
        bad_tool.tools = vec!["1bad".to_owned()];
        assert!(matches!(
            bad_tool.validate(),
            Err(PluginError::InvalidTool(_))
        ));
    }

    #[test]
    fn unsupported_api_version_and_bad_entry_are_rejected() {
        let manifest = PluginManifest::from_json(&valid_manifest_json()).unwrap();
        let mut wrong_api = manifest.clone();
        wrong_api.api_version = 99;
        assert!(matches!(
            wrong_api.validate(),
            Err(PluginError::UnsupportedApiVersion(99))
        ));

        let mut traversal = manifest.clone();
        traversal.entry = "../credentials.json".to_owned();
        assert!(matches!(
            traversal.validate(),
            Err(PluginError::InvalidEntry)
        ));

        let mut absolute = manifest;
        absolute.entry = "/etc/passwd".to_owned();
        assert!(matches!(
            absolute.validate(),
            Err(PluginError::InvalidEntry)
        ));
    }

    #[test]
    fn unknown_manifest_fields_are_rejected() {
        let json = r#"{"name":"x","api_version":1,"entry":"a.js","extra":true}"#;
        assert!(matches!(
            PluginManifest::from_json(json),
            Err(PluginError::Json(_))
        ));
    }

    /// §14.3 acceptance: the plugin cannot read `credentials.json` no matter
    /// which hook or tool it claims — execution runs under bwrap with the
    /// config home replaced by an empty tmpfs.
    #[tokio::test]
    async fn plugin_cannot_read_the_credential_store() {
        if !crate::sandbox::bwrap_available() {
            return;
        }
        let workspace = tempfile::tempdir().unwrap();
        let config_home = tempfile::tempdir().unwrap();
        let secret = config_home.path().join("credentials.json");
        std::fs::write(&secret, "{\"api_key\":\"super-secret-value\"}").unwrap();

        let entry = "probe.sh";
        let script = format!(
            "if cat '{}' 2>/dev/null; then echo LEAKED; else echo HIDDEN; fi",
            secret.display()
        );
        std::fs::write(workspace.path().join(entry), script).unwrap();

        let manifest = PluginManifest::from_json(&format!(
            r#"{{"name":"probe","api_version":1,"entry":"{entry}"}}"#
        ))
        .unwrap();
        let sandbox = crate::SandboxConfig::new(
            workspace.path().to_path_buf(),
            config_home.path().to_path_buf(),
        );
        // `/bin/sh` stands in for the JS runtime so the test needs no Bun/Node;
        // `args_for_script` then produces `sh probe.sh`, which works here.
        let runtime = crate::JsRuntime {
            kind: crate::JsRuntimeKind::Bun,
            path: std::path::PathBuf::from("/bin/sh"),
        };
        let cancel = tokio_util::sync::CancellationToken::new();
        let result = run_plugin_sandboxed(&runtime, &manifest, &sandbox, &[], &cancel)
            .await
            .unwrap();
        assert!(result.stdout.contains("HIDDEN"), "{} ", result.stdout);
        assert!(!result.stdout.contains("LEAKED"));
        assert!(!result.stdout.contains("super-secret-value"));
    }
}
