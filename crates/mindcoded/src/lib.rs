//! MindCode local daemon lifecycle and protocol service.

mod instance;
pub mod protocol;

use anyhow::{bail, Context, Result};
use instance::InstanceLock;
use mindcode_state::{
    ClaimOptions, ConflictMode, ListOptions, StateError, TaskGraph, TaskGraphConfig, TaskInput,
    TaskStatus, DEFAULT_LEASE_TTL_MS,
};
use protocol::{
    read_message, write_message, ClientMessage, RemoteErrorPayload, ServerMessage, PROTOCOL_VERSION,
};
use serde::{
    de::{DeserializeOwned, Deserializer},
    Deserialize, Serialize,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    net::{unix::OwnedWriteHalf, UnixListener, UnixStream},
    sync::{Mutex as AsyncMutex, Notify},
    sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError},
    task::JoinSet,
    time::{sleep, sleep_until, timeout, Instant as TokioInstant},
};
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;

const DEFAULT_IDLE_SECONDS: u64 = 30 * 60;
const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_POLL: Duration = Duration::from_millis(250);
const MAX_SLEEP_MS: u64 = 60_000;
pub const MAX_DAEMON_CONNECTIONS: usize = 64;
pub const MAX_DAEMON_IN_FLIGHT_REQUESTS: usize = 128;
pub const MAX_COMPLETED_MUTATION_REPLAY_BYTES: usize = 4 * 1024 * 1024;
const SERVER_CAPABILITIES: &[&str] = &[
    "request",
    "stream",
    "cancel",
    "ping",
    "status",
    "shutdown",
    "task_graph",
    "task_graph.route",
    "task_graph.route_update",
    "task_graph.read",
    "task_graph.list",
    "task_graph.list_dependents",
    "task_graph.claim",
    "task_graph.update",
    "task_graph.renew_lease",
    "task_graph.release_lease",
    "task_graph.recover",
    "task_graph.snapshot",
];

type SharedWriter = Arc<AsyncMutex<OwnedWriteHalf>>;

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UnixIdentity {
    dev: u64,
    ino: u64,
}

#[derive(Debug, Clone)]
pub struct DaemonConfig {
    pub socket: PathBuf,
    pub state_dir: Option<PathBuf>,
    pub idle_seconds: Option<u64>,
    pub handshake_timeout: Duration,
    pub build_id: String,
}

impl DaemonConfig {
    pub fn default_socket() -> PathBuf {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join(".mindcode/run/mindcoded-v1.sock")
    }

    pub fn idle_duration(&self) -> Option<Duration> {
        self.idle_seconds
            .or(Some(DEFAULT_IDLE_SECONDS))
            .filter(|seconds| *seconds > 0)
            .map(Duration::from_secs)
    }
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            socket: Self::default_socket(),
            state_dir: None,
            idle_seconds: Some(DEFAULT_IDLE_SECONDS),
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
            build_id: "dev".to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatusSnapshot {
    pub protocol_version: u16,
    pub build_id: String,
    pub pid: u32,
    pub uptime_ms: u64,
    pub active_connections: u64,
    pub active_sessions: u64,
    pub active_requests: u64,
    pub total_requests: u64,
    pub cancelled_requests: u64,
    pub idle_seconds: u64,
}

#[derive(Debug, Default)]
struct Metrics {
    active_connections: std::sync::atomic::AtomicU64,
    active_sessions: std::sync::atomic::AtomicU64,
    active_requests: std::sync::atomic::AtomicU64,
    total_requests: std::sync::atomic::AtomicU64,
    cancelled_requests: std::sync::atomic::AtomicU64,
}

struct DaemonState {
    config: DaemonConfig,
    task_graph: Arc<TaskGraph>,
    request_ledger: Arc<Mutex<RequestLedger>>,
    metrics: Arc<Metrics>,
    shutdown: CancellationToken,
    activity: Notify,
    connection_slots: Arc<Semaphore>,
    request_slots: Arc<Semaphore>,
    started_at: Instant,
}

struct SessionLease {
    metrics: Arc<Metrics>,
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;

        self.metrics.active_sessions.fetch_sub(1, Ordering::AcqRel);
    }
}

impl DaemonState {
    fn touch(&self) {
        self.activity.notify_waiters();
    }

    fn status(&self) -> StatusSnapshot {
        use std::sync::atomic::Ordering;

        StatusSnapshot {
            protocol_version: PROTOCOL_VERSION,
            build_id: self.config.build_id.clone(),
            pid: std::process::id(),
            uptime_ms: self.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
            active_connections: self.metrics.active_connections.load(Ordering::Relaxed),
            active_sessions: self.metrics.active_sessions.load(Ordering::Relaxed),
            active_requests: self.metrics.active_requests.load(Ordering::Relaxed),
            total_requests: self.metrics.total_requests.load(Ordering::Relaxed),
            cancelled_requests: self.metrics.cancelled_requests.load(Ordering::Relaxed),
            idle_seconds: self.config.idle_seconds.unwrap_or(DEFAULT_IDLE_SECONDS),
        }
    }
}

pub struct Daemon {
    state: Arc<DaemonState>,
}

impl Daemon {
    pub fn new(config: DaemonConfig) -> Self {
        let mut task_graph_config = TaskGraphConfig::from_env();
        task_graph_config.lease_ttl_ms = DEFAULT_LEASE_TTL_MS;
        if let Some(state_dir) = &config.state_dir {
            task_graph_config.state_dir = state_dir.clone();
        }
        Self {
            state: Arc::new(DaemonState {
                task_graph: Arc::new(TaskGraph::new(task_graph_config)),
                request_ledger: Arc::new(Mutex::new(RequestLedger::default())),
                config,
                metrics: Arc::new(Metrics::default()),
                shutdown: CancellationToken::new(),
                activity: Notify::new(),
                connection_slots: Arc::new(Semaphore::new(MAX_DAEMON_CONNECTIONS)),
                request_slots: Arc::new(Semaphore::new(MAX_DAEMON_IN_FLIGHT_REQUESTS)),
                started_at: Instant::now(),
            }),
        }
    }

    pub fn config(&self) -> &DaemonConfig {
        &self.state.config
    }

    pub fn shutdown(&self) {
        self.state.shutdown.cancel();
        self.state.touch();
    }

