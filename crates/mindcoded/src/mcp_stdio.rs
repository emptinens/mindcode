//! Reusable, shell-free MCP stdio process supervision.
//!
//! This file is intentionally standalone so daemon RPC wiring can add it to the
//! crate later without changing the current daemon module graph.

use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::{OsStr, OsString},
    fmt, io,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, Weak,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{Mutex as AsyncMutex, Notify},
};
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_STDERR_BYTES: usize = 64 * 1024;
pub const DEFAULT_STDOUT_QUEUE_MESSAGES: usize = 128;
pub const DEFAULT_STDOUT_QUEUE_BYTES: usize = 32 * 1024 * 1024;
pub const DEFAULT_GLOBAL_STDOUT_QUEUE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_CONNECTION_ID_BYTES: usize = 128;
pub const MAX_COMMAND_BYTES: usize = 4 * 1024;
pub const MAX_ARGUMENTS: usize = 128;
pub const MAX_ARGUMENT_BYTES: usize = 8 * 1024;
pub const MAX_ARGUMENT_TOTAL_BYTES: usize = 1024 * 1024;
pub const MAX_CWD_BYTES: usize = 4 * 1024;
pub const MAX_ENV_ENTRIES: usize = 128;
pub const MAX_ENV_KEY_BYTES: usize = 256;
pub const MAX_ENV_VALUE_BYTES: usize = 32 * 1024;
pub const MAX_ENV_TOTAL_BYTES: usize = 1024 * 1024;
/// Maximum number of MCP child processes, including connections still spawning.
pub const MAX_MCP_CONNECTIONS: usize = 64;

const CHILD_EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
// Process termination must never wait indefinitely on a broken child or a
// descendant that retained one of the child's pipes.
const PROCESS_REAP_TIMEOUT: Duration = Duration::from_millis(500);
const OPENING_RESOLUTION_TIMEOUT: Duration = Duration::from_secs(2);
const STDIN_LOCK_TIMEOUT: Duration = Duration::from_millis(500);
const STDIN_IO_TIMEOUT: Duration = Duration::from_millis(500);
const STDERR_READ_CHUNK_BYTES: usize = 8 * 1024;
const INHERITED_ENV_TOTAL_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpStdioErrorCode {
    NotFound,
    AlreadyExists,
    InvalidConnectionId,
    ConnectionLimit,
    InvalidCommand,
    InvalidArguments,
    InvalidCwd,
    InvalidEnvironment,
    ForbiddenEnvironment,
    SpawnFailed,
    IoError,
    InvalidJsonRpc,
    MessageTooLarge,
    OversizedLine,
    MalformedJson,
    QueueOverflow,
    Cancelled,
    Timeout,
    Closed,
    ChildExited,
}

impl McpStdioErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::AlreadyExists => "already_exists",
            Self::InvalidConnectionId => "invalid_connection_id",
            Self::ConnectionLimit => "connection_limit",
            Self::InvalidCommand => "invalid_command",
            Self::InvalidArguments => "invalid_arguments",
            Self::InvalidCwd => "invalid_cwd",
            Self::InvalidEnvironment => "invalid_environment",
            Self::ForbiddenEnvironment => "forbidden_environment",
            Self::SpawnFailed => "spawn_failed",
            Self::IoError => "io_error",
            Self::InvalidJsonRpc => "invalid_json_rpc",
            Self::MessageTooLarge => "message_too_large",
            Self::OversizedLine => "oversized_line",
            Self::MalformedJson => "malformed_json",
            Self::QueueOverflow => "queue_overflow",
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
            Self::Closed => "closed",
            Self::ChildExited => "child_exited",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpStdioError {
    code: McpStdioErrorCode,
}

impl McpStdioError {
    pub const fn new(code: McpStdioErrorCode) -> Self {
        Self { code }
    }

    pub const fn code(self) -> McpStdioErrorCode {
        self.code
    }

    pub const fn stable_code(self) -> &'static str {
        self.code.as_str()
    }
}

impl fmt::Display for McpStdioError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code.as_str())
    }
}

impl std::error::Error for McpStdioError {}

#[derive(Debug, Clone)]
pub struct McpStdioConfig {
    pub stdout_queue_max_messages: usize,
    pub stdout_queue_max_bytes: usize,
    pub global_stdout_queue_max_bytes: usize,
}

impl Default for McpStdioConfig {
    fn default() -> Self {
        Self {
            stdout_queue_max_messages: DEFAULT_STDOUT_QUEUE_MESSAGES,
            stdout_queue_max_bytes: DEFAULT_STDOUT_QUEUE_BYTES,
            global_stdout_queue_max_bytes: DEFAULT_GLOBAL_STDOUT_QUEUE_BYTES,
        }
    }
}

impl McpStdioConfig {
    pub const fn with_limits(max_messages: usize, max_bytes: usize) -> Self {
        Self {
            stdout_queue_max_messages: max_messages,
            stdout_queue_max_bytes: max_bytes,
            global_stdout_queue_max_bytes: DEFAULT_GLOBAL_STDOUT_QUEUE_BYTES,
        }
    }

