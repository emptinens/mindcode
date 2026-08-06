use crate::{CoreToolError, CoreToolErrorCode, CoreToolResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout as time_timeout, Duration};
use tokio_util::sync::CancellationToken;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_ARGV: usize = 128;
const MAX_ARG_BYTES: usize = 16 * 1024;
const MAX_ARGV_BYTES: usize = 64 * 1024;
const MAX_ENV: usize = 64;
const MAX_ENV_KEY_BYTES: usize = 256;
const MAX_ENV_VALUE_BYTES: usize = 64 * 1024;
const MAX_ENV_BYTES: usize = 4 * 1024 * 1024;
const MAX_STDIN_BYTES: usize = 1024 * 1024;
const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_CWD_BYTES: usize = 16 * 1024;
const READ_CHUNK_BYTES: usize = 8192;
const POST_TERMINATION_GRACE_MS: u64 = 250;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessRunRequest {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub stdin: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessRunResult {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug)]
struct OutputState {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    used: usize,
    budget: usize,
    truncated: bool,
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

fn default_max_output_bytes() -> usize {
    DEFAULT_MAX_OUTPUT_BYTES
}

impl ProcessRunRequest {
    pub fn validate(&self) -> CoreToolResult<()> {
        if self.argv.is_empty() || self.argv.len() > MAX_ARGV || self.argv[0].is_empty() {
            return Err(CoreToolError::new(
                CoreToolErrorCode::InvalidArgv,
                "argv must contain 1..128 items and argv[0] must not be empty",
            ));
        }
        let mut argv_bytes = 0usize;
        for arg in &self.argv {
            if arg.len() > MAX_ARG_BYTES || contains_forbidden_text_control(arg) {
                return Err(CoreToolError::new(
                    CoreToolErrorCode::InvalidArgv,
                    "argv item exceeds its bound or contains a forbidden control character",
                ));
            }
            argv_bytes = argv_bytes.saturating_add(arg.len());
        }
        if argv_bytes > MAX_ARGV_BYTES {
            return Err(CoreToolError::new(
                CoreToolErrorCode::InvalidArgv,
                "argv exceeds its total byte bound",
            ));
        }
        validate_cwd(&self.cwd)?;
        if self.env.len() > MAX_ENV {
            return Err(CoreToolError::new(
                CoreToolErrorCode::InvalidEnvironment,
                "env must contain at most 64 entries",
            ));
        }
        let mut env_bytes = 0usize;
        for (key, value) in &self.env {
            if key.is_empty()
                || key.len() > MAX_ENV_KEY_BYTES
                || value.len() > MAX_ENV_VALUE_BYTES
                || key.contains('\0')
                || key.contains('=')
                || contains_forbidden_text_control(key)
                || contains_forbidden_text_control(value)
            {
                return Err(CoreToolError::new(
                    CoreToolErrorCode::InvalidEnvironment,
                    "env contains an invalid key or value",
                ));
            }
            if is_credential_shaped_key(key) {
                return Err(CoreToolError::new(
                    CoreToolErrorCode::InvalidEnvironment,
                    "credential-shaped environment keys are not allowed",
                ));
            }
            env_bytes = env_bytes
                .saturating_add(key.len())
                .saturating_add(value.len());
        }
        if env_bytes > MAX_ENV_BYTES {
            return Err(CoreToolError::new(
                CoreToolErrorCode::InvalidEnvironment,
                "env exceeds its total byte bound",
            ));
        }
        if self.stdin.as_ref().is_some_and(|data| {
            data.len() > MAX_STDIN_BYTES || contains_forbidden_stdin_control(data)
        }) {
            return Err(CoreToolError::new(
                CoreToolErrorCode::InvalidInput,
                "stdin exceeds its bound or contains a forbidden control character",
            ));
        }
        if !(1..=MAX_TIMEOUT_MS).contains(&self.timeout_ms) {
            return Err(CoreToolError::new(
                CoreToolErrorCode::InvalidInput,
                "timeout_ms must be between 1 and 120000",
            ));
        }
        if !(1..=MAX_OUTPUT_BYTES).contains(&self.max_output_bytes) {
            return Err(CoreToolError::new(
                CoreToolErrorCode::InvalidInput,
                "max_output_bytes must be between 1 and 8 MiB",
            ));
        }
        Ok(())
    }
}

pub async fn process_run(
    request: ProcessRunRequest,
    cancellation: CancellationToken,
) -> CoreToolResult<ProcessRunResult> {
    request.validate()?;
    let started = Instant::now();
    let mut command = Command::new(&request.argv[0]);
    command
        .args(&request.argv[1..])
        .current_dir(&request.cwd)
        .env_clear()
        .kill_on_drop(true)
        .stdin(if request.stdin.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    add_safe_environment(&mut command, &request.env);
    configure_process_group(&mut command);
    let mut child = command.spawn().map_err(|_| {
        CoreToolError::new(
            CoreToolErrorCode::ProcessSpawn,
            "process could not be spawned",
        )
    })?;

    let output = Arc::new(Mutex::new(OutputState {
        stdout: Vec::new(),
        stderr: Vec::new(),
        used: 0,
        budget: request.max_output_bytes,
        truncated: false,
    }));
    let stdout = child.stdout.take().ok_or_else(|| {
        CoreToolError::new(CoreToolErrorCode::ProcessIo, "stdout pipe was unavailable")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        CoreToolError::new(CoreToolErrorCode::ProcessIo, "stderr pipe was unavailable")
    })?;
    let stdout_task = tokio::spawn(read_output(stdout, Arc::clone(&output), true));
    let stderr_task = tokio::spawn(read_output(stderr, Arc::clone(&output), false));
    let stdin_task = request.stdin.map(|data| {
        let mut stdin = child.stdin.take().expect("stdin configured");
        tokio::spawn(async move {
            let result = stdin.write_all(data.as_bytes()).await;
            drop(stdin);
            result
        })
    });

    let timeout = sleep(Duration::from_millis(request.timeout_ms));
    tokio::pin!(timeout);
    let mut timed_out = false;
    let mut terminated = false;
    let cancelled = tokio::select! {
        status = child.wait() => {
            status.map_err(|_| CoreToolError::new(CoreToolErrorCode::ProcessIo, "process wait failed"))?;
            false
        }
        _ = &mut timeout => {
            timed_out = true;
            terminate_process_group(&mut child).await;
            terminated = true;
            false
        }
        _ = cancellation.cancelled() => {
            terminate_process_group(&mut child).await;
            terminated = true;
            true
        }
    };

    let child_wait_failed = if terminated {
        !matches!(
            time_timeout(
                Duration::from_millis(POST_TERMINATION_GRACE_MS),
                child.wait(),
            )
            .await,
            Ok(Ok(_))
        )
    } else {
        false
    };

    // A child can exit successfully after spawning a detached descendant that
    // inherited its pipes. Bound every post-exit join, not only forced
    // termination, so the request timeout cannot be bypassed by held FDs.
    let stdin_join = async {
        match stdin_task {
            Some(task) => join_io_task_bounded(task).await,
            None => Some(Ok(())),
        }
    };
    let (stdin_result, stdout_result, stderr_result) = tokio::join!(
        stdin_join,
        join_io_task_bounded(stdout_task),
        join_io_task_bounded(stderr_task),
    );
    let _ = stdin_result;
    if stdout_result.is_none() || stderr_result.is_none() {
        output.lock().await.truncated = true;
    }
    if !cancelled {
        if let Some(result) = stdout_result {
            result.map_err(|_| {
                CoreToolError::new(CoreToolErrorCode::ProcessIo, "stdout read failed")
            })?;
        }
        if let Some(result) = stderr_result {
            result.map_err(|_| {
                CoreToolError::new(CoreToolErrorCode::ProcessIo, "stderr read failed")
            })?;
        }
    }
    if child_wait_failed {
        return Err(CoreToolError::new(
            CoreToolErrorCode::ProcessIo,
            "process was not reaped after termination",
        ));
    }
    if cancelled {
        return Err(CoreToolError::new(
            CoreToolErrorCode::Cancelled,
            "process run was cancelled",
        ));
    }

    let status = child
        .try_wait()
        .map_err(|_| {
            CoreToolError::new(CoreToolErrorCode::ProcessIo, "process status unavailable")
        })?
        .ok_or_else(|| {
            CoreToolError::new(CoreToolErrorCode::ProcessIo, "process was not reaped")
        })?;
    let output = Arc::try_unwrap(output)
        .map_err(|_| CoreToolError::new(CoreToolErrorCode::ProcessIo, "output state unavailable"))?
        .into_inner();
    #[cfg(unix)]
    let signal = std::os::unix::process::ExitStatusExt::signal(&status);
    #[cfg(not(unix))]
    let signal = None;
    Ok(ProcessRunResult {
        exit_code: status.code(),
        signal,
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        timed_out,
        truncated: output.truncated,
        duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
    })
}

async fn read_output<R>(
    mut reader: R,
    output: Arc<Mutex<OutputState>>,
    is_stdout: bool,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0u8; READ_CHUNK_BYTES];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            return Ok(());
        }
        let mut state = output.lock().await;
        let remaining = state.budget.saturating_sub(state.used);
        let kept = remaining.min(count);
        if kept > 0 {
            if is_stdout {
                state.stdout.extend_from_slice(&buffer[..kept]);
            } else {
                state.stderr.extend_from_slice(&buffer[..kept]);
            }
            state.used += kept;
        }
        if kept < count {
            state.truncated = true;
        }
    }
}