    pub async fn run(self) -> Result<()> {
        let socket_path = &self.state.config.socket;
        let parent = socket_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create daemon runtime directory {}", parent.display()))?;
        let runtime_identity = secure_runtime_directory(parent)?;

        let lock_path = parent.join("mindcoded-v1.lock");
        let _instance_lock =
            InstanceLock::acquire(&lock_path, socket_path, &self.state.config.build_id)
                .with_context(|| format!("acquire daemon instance lock {}", lock_path.display()))?;

        let task_graph = Arc::clone(&self.state.task_graph);
        tokio::task::spawn_blocking(move || task_graph.initialize())
            .await
            .context("join task graph initialization")??;

        ensure_runtime_directory_unchanged(parent, runtime_identity)?;
        remove_stale_socket(socket_path)?;
        let listener = bind_restricted_socket(socket_path)
            .with_context(|| format!("bind daemon socket {}", socket_path.display()))?;
        set_socket_mode(socket_path)?;
        let socket_identity = socket_identity(socket_path)?;
        ensure_runtime_directory_unchanged(parent, runtime_identity)?;

        let mut tasks = JoinSet::new();
        let mut last_activity = Instant::now();
        let idle_duration = self.state.config.idle_duration();

        loop {
            use std::sync::atomic::Ordering;

            let idle_allowed = self
                .state
                .metrics
                .active_connections
                .load(Ordering::Acquire)
                == 0
                && self.state.metrics.active_requests.load(Ordering::Acquire) == 0;
            let idle_deadline = idle_duration.map(|duration| last_activity + duration);
            let idle_sleep = sleep_until(TokioInstant::from_std(
                idle_deadline
                    .unwrap_or_else(|| Instant::now() + Duration::from_secs(24 * 60 * 60))
                    .max(Instant::now()),
            ));
            tokio::pin!(idle_sleep);

            tokio::select! {
                _ = self.state.shutdown.cancelled() => break,
                _ = tokio::signal::ctrl_c() => {
                    self.state.shutdown.cancel();
                    break;
                }
                accepted = listener.accept() => {
                    let (stream, _) = accepted.context("accept daemon connection")?;
                    last_activity = Instant::now();
                    let state = Arc::clone(&self.state);
                    match state.connection_slots.clone().try_acquire_owned() {
                        Ok(permit) => {
                            tasks.spawn(async move { handle_connection(stream, state, permit).await });
                        }
                        Err(TryAcquireError::NoPermits) => {
                            tasks.spawn(async move { reject_overloaded_connection(stream, state).await });
                        }
                        Err(TryAcquireError::Closed) => break,
                    }
                }
                joined = tasks.join_next(), if !tasks.is_empty() => {
                    if let Some(Err(error)) = joined {
                        eprintln!("mindcoded connection task failed: {error}");
                    }
                    last_activity = Instant::now();
                }
                _ = &mut idle_sleep, if idle_allowed && idle_deadline.is_some() => {
                    if last_activity.elapsed() >= idle_duration.unwrap_or_default() {
                        self.state.shutdown.cancel();
                        break;
                    }
                }
                _ = sleep(IDLE_POLL), if !idle_allowed => {}
            }
        }

        self.state.shutdown.cancel();
        while let Some(result) = tasks.join_next().await {
            if let Err(error) = result {
                eprintln!("mindcoded connection task failed during shutdown: {error}");
            }
        }
        drop(listener);
        if runtime_directory_unchanged(parent, runtime_identity) {
            remove_socket_if_owned(socket_path, socket_identity)?;
        }
        Ok(())
    }
}

const MAX_COMPLETED_MUTATION_REPLAYS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
struct RequestFingerprint {
    method: String,
    params: Option<Value>,
}

struct RequestEntry {
    generation: u64,
    token: CancellationToken,
}

#[derive(Default)]
struct ConnectionRegistry {
    requests: HashMap<String, RequestEntry>,
    next_generation: u64,
}

struct ActiveRequest {
    generation: u64,
}

#[derive(Default)]
struct RequestLedger {
    active: HashMap<String, ActiveRequest>,
    completed: HashMap<String, CompletedMutation>,
    completed_order: VecDeque<String>,
    completed_bytes: usize,
    next_generation: u64,
}

struct CompletedMutation {
    fingerprint: RequestFingerprint,
    result: RequestResult,
    bytes: usize,
}

fn replay_entry_bytes(
    request_id: &str,
    fingerprint: &RequestFingerprint,
    result: &RequestResult,
) -> usize {
    request_id
        .len()
        .saturating_add(fingerprint.method.len())
        .saturating_add(
            fingerprint
                .params
                .as_ref()
                .and_then(|value| serde_json::to_vec(value).ok())
                .map_or(0, |value| value.len()),
        )
        .saturating_add(
            result
                .result
                .as_ref()
                .and_then(|value| serde_json::to_vec(value).ok())
                .map_or(0, |value| value.len()),
        )
        .saturating_add(
            result
                .error
                .as_ref()
                .and_then(|value| serde_json::to_vec(value).ok())
                .map_or(0, |value| value.len()),
        )
}

enum RequestStart {
    Started(RequestLease),
    Replay(RequestResult),
    Duplicate,
    IdReuse,
    Overloaded,
}

struct RequestLease {
    request_id: String,
    local_generation: u64,
    global_generation: u64,
    fingerprint: RequestFingerprint,
    token: CancellationToken,
    local_registry: Arc<Mutex<ConnectionRegistry>>,
    global_registry: Arc<Mutex<RequestLedger>>,
    metrics: Arc<Metrics>,
    _in_flight_permit: OwnedSemaphorePermit,
    finished: bool,
}

impl RequestLease {
    fn begin(
        request_id: String,
        fingerprint: RequestFingerprint,
        local_registry: &Arc<Mutex<ConnectionRegistry>>,
        global_registry: &Arc<Mutex<RequestLedger>>,
        metrics: &Arc<Metrics>,
        request_slots: &Arc<Semaphore>,
    ) -> RequestStart {
        let mut global_guard = global_registry.lock().expect("request ledger poisoned");
        if let Some(completed) = global_guard.completed.get(&request_id) {
            return if completed.fingerprint == fingerprint {
                RequestStart::Replay(completed.result.clone())
            } else {
                RequestStart::IdReuse
            };
        }
        if global_guard.active.contains_key(&request_id) {
            return RequestStart::Duplicate;
        }
        let in_flight_permit = match request_slots.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(TryAcquireError::NoPermits | TryAcquireError::Closed) => {
                return RequestStart::Overloaded;
            }
        };
        global_guard.next_generation = global_guard.next_generation.wrapping_add(1).max(1);
        let global_generation = global_guard.next_generation;
        let token = CancellationToken::new();
        global_guard.active.insert(
            request_id.clone(),
            ActiveRequest {
                generation: global_generation,
            },
        );
        drop(global_guard);

        let mut local_guard = local_registry.lock().expect("connection registry poisoned");
        local_guard.next_generation = local_guard.next_generation.wrapping_add(1).max(1);
        let local_generation = local_guard.next_generation;
        local_guard.requests.insert(
            request_id.clone(),
            RequestEntry {
                generation: local_generation,
                token: token.clone(),
            },
        );
        drop(local_guard);