    pub const fn with_limits_and_global(
        max_messages: usize,
        max_bytes: usize,
        global_max_bytes: usize,
    ) -> Self {
        Self {
            stdout_queue_max_messages: max_messages,
            stdout_queue_max_bytes: max_bytes,
            global_stdout_queue_max_bytes: global_max_bytes,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpStdioConnectionState {
    Running,
    Terminal,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpStdioStatus {
    pub connection_id: String,
    pub pid: Option<u32>,
    pub state: McpStdioConnectionState,
    pub queued_messages: usize,
    pub queued_bytes: usize,
    pub stderr_bytes: usize,
    pub terminal_error: Option<McpStdioErrorCode>,
    pub uptime_ms: u64,
}

#[derive(Clone)]
pub struct McpStdioSupervisor {
    inner: Arc<SupervisorInner>,
}

struct SupervisorInner {
    registry: Mutex<Registry>,
    config: McpStdioConfig,
    global_queue_bytes: Arc<std::sync::atomic::AtomicUsize>,
    opening_notify: Notify,
    close_all_lock: AsyncMutex<()>,
}

struct Registry {
    connections: HashMap<String, Arc<Connection>>,
    openings: HashSet<String>,
    pending_closes: HashSet<String>,
    closing: bool,
}

struct Connection {
    id: String,
    pid: Option<u32>,
    process: Arc<ProcessHandle>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    state: Mutex<ConnectionState>,
    stderr: Mutex<VecDeque<u8>>,
    notify: Notify,
    started_at: Instant,
    config: McpStdioConfig,
    global_queue_bytes: Arc<std::sync::atomic::AtomicUsize>,
}

struct ConnectionState {
    closed: bool,
    child_exited: bool,
    stdout_closed: bool,
    terminal: Option<McpStdioErrorCode>,
    queue: VecDeque<QueuedMessage>,
    queue_bytes: usize,
}

struct QueuedMessage {
    value: Value,
    bytes: usize,
}

struct ProcessHandle {
    child: AsyncMutex<Option<Child>>,
    pid: Option<u32>,
    exited: AtomicBool,
}

impl McpStdioSupervisor {
    pub fn new() -> Self {
        Self::with_config(McpStdioConfig::default())
    }

    pub fn with_config(config: McpStdioConfig) -> Self {
        Self {
            inner: Arc::new(SupervisorInner {
                registry: Mutex::new(Registry {
                    connections: HashMap::new(),
                    openings: HashSet::new(),
                    pending_closes: HashSet::new(),
                    closing: false,
                }),
                config,
                global_queue_bytes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                opening_notify: Notify::new(),
                close_all_lock: AsyncMutex::new(()),
            }),
        }
    }

    pub fn with_limits(max_queue_messages: usize, max_queue_bytes: usize) -> Self {
        Self {
            inner: Arc::new(SupervisorInner {
                registry: Mutex::new(Registry {
                    connections: HashMap::new(),
                    openings: HashSet::new(),
                    pending_closes: HashSet::new(),
                    closing: false,
                }),
                config: McpStdioConfig::with_limits(max_queue_messages, max_queue_bytes),
                global_queue_bytes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                opening_notify: Notify::new(),
                close_all_lock: AsyncMutex::new(()),
            }),
        }
    }

    pub async fn open<C, P, I, A, Q, E, K, V>(
        &self,
        connection_id: C,
        command: P,
        args: I,
        cwd: Q,
        env: E,
    ) -> Result<McpStdioStatus, McpStdioError>
    where
        C: Into<String>,
        P: AsRef<OsStr>,
        I: IntoIterator<Item = A>,
        A: AsRef<OsStr>,
        Q: AsRef<Path>,
        E: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        let cancellation = CancellationToken::new();
        self.open_with_cancellation(connection_id, command, args, cwd, env, &cancellation)
            .await
    }

    pub async fn open_with_cancellation<C, P, I, A, Q, E, K, V>(
        &self,
        connection_id: C,
        command: P,
        args: I,
        cwd: Q,
        env: E,
        cancellation: &CancellationToken,
    ) -> Result<McpStdioStatus, McpStdioError>
    where
        C: Into<String>,
        P: AsRef<OsStr>,
        I: IntoIterator<Item = A>,
        A: AsRef<OsStr>,
        Q: AsRef<Path>,
        E: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        if cancellation.is_cancelled() {
            return Err(McpStdioError::new(McpStdioErrorCode::Cancelled));
        }
        let connection_id = connection_id.into();
        validate_connection_id(&connection_id)?;

        let command = command.as_ref().to_os_string();
        validate_command(&command)?;

        let args = collect_args(args)?;
        let cwd = validate_cwd(cwd.as_ref())?;
        let explicit_env = collect_explicit_env(env)?;
        let inherited_env = collect_safe_inherited_env();

        {
            let mut registry = lock(&self.inner.registry);
            if registry.closing
                || registry.connections.contains_key(&connection_id)
                || registry.openings.contains(&connection_id)
                || registry.pending_closes.contains(&connection_id)
            {
                return Err(McpStdioError::new(McpStdioErrorCode::AlreadyExists));
            }
            if registry
                .connections
                .len()
                .saturating_add(registry.openings.len())
                >= MAX_MCP_CONNECTIONS
            {
                return Err(McpStdioError::new(McpStdioErrorCode::ConnectionLimit));
            }
            registry.openings.insert(connection_id.clone());
        }

        #[cfg(test)]
        tokio::task::yield_now().await;

        let spawn_result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                let mut registry = lock(&self.inner.registry);
                registry.openings.remove(&connection_id);
                registry.pending_closes.remove(&connection_id);
                drop(registry);
                self.inner.opening_notify.notify_waiters();
                return Err(McpStdioError::new(McpStdioErrorCode::Cancelled));
            }
            result = self.spawn_connection(
                &connection_id,
                command,
                &args,
                &cwd,
                &inherited_env,
                &explicit_env,
            ) => result,
        };

        let (connection, stdout, stderr) = match spawn_result {
            Ok(connection) => connection,
            Err(error) => {
                let mut registry = lock(&self.inner.registry);
                registry.openings.remove(&connection_id);
                registry.pending_closes.remove(&connection_id);
                drop(registry);
                self.inner.opening_notify.notify_waiters();
                return Err(error);
            }
        };

        let insertion_error = {
            let mut registry = lock(&self.inner.registry);
            registry.openings.remove(&connection_id);
            let pending_close = registry.pending_closes.remove(&connection_id);
            if cancellation.is_cancelled() {
                Some(McpStdioError::new(McpStdioErrorCode::Cancelled))
            } else if registry.closing || pending_close {
                Some(McpStdioError::new(McpStdioErrorCode::Closed))
            } else if registry.connections.contains_key(&connection_id) {
                Some(McpStdioError::new(McpStdioErrorCode::AlreadyExists))
            } else {
                registry
                    .connections
                    .insert(connection_id.clone(), connection.clone());
                None
            }
        };
        if let Some(error) = insertion_error {
            connection.close().await;
            self.inner.opening_notify.notify_waiters();
            return Err(error);
        }
        self.inner.opening_notify.notify_waiters();

        if cancellation.is_cancelled() {
            // The cancellation may race the insertion check. Do not leave a
            // successfully inserted process behind after a cancelled open.
            let removed = {
                let mut registry = lock(&self.inner.registry);
                registry
                    .connections
                    .get(&connection_id)
                    .filter(|current| Arc::ptr_eq(current, &connection))
                    .is_some()
                    .then(|| registry.connections.remove(&connection_id))
                    .flatten()
            };
            if let Some(connection) = removed {
                connection.close().await;
                return Err(McpStdioError::new(McpStdioErrorCode::Cancelled));
            }
        }

        spawn_background_tasks(&connection, stdout, stderr);
        Ok(connection.status())
    }

    pub async fn send(&self, connection_id: &str, message: Value) -> Result<(), McpStdioError> {
        let connection = self.connection(connection_id)?;
        send_to_connection(&connection, message).await
    }

