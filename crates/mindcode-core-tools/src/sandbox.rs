//! Opt-in OS-level shell isolation via bubblewrap (§13.1).
//!
//! The static risk filter (§11.1) is defense-in-depth, not a sandbox: an
//! obfuscated command can still read `credentials.json`. This module builds a
//! bubblewrap invocation that makes the rest of the filesystem read-only,
//! hides the MindCode config directory behind an empty tmpfs (so the
//! credential store is unreadable), and leaves only the workspace writable.
//! It is opt-in by design: the fast path for `Safe` commands stays un-sandboxed,
//! and callers fall back to an explicit allow-list flag when bwrap is absent.

use crate::{process_run, CoreToolError, CoreToolErrorCode, CoreToolResult, ProcessRunRequest, ProcessRunResult};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

const SANDBOX_TIMEOUT_MS: u64 = 120_000;

/// What the sandbox exposes and hides.
#[derive(Clone, Debug)]
pub struct SandboxConfig {
    /// The writable workspace root, bind-mounted read-write.
    pub workspace: PathBuf,
    /// The MindCode config directory (holds `credentials.json`).  Replaced by
    /// an empty tmpfs inside the sandbox so the credential store is unreadable.
    pub config_home: PathBuf,
    /// Whether the sandboxed process may reach the network.  Off by default:
    /// isolation drops the net namespace unless the caller explicitly opts in.
    pub network: NetworkPolicy,
}

/// Network exposure for a sandboxed command.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NetworkPolicy {
    /// No network: the net namespace is unshared and the command is offline.
    #[default]
    Deny,
    /// The command shares the host network namespace (e.g. `cargo build` that
    /// must fetch dependencies).  Requires an explicit opt-in.
    Allow,
}

impl SandboxConfig {
    pub fn new(workspace: PathBuf, config_home: PathBuf) -> Self {
        Self {
            workspace,
            config_home,
            network: NetworkPolicy::Deny,
        }
    }

    /// Opt a sandboxed command into network access (default is offline).
    pub fn with_network(mut self, network: NetworkPolicy) -> Self {
        self.network = network;
        self
    }
}

/// Whether a `bwrap` binary is reachable on `$PATH`.
pub fn bwrap_available() -> bool {
    find_bwrap().is_some()
}

