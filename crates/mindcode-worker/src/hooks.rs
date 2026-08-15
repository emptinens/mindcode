//! Shell `pre_tool` hook gate (§11.4).
//!
//! A synchronous gate that runs before every worker tool call. Hooks live in a
//! global directory (`~/.config/mindcode/hooks`) and a project-local directory
//! (`.mindcode/hooks`); a project-local script shadows the global one by name.
//! The contract is exit `0` = allow, exit `2` = block (stderr, capped), and
//! any other exit / timeout / execution failure = **fail-closed** by default.
//! An explicit observer mode can opt into fail-open behavior, but security
//! hooks used by workers keep the default hard lock-out.
//!
//! Hooks gate worker tools only, never the Leader chat flow, and they receive a
//! secret-free payload (no credential values ever). `MINDCODE_HOOKS_DISABLED=1`
//! is exported so a hook can safely call `mindcode` itself without recursing.

use mindcode_core_tools::{process_run, ProcessRunRequest};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

const PRE_TOOL_HOOK: &str = "pre_tool";
const HOOK_TIMEOUT_MS: u64 = 5_000;
const HOOK_MAX_OUTPUT_BYTES: usize = 2 * 1024;
const HOOKS_DISABLED_ENV: &str = "MINDCODE_HOOKS_DISABLED";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HookDecision {
    Allow,
    Block(String),
}

/// Where to look for hook scripts. `None` means the directory is absent and is
/// simply skipped.
#[derive(Clone, Debug)]
pub struct HookSet {
    pub global: Option<PathBuf>,
    pub project: Option<PathBuf>,
    /// Broken/timeout/unexpected hook execution blocks worker tools by
    /// default. Set false only for an explicitly non-security observer hook.
    pub fail_closed: bool,
}

impl Default for HookSet {
    fn default() -> Self {
        Self {
            global: None,
            project: None,
            fail_closed: true,
        }
    }
}

impl HookSet {
    /// Construct a hook set with the security-default fail-closed policy.
    pub fn new(global: Option<PathBuf>, project: Option<PathBuf>) -> Self {
        Self {
            global,
            project,
            fail_closed: true,
        }
    }

    /// Opt into fail-open behavior for an observer-only hook set.
    pub fn with_fail_closed(mut self, fail_closed: bool) -> Self {
        self.fail_closed = fail_closed;
        self
    }
}

impl HookSet {
    /// Resolve a hook script path: project-local first, then global.
    pub fn resolve(&self, name: &str) -> Option<PathBuf> {
        for dir in [self.project.as_ref(), self.global.as_ref()]
            .into_iter()
            .flatten()
        {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }
}

/// Run the `pre_tool` hook for one tool call. Absent hook → `Allow`; the
/// payload is the secret-free JSON the script reads on stdin.
pub async fn run_pre_tool(
    hooks: &HookSet,
    payload: &Value,
    cancel: &CancellationToken,
) -> HookDecision {
    let Some(script) = hooks.resolve(PRE_TOOL_HOOK) else {
        return HookDecision::Allow;
    };
    let mut env = BTreeMap::new();
    env.insert(HOOKS_DISABLED_ENV.to_owned(), "1".to_owned());
    let cwd = script
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let request = ProcessRunRequest {
        argv: vec![script.to_string_lossy().into_owned()],
        cwd,
        env,
        stdin: Some(payload.to_string()),
        timeout_ms: HOOK_TIMEOUT_MS,
        max_output_bytes: HOOK_MAX_OUTPUT_BYTES,
        rlimits: None,
        seccomp_fd: None,
    };
    match process_run(request, cancel.clone()).await {
        Ok(result) if result.exit_code == Some(0) => HookDecision::Allow,
        Ok(result) if result.exit_code == Some(2) => {
            let reason = if result.stderr.trim().is_empty() {
                "blocked by pre_tool hook".to_owned()
            } else {
                result.stderr.trim().to_owned()
            };
            HookDecision::Block(reason)
        }
        // Missing binary, unexpected exit, timeout, exec failure: the
        // security-default is fail-closed. An absent hook path was handled
        // above and remains an intentional "no policy" allow.
        Ok(result) => {
            if hooks.fail_closed {
                HookDecision::Block(format!(
                    "pre_tool hook failed closed (exit {:?})",
                    result.exit_code
                ))
            } else {
                HookDecision::Allow
            }
        }
        Err(_) if hooks.fail_closed => {
            HookDecision::Block("pre_tool hook failed closed".to_owned())
        }
        Err(_) => HookDecision::Allow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn write_hook(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        fs::write(&path, body).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn absent_hook_is_allow() {
        let hooks = HookSet::default();
        let decision = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(run_pre_tool(
                &hooks,
                &serde_json::json!({"tool": "read_file"}),
                &CancellationToken::new(),
            ));
        assert_eq!(decision, HookDecision::Allow);
    }

    #[cfg(unix)]
    #[test]
    fn exit_zero_allows_and_exit_two_blocks_with_capped_reason() {
        let tmp = tempdir().unwrap();
        write_hook(tmp.path(), "pre_tool", "#!/bin/sh\nexit 0\n");
        let hooks = HookSet {
            global: Some(tmp.path().to_path_buf()),
            project: None,
            fail_closed: true,
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let decision = runtime.block_on(run_pre_tool(
            &hooks,
            &serde_json::json!({"tool": "read_file", "args": {"path": "a"}}),
            &CancellationToken::new(),
        ));
        assert_eq!(decision, HookDecision::Allow);

        write_hook(
            tmp.path(),
            "pre_tool",
            "#!/bin/sh\necho 'not allowed' >&2\nexit 2\n",
        );
        let decision = runtime.block_on(run_pre_tool(
            &hooks,
            &serde_json::json!({"tool": "run_shell"}),
            &CancellationToken::new(),
        ));
        assert_eq!(decision, HookDecision::Block("not allowed".to_owned()));
    }

    #[cfg(unix)]
    #[test]
    fn unexpected_hook_exit_fails_closed_by_default() {
        let tmp = tempdir().unwrap();
        write_hook(tmp.path(), "pre_tool", "#!/bin/sh\nexit 3\n");
        let hooks = HookSet::new(Some(tmp.path().to_path_buf()), None);
        let decision = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(run_pre_tool(
                &hooks,
                &serde_json::json!({"tool": "run_shell"}),
                &CancellationToken::new(),
            ));
        assert_eq!(
            decision,
            HookDecision::Block("pre_tool hook failed closed (exit Some(3))".to_owned())
        );

        let permissive = hooks.with_fail_closed(false);
        let decision = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(run_pre_tool(
                &permissive,
                &serde_json::json!({"tool": "run_shell"}),
                &CancellationToken::new(),
            ));
        assert_eq!(decision, HookDecision::Allow);
    }

    #[cfg(unix)]
    #[test]
    fn project_local_hook_shadows_global() {
        let tmp = tempdir().unwrap();
        let global = tmp.path().join("global");
        let project = tmp.path().join("project");
        fs::create_dir_all(&global).unwrap();
        fs::create_dir_all(&project).unwrap();
        write_hook(&global, "pre_tool", "#!/bin/sh\nexit 0\n");
        write_hook(&project, "pre_tool", "#!/bin/sh\nexit 2\n");
        let hooks = HookSet {
            global: Some(global),
            project: Some(project),
            fail_closed: true,
        };
        let decision = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(run_pre_tool(
                &hooks,
                &serde_json::json!({"tool": "write_file"}),
                &CancellationToken::new(),
            ));
        assert_eq!(
            decision,
            HookDecision::Block("blocked by pre_tool hook".to_owned())
        );
    }
}