    pub async fn send_with_cancellation(
        &self,
        connection_id: &str,
        message: Value,
        cancellation: &CancellationToken,
    ) -> Result<(), McpStdioError> {
        let connection = self.connection(connection_id)?;
        if cancellation.is_cancelled() {
            connection.terminalize(McpStdioErrorCode::Cancelled);
            return Err(McpStdioError::new(McpStdioErrorCode::Cancelled));
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                connection.terminalize(McpStdioErrorCode::Cancelled);
                Err(McpStdioError::new(McpStdioErrorCode::Cancelled))
            }
            result = send_to_connection(&connection, message) => result,
        }
    }

    pub async fn receive(
        &self,
        connection_id: &str,
        cancellation: Option<CancellationToken>,
        timeout: Option<Duration>,
    ) -> Result<Value, McpStdioError> {
        let connection = self.connection(connection_id)?;
        receive_from_connection(&connection, cancellation.as_ref(), timeout).await
    }

    pub async fn receive_with_cancellation(
        &self,
        connection_id: &str,
        cancellation: &CancellationToken,
        timeout: Option<Duration>,
    ) -> Result<Value, McpStdioError> {
        self.receive(connection_id, Some(cancellation.clone()), timeout)
            .await
    }

    pub async fn receive_timeout(
        &self,
        connection_id: &str,
        timeout: Duration,
    ) -> Result<Value, McpStdioError> {
        self.receive(connection_id, None, Some(timeout)).await
    }

    pub fn try_receive(&self, connection_id: &str) -> Result<Option<Value>, McpStdioError> {
        let connection = self.connection(connection_id)?;
        match connection.poll_receive() {
            ReceivePoll::Message(message) => Ok(Some(message)),
            ReceivePoll::Wait => Ok(None),
            ReceivePoll::Error(error) => Err(error),
        }
    }

    pub fn status(&self, connection_id: &str) -> Result<McpStdioStatus, McpStdioError> {
        self.connection(connection_id)
            .map(|connection| connection.status())
    }

    pub fn list(&self) -> Vec<McpStdioStatus> {
        let connections = {
            let registry = lock(&self.inner.registry);
            registry.connections.values().cloned().collect::<Vec<_>>()
        };
        let mut statuses = connections
            .iter()
            .map(|connection| connection.status())
            .collect::<Vec<_>>();
        statuses.sort_by(|left, right| left.connection_id.cmp(&right.connection_id));
        statuses
    }

    pub async fn close(&self, connection_id: &str) -> Result<(), McpStdioError> {
        let deadline = Instant::now() + OPENING_RESOLUTION_TIMEOUT;
        let connection = loop {
            let notified = self.inner.opening_notify.notified();
            let (connection, opening) = {
                let mut registry = lock(&self.inner.registry);
                let connection = registry.connections.get(connection_id).cloned();
                let opening = registry.openings.contains(connection_id);
                if opening && connection.is_none() {
                    // This tombstone survives a bounded close timeout. The
                    // opener must observe it before insertion and reap the
                    // just-spawned process instead of orphaning it.
                    registry.pending_closes.insert(connection_id.to_owned());
                }
                (connection, opening)
            };
            if connection.is_some() || !opening {
                break connection;
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err(McpStdioError::new(McpStdioErrorCode::Timeout));
            };
            if tokio::time::timeout(remaining, notified).await.is_err() {
                return Err(McpStdioError::new(McpStdioErrorCode::Timeout));
            }
        };

        let Some(connection) = connection else {
            lock(&self.inner.registry)
                .pending_closes
                .remove(connection_id);
            return Ok(());
        };

        lock(&self.inner.registry)
            .pending_closes
            .remove(connection_id);
        connection.close().await;

        let mut registry = lock(&self.inner.registry);
        if registry
            .connections
            .get(connection_id)
            .is_some_and(|current| Arc::ptr_eq(current, &connection))
        {
            registry.connections.remove(connection_id);
        }
        Ok(())
    }

    pub async fn close_all(&self) -> Result<(), McpStdioError> {
        // Serialize shutdown passes. Otherwise one call can clear `closing`
        // while another is still draining or waiting for an opening.
        let _close_all_guard = self.inner.close_all_lock.lock().await;
        {
            let mut registry = lock(&self.inner.registry);
            registry.closing = true;
        }

        let connections = {
            let mut registry = lock(&self.inner.registry);
            registry
                .connections
                .drain()
                .map(|(_, connection)| connection)
                .collect::<Vec<_>>()
        };

        for connection in connections {
            connection.close().await;
        }

        loop {
            let notified = self.inner.opening_notify.notified();
            if lock(&self.inner.registry).openings.is_empty() {
                break;
            }
            notified.await;
        }

        lock(&self.inner.registry).closing = false;
        Ok(())
    }

    fn connection(&self, connection_id: &str) -> Result<Arc<Connection>, McpStdioError> {
        lock(&self.inner.registry)
            .connections
            .get(connection_id)
            .cloned()
            .ok_or_else(|| McpStdioError::new(McpStdioErrorCode::NotFound))
    }

    async fn spawn_connection(
        &self,
        connection_id: &str,
        command: OsString,
        args: &[OsString],
        cwd: &Path,
        inherited_env: &[(OsString, OsString)],
        explicit_env: &[(OsString, OsString)],
    ) -> Result<(Arc<Connection>, ChildStdout, ChildStderr), McpStdioError> {
        let mut process = Command::new(command);
        process
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        for (key, value) in inherited_env.iter().chain(explicit_env.iter()) {
            process.env(key, value);
        }

        #[cfg(unix)]
        process.process_group(0);

        let mut child = process
            .spawn()
            .map_err(|_| McpStdioError::new(McpStdioErrorCode::SpawnFailed))?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let (Some(stdin), Some(stdout), Some(stderr)) = (stdin, stdout, stderr) else {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(McpStdioError::new(McpStdioErrorCode::SpawnFailed));
        };

        let process = Arc::new(ProcessHandle {
            child: AsyncMutex::new(Some(child)),
            pid,
            exited: AtomicBool::new(false),
        });
        Ok((
            Arc::new(Connection {
                id: connection_id.to_owned(),
                pid,
                process,
                stdin: AsyncMutex::new(Some(stdin)),
                state: Mutex::new(ConnectionState {
                    closed: false,
                    child_exited: false,
                    stdout_closed: false,
                    terminal: None,
                    queue: VecDeque::new(),
                    queue_bytes: 0,
                }),
                stderr: Mutex::new(VecDeque::with_capacity(MAX_STDERR_BYTES)),
                notify: Notify::new(),
                started_at: Instant::now(),
                config: self.inner.config.clone(),
                global_queue_bytes: Arc::clone(&self.inner.global_queue_bytes),
            }),
            stdout,
            stderr,
        ))
    }
}

async fn send_to_connection(
    connection: &Arc<Connection>,
    message: Value,
) -> Result<(), McpStdioError> {
    let mut encoded = encode_json_rpc(&message)?;
    encoded.push(b'\n');

    if connection.is_closed_or_terminal() {
        return Err(connection.current_error());
    }

    let mut stdin = match tokio::time::timeout(STDIN_LOCK_TIMEOUT, connection.stdin.lock()).await {
        Ok(stdin) => stdin,
        Err(_) => {
            connection.terminalize(McpStdioErrorCode::Timeout);
            return Err(McpStdioError::new(McpStdioErrorCode::Timeout));
        }
    };
    if connection.is_closed_or_terminal() {
        return Err(connection.current_error());
    }
    let writer = stdin
        .as_mut()
        .ok_or_else(|| McpStdioError::new(McpStdioErrorCode::Closed))?;

    let write_result = tokio::time::timeout(STDIN_IO_TIMEOUT, async {
        writer.write_all(&encoded).await?;
        writer.flush().await
    })
    .await;
    match write_result {
        Err(_) => {
            drop(stdin);
            connection.terminalize(McpStdioErrorCode::Timeout);
            return Err(McpStdioError::new(McpStdioErrorCode::Timeout));
        }
        Ok(Err(_)) => {
            drop(stdin);
            connection.terminalize(McpStdioErrorCode::IoError);
            return Err(McpStdioError::new(McpStdioErrorCode::IoError));
        }
        Ok(Ok(())) => {}
    }

    Ok(())
}

impl Default for McpStdioSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl SupervisorInner {
    fn shutdown(&self) {
        let connections = {
            let mut registry = lock(&self.registry);
            registry.closing = true;
            registry.openings.clear();
            registry.pending_closes.clear();
            registry
                .connections
                .drain()
                .map(|(_, connection)| connection)
                .collect::<Vec<_>>()
        };
        for connection in connections {
            connection.shutdown_sync();
        }
    }
}

impl Drop for SupervisorInner {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl ProcessHandle {
    async fn wait(&self) -> io::Result<Option<ExitStatus>> {
        let mut child_slot = self.child.lock().await;
        let Some(child) = child_slot.as_mut() else {
            return Ok(None);
        };
        let result = child.wait().await;
        if result.is_ok() {
            self.exited.store(true, Ordering::Release);
            *child_slot = None;
        }
        result.map(Some)
    }