async fn join_io_task_bounded(
    mut task: JoinHandle<std::io::Result<()>>,
) -> Option<std::io::Result<()>> {
    match time_timeout(Duration::from_millis(POST_TERMINATION_GRACE_MS), &mut task).await {
        Ok(Ok(result)) => Some(result),
        Ok(Err(_)) => None,
        Err(_) => {
            task.abort();
            let _ = task.await;
            None
        }
    }
}

fn validate_cwd(cwd: &Path) -> CoreToolResult<()> {
    if path_bytes_len(cwd) > MAX_CWD_BYTES || path_has_control(cwd) {
        return Err(CoreToolError::new(
            CoreToolErrorCode::InvalidCwd,
            "cwd exceeds its byte bound or contains a forbidden control character",
        ));
    }
    if !cwd.is_absolute() {
        return Err(CoreToolError::new(
            CoreToolErrorCode::InvalidCwd,
            "cwd must be an absolute path",
        ));
    }
    match std::fs::metadata(cwd) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        _ => Err(CoreToolError::new(
            CoreToolErrorCode::InvalidCwd,
            "cwd must be an existing directory",
        )),
    }
}

fn is_credential_shaped_key(key: &str) -> bool {
    let normalized = key.to_ascii_uppercase().replace(['-', '.'], "_");
    if normalized == "VEXZY_API_KEY" || normalized == "AUTHORIZATION" {
        return true;
    }
    let words: Vec<&str> = normalized.split('_').collect();
    words.iter().any(|word| {
        matches!(
            *word,
            "AUTH"
                | "AUTHORIZATION"
                | "TOKEN"
                | "SECRET"
                | "PASSWORD"
                | "PASSWD"
                | "CREDENTIAL"
                | "CREDENTIALS"
                | "COOKIE"
                | "BEARER"
        )
    }) || (words.contains(&"API") && words.contains(&"KEY"))
        || (words.contains(&"PRIVATE") && words.contains(&"KEY"))
        || (words.contains(&"ACCESS") && words.contains(&"KEY"))
        || normalized.ends_with("_KEY")
}

