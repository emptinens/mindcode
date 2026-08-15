//! Opt-in OS-level shell isolation via bubblewrap (§13.1).
//!
//! The static risk filter (§11.1) is defense-in-depth, not a sandbox: an
//! obfuscated command can still read `credentials.json`. This module builds a
//! bubblewrap invocation that makes the rest of the filesystem read-only,
//! hides the MindCode config directory behind an empty tmpfs (so the
//! credential store is unreadable), and leaves only the workspace writable.
//! It is opt-in by design: the fast path for `Safe` commands stays un-sandboxed,
//! and callers fall back to an explicit allow-list flag when bwrap is absent.

use crate::{
    open_seccomp_bpf_fd, process_run, CoreToolError, CoreToolErrorCode, CoreToolResult,
    ProcessRunRequest, ProcessRunResult, ResourceLimits,
};
use std::os::fd::RawFd;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

const SANDBOX_TIMEOUT_MS: u64 = 120_000;

/// Sensible resource bounds for a sandboxed command (§13.1): cap open FDs and
/// single-file size so a runaway command cannot exhaust the host. `nproc` is
/// deliberately left unset — RLIMIT_NPROC is a per-UID (host-wide) limit that
/// would starve every process of the launching user, not just the sandbox.
/// Process count stays bounded by `--unshare-pid`, the timeout, and
/// `--die-with-parent` instead.
fn default_rlimits() -> ResourceLimits {
    ResourceLimits {
        nofile: Some(256),
        fsize: Some(1024 * 1024 * 1024),
        nproc: None,
    }
}

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
    /// Resource bounds applied to the sandboxed process.
    pub rlimits: ResourceLimits,
    /// Whether to install the seccomp (cBPF) syscall denylist (§13.1). On by
    /// default; the denylist refuses escape/host-global-state syscalls while
    /// leaving the normal build surface open.
    pub seccomp: bool,
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
            rlimits: default_rlimits(),
            seccomp: true,
        }
    }

    /// Opt a sandboxed command into network access (default is offline).
    pub fn with_network(mut self, network: NetworkPolicy) -> Self {
        self.network = network;
        self
    }

    /// Override the sandbox resource bounds (defaults are already applied).
    pub fn with_rlimits(mut self, rlimits: ResourceLimits) -> Self {
        self.rlimits = rlimits;
        self
    }

    /// Disable the seccomp denylist (e.g. for compatibility debugging).
    pub fn with_seccomp(mut self, enabled: bool) -> Self {
        self.seccomp = enabled;
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
    // The seccomp program must be built before spawn and its fd kept open
    // until the child execs bwrap (which reads it via `--seccomp <fd>`).
    let seccomp_fd = if config.seccomp {
        Some(open_seccomp_bpf_fd()?)
    } else {
        None
    };
    let seccomp_raw = seccomp_fd.as_ref().map(std::os::fd::AsRawFd::as_raw_fd);
    if let Some(fd) = seccomp_raw {
        insert_seccomp(&mut argv, fd)?;
    }
    let request = ProcessRunRequest {
        argv,
        cwd: config.workspace.clone(),
        env: Default::default(),
        stdin: None,
        timeout_ms: SANDBOX_TIMEOUT_MS,
        max_output_bytes: 1024 * 1024,
        rlimits: Some(config.rlimits),
        seccomp_fd: seccomp_raw,
    };
    process_run(request, cancel.clone()).await
}

/// Insert `--seccomp <fd>` immediately before the `--` separator so the option
/// stays on the bwrap side of the command line. Returns an error if the
/// separator is missing (which would mean a malformed argv layout).
fn insert_seccomp(argv: &mut Vec<String>, fd: RawFd) -> CoreToolResult<()> {
    let separator = argv.iter().position(|arg| arg == "--").ok_or_else(|| {
        CoreToolError::new(
            CoreToolErrorCode::InvalidArgv,
            "bwrap argv is missing the command separator",
        )
    })?;
    argv.splice(
        separator..separator,
        ["--seccomp".to_owned(), fd.to_string()],
    );
    Ok(())
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
        let argv = build_bwrap_argv(
            &config(),
            &["sh".to_owned(), "-c".to_owned(), "true".to_owned()],
        );
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
    fn insert_seccomp_places_the_flag_before_the_command_separator() {
        let mut argv = build_bwrap_argv(
            &config(),
            &["sh".to_owned(), "-c".to_owned(), "true".to_owned()],
        );
        insert_seccomp(&mut argv, 42).unwrap();
        let separator = argv.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(argv[separator - 2], "--seccomp");
        assert_eq!(argv[separator - 1], "42");
        // The command tail is untouched.
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
        let unshare = allowed
            .iter()
            .position(|arg| arg == "--unshare-all")
            .unwrap();
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
        let read = run_sandboxed(&config, &["sh".to_owned(), "-c".to_owned(), probe], &cancel)
            .await
            .unwrap();
        assert!(
            read.stdout.contains("HIDDEN"),
            "unexpected output: {}",
            read.stdout
        );
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

    #[tokio::test]
    async fn seccomp_filter_is_loaded_by_default_and_absent_when_disabled() {
        if !bwrap_available() {
            return;
        }
        let workspace = temp_dir("mindcode-seccomp-ws");
        let config_home = temp_dir("mindcode-seccomp-cfg");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_home).unwrap();
        let cancel = CancellationToken::new();
        let probe = [
            "sh".to_owned(),
            "-c".to_owned(),
            "awk '/^Seccomp:/ {print $2}' /proc/self/status".to_owned(),
        ];

        // Default: the denylist is installed, so the kernel reports
        // SECCOMP_MODE_FILTER (2).
        let on = run_sandboxed(
            &SandboxConfig::new(workspace.clone(), config_home.clone()),
            &probe,
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(on.stdout.trim(), "2", "seccomp should be active by default");

        // Explicitly disabled: no filter, kernel reports 0.
        let off = run_sandboxed(
            &SandboxConfig::new(workspace.clone(), config_home.clone()).with_seccomp(false),
            &probe,
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(
            off.stdout.trim(),
            "0",
            "seccomp should be absent when disabled"
        );

        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&config_home);
    }

    #[tokio::test]
    async fn seccomp_denies_ptrace_that_the_off_config_allows() {
        if !bwrap_available() || !python3_available() {
            return;
        }
        let workspace = temp_dir("mindcode-seccomp-ptrace-ws");
        let config_home = temp_dir("mindcode-seccomp-ptrace-cfg");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&config_home).unwrap();
        let cancel = CancellationToken::new();
        // PTRACE_TRACEME needs no capability; the denylist is the only thing
        // that can refuse it inside bwrap (which already drops all caps).
        let probe = [
            "python3".to_owned(),
            "-c".to_owned(),
            "import ctypes; r=ctypes.CDLL('libc.so.6').ptrace(0,0,0,0); print('OK' if r==0 else 'EPERM')".to_owned(),
        ];

        let denied = run_sandboxed(
            &SandboxConfig::new(workspace.clone(), config_home.clone()),
            &probe,
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(
            denied.stdout.trim(),
            "EPERM",
            "ptrace must be denied by seccomp"
        );

        let allowed = run_sandboxed(
            &SandboxConfig::new(workspace.clone(), config_home.clone()).with_seccomp(false),
            &probe,
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(
            allowed.stdout.trim(),
            "OK",
            "ptrace succeeds without the denylist"
        );

        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&config_home);
    }

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    fn python3_available() -> bool {
        std::process::Command::new("python3")
            .arg("-c")
            .arg("pass")
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}
