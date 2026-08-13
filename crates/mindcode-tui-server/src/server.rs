//! Server side of the native TUI control protocol.
//!
//! Mirrors the TypeScript `src/runtime/nativeTui/controlServer.ts` reference:
//! a single-client Unix-socket listener with a capability-negotiated handshake,
//! a backpressure-bounded outbound queue (with snapshot coalescing), and
//! input routing.  All I/O is local; no network or live provider is touched.

use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use mindcode_protocol::ui::{
    decode_ui_frame, encode_ui_frame, UiInputEventKind, UiMessage, UiRenderSnapshot,
    UI_MAX_FRAME_SIZE, UI_PROTOCOL_VERSION,
};
use mindcode_protocol::ProtocolError;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{oneshot, Mutex, Notify};
use tokio::task::JoinHandle;

use crate::projection::{ProjectionError, ProjectionInput, ProjectionStore};

pub const DEFAULT_CLIENT: &str = "mindcode-tui";
pub const DEFAULT_CLIENT_CAPABILITIES: [&str; 6] = [
    "render_snapshot",
    "input",
    "resize",
    "shutdown",
    "mouse",
    "action",
];
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(3_000);
pub const DEFAULT_MAX_OUTBOUND_MESSAGES: usize = 256;
pub const DEFAULT_MAX_OUTBOUND_BYTES: usize = UI_MAX_FRAME_SIZE * 2;

#[derive(Debug)]
pub enum ControlServerError {
    Io(std::io::Error),
    Protocol(ProtocolError),
    Projection(ProjectionError),
    InvalidConfiguration(String),
    QueueSaturated,
    Closed,
}

impl fmt::Display for ControlServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "control server I/O error: {error}"),
            Self::Protocol(error) => write!(f, "control server protocol error: {error}"),
            Self::Projection(error) => write!(f, "control server projection error: {error}"),
            Self::InvalidConfiguration(message) => {
                write!(f, "control server configuration error: {message}")
            }
            Self::QueueSaturated => write!(f, "control server outbound queue is saturated"),
            Self::Closed => write!(f, "control server is closed"),
        }
    }
}

impl std::error::Error for ControlServerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Protocol(error) => Some(error),
            Self::Projection(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for ControlServerError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<ProtocolError> for ControlServerError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

impl From<ProjectionError> for ControlServerError {
    fn from(error: ProjectionError) -> Self {
        Self::Projection(error)
    }
}

/// Callback invoked for each accepted `input_event` after capability checks.
pub type InputHandler = Arc<dyn Fn(UiMessage) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct ControlServerConfig {
    pub session_id: String,
    pub socket_path: PathBuf,
    pub capabilities: Vec<String>,
    pub expected_client: String,
    pub expected_client_capabilities: Vec<String>,
    pub handshake_timeout: Duration,
    pub max_outbound_queue_messages: usize,
    pub max_outbound_queue_bytes: usize,
}

impl ControlServerConfig {
    pub fn new(session_id: impl Into<String>, socket_path: impl Into<PathBuf>) -> Self {
        Self {
            session_id: session_id.into(),
            socket_path: socket_path.into(),
            capabilities: DEFAULT_CLIENT_CAPABILITIES
                .iter()
                .map(|capability| capability.to_string())
                .collect(),
            expected_client: DEFAULT_CLIENT.to_owned(),
            expected_client_capabilities: DEFAULT_CLIENT_CAPABILITIES
                .iter()
                .map(|capability| capability.to_string())
                .collect(),
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
            max_outbound_queue_messages: DEFAULT_MAX_OUTBOUND_MESSAGES,
            max_outbound_queue_bytes: DEFAULT_MAX_OUTBOUND_BYTES,
        }
    }

    fn validate(&self) -> Result<(), ControlServerError> {
        if self.session_id.is_empty() {
            return Err(ControlServerError::InvalidConfiguration(
                "session_id must not be empty".into(),
            ));
        }
        if !self
            .session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(ControlServerError::InvalidConfiguration(
                "session_id must contain only ASCII path-safe characters".into(),
            ));
        }
        if self.capabilities.is_empty() || self.capabilities.len() > 64 {
            return Err(ControlServerError::InvalidConfiguration(
                "capabilities must contain 1-64 values".into(),
            ));
        }
        if self.expected_client.is_empty() {
            return Err(ControlServerError::InvalidConfiguration(
                "expected_client must not be empty".into(),
            ));
        }
        if self.max_outbound_queue_messages == 0 || self.max_outbound_queue_bytes == 0 {
            return Err(ControlServerError::InvalidConfiguration(
                "outbound queue bounds must be positive".into(),
            ));
        }
        Ok(())
    }
}