    fn kill_group_sync(&self) {
        if self.exited.load(Ordering::Acquire) {
            return;
        }

        #[cfg(unix)]
        if let Some(pid) = self.pid.filter(|pid| *pid <= i32::MAX as u32) {
            unsafe {
                libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            }
        }

        #[cfg(not(unix))]
        if let Ok(mut child) = self.child.try_lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.start_kill();
            }
        }
    }

    async fn terminate_and_reap(&self) {
        self.kill_group_sync();
        let first_wait = tokio::time::timeout(PROCESS_REAP_TIMEOUT, self.wait()).await;
        if !matches!(first_wait, Ok(Ok(_))) {
            // A process-group kill may fail after the group leader exits or
            // when a platform does not expose the group. Kill the direct
            // child as a fallback, then give reaping one bounded final wait.
            self.kill_direct_child();
            let _ = tokio::time::timeout(PROCESS_REAP_TIMEOUT, self.wait()).await;
        }
    }

    fn kill_direct_child(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid.filter(|pid| *pid <= i32::MAX as u32) {
            // The background waiter owns the Child mutex while awaiting exit,
            // so the positive-PID fallback must not wait for that same lock.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }

        #[cfg(not(unix))]
        if let Ok(mut child_slot) = self.child.try_lock() {
            if let Some(child) = child_slot.as_mut() {
                let _ = child.start_kill();
            }
        }
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        self.kill_group_sync();
    }
}

impl Connection {
    fn status(&self) -> McpStdioStatus {
        let state = lock(&self.state);
        let stderr_bytes = lock(&self.stderr).len();
        let status = if state.closed {
            McpStdioConnectionState::Closed
        } else if state.terminal.is_some() {
            McpStdioConnectionState::Terminal
        } else {
            McpStdioConnectionState::Running
        };
        McpStdioStatus {
            connection_id: self.id.clone(),
            pid: self.pid,
            state: status,
            queued_messages: state.queue.len(),
            queued_bytes: state.queue_bytes,
            stderr_bytes,
            terminal_error: state.terminal,
            uptime_ms: self.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        }
    }

    fn is_closed_or_terminal(&self) -> bool {
        let state = lock(&self.state);
        state.closed || state.terminal.is_some()
    }

    fn current_error(&self) -> McpStdioError {
        let state = lock(&self.state);
        if state.closed {
            return McpStdioError::new(McpStdioErrorCode::Closed);
        }
        state
            .terminal
            .map(McpStdioError::new)
            .unwrap_or_else(|| McpStdioError::new(McpStdioErrorCode::IoError))
    }

    fn poll_receive(&self) -> ReceivePoll {
        let mut state = lock(&self.state);
        if let Some(message) = state.queue.pop_front() {
            state.queue_bytes = state.queue_bytes.saturating_sub(message.bytes);
            self.release_global_queue_bytes(message.bytes);
            return ReceivePoll::Message(message.value);
        }
        if state.closed {
            return ReceivePoll::Error(McpStdioError::new(McpStdioErrorCode::Closed));
        }
        match state.terminal {
            Some(code) if code == McpStdioErrorCode::ChildExited && !state.stdout_closed => {
                ReceivePoll::Wait
            }
            Some(code) => ReceivePoll::Error(McpStdioError::new(code)),
            None => ReceivePoll::Wait,
        }
    }

    fn enqueue(&self, value: Value, bytes: usize) -> bool {
        let overflow = {
            let mut state = lock(&self.state);
            if state.closed
                || (state.terminal.is_some()
                    && state.terminal != Some(McpStdioErrorCode::ChildExited))
            {
                return false;
            }

            if state.queue.len() >= self.config.stdout_queue_max_messages
                || state.queue_bytes.saturating_add(bytes) > self.config.stdout_queue_max_bytes
                || !self.try_reserve_global_queue_bytes(bytes)
            {
                true
            } else {
                state.queue_bytes = state.queue_bytes.saturating_add(bytes);
                state.queue.push_back(QueuedMessage { value, bytes });
                false
            }
        };

        if overflow {
            self.terminalize(McpStdioErrorCode::QueueOverflow);
            false
        } else {
            self.notify.notify_one();
            true
        }
    }

    fn terminalize(&self, code: McpStdioErrorCode) {
        let terminalized = {
            let mut state = lock(&self.state);
            if state.closed || state.terminal.is_some() {
                false
            } else {
                state.terminal = Some(code);
                true
            }
        };

        if terminalized {
            self.process.kill_group_sync();
            self.notify.notify_waiters();
        }
    }

    fn on_child_exit(&self) {
        {
            let mut state = lock(&self.state);
            state.child_exited = true;
        }
        self.notify.notify_waiters();
    }

    fn on_stdout_closed(&self) {
        {
            let mut state = lock(&self.state);
            state.stdout_closed = true;
            if state.child_exited && !state.closed && state.terminal.is_none() {
                state.terminal = Some(McpStdioErrorCode::ChildExited);
            }
        }
        self.notify.notify_waiters();
    }

    fn is_stdout_closed(&self) -> bool {
        lock(&self.state).stdout_closed
    }

    fn force_stdout_closed(&self) {
        {
            let mut state = lock(&self.state);
            state.stdout_closed = true;
            if state.child_exited && !state.closed && state.terminal.is_none() {
                state.terminal = Some(McpStdioErrorCode::ChildExited);
            }
        }
        self.process.kill_group_sync();
        self.notify.notify_waiters();
    }

    async fn close(&self) {
        let queued_bytes = {
            let mut state = lock(&self.state);
            state.closed = true;
            state.queue.clear();
            std::mem::replace(&mut state.queue_bytes, 0)
        };
        self.release_global_queue_bytes(queued_bytes);
        self.notify.notify_waiters();

        self.process.kill_group_sync();

        if let Ok(mut stdin) = tokio::time::timeout(STDIN_LOCK_TIMEOUT, self.stdin.lock()).await {
            *stdin = None;
        }

        self.process.terminate_and_reap().await;
    }

    fn try_reserve_global_queue_bytes(&self, bytes: usize) -> bool {
        let budget = &self.global_queue_bytes;
        let limit = self.config.global_stdout_queue_max_bytes;
        let mut current = budget.load(Ordering::Acquire);
        loop {
            let Some(next) = current.checked_add(bytes) else {
                return false;
            };
            if next > limit {
                return false;
            }
            match budget.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return true,
                Err(observed) => current = observed,
            }
        }
    }

    fn release_global_queue_bytes(&self, bytes: usize) {
        if bytes == 0 {
            return;
        }
        let previous = self.global_queue_bytes.fetch_sub(bytes, Ordering::AcqRel);
        debug_assert!(
            previous >= bytes,
            "global stdout queue accounting underflow"
        );
    }

    fn shutdown_sync(&self) {
        let queued_bytes = {
            let mut state = lock(&self.state);
            state.closed = true;
            state.queue.clear();
            std::mem::replace(&mut state.queue_bytes, 0)
        };
        self.release_global_queue_bytes(queued_bytes);
        if let Ok(mut stdin) = self.stdin.try_lock() {
            *stdin = None;
        }
        self.process.kill_group_sync();
        self.notify.notify_waiters();
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.shutdown_sync();
    }
}

#[derive(Debug)]
enum ReceivePoll {
    Message(Value),
    Wait,
    Error(McpStdioError),
}

async fn receive_from_connection(
    connection: &Arc<Connection>,
    cancellation: Option<&CancellationToken>,
    timeout: Option<Duration>,
) -> Result<Value, McpStdioError> {
    loop {
        let notified = connection.notify.notified();
        match connection.poll_receive() {
            ReceivePoll::Message(message) => return Ok(message),
            ReceivePoll::Error(error) => return Err(error),
            ReceivePoll::Wait => {}
        }

        match (cancellation, timeout) {
            (Some(token), Some(duration)) => {
                tokio::select! {
                    _ = notified => {}
                    _ = token.cancelled() => {
                        return Err(McpStdioError::new(McpStdioErrorCode::Cancelled));
                    }
                    _ = tokio::time::sleep(duration) => {
                        return Err(McpStdioError::new(McpStdioErrorCode::Timeout));
                    }
                }
            }
            (Some(token), None) => {
                tokio::select! {
                    _ = notified => {}
                    _ = token.cancelled() => {
                        return Err(McpStdioError::new(McpStdioErrorCode::Cancelled));
                    }
                }
            }
            (None, Some(duration)) => {
                tokio::select! {
                    _ = notified => {}
                    _ = tokio::time::sleep(duration) => {
                        return Err(McpStdioError::new(McpStdioErrorCode::Timeout));
                    }
                }
            }
            (None, None) => {
                notified.await;
            }
        }
    }
}