        use std::sync::atomic::Ordering;
        metrics.active_requests.fetch_add(1, Ordering::AcqRel);
        metrics.total_requests.fetch_add(1, Ordering::Relaxed);
        RequestStart::Started(Self {
            request_id,
            local_generation,
            global_generation,
            fingerprint,
            token,
            local_registry: Arc::clone(local_registry),
            global_registry: Arc::clone(global_registry),
            metrics: Arc::clone(metrics),
            _in_flight_permit: in_flight_permit,
            finished: false,
        })
    }

    fn finish(&mut self, cache_result: bool, result: &RequestResult) {
        if self.finished {
            return;
        }

        let mut global = self
            .global_registry
            .lock()
            .expect("request ledger poisoned");
        let owns_global = global
            .active
            .get(&self.request_id)
            .is_some_and(|entry| entry.generation == self.global_generation);
        if owns_global {
            global.active.remove(&self.request_id);
            if cache_result {
                let bytes = replay_entry_bytes(&self.request_id, &self.fingerprint, result);
                if bytes <= MAX_COMPLETED_MUTATION_REPLAY_BYTES {
                    global.completed_bytes = global.completed_bytes.saturating_add(bytes);
                    global.completed.insert(
                        self.request_id.clone(),
                        CompletedMutation {
                            fingerprint: self.fingerprint.clone(),
                            result: result.clone(),
                            bytes,
                        },
                    );
                    global.completed_order.push_back(self.request_id.clone());
                }
                while global.completed_order.len() > MAX_COMPLETED_MUTATION_REPLAYS
                    || global.completed_bytes > MAX_COMPLETED_MUTATION_REPLAY_BYTES
                {
                    if let Some(evicted) = global.completed_order.pop_front() {
                        if let Some(entry) = global.completed.remove(&evicted) {
                            global.completed_bytes =
                                global.completed_bytes.saturating_sub(entry.bytes);
                        }
                    }
                }
            }
        }
        drop(global);
        self.remove_local();
        self.metrics
            .active_requests
            .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        self.finished = true;
    }

    fn remove_local(&self) {
        let mut local = self
            .local_registry
            .lock()
            .expect("connection registry poisoned");
        if local
            .requests
            .get(&self.request_id)
            .is_some_and(|entry| entry.generation == self.local_generation)
        {
            local.requests.remove(&self.request_id);
        }
    }
}