struct Inner {
    config: ControlServerConfig,
    on_input: Option<InputHandler>,
    state: Mutex<State>,
    closed: Notify,
}

struct State {
    projection: ProjectionStore,
    current: Option<Arc<ClientConn>>,
    accept_handle: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub struct ControlServer {
    inner: Arc<Inner>,
}

impl ControlServer {
    pub fn new(
        config: ControlServerConfig,
        on_input: Option<InputHandler>,
    ) -> Result<Self, ControlServerError> {
        config.validate()?;
        let projection = ProjectionStore::new(config.session_id.clone())?;
        Ok(Self {
            inner: Arc::new(Inner {
                config,
                on_input,
                state: Mutex::new(State {
                    projection,
                    current: None,
                    accept_handle: None,
                }),
                closed: Notify::new(),
            }),
        })
    }

    pub fn socket_path(&self) -> &std::path::Path {
        &self.inner.config.socket_path
    }

    pub fn session_id(&self) -> &str {
        &self.inner.config.session_id
    }

    pub async fn start(&self) -> Result<(), ControlServerError> {
        {
            let state = self.inner.state.lock().await;
            if state.accept_handle.is_some() {
                return Ok(());
            }
        }
        prepare_socket_dir(&self.inner.config.socket_path).await?;
        remove_stale_socket(&self.inner.config.socket_path).await?;
        let listener = UnixListener::bind(&self.inner.config.socket_path)?;
        let inner = self.inner.clone();
        let handle = tokio::spawn(async move {
            accept_loop(listener, inner).await;
        });
        self.inner.state.lock().await.accept_handle = Some(handle);
        Ok(())
    }

    pub async fn close(&self) {
        self.inner.closed.notify_waiters();
        let client = {
            let mut state = self.inner.state.lock().await;
            if let Some(handle) = state.accept_handle.take() {
                handle.abort();
            }
            state.current.take()
        };
        if let Some(client) = client {
            client.shutdown().await;
        }
        let _ = tokio::fs::remove_file(&self.inner.config.socket_path).await;
    }

    /// Project a state update into a snapshot and, when a client is ready,
    /// send it.  Returns the produced snapshot.
    pub async fn publish(
        &self,
        input: &ProjectionInput,
    ) -> Result<UiRenderSnapshot, ControlServerError> {
        let snapshot = self.inner.state.lock().await.projection.update(input)?;
        let client = self.inner.state.lock().await.current.clone();
        if let Some(client) = client {
            client.send_snapshot_if_ready(&snapshot).await;
        }
        Ok(snapshot)
    }

    pub async fn revision(&self) -> u64 {
        self.inner.state.lock().await.projection.revision()
    }

    pub async fn snapshot(&self) -> Option<UiRenderSnapshot> {
        self.inner.state.lock().await.projection.snapshot().cloned()
    }
}

async fn prepare_socket_dir(path: &std::path::Path) -> Result<(), ControlServerError> {
    let Some(parent) = path.parent() else {
        return Err(ControlServerError::InvalidConfiguration(
            "socket path has no parent directory".into(),
        ));
    };
    tokio::fs::create_dir_all(parent).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await?;
    }
    Ok(())
}