fn encode_json_rpc(value: &Value) -> Result<Vec<u8>, McpStdioError> {
    validate_json_rpc(value)?;
    let bytes = serde_json::to_vec(value)
        .map_err(|_| McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc))?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(McpStdioError::new(McpStdioErrorCode::MessageTooLarge));
    }
    Ok(bytes)
}

fn validate_json_rpc(value: &Value) -> Result<(), McpStdioError> {
    let object = value
        .as_object()
        .ok_or_else(|| McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc))?;

    match object.get("jsonrpc") {
        Some(Value::String(version)) if version == "2.0" => {}
        _ => return Err(McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc)),
    }

    if let Some(method) = object.get("method") {
        if !method.as_str().is_some_and(validate_json_rpc_method) {
            return Err(McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc));
        }
        if !object
            .keys()
            .all(|key| matches!(key.as_str(), "jsonrpc" | "method" | "id" | "params"))
        {
            return Err(McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc));
        }
        if let Some(params) = object.get("params") {
            if !params.is_object() && !params.is_array() {
                return Err(McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc));
            }
        }
        if let Some(id) = object.get("id") {
            validate_request_id(id)?;
        }
        if object.contains_key("result") || object.contains_key("error") {
            return Err(McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc));
        }
        return Ok(());
    }

    let has_result = object.contains_key("result");
    let has_error = object.contains_key("error");
    if has_result == has_error || !object.contains_key("id") {
        return Err(McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc));
    }
    if !object
        .keys()
        .all(|key| matches!(key.as_str(), "jsonrpc" | "id" | "result" | "error"))
    {
        return Err(McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc));
    }
    validate_response_id(object.get("id").expect("id checked above"))?;

    if let Some(error) = object.get("error") {
        let error = error
            .as_object()
            .ok_or_else(|| McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc))?;
        if !error
            .keys()
            .all(|key| matches!(key.as_str(), "code" | "message" | "data"))
        {
            return Err(McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc));
        }
        if !error.get("code").is_some_and(is_js_safe_integer)
            || !error.get("message").is_some_and(Value::is_string)
        {
            return Err(McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc));
        }
    }

    Ok(())
}

fn validate_request_id(id: &Value) -> Result<(), McpStdioError> {
    if id.is_string() || is_js_safe_integer(id) {
        Ok(())
    } else {
        Err(McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc))
    }
}

fn validate_response_id(id: &Value) -> Result<(), McpStdioError> {
    if id.is_null() || id.is_string() || is_js_safe_integer(id) {
        Ok(())
    } else {
        Err(McpStdioError::new(McpStdioErrorCode::InvalidJsonRpc))
    }
}

const MAX_JS_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn is_js_safe_integer(value: &Value) -> bool {
    value
        .as_i64()
        .is_some_and(|number| (-MAX_JS_SAFE_INTEGER..=MAX_JS_SAFE_INTEGER).contains(&number))
        || value
            .as_u64()
            .is_some_and(|number| number <= MAX_JS_SAFE_INTEGER as u64)
}

fn validate_json_rpc_method(method: &str) -> bool {
    !method.is_empty()
        && method.len() <= MAX_COMMAND_BYTES
        && !method.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
}

fn validate_connection_id(connection_id: &str) -> Result<(), McpStdioError> {
    let bytes = connection_id.as_bytes();
    let valid = bytes
        .first()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'));
    if bytes.is_empty() || bytes.len() > MAX_CONNECTION_ID_BYTES || !valid {
        Err(McpStdioError::new(McpStdioErrorCode::InvalidConnectionId))
    } else {
        Ok(())
    }
}

fn validate_command(command: &OsStr) -> Result<(), McpStdioError> {
    if os_len(command) == 0
        || os_len(command) > MAX_COMMAND_BYTES
        || os_has_nul(command)
        || os_has_control(command)
    {
        Err(McpStdioError::new(McpStdioErrorCode::InvalidCommand))
    } else {
        Ok(())
    }
}

fn collect_args<I, A>(args: I) -> Result<Vec<OsString>, McpStdioError>
where
    I: IntoIterator<Item = A>,
    A: AsRef<OsStr>,
{
    let mut collected = Vec::new();
    let mut total_bytes = 0_usize;

    for arg in args {
        if collected.len() >= MAX_ARGUMENTS {
            return Err(McpStdioError::new(McpStdioErrorCode::InvalidArguments));
        }
        let arg = arg.as_ref();
        let bytes = os_len(arg);
        if bytes > MAX_ARGUMENT_BYTES || os_has_nul(arg) || os_has_control(arg) {
            return Err(McpStdioError::new(McpStdioErrorCode::InvalidArguments));
        }
        total_bytes = total_bytes
            .checked_add(bytes)
            .ok_or_else(|| McpStdioError::new(McpStdioErrorCode::InvalidArguments))?;
        if total_bytes > MAX_ARGUMENT_TOTAL_BYTES {
            return Err(McpStdioError::new(McpStdioErrorCode::InvalidArguments));
        }
        collected.push(arg.to_os_string());
    }

    Ok(collected)
}

fn validate_cwd(cwd: &Path) -> Result<PathBuf, McpStdioError> {
    if os_len(cwd.as_os_str()) == 0
        || os_len(cwd.as_os_str()) > MAX_CWD_BYTES
        || os_has_nul(cwd.as_os_str())
        || os_has_control(cwd.as_os_str())
        || !cwd.is_absolute()
        || !cwd.is_dir()
    {
        return Err(McpStdioError::new(McpStdioErrorCode::InvalidCwd));
    }
    Ok(cwd.to_owned())
}

fn collect_explicit_env<E, K, V>(env: E) -> Result<Vec<(OsString, OsString)>, McpStdioError>
where
    E: IntoIterator<Item = (K, V)>,
    K: AsRef<OsStr>,
    V: AsRef<OsStr>,
{
    let mut collected = Vec::new();
    let mut names = HashSet::new();
    let mut total_bytes = 0_usize;

    for (key, value) in env {
        if collected.len() >= MAX_ENV_ENTRIES {
            return Err(McpStdioError::new(McpStdioErrorCode::InvalidEnvironment));
        }
        let key = key.as_ref();
        let value = value.as_ref();
        let forbidden = is_forbidden_env_key(key);

        if os_len(key) == 0
            || os_len(key) > MAX_ENV_KEY_BYTES
            || os_len(value) > MAX_ENV_VALUE_BYTES
            || os_has_nul(key)
            || os_has_nul(value)
            || os_has_control(key)
            || os_has_control(value)
            || os_has_byte(key, b'=')
            || forbidden
        {
            return Err(McpStdioError::new(if forbidden {
                McpStdioErrorCode::ForbiddenEnvironment
            } else {
                McpStdioErrorCode::InvalidEnvironment
            }));
        }

        let key = key.to_os_string();
        if !names.insert(key.clone()) {
            return Err(McpStdioError::new(McpStdioErrorCode::InvalidEnvironment));
        }

        total_bytes = total_bytes
            .checked_add(os_len(&key))
            .and_then(|total| total.checked_add(os_len(value)))
            .ok_or_else(|| McpStdioError::new(McpStdioErrorCode::InvalidEnvironment))?;
        if total_bytes > MAX_ENV_TOTAL_BYTES {
            return Err(McpStdioError::new(McpStdioErrorCode::InvalidEnvironment));
        }

        collected.push((key, value.to_os_string()));
    }

    Ok(collected)
}