fn add_safe_environment(command: &mut Command, requested: &BTreeMap<String, String>) {
    for (key, value) in std::env::vars_os() {
        let key_string = key.to_string_lossy();
        if is_safe_inherited_key(&key_string) {
            command.env(&key, &value);
        }
    }
    for (key, value) in requested {
        command.env(key, value);
    }
}

fn is_safe_inherited_key(key: &str) -> bool {
    matches!(key, "PATH" | "HOME" | "TMPDIR" | "TERM" | "LANG") || key.starts_with("LC_")
}

fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(not(unix))]
    let _ = command;
}

async fn terminate_process_group(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
        // SAFETY: the child was placed in a private process group before exec.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = time_timeout(
        Duration::from_millis(POST_TERMINATION_GRACE_MS),
        child.kill(),
    )
    .await;
}

fn path_bytes_len(path: &Path) -> usize {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().len()
    }
    #[cfg(not(unix))]
    {
        path.to_string_lossy().len()
    }
}

fn contains_forbidden_text_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| (character as u32) < 0x20 || character as u32 == 0x7f)
}

fn contains_forbidden_stdin_control(value: &str) -> bool {
    value.chars().any(|character| {
        let code = character as u32;
        (code < 0x20 && !matches!(code, 9 | 10 | 13)) || code == 0x7f
    })
}

fn path_has_control(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str()
            .as_bytes()
            .iter()
            .any(|byte| *byte < 0x20 || *byte == 0x7f)
    }
    #[cfg(not(unix))]
    {
        path.to_string_lossy()
            .chars()
            .any(|character| (character as u32) < 0x20 || character as u32 == 0x7f)
    }
}