async fn remove_stale_socket(path: &std::path::Path) -> Result<(), ControlServerError> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => {
            use std::os::unix::fs::FileTypeExt;
            if !metadata.file_type().is_socket() {
                return Err(ControlServerError::InvalidConfiguration(
                    "socket path exists and is not a Unix socket".into(),
                ));
            }
            tokio::fs::remove_file(path).await?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn accept_loop(listener: UnixListener, inner: Arc<Inner>) {
    loop {
        tokio::select! {
            _ = inner.closed.notified() => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { break };
                let conn = Arc::new(ClientConn::new(inner.config.clone()));
                {
                    let mut state = inner.state.lock().await;
                    if let Some(previous) = state.current.take() {
                        drop(state);
                        previous.shutdown().await;
                        state = inner.state.lock().await;
                    }
                    state.current = Some(conn.clone());
                }
                conn.spawn(stream, inner.clone()).await;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Client connection.
// ---------------------------------------------------------------------------

struct OutboundEntry {
    frame: Vec<u8>,
    snapshot: bool,
    sequence: Option<u64>,
    done: Option<oneshot::Sender<Result<(), ControlServerError>>>,
}

#[derive(Default)]
struct WriterQueue {
    entries: VecDeque<OutboundEntry>,
    queued_bytes: usize,
}

#[derive(Clone)]
struct ClientHandle {
    queue: Arc<Mutex<WriterQueue>>,
    notify: Arc<Notify>,
    last_sent: Arc<Mutex<Option<u64>>>,
    max_messages: usize,
    max_bytes: usize,
}

impl ClientHandle {
    async fn send(&self, message: &UiMessage) -> Result<(), ControlServerError> {
        let frame = encode_ui_frame(message)?;
        let (is_snapshot, sequence) = match message {
            UiMessage::RenderSnapshot { sequence, .. } => (true, Some(*sequence)),
            _ => (false, None),
        };
        let (done, receiver) = oneshot::channel();
        self.enqueue(OutboundEntry {
            frame,
            snapshot: is_snapshot,
            sequence,
            done: Some(done),
        })
        .await?;
        receiver.await.map_err(|_| ControlServerError::Closed)??;
        Ok(())
    }

    /// Enqueue a snapshot without awaiting its write (fire-and-forget).
    /// Stale or coalesced snapshots are dropped silently.
    async fn send_snapshot(&self, snapshot: &UiRenderSnapshot) -> Result<(), ControlServerError> {
        // Skip snapshots no newer than the last one already sent.
        if self
            .last_sent
            .lock()
            .await
            .is_some_and(|last| snapshot.sequence <= last)
        {
            return Ok(());
        }
        let frame = encode_ui_frame(&UiMessage::RenderSnapshot {
            version: snapshot.version,
            id: snapshot.id.clone(),
            sequence: snapshot.sequence,
            sessions: snapshot.sessions.clone(),
            workspaces: snapshot.workspaces.clone(),
            active_session_id: snapshot.active_session_id.clone(),
            status: snapshot.status.clone(),
            telemetry: snapshot.telemetry.clone(),
            tasks: snapshot.tasks.clone(),
            agents: snapshot.agents.clone(),
            transcript: snapshot.transcript.clone(),
            transcript_window: snapshot.transcript_window.clone(),
            changes: snapshot.changes.clone(),
            activity: snapshot.activity.clone(),
            permissions: snapshot.permissions.clone(),
            writer: snapshot.writer.clone(),
        })?;
        self.enqueue(OutboundEntry {
            frame,
            snapshot: true,
            sequence: Some(snapshot.sequence),
            done: None,
        })
        .await?;
        Ok(())
    }

    async fn enqueue(&self, entry: OutboundEntry) -> Result<(), ControlServerError> {
        {
            let mut queue = self.queue.lock().await;
            enqueue_entry(&mut queue, entry, self.max_messages, self.max_bytes)?;
        }
        self.notify.notify_one();
        Ok(())
    }
}

fn enqueue_entry(
    queue: &mut WriterQueue,
    entry: OutboundEntry,
    max_messages: usize,
    max_bytes: usize,
) -> Result<(), ControlServerError> {
    if entry.snapshot {
        if let Some(index) = queue.entries.iter().position(|queued| queued.snapshot) {
            let previous = queue
                .entries
                .remove(index)
                .expect("positioned entry exists");
            let next_bytes = queue.queued_bytes - previous.frame.len() + entry.frame.len();
            if next_bytes > max_bytes {
                queue.entries.insert(index, previous);
                return Err(ControlServerError::QueueSaturated);
            }
            queue.queued_bytes = next_bytes;
            if let Some(done) = previous.done {
                let _ = done.send(Ok(()));
            }
            queue.entries.insert(index, entry);
            return Ok(());
        }
    }
    if queue.entries.len() >= max_messages || queue.queued_bytes + entry.frame.len() > max_bytes {
        return Err(ControlServerError::QueueSaturated);
    }
    queue.queued_bytes += entry.frame.len();
    queue.entries.push_back(entry);
    Ok(())
}

struct ClientConn {
    handle: ClientHandle,
    ready: Arc<AtomicBool>,
    handshake_complete: Arc<AtomicBool>,
    negotiated: Arc<Mutex<HashSet<String>>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl ClientConn {
    fn new(config: ControlServerConfig) -> Self {
        let handle = ClientHandle {
            queue: Arc::new(Mutex::new(WriterQueue::default())),
            notify: Arc::new(Notify::new()),
            last_sent: Arc::new(Mutex::new(None)),
            max_messages: config.max_outbound_queue_messages,
            max_bytes: config.max_outbound_queue_bytes,
        };
        Self {
            handle,
            ready: Arc::new(AtomicBool::new(false)),
            handshake_complete: Arc::new(AtomicBool::new(false)),
            negotiated: Arc::new(Mutex::new(HashSet::new())),
            tasks: Mutex::new(Vec::new()),
        }
    }

    async fn spawn(self: &Arc<Self>, stream: UnixStream, inner: Arc<Inner>) {
        let (read, write) = stream.into_split();
        let writer = tokio::spawn(writer_task(write, self.handle.clone(), self.clone()));
        let reader = tokio::spawn(reader_task(read, self.clone(), inner.clone()));
        let timeout = tokio::spawn(handshake_timeout_task(
            self.clone(),
            inner.config.handshake_timeout,
        ));
        self.tasks.lock().await.extend([writer, reader, timeout]);
    }

    async fn shutdown(&self) {
        self.ready.store(false, Ordering::SeqCst);
        self.handshake_complete.store(false, Ordering::SeqCst);
        let tasks = std::mem::take(&mut *self.tasks.lock().await);
        for task in tasks {
            task.abort();
        }
        // Reject anything still queued so senders observe the closure.
        let mut queue = self.handle.queue.lock().await;
        for entry in queue.entries.drain(..) {
            if let Some(done) = entry.done {
                let _ = done.send(Err(ControlServerError::Closed));
            }
        }
        queue.queued_bytes = 0;
    }

    async fn send_snapshot_if_ready(&self, snapshot: &UiRenderSnapshot) {
        if !self.ready.load(Ordering::SeqCst) {
            return;
        }
        if !self.negotiated.lock().await.contains("render_snapshot") {
            return;
        }
        let _ = self.handle.send_snapshot(snapshot).await;
    }

    async fn send_error(
        &self,
        id: &str,
        code: &str,
        message: &str,
    ) -> Result<(), ControlServerError> {
        self.handle
            .send(&UiMessage::Error {
                version: UI_PROTOCOL_VERSION,
                id: id.to_owned(),
                code: code.to_owned(),
                message: message.to_owned(),
                details: None,
            })
            .await
    }
}

async fn handshake_timeout_task(conn: Arc<ClientConn>, timeout: Duration) {
    tokio::time::sleep(timeout).await;
    if !conn.ready.load(Ordering::SeqCst) {
        conn.shutdown().await;
    }
}

async fn writer_task(mut write: OwnedWriteHalf, handle: ClientHandle, conn: Arc<ClientConn>) {
    loop {
        let next = {
            let mut queue = handle.queue.lock().await;
            if queue.entries.is_empty() {
                drop(queue);
                handle.notify.notified().await;
                continue;
            }
            queue.entries.pop_front()
        };
        let Some(entry) = next else { continue };
        {
            let mut queue = handle.queue.lock().await;
            queue.queued_bytes = queue.queued_bytes.saturating_sub(entry.frame.len());
        }
        if let Err(error) = write.write_all(&entry.frame).await {
            if let Some(done) = entry.done {
                let _ = done.send(Err(ControlServerError::Io(error)));
            }
            fail_queue(&handle).await;
            conn.shutdown().await;
            return;
        }
        if entry.snapshot {
            if let Some(sequence) = entry.sequence {
                let mut last = handle.last_sent.lock().await;
                if last.is_none_or(|current| sequence > current) {
                    *last = Some(sequence);
                }
            }
        }
        if let Some(done) = entry.done {
            let _ = done.send(Ok(()));
        }
    }
}

async fn fail_queue(handle: &ClientHandle) {
    let mut queue = handle.queue.lock().await;
    for entry in queue.entries.drain(..) {
        if let Some(done) = entry.done {
            let _ = done.send(Err(ControlServerError::Closed));
        }
    }
    queue.queued_bytes = 0;
}

struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    fn push(&mut self, bytes: &[u8]) -> Result<Vec<UiMessage>, ControlServerError> {
        if self.buffer.len().saturating_add(bytes.len()) > UI_MAX_FRAME_SIZE + 4 {
            return Err(ControlServerError::Protocol(ProtocolError::FrameTooLarge {
                size: self.buffer.len() + bytes.len(),
                max: UI_MAX_FRAME_SIZE,
            }));
        }
        self.buffer.extend_from_slice(bytes);
        let mut decoded = Vec::new();
        loop {
            if self.buffer.len() < 4 {
                break;
            }
            let payload_size =
                u32::from_be_bytes(self.buffer[..4].try_into().expect("four-byte header")) as usize;
            if payload_size == 0 {
                return Err(ControlServerError::Protocol(ProtocolError::ZeroLengthFrame));
            }
            if payload_size > UI_MAX_FRAME_SIZE {
                return Err(ControlServerError::Protocol(ProtocolError::FrameTooLarge {
                    size: payload_size,
                    max: UI_MAX_FRAME_SIZE,
                }));
            }
            let frame_size = payload_size + 4;
            if self.buffer.len() < frame_size {
                break;
            }
            let frame: Vec<u8> = self.buffer.drain(..frame_size).collect();
            decoded.push(decode_ui_frame(&frame)?);
        }
        Ok(decoded)
    }
}

async fn reader_task(mut read: OwnedReadHalf, conn: Arc<ClientConn>, inner: Arc<Inner>) {
    let mut decoder = FrameDecoder::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = match read.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        let messages = match decoder.push(&buffer[..count]) {
            Ok(messages) => messages,
            Err(_) => break,
        };
        for message in messages {
            if handle_message(&conn, &inner, message).await.is_err() {
                return;
            }
        }
    }
    disconnect(&inner, &conn).await;
}

async fn disconnect(inner: &Arc<Inner>, conn: &Arc<ClientConn>) {
    conn.shutdown().await;
    let mut state = inner.state.lock().await;
    if state
        .current
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, conn))
    {
        state.current = None;
    }
}

async fn handle_message(
    conn: &Arc<ClientConn>,
    inner: &Arc<Inner>,
    message: UiMessage,
) -> Result<(), ControlServerError> {
    let id = message_id(&message).to_owned();
    if !conn.handshake_complete.load(Ordering::SeqCst)
        && !matches!(message, UiMessage::Handshake { .. })
    {
        conn.send_error(&id, "handshake_required", "Handshake required")
            .await?;
        conn.shutdown().await;
        return Err(ControlServerError::Closed);
    }
    match message {
        UiMessage::Handshake {
            version,
            id,
            client,
            capabilities,
        } => {
            if conn.handshake_complete.load(Ordering::SeqCst) {
                conn.send_error(&id, "duplicate_handshake", "Handshake already completed")
                    .await?;
                conn.shutdown().await;
                return Err(ControlServerError::Closed);
            }
            if version != UI_PROTOCOL_VERSION {
                conn.send_error(&id, "handshake_rejected", "Unsupported protocol version")
                    .await?;
                conn.shutdown().await;
                return Err(ControlServerError::Closed);
            }
            let Some(negotiated) =
                negotiate_capabilities(&inner.config, &id, &client, &capabilities)
            else {
                conn.send_error(
                    &id,
                    "handshake_rejected",
                    "Handshake values do not match this native TUI session",
                )
                .await?;
                conn.shutdown().await;
                return Err(ControlServerError::Closed);
            };
            *conn.negotiated.lock().await = negotiated.iter().cloned().collect();
            conn.handshake_complete.store(true, Ordering::SeqCst);
            conn.ready.store(true, Ordering::SeqCst);
            conn.handle
                .send(&UiMessage::Capabilities {
                    version: UI_PROTOCOL_VERSION,
                    id: inner.config.session_id.clone(),
                    capabilities: negotiated,
                })
                .await?;
            let snapshot = inner.state.lock().await.projection.snapshot().cloned();
            if let Some(snapshot) = snapshot {
                conn.send_snapshot_if_ready(&snapshot).await;
            }
            Ok(())
        }
        UiMessage::Capabilities { .. } => Ok(()),
        UiMessage::TerminalSize { id, .. } => {
            if !require_capability(conn, &id, "resize").await? {
                return Ok(());
            }
            Ok(())
        }
        UiMessage::InputEvent {
            id,
            sequence,
            event,
            ..
        } => {
            if !require_capability(conn, &id, "input").await? {
                return Ok(());
            }
            if matches!(event, UiInputEventKind::Mouse(_))
                && !require_capability(conn, &id, "mouse").await?
            {
                return Ok(());
            }
            if matches!(event, UiInputEventKind::Action(_))
                && !require_capability(conn, &id, "action").await?
            {
                return Ok(());
            }
            if let Some(on_input) = &inner.on_input {
                on_input(UiMessage::InputEvent {
                    version: UI_PROTOCOL_VERSION,
                    id: id.clone(),
                    sequence,
                    event,
                });
            }
            conn.handle
                .send(&UiMessage::Ack {
                    version: UI_PROTOCOL_VERSION,
                    id,
                    sequence,
                })
                .await?;
            Ok(())
        }
        UiMessage::Shutdown {
            version,
            id,
            reason,
        } => {
            if !require_capability(conn, &id, "shutdown").await? {
                return Ok(());
            }
            conn.handle
                .send(&UiMessage::Shutdown {
                    version,
                    id,
                    reason,
                })
                .await?;
            conn.shutdown().await;
            Err(ControlServerError::Closed)
        }
        other => Err(ControlServerError::InvalidConfiguration(format!(
            "unsupported client message: {other:?}"
        ))),
    }
}

async fn require_capability(
    conn: &ClientConn,
    id: &str,
    capability: &str,
) -> Result<bool, ControlServerError> {
    if conn.negotiated.lock().await.contains(capability) {
        return Ok(true);
    }
    conn.send_error(
        id,
        "capability_required",
        &format!("Capability {capability} was not negotiated"),
    )
    .await?;
    Ok(false)
}

fn negotiate_capabilities(
    config: &ControlServerConfig,
    id: &str,
    client: &str,
    capabilities: &[String],
) -> Option<Vec<String>> {
    if id != config.session_id || client != config.expected_client {
        return None;
    }
    let actual: HashSet<&str> = capabilities.iter().map(String::as_str).collect();
    if actual.len() != capabilities.len()
        || !config
            .expected_client_capabilities
            .iter()
            .all(|capability| actual.contains(capability.as_str()))
    {
        return None;
    }
    Some(
        config
            .capabilities
            .iter()
            .filter(|capability| actual.contains(capability.as_str()))
            .cloned()
            .collect(),
    )
}

fn message_id(message: &UiMessage) -> &str {
    match message {
        UiMessage::Handshake { id, .. }
        | UiMessage::Capabilities { id, .. }
        | UiMessage::TerminalSize { id, .. }
        | UiMessage::InputEvent { id, .. }
        | UiMessage::RenderSnapshot { id, .. }
        | UiMessage::Ack { id, .. }
        | UiMessage::Error { id, .. }
        | UiMessage::Shutdown { id, .. } => id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(frame: Vec<u8>, snapshot: bool, sequence: Option<u64>) -> OutboundEntry {
        OutboundEntry {
            frame,
            snapshot,
            sequence,
            done: None,
        }
    }

    #[test]
    fn enqueue_coalesces_pending_snapshots() {
        let mut queue = WriterQueue::default();
        enqueue_entry(&mut queue, entry(vec![1], true, Some(1)), 256, 1024).unwrap();
        enqueue_entry(&mut queue, entry(vec![2], true, Some(2)), 256, 1024).unwrap();
        assert_eq!(queue.entries.len(), 1);
        assert_eq!(queue.entries[0].sequence, Some(2));
        assert_eq!(queue.queued_bytes, 1);
    }

    #[test]
    fn enqueue_rejects_when_message_count_is_saturated() {
        let mut queue = WriterQueue::default();
        enqueue_entry(&mut queue, entry(vec![1], false, None), 1, 1024).unwrap();
        assert!(matches!(
            enqueue_entry(&mut queue, entry(vec![2], false, None), 1, 1024),
            Err(ControlServerError::QueueSaturated)
        ));
    }

    #[test]
    fn enqueue_rejects_when_byte_budget_is_saturated() {
        let mut queue = WriterQueue::default();
        assert!(matches!(
            enqueue_entry(&mut queue, entry(vec![0; 8], false, None), 256, 4),
            Err(ControlServerError::QueueSaturated)
        ));
        assert!(queue.entries.is_empty());
    }

    #[test]
    fn handshake_requires_matching_session_and_client() {
        let config = ControlServerConfig::new("session-1", "/tmp/never-bound.sock");
        assert_eq!(
            negotiate_capabilities(&config, "session-1", "mindcode-tui", &["input".to_owned()]),
            None
        );
        assert!(negotiate_capabilities(
            &config,
            "session-1",
            "mindcode-tui",
            &[
                "render_snapshot".into(),
                "input".into(),
                "resize".into(),
                "shutdown".into(),
                "mouse".into(),
                "action".into()
            ]
        )
        .is_some());
        assert_eq!(
            negotiate_capabilities(
                &config,
                "other",
                "mindcode-tui",
                &[
                    "render_snapshot".into(),
                    "input".into(),
                    "resize".into(),
                    "shutdown".into(),
                    "mouse".into(),
                    "action".into()
                ]
            ),
            None
        );
    }
}