fn collect_safe_inherited_env() -> Vec<(OsString, OsString)> {
    let mut collected = Vec::new();
    let mut total_bytes = 0_usize;

    for (key, value) in std::env::vars_os() {
        if !is_allowed_inherited_env_key(&key)
            || is_forbidden_env_key(&key)
            || os_len(&key) == 0
            || os_len(&key) > MAX_ENV_KEY_BYTES
            || os_len(&value) > MAX_ENV_VALUE_BYTES
            || os_has_nul(&key)
            || os_has_nul(&value)
            || os_has_control(&key)
            || os_has_control(&value)
            || os_has_byte(&key, b'=')
        {
            continue;
        }

        let entry_bytes = os_len(&key).saturating_add(os_len(&value));
        if total_bytes.saturating_add(entry_bytes) > INHERITED_ENV_TOTAL_BYTES {
            continue;
        }
        total_bytes = total_bytes.saturating_add(entry_bytes);
        collected.push((key, value));
    }

    collected
}

fn is_allowed_inherited_env_key(key: &OsStr) -> bool {
    let key = key.to_string_lossy();
    matches!(
        key.as_ref(),
        "PATH"
            | "HOME"
            | "USER"
            | "LOGNAME"
            | "SHELL"
            | "TMPDIR"
            | "TMP"
            | "TEMP"
            | "LANG"
            | "LANGUAGE"
            | "TZ"
            | "TERM"
    ) || key.starts_with("LC_")
}

fn is_forbidden_env_key(key: &OsStr) -> bool {
    let key = key.to_string_lossy().to_ascii_uppercase();
    if key == "AUTHORIZATION" || key.ends_with("_AUTHORIZATION") || key == "VEXZY_API_KEY" {
        return true;
    }

    key.contains("VEXZY")
        && [
            "KEY",
            "TOKEN",
            "SECRET",
            "PASSWORD",
            "PASSWD",
            "AUTH",
            "CREDENTIAL",
            "BEARER",
            "COOKIE",
            "PRIVATE",
            "CERT",
        ]
        .iter()
        .any(|marker| key.contains(marker))
}

fn os_len(value: &OsStr) -> usize {
    #[cfg(unix)]
    {
        value.as_bytes().len()
    }

    #[cfg(not(unix))]
    {
        value.to_string_lossy().len()
    }
}

fn os_has_nul(value: &OsStr) -> bool {
    #[cfg(unix)]
    {
        value.as_bytes().contains(&0)
    }

    #[cfg(not(unix))]
    {
        value.to_string_lossy().contains('\0')
    }
}

fn os_has_control(value: &OsStr) -> bool {
    #[cfg(unix)]
    {
        value
            .as_bytes()
            .iter()
            .any(|byte| *byte < 0x20 || *byte == 0x7f)
    }

    #[cfg(not(unix))]
    {
        value.to_string_lossy().chars().any(char::is_control)
    }
}

fn os_has_byte(value: &OsStr, byte: u8) -> bool {
    #[cfg(unix)]
    {
        value.as_bytes().contains(&byte)
    }

    #[cfg(not(unix))]
    {
        let _ = byte;
        false
    }
}

async fn read_bounded_line<R>(reader: &mut R) -> io::Result<BoundedLine>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::new();

    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(if line.is_empty() {
                BoundedLine::Eof
            } else {
                BoundedLine::PartialEof
            });
        }

        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if newline > MAX_MESSAGE_BYTES.saturating_sub(line.len()) {
                return Ok(BoundedLine::Oversized);
            }
            line.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            return Ok(BoundedLine::Complete(line));
        }

        if available.len() > MAX_MESSAGE_BYTES.saturating_sub(line.len()) {
            return Ok(BoundedLine::Oversized);
        }
        line.extend_from_slice(available);
        let consumed = available.len();
        reader.consume(consumed);
    }
}

enum BoundedLine {
    Eof,
    PartialEof,
    Oversized,
    Complete(Vec<u8>),
}

async fn read_stdout(mut stdout: BufReader<ChildStdout>, weak: Weak<Connection>) {
    loop {
        let line = match read_bounded_line(&mut stdout).await {
            Ok(line) => line,
            Err(_) => {
                if let Some(connection) = weak.upgrade() {
                    connection.terminalize(McpStdioErrorCode::IoError);
                }
                break;
            }
        };

        match line {
            BoundedLine::Eof => break,
            BoundedLine::PartialEof => {
                if let Some(connection) = weak.upgrade() {
                    connection.terminalize(McpStdioErrorCode::MalformedJson);
                }
                break;
            }
            BoundedLine::Oversized => {
                if let Some(connection) = weak.upgrade() {
                    connection.terminalize(McpStdioErrorCode::OversizedLine);
                }
                break;
            }
            BoundedLine::Complete(line) => {
                let value = match serde_json::from_slice::<Value>(&line) {
                    Ok(value) => value,
                    Err(_) => {
                        if let Some(connection) = weak.upgrade() {
                            connection.terminalize(McpStdioErrorCode::MalformedJson);
                        }
                        break;
                    }
                };
                if validate_json_rpc(&value).is_err() {
                    if let Some(connection) = weak.upgrade() {
                        connection.terminalize(McpStdioErrorCode::InvalidJsonRpc);
                    }
                    break;
                }
                let Some(connection) = weak.upgrade() else {
                    break;
                };
                if !connection.enqueue(value, line.len()) {
                    break;
                }
            }
        }
    }

    if let Some(connection) = weak.upgrade() {
        connection.on_stdout_closed();
    }
}

async fn read_stderr(mut stderr: ChildStderr, weak: Weak<Connection>) {
    let mut buffer = [0_u8; STDERR_READ_CHUNK_BYTES];
    while let Ok(read) = stderr.read(&mut buffer).await {
        if read == 0 {
            break;
        }
        if let Some(connection) = weak.upgrade() {
            let mut ring = lock(&connection.stderr);
            for byte in &buffer[..read] {
                if ring.len() == MAX_STDERR_BYTES {
                    ring.pop_front();
                }
                ring.push_back(*byte);
            }
        } else {
            break;
        }
    }
}