impl Drop for RequestLease {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let mut global = self
            .global_registry
            .lock()
            .expect("request ledger poisoned");
        if global
            .active
            .get(&self.request_id)
            .is_some_and(|entry| entry.generation == self.global_generation)
        {
            global.active.remove(&self.request_id);
        }
        drop(global);
        self.remove_local();
        self.metrics
            .active_requests
            .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

async fn reject_overloaded_connection(
    mut stream: UnixStream,
    state: Arc<DaemonState>,
) -> Result<()> {
    let handshake = match timeout(
        state.config.handshake_timeout,
        read_message::<_, ClientMessage>(&mut stream),
    )
    .await
    {
        Ok(Ok(Some(ClientMessage::Handshake { id, .. }))) => id,
        _ => return Ok(()),
    };
    write_message(
        &mut stream,
        &ServerMessage::HandshakeAck {
            id: handshake,
            version: PROTOCOL_VERSION,
            accepted: false,
            server: Some(format!("mindcoded/{}", state.config.build_id)),
            capabilities: Vec::new(),
            error: Some(RemoteErrorPayload {
                code: "DAEMON_OVERLOADED_CONNECTIONS".into(),
                message: "daemon connection limit reached".into(),
                details: None,
            }),
        },
    )
    .await
    .context("write overloaded connection response")?;
    Ok(())
}

async fn handle_connection(
    stream: UnixStream,
    state: Arc<DaemonState>,
    _connection_permit: OwnedSemaphorePermit,
) -> Result<()> {
    use std::sync::atomic::Ordering;

    state
        .metrics
        .active_connections
        .fetch_add(1, Ordering::AcqRel);
    let result = handle_connection_inner(stream, Arc::clone(&state)).await;
    state
        .metrics
        .active_connections
        .fetch_sub(1, Ordering::AcqRel);
    state.touch();
    result
}

async fn handle_connection_inner(stream: UnixStream, state: Arc<DaemonState>) -> Result<()> {
    let (mut reader, writer_half) = stream.into_split();
    let writer = Arc::new(AsyncMutex::new(writer_half));
    let registry = Arc::new(Mutex::new(ConnectionRegistry::default()));

    let first_message = tokio::select! {
        _ = state.shutdown.cancelled() => return Ok(()),
        result = timeout(
            state.config.handshake_timeout,
            read_message::<_, ClientMessage>(&mut reader),
        ) => match result {
            Ok(result) => result.context("read protocol frame")?,
            Err(_) => return Ok(()),
        },
    };
    let Some(message) = first_message else {
        return Ok(());
    };
    state.touch();

    let ClientMessage::Handshake { id, version, .. } = message else {
        return Ok(());
    };
    let accepted = version == PROTOCOL_VERSION;
    let error = (!accepted).then(|| RemoteErrorPayload {
        code: "protocol_version".into(),
        message: format!("unsupported protocol version {version}"),
        details: None,
    });
    write_server_message(
        &writer,
        &ServerMessage::HandshakeAck {
            id,
            version: PROTOCOL_VERSION,
            accepted,
            server: Some(format!("mindcoded/{}", state.config.build_id)),
            capabilities: SERVER_CAPABILITIES
                .iter()
                .map(|value| (*value).into())
                .collect(),
            error,
        },
    )
    .await?;
    if !accepted {
        return Ok(());
    }
    state
        .metrics
        .active_sessions
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    let _session_lease = SessionLease {
        metrics: Arc::clone(&state.metrics),
    };

    let mut tasks: JoinSet<Result<()>> = JoinSet::new();
    let loop_result: Result<()> = loop {
        tokio::select! {
            _ = state.shutdown.cancelled() => break Ok(()),
            joined = tasks.join_next(), if !tasks.is_empty() => {
                if let Some(Err(error)) = joined {
                    eprintln!("mindcoded request task failed: {error}");
                }
            }
            message = read_message::<_, ClientMessage>(&mut reader) => {
                let message = match message.context("read protocol frame") {
                    Ok(Some(message)) => message,
                    Ok(None) => break Ok(()),
                    Err(error) => break Err(error),
                };
                state.touch();
                match message {
                    ClientMessage::Handshake { id, .. } => {
                        if let Err(error) = write_error(&writer, id, "duplicate_handshake", "handshake already completed").await {
                            break Err(error);
                        }
                    }
                    ClientMessage::Cancel { id } => {
                        if let Err(error) = handle_cancel(id, &state, &registry, &writer).await {
                            break Err(error);
                        }
                    }
                    ClientMessage::Request { id, method, params, .. } => {
                        let request_id = id.clone();
                        let fingerprint = RequestFingerprint {
                            method: method.clone(),
                            params: params.clone(),
                        };
                        let start = RequestLease::begin(
                            request_id.clone(),
                            fingerprint,
                            &registry,
                            &state.request_ledger,
                            &state.metrics,
                            &state.request_slots,
                        );
                        let lease = match start {
                            RequestStart::Started(lease) => lease,
                            RequestStart::Replay(result) => {
                                if let Err(error) = write_request_result(&writer, request_id, result).await {
                                    break Err(error);
                                }
                                continue;
                            }
                            RequestStart::Duplicate => {
                                if let Err(error) = write_error(&writer, request_id, "duplicate_request", "request id is already active").await {
                                    break Err(error);
                                }
                                continue;
                            }
                            RequestStart::IdReuse => {
                                if let Err(error) = write_error(&writer, request_id, "request_id_reuse", "request id was already completed with different method or params").await {
                                    break Err(error);
                                }
                                continue;
                            }
                            RequestStart::Overloaded => {
                                if let Err(error) = write_error(&writer, request_id, "DAEMON_OVERLOADED_REQUESTS", "daemon in-flight request limit reached").await {
                                    break Err(error);
                                }
                                continue;
                            }
                        };
                        let task_state = Arc::clone(&state);
                        let task_writer = Arc::clone(&writer);
                        tasks.spawn(async move {
                            run_request(id, method, params, lease, task_state, task_writer).await
                        });
                    }
                }
            }
        }
    };

    cancel_all_requests(&registry);
    while let Some(result) = tasks.join_next().await {
        if let Err(error) = result {
            eprintln!("mindcoded request task failed during shutdown: {error}");
        }
    }
    loop_result
}

async fn handle_cancel(
    id: String,
    state: &Arc<DaemonState>,
    registry: &Arc<Mutex<ConnectionRegistry>>,
    writer: &SharedWriter,
) -> Result<()> {
    let cancelled = {
        let registry_guard = registry.lock().expect("connection registry poisoned");
        if let Some(entry) = registry_guard.requests.get(&id) {
            let was_cancelled = entry.token.is_cancelled();
            entry.token.cancel();
            !was_cancelled
        } else {
            false
        }
    };
    if cancelled {
        state
            .metrics
            .cancelled_requests
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    write_ok(writer, id, json!({ "cancelled": cancelled })).await
}

async fn run_request(
    id: String,
    method: String,
    params: Option<Value>,
    lease: RequestLease,
    state: Arc<DaemonState>,
    writer: SharedWriter,
) -> Result<()> {
    let cancellation = lease.token.clone();
    let result = execute_request(&method, params, &state, cancellation).await?;
    let should_shutdown = result.shutdown;
    let replayable = is_mutation_method(&method);
    let mut lease = lease;
    if replayable {
        // Publish a completed mutation before writing its response so a
        // reconnect can replay it even if the original socket disappears.
        lease.finish(true, &result);
    }
    let response = ServerMessage::Response {
        id,
        ok: result.ok,
        result: result.result.clone(),
        error: result.error.clone(),
    };
    let write_result = write_server_message(&writer, &response).await;
    if !replayable {
        // Keep non-mutation request ids active until their response has been
        // written, preserving the existing duplicate-request protection.
        lease.finish(false, &result);
    }
    state.touch();
    if should_shutdown {
        state.shutdown.cancel();
    }
    write_result
}

#[derive(Debug, Clone)]
struct RequestResult {
    ok: bool,
    result: Option<Value>,
    error: Option<RemoteErrorPayload>,
    shutdown: bool,
}

impl RequestResult {
    fn ok(result: Value) -> Self {
        Self {
            ok: true,
            result: Some(result),
            error: None,
            shutdown: false,
        }
    }

    fn shutdown(result: Value) -> Self {
        Self {
            shutdown: true,
            ..Self::ok(result)
        }
    }

    fn error(code: &str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(RemoteErrorPayload {
                code: code.into(),
                message: message.into(),
                details: None,
            }),
            shutdown: false,
        }
    }

    fn cancelled() -> Self {
        Self::error("cancelled", "request cancelled")
    }

    fn serialized<T: Serialize>(value: T) -> Result<Self> {
        Ok(Self::ok(serde_json::to_value(value)?))
    }

    fn state_error(error: StateError) -> Self {
        let details = match &error {
            StateError::VersionConflict {
                task_id,
                expected,
                actual,
            } => Some(json!({
                "task_id": task_id,
                "expected_version": expected,
                "actual_version": actual,
            })),
            StateError::DependencyNotFound {
                task_id,
                dependency_id,
            } => Some(json!({
                "task_id": task_id,
                "dependency_id": dependency_id,
            })),
            StateError::DependencyCycle(cycle) => Some(json!({ "cycle": cycle })),
            _ => None,
        };
        Self {
            ok: false,
            result: None,
            error: Some(RemoteErrorPayload {
                code: error.code().into(),
                message: error.to_string(),
                details,
            }),
            shutdown: false,
        }
    }

    fn invalid_params(message: impl Into<String>) -> Self {
        Self::error("INVALID_PARAMS", message)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteParams {
    task: TaskInput,
    mode: Option<ConflictMode>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskIdParams {
    task_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum StatusFilter {
    One(TaskStatus),
    Many(Vec<TaskStatus>),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListParams {
    status: Option<StatusFilter>,
    owner: Option<Value>,
    limit: Option<u64>,
    offset: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClaimParams {
    task_id: String,
    owner: String,
    lease_id: Option<String>,
    ttl_ms: Option<u64>,
    expected_version: Option<u64>,
    now: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteUpdateParams {
    task_id: String,
    patch: Value,
    mode: Option<ConflictMode>,
    expected_version: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateParams {
    task_id: String,
    patch: Value,
    expected_version: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseParams {
    lease_id: String,
    owner: Option<String>,
    ttl_ms: Option<u64>,
    now: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseParams {
    lease_id: String,
    owner: Option<String>,
    now: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoverParams {
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    now: Option<String>,
}

fn deserialize_optional_string<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

fn parse_params<T: DeserializeOwned>(
    params: Option<Value>,
) -> std::result::Result<T, RequestResult> {
    let Some(params) = params else {
        return Err(RequestResult::invalid_params("params must be an object"));
    };
    if !params.is_object() {
        return Err(RequestResult::invalid_params("params must be an object"));
    }
    serde_json::from_value(params).map_err(|error| RequestResult::invalid_params(error.to_string()))
}

fn parse_empty_params(params: Option<Value>) -> std::result::Result<(), RequestResult> {
    match params {
        Some(Value::Object(object)) if object.is_empty() => Ok(()),
        Some(Value::Object(_)) | Some(_) | None => Err(RequestResult::invalid_params(
            "snapshot params must be an empty object",
        )),
    }
}

fn validate_rpc_patch(patch: &Value) -> std::result::Result<(), RequestResult> {
    let Some(object) = patch.as_object() else {
        return Err(RequestResult::invalid_params("patch must be an object"));
    };
    const ALLOWED: &[&str] = &[
        "status",
        "owner",
        "kind",
        "effort",
        "priority",
        "blocked_by",
        "depends_on",
        "claimed_at",
        "started_at",
        "finished_at",
        "files_touched",
        "read_set",
        "write_set",
        "isolation",
        "lease_id",
        "policy_epoch",
        "report_id",
        "expectedVersion",
        "expected_version",
        "version",
    ];
    if let Some(unknown) = object.keys().find(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(RequestResult::invalid_params(format!(
            "unknown patch field: {unknown}"
        )));
    }
    Ok(())
}

async fn run_state_call<T, F>(
    cancellation: &CancellationToken,
    operation: F,
) -> Result<Option<std::result::Result<T, StateError>>>
where
    T: Send + 'static,
    F: FnOnce() -> std::result::Result<T, StateError> + Send + 'static,
{
    let mut handle = tokio::task::spawn_blocking(operation);
    tokio::select! {
        result = &mut handle => {
            Ok(Some(result.context("join task graph operation")?))
        }
        _ = cancellation.cancelled() => {
            // `spawn_blocking` cannot be force-aborted after it starts. Wait
            // for the SQLite operation to reach its commit/rollback boundary
            // and return its actual result. A committed mutation must never
            // be reported as an ambiguous cancellation.
            Ok(Some(handle.await.context("join task graph operation")?))
        }
    }
}

async fn execute_request(
    method: &str,
    params: Option<Value>,
    state: &Arc<DaemonState>,
    cancellation: CancellationToken,
) -> Result<RequestResult> {
    if cancellation.is_cancelled() {
        return Ok(RequestResult::cancelled());
    }

    match method {
        "ping" => Ok(RequestResult::ok(json!({ "pong": true }))),
        "status" => Ok(RequestResult::ok(serde_json::to_value(state.status())?)),
        "sleep" => {
            let duration_ms = params
                .as_ref()
                .and_then(|value| value.get("duration_ms"))
                .and_then(Value::as_u64)
                .unwrap_or(1_000)
                .min(MAX_SLEEP_MS);
            tokio::select! {
                _ = cancellation.cancelled() => Ok(RequestResult::cancelled()),
                _ = sleep(Duration::from_millis(duration_ms)) => Ok(RequestResult::ok(json!({ "slept_ms": duration_ms }))),
            }
        }
        "shutdown" => Ok(RequestResult::shutdown(json!({ "accepted": true }))),
        "task_graph.route" => {
            let request = match parse_params::<RouteParams>(params) {
                Ok(value) => value,
                Err(error) => return Ok(error),
            };
            let graph = Arc::clone(&state.task_graph);
            let result = run_state_call(&cancellation, move || {
                graph.route(request.task, request.mode.unwrap_or_default())
            })
            .await?;
            match result {
                None => Ok(RequestResult::cancelled()),
                Some(Ok(value)) => RequestResult::serialized(value),
                Some(Err(error)) => Ok(RequestResult::state_error(error)),
            }
        }
        "task_graph.route_update" => {
            let request = match parse_params::<RouteUpdateParams>(params) {
                Ok(value) => value,
                Err(error) => return Ok(error),
            };
            if let Err(error) = validate_rpc_patch(&request.patch) {
                return Ok(error);
            }
            let graph = Arc::clone(&state.task_graph);
            let result = run_state_call(&cancellation, move || {
                graph.route_update(
                    &request.task_id,
                    request.patch,
                    request.mode.unwrap_or_default(),
                    request.expected_version,
                )
            })
            .await?;
            match result {
                None => Ok(RequestResult::cancelled()),
                Some(Ok(value)) => RequestResult::serialized(value),
                Some(Err(error)) => Ok(RequestResult::state_error(error)),
            }
        }
        "task_graph.read" => {
            let request = match parse_params::<TaskIdParams>(params) {
                Ok(value) => value,
                Err(error) => return Ok(error),
            };
            let graph = Arc::clone(&state.task_graph);
            let result =
                run_state_call(&cancellation, move || graph.read(&request.task_id)).await?;
            match result {
                None => Ok(RequestResult::cancelled()),
                Some(Ok(task)) => RequestResult::serialized(json!({ "task": task })),
                Some(Err(error)) => Ok(RequestResult::state_error(error)),
            }
        }
        "task_graph.list" => {
            let request = match parse_params::<ListParams>(params) {
                Ok(value) => value,
                Err(error) => return Ok(error),
            };
            let status = match request.status {
                None => None,
                Some(StatusFilter::One(value)) => Some(vec![value]),
                Some(StatusFilter::Many(value)) => Some(value),
            };
            let owner = match request.owner {
                None => None,
                Some(Value::Null) => Some(None),
                Some(Value::String(value)) => Some(Some(value)),
                Some(value) => {
                    return Ok(RequestResult::invalid_params(format!(
                        "owner must be a string or null, got {value}"
                    )))
                }
            };
            let options = ListOptions {
                status,
                owner,
                limit: request.limit,
                offset: request.offset,
            };
            let graph = Arc::clone(&state.task_graph);
            let result = run_state_call(&cancellation, move || graph.list(options)).await?;
            match result {
                None => Ok(RequestResult::cancelled()),
                Some(Ok(tasks)) => RequestResult::serialized(json!({ "tasks": tasks })),
                Some(Err(error)) => Ok(RequestResult::state_error(error)),
            }
        }
        "task_graph.list_dependents" => {
            let request = match parse_params::<TaskIdParams>(params) {
                Ok(value) => value,
                Err(error) => return Ok(error),
            };
            let graph = Arc::clone(&state.task_graph);
            let result = run_state_call(&cancellation, move || {
                graph.list_dependents(&request.task_id)
            })
            .await?;
            match result {
                None => Ok(RequestResult::cancelled()),
                Some(Ok(tasks)) => RequestResult::serialized(json!({ "tasks": tasks })),
                Some(Err(error)) => Ok(RequestResult::state_error(error)),
            }
        }
        "task_graph.claim" => {
            let request = match parse_params::<ClaimParams>(params) {
                Ok(value) => value,
                Err(error) => return Ok(error),
            };
            let options = ClaimOptions {
                lease_id: request.lease_id,
                ttl_ms: request.ttl_ms,
                expected_version: request.expected_version,
                now: request.now,
            };
            let graph = Arc::clone(&state.task_graph);
            let result = run_state_call(&cancellation, move || {
                graph.claim(&request.task_id, &request.owner, options)
            })
            .await?;
            match result {
                None => Ok(RequestResult::cancelled()),
                Some(Ok(value)) => RequestResult::serialized(value),
                Some(Err(error)) => Ok(RequestResult::state_error(error)),
            }
        }
        "task_graph.update" => {
            let request = match parse_params::<UpdateParams>(params) {
                Ok(value) => value,
                Err(error) => return Ok(error),
            };
            if let Err(error) = validate_rpc_patch(&request.patch) {
                return Ok(error);
            }
            let graph = Arc::clone(&state.task_graph);
            let result = run_state_call(&cancellation, move || {
                graph.update(&request.task_id, request.patch, request.expected_version)
            })
            .await?;
            match result {
                None => Ok(RequestResult::cancelled()),
                Some(Ok(task)) => RequestResult::serialized(json!({ "task": task })),
                Some(Err(error)) => Ok(RequestResult::state_error(error)),
            }
        }
        "task_graph.renew_lease" => {
            let request = match parse_params::<LeaseParams>(params) {
                Ok(value) => value,
                Err(error) => return Ok(error),
            };
            let graph = Arc::clone(&state.task_graph);
            let result = run_state_call(&cancellation, move || {
                graph.renew_lease(
                    &request.lease_id,
                    request.owner.as_deref(),
                    request.ttl_ms,
                    request.now.as_deref(),
                )
            })
            .await?;
            match result {
                None => Ok(RequestResult::cancelled()),
                Some(Ok(lease)) => RequestResult::serialized(json!({ "lease": lease })),
                Some(Err(error)) => Ok(RequestResult::state_error(error)),
            }
        }
        "task_graph.release_lease" => {
            let request = match parse_params::<ReleaseParams>(params) {
                Ok(value) => value,
                Err(error) => return Ok(error),
            };
            let graph = Arc::clone(&state.task_graph);
            let result = run_state_call(&cancellation, move || {
                graph.release_lease(
                    &request.lease_id,
                    request.owner.as_deref(),
                    request.now.as_deref(),
                )
            })
            .await?;
            match result {
                None => Ok(RequestResult::cancelled()),
                Some(Ok(lease)) => RequestResult::serialized(json!({ "lease": lease })),
                Some(Err(error)) => Ok(RequestResult::state_error(error)),
            }
        }
        "task_graph.recover" => {
            let request = match parse_params::<RecoverParams>(params) {
                Ok(value) => value,
                Err(error) => return Ok(error),
            };
            let now = request.now;
            let graph = Arc::clone(&state.task_graph);
            let result =
                run_state_call(&cancellation, move || graph.recover(now.as_deref())).await?;
            match result {
                None => Ok(RequestResult::cancelled()),
                Some(Ok(value)) => RequestResult::serialized(value),
                Some(Err(error)) => Ok(RequestResult::state_error(error)),
            }
        }
        "task_graph.snapshot" => {
            if let Err(error) = parse_empty_params(params) {
                return Ok(error);
            }
            let graph = Arc::clone(&state.task_graph);
            let result = run_state_call(&cancellation, move || graph.snapshot()).await?;
            match result {
                None => Ok(RequestResult::cancelled()),
                Some(Ok(value)) => RequestResult::serialized(value),
                Some(Err(error)) => Ok(RequestResult::state_error(error)),
            }
        }
        _ => Ok(RequestResult::error(
            "unsupported_method",
            format!("unsupported daemon method: {method}"),
        )),
    }
}

fn cancel_all_requests(registry: &Arc<Mutex<ConnectionRegistry>>) {
    let registry_guard = registry.lock().expect("connection registry poisoned");
    for entry in registry_guard.requests.values() {
        entry.token.cancel();
    }
}

fn is_mutation_method(method: &str) -> bool {
    matches!(
        method,
        "task_graph.route"
            | "task_graph.claim"
            | "task_graph.update"
            | "task_graph.renew_lease"
            | "task_graph.release_lease"
            | "task_graph.recover"
    )
}

async fn write_server_message(writer: &SharedWriter, message: &ServerMessage) -> Result<()> {
    let mut writer_guard = writer.lock().await;
    write_message(&mut *writer_guard, message)
        .await
        .context("write daemon response")
}

async fn write_request_result(
    writer: &SharedWriter,
    id: String,
    result: RequestResult,
) -> Result<()> {
    write_server_message(
        writer,
        &ServerMessage::Response {
            id,
            ok: result.ok,
            result: result.result,
            error: result.error,
        },
    )
    .await
}

async fn write_ok(writer: &SharedWriter, id: String, result: Value) -> Result<()> {
    write_server_message(
        writer,
        &ServerMessage::Response {
            id,
            ok: true,
            result: Some(result),
            error: None,
        },
    )
    .await
}

async fn write_error(writer: &SharedWriter, id: String, code: &str, message: &str) -> Result<()> {
    write_server_message(
        writer,
        &ServerMessage::Response {
            id,
            ok: false,
            result: None,
            error: Some(RemoteErrorPayload {
                code: code.into(),
                message: message.into(),
                details: None,
            }),
        },
    )
    .await
}

#[cfg(unix)]
fn unix_identity(metadata: &std::fs::Metadata) -> UnixIdentity {
    use std::os::unix::fs::MetadataExt;
    UnixIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
    }
}

#[cfg(unix)]
fn secure_runtime_directory(path: &Path) -> Result<UnixIdentity> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("stat daemon runtime directory {}", path.display()))?;
    if !metadata.file_type().is_dir() {
        bail!("daemon runtime path is not a directory: {}", path.display());
    }
    let uid = unsafe { libc::geteuid() } as u32;
    if metadata.uid() != uid {
        bail!(
            "daemon runtime directory is not owned by the current user: {}",
            path.display()
        );
    }
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(path, permissions)
        .with_context(|| format!("set daemon runtime directory mode {}", path.display()))?;
    let verified = std::fs::symlink_metadata(path)?;
    if !verified.file_type().is_dir()
        || verified.uid() != uid
        || verified.permissions().mode() & 0o777 != 0o700
    {
        bail!(
            "daemon runtime directory failed security checks: {}",
            path.display()
        );
    }
    Ok(unix_identity(&verified))
}

#[cfg(not(unix))]
fn secure_runtime_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn ensure_runtime_directory_unchanged(path: &Path, expected: UnixIdentity) -> Result<()> {
    if !runtime_directory_unchanged(path, expected) {
        bail!(
            "daemon runtime directory changed during startup: {}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_runtime_directory_unchanged(_path: &Path, _expected: ()) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn runtime_directory_unchanged(path: &Path, expected: UnixIdentity) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_dir() && unix_identity(&metadata) == expected)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn runtime_directory_unchanged(_path: &Path, _expected: ()) -> bool {
    true
}

fn remove_stale_socket(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() => std::fs::remove_file(path)
            .with_context(|| format!("remove stale socket {}", path.display())),
        Ok(_) => bail!("daemon socket path is not a socket: {}", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("inspect daemon socket {}", path.display()))
        }
    }
}

#[cfg(unix)]
fn bind_restricted_socket(path: &Path) -> std::io::Result<UnixListener> {
    // AF_UNIX bind applies the process umask to the socket inode. Tokio's
    // path-based bind cannot make creation and chmod one atomic operation, so
    // use a restrictive umask for the bind and verify the result immediately.
    let previous = unsafe { libc::umask(0o077) };
    let result = UnixListener::bind(path);
    unsafe { libc::umask(previous) };
    result
}

#[cfg(not(unix))]
fn bind_restricted_socket(path: &Path) -> std::io::Result<UnixListener> {
    UnixListener::bind(path)
}

#[cfg(unix)]
fn set_socket_mode(path: &Path) -> Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_socket() {
        bail!(
            "daemon socket was replaced before permission check: {}",
            path.display()
        );
    }
    if metadata.uid() != unsafe { libc::geteuid() } as u32 {
        bail!(
            "daemon socket is not owned by the current user: {}",
            path.display()
        );
    }
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o600);
    std::fs::set_permissions(path, permissions)?;
    let verified = std::fs::symlink_metadata(path)?;
    if !verified.file_type().is_socket() || verified.permissions().mode() & 0o777 != 0o600 {
        bail!("daemon socket failed security checks: {}", path.display());
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_socket_mode(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn socket_identity(path: &Path) -> Result<UnixIdentity> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_socket() {
        bail!("daemon socket is not a socket: {}", path.display());
    }
    Ok(unix_identity(&metadata))
}

#[cfg(not(unix))]
fn socket_identity(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn remove_socket_if_owned(path: &Path, expected: UnixIdentity) -> Result<()> {
    let remove = std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_socket() && unix_identity(&metadata) == expected)
        .unwrap_or(false);
    if remove {
        std::fs::remove_file(path)
            .with_context(|| format!("remove daemon socket {}", path.display()))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn remove_socket_if_owned(path: &Path, _expected: ()) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() => std::fs::remove_file(path)
            .with_context(|| format!("remove daemon socket {}", path.display())),
        Ok(_) | Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::net::UnixStream;

    fn test_config(path: PathBuf) -> DaemonConfig {
        let state_dir = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("state");
        DaemonConfig {
            socket: path,
            state_dir: Some(state_dir),
            idle_seconds: Some(60),
            handshake_timeout: Duration::from_millis(100),
            build_id: "test-build".into(),
        }
    }

    async fn wait_for_socket(path: &Path) {
        for _ in 0..100 {
            if path.exists() {
                return;
            }
            sleep(Duration::from_millis(10)).await;
        }
        panic!("socket was not created: {}", path.display());
    }

    async fn connect_and_handshake(path: &Path) -> UnixStream {
        let mut stream = UnixStream::connect(path).await.unwrap();
        write_message(
            &mut stream,
            &ClientMessage::Handshake {
                id: "handshake-1".into(),
                version: PROTOCOL_VERSION,
                client: "test-client".into(),
                capabilities: vec!["request".into()],
            },
        )
        .await
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).await.unwrap().unwrap();
        assert!(matches!(
            response,
            ServerMessage::HandshakeAck { accepted: true, .. }
        ));
        stream
    }

    async fn request(
        stream: &mut UnixStream,
        id: &str,
        method: &str,
        params: Option<Value>,
    ) -> ServerMessage {
        write_message(
            stream,
            &ClientMessage::Request {
                id: id.into(),
                method: method.into(),
                params,
                stream: false,
            },
        )
        .await
        .unwrap();
        read_message(stream).await.unwrap().unwrap()
    }

    async fn shutdown(stream: &mut UnixStream) {
        let response = request(stream, "shutdown", "shutdown", None).await;
        assert!(matches!(response, ServerMessage::Response { ok: true, .. }));
    }

    #[tokio::test]
    async fn handshake_ping_status_and_shutdown() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("run/mindcoded.sock");
        let task = tokio::spawn(Daemon::new(test_config(path.clone())).run());
        wait_for_socket(&path).await;
        let mut stream = connect_and_handshake(&path).await;
        for (id, method) in [("request-1", "ping"), ("request-2", "status")] {
            let response = request(&mut stream, id, method, None).await;
            assert!(matches!(response, ServerMessage::Response { ok: true, .. }));
        }
        shutdown(&mut stream).await;
        drop(stream);
        task.await.unwrap().unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn incompatible_handshake_is_rejected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mindcoded.sock");
        let task = tokio::spawn(Daemon::new(test_config(path.clone())).run());
        wait_for_socket(&path).await;
        let mut stream = UnixStream::connect(&path).await.unwrap();
        write_message(
            &mut stream,
            &ClientMessage::Handshake {
                id: "bad".into(),
                version: 99,
                client: "test".into(),
                capabilities: vec![],
            },
        )
        .await
        .unwrap();
        let response: ServerMessage = read_message(&mut stream).await.unwrap().unwrap();
        assert!(matches!(
            response,
            ServerMessage::HandshakeAck {
                accepted: false,
                ..
            }
        ));
        task.abort();
        let _ = task.await;
    }

    #[tokio::test]
    async fn handshake_timeout_closes_uninitialized_connection() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mindcoded.sock");
        let mut config = test_config(path.clone());
        config.handshake_timeout = Duration::from_millis(30);
        let task = tokio::spawn(Daemon::new(config).run());
        wait_for_socket(&path).await;
        let mut stream = UnixStream::connect(&path).await.unwrap();
        let result = timeout(
            Duration::from_millis(500),
            read_message::<_, ServerMessage>(&mut stream),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(result.is_none());
        task.abort();
        let _ = task.await;
    }

    #[tokio::test]
    async fn cancellation_is_read_while_request_is_active() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mindcoded.sock");
        let task = tokio::spawn(Daemon::new(test_config(path.clone())).run());
        wait_for_socket(&path).await;
        let mut stream = connect_and_handshake(&path).await;
        write_message(
            &mut stream,
            &ClientMessage::Request {
                id: "long-request".into(),
                method: "sleep".into(),
                params: Some(json!({ "duration_ms": 5_000 })),
                stream: false,
            },
        )
        .await
        .unwrap();
        sleep(Duration::from_millis(20)).await;
        write_message(
            &mut stream,
            &ClientMessage::Cancel {
                id: "long-request".into(),
            },
        )
        .await
        .unwrap();

        let first = timeout(
            Duration::from_secs(1),
            read_message::<_, ServerMessage>(&mut stream),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        let second = timeout(
            Duration::from_secs(1),
            read_message::<_, ServerMessage>(&mut stream),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        let responses = [first, second];
        assert!(responses.iter().any(|message| matches!(
            message,
            ServerMessage::Response { result: Some(result), .. }
                if result.get("cancelled") == Some(&Value::Bool(true))
        )));
        assert!(responses.iter().any(|message| matches!(
            message,
            ServerMessage::Response { ok: false, error: Some(error), .. }
                if error.code == "cancelled"
        )));
        let status = request(&mut stream, "status-after-cancel", "status", None).await;
        match status {
            ServerMessage::Response {
                result: Some(result),
                ..
            } => {
                // The status request itself owns a lease until its response is
                // written, so the snapshot includes that one active request.
                assert_eq!(result["active_requests"], 1);
            }
            other => panic!("unexpected status response: {other:?}"),
        }
        shutdown(&mut stream).await;
        drop(stream);
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn duplicate_active_request_id_is_rejected_and_metrics_stay_balanced() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mindcoded.sock");
        let task = tokio::spawn(Daemon::new(test_config(path.clone())).run());
        wait_for_socket(&path).await;
        let mut stream = connect_and_handshake(&path).await;
        write_message(
            &mut stream,
            &ClientMessage::Request {
                id: "same-id".into(),
                method: "sleep".into(),
                params: Some(json!({ "duration_ms": 5_000 })),
                stream: false,
            },
        )
        .await
        .unwrap();
        sleep(Duration::from_millis(20)).await;
        let duplicate = request(&mut stream, "same-id", "ping", None).await;
        assert!(matches!(
            duplicate,
            ServerMessage::Response { ok: false, error: Some(error), .. }
                if error.code == "duplicate_request"
        ));
        write_message(
            &mut stream,
            &ClientMessage::Cancel {
                id: "same-id".into(),
            },
        )
        .await
        .unwrap();
        let _ = read_message::<_, ServerMessage>(&mut stream).await.unwrap();
        let _ = read_message::<_, ServerMessage>(&mut stream).await.unwrap();
        let status = request(&mut stream, "status-after-duplicate", "status", None).await;
        match status {
            ServerMessage::Response {
                result: Some(result),
                ..
            } => {
                assert_eq!(result["active_requests"], 1);
            }
            other => panic!("unexpected status response: {other:?}"),
        }
        shutdown(&mut stream).await;
        drop(stream);
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn global_connection_limit_returns_a_stable_handshake_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("run/mindcoded.sock");
        let task = tokio::spawn(Daemon::new(test_config(path.clone())).run());
        wait_for_socket(&path).await;
        let mut held = Vec::with_capacity(MAX_DAEMON_CONNECTIONS);
        for _ in 0..MAX_DAEMON_CONNECTIONS {
            held.push(connect_and_handshake(&path).await);
        }

        let mut overloaded = UnixStream::connect(&path).await.unwrap();
        write_message(
            &mut overloaded,
            &ClientMessage::Handshake {
                id: "overload-handshake".into(),
                version: PROTOCOL_VERSION,
                client: "overload-test".into(),
                capabilities: vec![],
            },
        )
        .await
        .unwrap();
        let response = timeout(
            Duration::from_secs(1),
            read_message::<_, ServerMessage>(&mut overloaded),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert!(matches!(
            response,
            ServerMessage::HandshakeAck {
                accepted: false,
                error: Some(error),
                ..
            } if error.code == "DAEMON_OVERLOADED_CONNECTIONS"
        ));
        drop(overloaded);
        shutdown(&mut held[0]).await;
        drop(held);
        task.await.unwrap().unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runtime_and_socket_permissions_are_restricted() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let dir = tempdir().unwrap();
        let runtime = dir.path().join("run");
        let path = runtime.join("mindcoded.sock");
        let task = tokio::spawn(Daemon::new(test_config(path.clone())).run());
        wait_for_socket(&path).await;
        let runtime_mode = std::fs::symlink_metadata(&runtime)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let socket_metadata = std::fs::symlink_metadata(&path).unwrap();
        assert_eq!(runtime_mode, 0o700);
        assert_eq!(socket_metadata.permissions().mode() & 0o777, 0o600);
        assert_eq!(socket_metadata.uid(), unsafe { libc::geteuid() } as u32);
        let mut stream = connect_and_handshake(&path).await;
        shutdown(&mut stream).await;
        drop(stream);
        task.await.unwrap().unwrap();
    }

    #[test]
    fn duplicate_lease_does_not_replace_generation() {
        let metrics = Arc::new(Metrics::default());
        let local_registry = Arc::new(Mutex::new(ConnectionRegistry::default()));
        let global_registry = Arc::new(Mutex::new(RequestLedger::default()));
        let request_slots = Arc::new(Semaphore::new(MAX_DAEMON_IN_FLIGHT_REQUESTS));
        let fingerprint = RequestFingerprint {
            method: "task_graph.update".into(),
            params: Some(json!({"task_id":"id"})),
        };
        let first = match RequestLease::begin(
            "id".into(),
            fingerprint.clone(),
            &local_registry,
            &global_registry,
            &metrics,
            &request_slots,
        ) {
            RequestStart::Started(lease) => lease,
            _ => panic!("expected started request"),
        };
        assert!(matches!(
            RequestLease::begin(
                "id".into(),
                fingerprint,
                &local_registry,
                &global_registry,
                &metrics,
                &request_slots,
            ),
            RequestStart::Duplicate
        ));
        assert_eq!(
            local_registry
                .lock()
                .unwrap()
                .requests
                .get("id")
                .unwrap()
                .generation,
            first.local_generation
        );
        drop(first);
        assert!(local_registry.lock().unwrap().requests.is_empty());
        assert!(global_registry.lock().unwrap().active.is_empty());
        assert_eq!(
            metrics
                .active_requests
                .load(std::sync::atomic::Ordering::Relaxed),
            0
        );
    }

    #[test]
    fn request_slots_return_a_stable_overload_result() {
        let metrics = Arc::new(Metrics::default());
        let local_registry = Arc::new(Mutex::new(ConnectionRegistry::default()));
        let global_registry = Arc::new(Mutex::new(RequestLedger::default()));
        let request_slots = Arc::new(Semaphore::new(1));
        let fingerprint = RequestFingerprint {
            method: "sleep".into(),
            params: None,
        };
        let first = match RequestLease::begin(
            "first".into(),
            fingerprint.clone(),
            &local_registry,
            &global_registry,
            &metrics,
            &request_slots,
        ) {
            RequestStart::Started(lease) => lease,
            _ => panic!("expected first request"),
        };
        assert!(matches!(
            RequestLease::begin(
                "second".into(),
                fingerprint,
                &local_registry,
                &global_registry,
                &metrics,
                &request_slots,
            ),
            RequestStart::Overloaded
        ));
        drop(first);
    }

    #[test]
    fn replay_cache_obeys_both_entry_and_byte_budgets() {
        let metrics = Arc::new(Metrics::default());
        let local_registry = Arc::new(Mutex::new(ConnectionRegistry::default()));
        let global_registry = Arc::new(Mutex::new(RequestLedger::default()));
        let request_slots = Arc::new(Semaphore::new(1));
        let payload = "x".repeat(30_000);
        for index in 0..200 {
            let lease = match RequestLease::begin(
                format!("replay-{index}"),
                RequestFingerprint {
                    method: "task_graph.route".into(),
                    params: Some(json!({"index": index})),
                },
                &local_registry,
                &global_registry,
                &metrics,
                &request_slots,
            ) {
                RequestStart::Started(lease) => lease,
                _ => panic!("expected replay request"),
            };
            let result = RequestResult::ok(json!({"payload": payload}));
            let mut lease = lease;
            lease.finish(true, &result);
        }
        let ledger = global_registry.lock().unwrap();
        assert!(ledger.completed_bytes <= MAX_COMPLETED_MUTATION_REPLAY_BYTES);
        assert!(ledger.completed_order.len() < 200);
        assert!(ledger.completed_order.len() <= MAX_COMPLETED_MUTATION_REPLAYS);
    }

    #[test]
    fn stale_socket_path_is_not_deleted_when_not_a_socket() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("socket");
        std::fs::write(&path, b"not a socket").unwrap();
        let error = remove_stale_socket(&path).unwrap_err();
        assert!(format!("{error:#}").contains("not a socket"));
    }
}