fn find_bwrap() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join("bwrap");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = std::fs::metadata(&candidate)
                .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
                .unwrap_or(false);
            if executable {
                return Some(candidate);
            }
        }
        #[cfg(not(unix))]
        {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Build the full `bwrap` argv.  Deterministic and independent of bwrap being
/// installed, so the layout is unit-testable.
pub fn build_bwrap_argv(config: &SandboxConfig, command: &[String]) -> Vec<String> {
    let mut argv: Vec<String> = vec![
        "bwrap".to_owned(),
        "--die-with-parent".to_owned(),
        "--unshare-all".to_owned(),
        // Read-only root: system binaries and libraries stay available, but
        // nothing outside the writable mounts can be modified.
        "--ro-bind".to_owned(),
        "/".to_owned(),
        "/".to_owned(),
        "--proc".to_owned(),
        "/proc".to_owned(),
        "--dev".to_owned(),
        "/dev".to_owned(),
        "--tmpfs".to_owned(),
        "/tmp".to_owned(),
        // The workspace is the only writable tree.
        "--bind".to_owned(),
        config.workspace.to_string_lossy().into_owned(),
        config.workspace.to_string_lossy().into_owned(),
        // Hide the credential store: an empty tmpfs replaces the config dir.
        "--tmpfs".to_owned(),
        config.config_home.to_string_lossy().into_owned(),
        "--chdir".to_owned(),
        config.workspace.to_string_lossy().into_owned(),
        "--clearenv".to_owned(),
        "--setenv".to_owned(),
        "PATH".to_owned(),
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_owned(),
        "--setenv".to_owned(),
        "HOME".to_owned(),
        config.workspace.to_string_lossy().into_owned(),
        "--setenv".to_owned(),
        "TMPDIR".to_owned(),
        "/tmp".to_owned(),
        "--".to_owned(),
    ];
    if config.network == NetworkPolicy::Allow {
        // `--unshare-all` drops the net namespace; `--share-net` re-adds it so
        // the command can reach the network while every other namespace stays
        // isolated. Insert it right after `--unshare-all` (index 2).
        argv.insert(3, "--share-net".to_owned());
    }
    argv.extend(command.iter().cloned());
    argv
}

/// Run one command under the sandbox, reusing the bounded process runner.
/// Returns an error when bwrap is unavailable so the caller can apply its
/// explicit fallback policy (never a silent unsandboxed execution).
pub async fn run_sandboxed(
    config: &SandboxConfig,
    command: &[String],
    cancel: &CancellationToken,
) -> CoreToolResult<ProcessRunResult> {
    if command.is_empty() || command[0].is_empty() {
        return Err(CoreToolError::new(
            CoreToolErrorCode::InvalidArgv,
            "sandboxed command must not be empty",
        ));
    }
    let bwrap = find_bwrap().ok_or_else(|| {
        CoreToolError::new(
            CoreToolErrorCode::ProcessSpawn,
            "bwrap is not available; the sandbox cannot run",
        )
    })?;
    let mut argv = build_bwrap_argv(config, command);
    argv[0] = bwrap.to_string_lossy().into_owned();
    let request = ProcessRunRequest {
        argv,
        cwd: config.workspace.clone(),
        env: Default::default(),
        stdin: None,
        timeout_ms: SANDBOX_TIMEOUT_MS,
        max_output_bytes: 1024 * 1024,
    };
    process_run(request, cancel.clone()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SandboxConfig {
        SandboxConfig::new(
            PathBuf::from("/workspace"),
            PathBuf::from("/home/user/.config/mindcode"),
        )
    }

    #[test]
    fn argv_hides_credentials_and_mounts_workspace_rw() {
        let argv = build_bwrap_argv(&config(), &["sh".to_owned(), "-c".to_owned(), "true".to_owned()]);
        assert_eq!(argv[0], "bwrap");
        // Read-only root + writable workspace.
        assert!(argv.windows(2).any(|pair| pair == ["--ro-bind", "/"]));
        assert!(argv.windows(2).any(|pair| pair == ["--bind", "/workspace"]));
        // Credential store is replaced by a tmpfs.
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--tmpfs", "/home/user/.config/mindcode"]));
        // The original command is preserved verbatim at the tail.
        assert_eq!(argv[argv.len() - 3..], ["sh", "-c", "true"]);
    }

    #[test]
    fn network_is_denied_by_default_and_opt_in_shares_it() {
        let command = ["sh".to_owned(), "-c".to_owned(), "true".to_owned()];
        // Default: no `--share-net`, the net namespace stays unshared.
        let denied = build_bwrap_argv(&config(), &command);
        assert!(!denied.iter().any(|arg| arg == "--share-net"));
        // Opt-in: `--share-net` follows `--unshare-all`.
        let allowed = build_bwrap_argv(&config().with_network(NetworkPolicy::Allow), &command);
        let unshare = allowed.iter().position(|arg| arg == "--unshare-all").unwrap();
        assert_eq!(allowed[unshare + 1], "--share-net");
    }

    #[tokio::test]
    async fn sandbox_hides_the_config_dir_but_runs_commands() {
        if !bwrap_available() {
            return;
        }
        let workspace = std::env::temp_dir().join(format!(
            "mindcode-sandbox-ws-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let config_home = std::env::temp_dir().join(format!(
            "mindcode-sandbox-cfg-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_home).unwrap();
        let secret = config_home.join("credentials.json");
        std::fs::write(&secret, "{\"vexzy\":\"super-secret-value\"}").unwrap();

        let config = SandboxConfig::new(workspace.clone(), config_home.clone());
        let cancel = CancellationToken::new();

        // The credential store is hidden behind an empty tmpfs, so reading it
        // must fail inside the sandbox even though it exists on the host.
        let probe = format!(
            "if cat '{}' 2>/dev/null; then echo LEAKED; else echo HIDDEN; fi",
            secret.display()
        );
        let read = run_sandboxed(
            &config,
            &["sh".to_owned(), "-c".to_owned(), probe],
            &cancel,
        )
        .await
        .unwrap();
        assert!(read.stdout.contains("HIDDEN"), "unexpected output: {}", read.stdout);
        assert!(!read.stdout.contains("LEAKED"));
        assert!(!read.stdout.contains("super-secret-value"));

        // A trivial command runs.
        let ok = run_sandboxed(
            &config,
            &["sh".to_owned(), "-c".to_owned(), "echo ok".to_owned()],
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(ok.stdout.trim(), "ok");

        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&config_home);
    }
}