fn spawn_background_tasks(connection: &Arc<Connection>, stdout: ChildStdout, stderr: ChildStderr) {
    let weak = Arc::downgrade(connection);
    tokio::spawn(read_stdout(BufReader::new(stdout), weak.clone()));
    tokio::spawn(read_stderr(stderr, weak.clone()));

    let process = connection.process.clone();
    let weak = Arc::downgrade(connection);
    tokio::spawn(async move {
        let _ = process.wait().await;
        let Some(connection) = weak.upgrade() else {
            return;
        };

        connection.on_child_exit();
        let deadline = tokio::time::sleep(CHILD_EXIT_DRAIN_TIMEOUT);
        tokio::pin!(deadline);
        loop {
            if connection.is_stdout_closed() {
                break;
            }
            let notified = connection.notify.notified();
            if connection.is_stdout_closed() {
                break;
            }
            tokio::select! {
                _ = notified => {}
                _ = &mut deadline => {
                    connection.force_stdout_closed();
                    break;
                }
            }
        }
        connection.notify.notify_waiters();
    });
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{path::PathBuf, time::Duration};
    use tokio::time::timeout;

    fn cwd() -> PathBuf {
        std::env::current_dir().expect("current directory")
    }

    fn empty_env() -> Vec<(String, String)> {
        Vec::new()
    }

    async fn open_cat(supervisor: &McpStdioSupervisor, id: &str) {
        supervisor
            .open(id, "/bin/cat", Vec::<String>::new(), cwd(), empty_env())
            .await
            .expect("open cat");
    }

    fn assert_code(error: McpStdioError, expected: McpStdioErrorCode) {
        assert_eq!(error.code(), expected, "stable error code");
    }

    #[tokio::test]
    async fn roundtrip_and_notification_fifo() {
        let supervisor = McpStdioSupervisor::new();
        open_cat(&supervisor, "roundtrip").await;

        let request = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "echo",
            "params": {"value": "roundtrip"}
        });
        let notification = json!({
            "jsonrpc": "2.0",
            "method": "notifications/one"
        });
        let second_notification = json!({
            "jsonrpc": "2.0",
            "method": "notifications/two"
        });

        supervisor.send("roundtrip", request.clone()).await.unwrap();
        assert_eq!(
            supervisor.receive("roundtrip", None, None).await.unwrap(),
            request
        );

        supervisor
            .send("roundtrip", notification.clone())
            .await
            .unwrap();
        supervisor
            .send("roundtrip", second_notification.clone())
            .await
            .unwrap();
        assert_eq!(
            supervisor.receive("roundtrip", None, None).await.unwrap(),
            notification
        );
        assert_eq!(
            supervisor.receive("roundtrip", None, None).await.unwrap(),
            second_notification
        );

        supervisor.close("roundtrip").await.unwrap();
        supervisor.close("roundtrip").await.unwrap();
    }

    #[tokio::test]
    async fn malformed_and_oversized_lines_terminalize() {
        let malformed = McpStdioSupervisor::new();
        malformed
            .open(
                "malformed",
                "/bin/echo",
                vec!["not-json".to_owned()],
                cwd(),
                empty_env(),
            )
            .await
            .unwrap();
        let error = timeout(
            Duration::from_secs(2),
            malformed.receive("malformed", None, None),
        )
        .await
        .expect("malformed line timeout")
        .unwrap_err();
        assert_code(error, McpStdioErrorCode::MalformedJson);
        assert_eq!(
            malformed.status("malformed").unwrap().terminal_error,
            Some(McpStdioErrorCode::MalformedJson)
        );
        malformed.close("malformed").await.unwrap();

        let oversized = McpStdioSupervisor::new();
        oversized
            .open(
                "oversized",
                "/bin/dd",
                vec![
                    "if=/dev/zero".to_owned(),
                    format!("bs={}", MAX_MESSAGE_BYTES + 1),
                    "count=1".to_owned(),
                ],
                cwd(),
                empty_env(),
            )
            .await
            .unwrap();
        let error = timeout(
            Duration::from_secs(5),
            oversized.receive("oversized", None, None),
        )
        .await
        .expect("oversized line timeout")
        .unwrap_err();
        assert_code(error, McpStdioErrorCode::OversizedLine);
        oversized.close("oversized").await.unwrap();
    }

    #[tokio::test]
    async fn queue_overflow_terminalizes() {
        let supervisor = McpStdioSupervisor::with_limits(2, 1024 * 1024);
        open_cat(&supervisor, "overflow").await;
        let message = json!({"jsonrpc":"2.0","method":"notification"});
        for _ in 0..8 {
            if supervisor.send("overflow", message.clone()).await.is_err() {
                break;
            }
        }

        let mut terminal = None;
        for _ in 0..8 {
            match supervisor
                .receive_timeout("overflow", Duration::from_secs(2))
                .await
            {
                Ok(_) => {}
                Err(error) => {
                    terminal = Some(error);
                    break;
                }
            }
        }
        assert_code(
            terminal.expect("queue overflow terminal error"),
            McpStdioErrorCode::QueueOverflow,
        );
        supervisor.close("overflow").await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_timeout_and_close_are_stable() {
        let supervisor = McpStdioSupervisor::new();
        open_cat(&supervisor, "cancel").await;

        let timeout_error = supervisor
            .receive_timeout("cancel", Duration::from_millis(25))
            .await
            .unwrap_err();
        assert_code(timeout_error, McpStdioErrorCode::Timeout);

        let cancellation = CancellationToken::new();
        let task_supervisor = supervisor.clone();
        let task_cancellation = cancellation.clone();
        let task = tokio::spawn(async move {
            task_supervisor
                .receive("cancel", Some(task_cancellation), None)
                .await
        });
        tokio::time::sleep(Duration::from_millis(25)).await;
        cancellation.cancel();
        let cancellation_error = task.await.unwrap().unwrap_err();
        assert_code(cancellation_error, McpStdioErrorCode::Cancelled);

        let send_cancellation = CancellationToken::new();
        send_cancellation.cancel();
        let send_error = supervisor
            .send_with_cancellation(
                "cancel",
                json!({"jsonrpc":"2.0","method":"cancelled-send"}),
                &send_cancellation,
            )
            .await
            .unwrap_err();
        assert_code(send_error, McpStdioErrorCode::Cancelled);

        supervisor.close("cancel").await.unwrap();
        supervisor.close("cancel").await.unwrap();
        assert!(supervisor.list().is_empty());
    }

    #[tokio::test]
    async fn close_is_bounded_behind_a_blocked_stdin_lock() {
        let supervisor = McpStdioSupervisor::new();
        open_cat(&supervisor, "blocked-close").await;
        let connection = supervisor.connection("blocked-close").unwrap();
        let stdin_guard = connection.stdin.lock().await;

        let closing = {
            let supervisor = supervisor.clone();
            tokio::spawn(async move { supervisor.close("blocked-close").await })
        };
        timeout(Duration::from_secs(3), closing)
            .await
            .expect("close must not wait indefinitely for stdin")
            .unwrap()
            .unwrap();
        drop(stdin_guard);
        assert!(supervisor.list().is_empty());
    }

    #[tokio::test]
    async fn close_all_reaps_every_connection_and_is_idempotent() {
        let supervisor = McpStdioSupervisor::new();
        open_cat(&supervisor, "close-one").await;
        open_cat(&supervisor, "close-two").await;
        assert_eq!(supervisor.list().len(), 2);

        supervisor.close_all().await.unwrap();
        assert!(supervisor.list().is_empty());
        supervisor.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn aggregate_connection_limit_includes_openings() {
        let supervisor = McpStdioSupervisor::new();
        {
            let mut registry = lock(&supervisor.inner.registry);
            for index in 0..MAX_MCP_CONNECTIONS {
                registry.openings.insert(format!("limit-{index}"));
            }
        }
        let error = supervisor
            .open(
                "limit-overflow",
                "/bin/cat",
                Vec::<String>::new(),
                cwd(),
                empty_env(),
            )
            .await
            .unwrap_err();
        assert_code(error, McpStdioErrorCode::ConnectionLimit);
        assert!(supervisor.list().is_empty());
        lock(&supervisor.inner.registry).openings.clear();
    }

    #[tokio::test]
    async fn close_waits_for_an_opening_before_returning() {
        let supervisor = McpStdioSupervisor::new();
        let opening_supervisor = supervisor.clone();
        let opening = tokio::spawn(async move {
            opening_supervisor
                .open(
                    "racing-open",
                    "/bin/cat",
                    Vec::<String>::new(),
                    cwd(),
                    empty_env(),
                )
                .await
        });

        timeout(Duration::from_secs(1), async {
            loop {
                if lock(&supervisor.inner.registry)
                    .openings
                    .contains("racing-open")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("open entered the opening state");

        let close = supervisor.close("racing-open");
        let (opened, closed) = tokio::join!(opening, close);
        assert_code(opened.unwrap().unwrap_err(), McpStdioErrorCode::Closed);
        closed.unwrap();
        assert!(supervisor.list().is_empty());
        assert!(lock(&supervisor.inner.registry).openings.is_empty());
    }

    #[tokio::test]
    async fn cancelled_open_never_inserts_a_connection() {
        let supervisor = McpStdioSupervisor::new();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let error = supervisor
            .open_with_cancellation(
                "cancelled-open",
                "/bin/cat",
                Vec::<String>::new(),
                cwd(),
                empty_env(),
                &cancellation,
            )
            .await
            .unwrap_err();
        assert_code(error, McpStdioErrorCode::Cancelled);
        assert!(supervisor.list().is_empty());
        {
            let registry = lock(&supervisor.inner.registry);
            assert!(registry.openings.is_empty());
            assert!(registry.pending_closes.is_empty());
        }

        let cancellation = CancellationToken::new();
        let opening_supervisor = supervisor.clone();
        let opening_cancellation = cancellation.clone();
        let opening = tokio::spawn(async move {
            opening_supervisor
                .open_with_cancellation(
                    "cancelled-after-reservation",
                    "/bin/cat",
                    Vec::<String>::new(),
                    cwd(),
                    empty_env(),
                    &opening_cancellation,
                )
                .await
        });
        timeout(Duration::from_secs(1), async {
            loop {
                if lock(&supervisor.inner.registry)
                    .openings
                    .contains("cancelled-after-reservation")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("open entered the reservation state");
        cancellation.cancel();
        assert_code(
            opening.await.unwrap().unwrap_err(),
            McpStdioErrorCode::Cancelled,
        );
        assert!(supervisor.list().is_empty());
    }

    #[tokio::test]
    async fn global_queue_budget_reserves_and_releases_exactly() {
        let supervisor =
            McpStdioSupervisor::with_config(McpStdioConfig::with_limits_and_global(8, 1024, 10));
        open_cat(&supervisor, "global-one").await;
        open_cat(&supervisor, "global-two").await;
        let first = supervisor.connection("global-one").unwrap();
        let second = supervisor.connection("global-two").unwrap();

        assert!(first.enqueue(json!({"jsonrpc":"2.0","method":"one"}), 6));
        assert_eq!(
            supervisor.inner.global_queue_bytes.load(Ordering::Acquire),
            6
        );
        assert!(!second.enqueue(json!({"jsonrpc":"2.0","method":"two"}), 5));
        assert_eq!(
            supervisor.inner.global_queue_bytes.load(Ordering::Acquire),
            6
        );
        assert!(matches!(first.poll_receive(), ReceivePoll::Message(_)));
        assert_eq!(
            supervisor.inner.global_queue_bytes.load(Ordering::Acquire),
            0
        );

        supervisor.close_all().await.unwrap();
        assert_eq!(
            supervisor.inner.global_queue_bytes.load(Ordering::Acquire),
            0
        );
    }

    #[tokio::test]
    async fn env_redaction_and_status_do_not_expose_values() {
        let supervisor = McpStdioSupervisor::new();
        let error = supervisor
            .open(
                "redaction",
                "/bin/cat",
                Vec::<String>::new(),
                cwd(),
                vec![("VEXZY_API_KEY".to_owned(), "secret-value".to_owned())],
            )
            .await
            .unwrap_err();
        assert_code(error, McpStdioErrorCode::ForbiddenEnvironment);
        assert!(!error.to_string().contains("secret-value"));

        let status = supervisor
            .open(
                "status",
                "/bin/cat",
                Vec::<String>::new(),
                cwd(),
                vec![("MCP_TEST_SAFE".to_owned(), "safe-value".to_owned())],
            )
            .await
            .unwrap();
        let encoded = serde_json::to_string(&status).unwrap();
        assert!(!encoded.contains("safe-value"));
        assert!(!encoded.contains("secret-value"));
        assert_eq!(supervisor.list().len(), 1);

        supervisor.close("status").await.unwrap();
    }

    #[test]
    fn exact_limits_and_inherited_environment_allowlist() {
        assert!(validate_connection_id("A0-z._:9").is_ok());
        assert!(validate_connection_id("_not_allowed").is_err());
        assert!(validate_connection_id("bad/slash").is_err());
        assert!(is_allowed_inherited_env_key(OsStr::new("PATH")));
        assert!(is_allowed_inherited_env_key(OsStr::new("LC_ALL")));
        assert!(!is_allowed_inherited_env_key(OsStr::new("OPENAI_API_KEY")));
        assert!(!is_allowed_inherited_env_key(OsStr::new("VEXZY_API_KEY")));
        assert_eq!(MAX_MESSAGE_BYTES, 4 * 1024 * 1024);
        assert_eq!(MAX_ARGUMENT_BYTES, 8 * 1024);
        assert_eq!(MAX_ENV_VALUE_BYTES, 32 * 1024);
        assert_eq!(DEFAULT_STDOUT_QUEUE_MESSAGES, 128);
        assert_eq!(DEFAULT_STDOUT_QUEUE_BYTES, 32 * 1024 * 1024);
        assert_eq!(MAX_STDERR_BYTES, 64 * 1024);
    }

    #[tokio::test]
    async fn send_requires_json_rpc_object_and_size_bound() {
        let supervisor = McpStdioSupervisor::new();
        open_cat(&supervisor, "validation").await;

        let error = supervisor
            .send("validation", json!([{"jsonrpc":"2.0","method":"x"}]))
            .await
            .unwrap_err();
        assert_code(error, McpStdioErrorCode::InvalidJsonRpc);

        let large = json!({
            "jsonrpc": "2.0",
            "method": "x",
            "params": {"payload": "x".repeat(MAX_MESSAGE_BYTES)}
        });
        let error = supervisor.send("validation", large).await.unwrap_err();
        assert_code(error, McpStdioErrorCode::MessageTooLarge);

        supervisor.close("validation").await.unwrap();
    }

    #[tokio::test]
    async fn json_rpc_validation_matches_strict_ts_envelope_rules() {
        let supervisor = McpStdioSupervisor::new();
        open_cat(&supervisor, "strict-validation").await;

        for message in [
            json!({"jsonrpc":"2.0","id":null,"method":"request"}),
            json!({"jsonrpc":"2.0","id":1.5,"method":"request"}),
            json!({"jsonrpc":"2.0","id":9_007_199_254_740_992_u64,"method":"request"}),
            json!({"jsonrpc":"2.0","id":1,"method":"bad\nmethod"}),
            json!({"jsonrpc":"2.0","method":"request","unknown":true}),
            json!({"jsonrpc":"2.0","id":1,"result":null,"unknown":true}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"x","unknown":true}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":9_007_199_254_740_992_u64,"message":"x"}}),
        ] {
            let error = supervisor
                .send("strict-validation", message)
                .await
                .unwrap_err();
            assert_code(error, McpStdioErrorCode::InvalidJsonRpc);
        }

        let response_with_null_id = json!({
            "jsonrpc": "2.0",
            "id": null,
            "result": {"accepted": true}
        });
        supervisor
            .send("strict-validation", response_with_null_id.clone())
            .await
            .unwrap();
        assert_eq!(
            supervisor
                .receive("strict-validation", None, Some(Duration::from_secs(1)))
                .await
                .unwrap(),
            response_with_null_id
        );
        supervisor.close("strict-validation").await.unwrap();
    }
}
