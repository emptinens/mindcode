//! In-process mock provider server for the transport integration tests.
//!
//! A self-contained `tokio::net::TcpListener` server bound to
//! `127.0.0.1:0`. It never contacts the network or a live provider and it
//! records every received `Authorization` header so tests can verify the
//! `Bearer` value against a key held only in test code.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

/// Test-only credential value. It lives exclusively in this test module and
/// never in the repository tree or any real config directory.
pub const TEST_API_KEY: &str = "test-transport-key-9f8e7d6c5b4a";

const CATALOG_JSON: &[u8] = br#"{"object":"list","data":[{"id":"model-alpha"},{"id":"model-beta","owned_by":"tests"},{"id":"model-gamma"}]}"#;

const CHAT_CHUNK_ROLE: &str = r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model-alpha","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}"#;
const CHAT_CHUNK_HELLO: &str = r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model-alpha","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#;
const CHAT_CHUNK_WORLD: &str = r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model-alpha","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}"#;
const CHAT_CHUNK_STOP: &str = r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model-alpha","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#;

const MESSAGE_START: &str = r#"{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"model-alpha","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}"#;
const MESSAGE_BLOCK_START: &str =
    r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#;
const MESSAGE_DELTA_HELLO: &str =
    r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#;
const MESSAGE_DELTA_WORLD: &str =
    r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}"#;
const MESSAGE_DELTA_STOP: &str = r#"{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}"#;

/// Configurable routing table for one mock server instance.
#[derive(Clone)]
pub struct MockRoutes {
    pub models_status: u16,
    pub models_body: Vec<u8>,
    pub chat_status: u16,
    pub chat_events: Vec<String>,
    pub messages_status: u16,
    pub messages_events: Vec<String>,
    pub oversized: bool,
}

impl Default for MockRoutes {
    fn default() -> Self {
        Self {
            models_status: 200,
            models_body: CATALOG_JSON.to_vec(),
            chat_status: 200,
            chat_events: vec![
                CHAT_CHUNK_ROLE.to_owned(),
                CHAT_CHUNK_HELLO.to_owned(),
                CHAT_CHUNK_WORLD.to_owned(),
                CHAT_CHUNK_STOP.to_owned(),
                "[DONE]".to_owned(),
            ],
            messages_status: 200,
            messages_events: vec![
                MESSAGE_START.to_owned(),
                MESSAGE_BLOCK_START.to_owned(),
                MESSAGE_DELTA_HELLO.to_owned(),
                MESSAGE_DELTA_WORLD.to_owned(),
                MESSAGE_DELTA_STOP.to_owned(),
                r#"{"type":"message_stop"}"#.to_owned(),
            ],
            oversized: false,
        }
    }
}

/// A running mock provider. `base_url()` is the only address needed by the
/// transport; every test must call `shutdown()` (or drop the runtime).
pub struct MockServer {
    pub addr: SocketAddr,
    auth: Arc<Mutex<Vec<Option<String>>>>,
    shutdown: Option<oneshot::Sender<()>>,
    handle: tokio::task::JoinHandle<()>,
}

impl MockServer {
    pub async fn start(routes: MockRoutes) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind mock");
        let addr = listener.local_addr().expect("mock local addr");
        let auth = Arc::new(Mutex::new(Vec::new()));
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let handle = tokio::spawn(serve(listener, routes, auth.clone(), shutdown_rx));
        Self {
            addr,
            auth,
            shutdown: Some(shutdown_tx),
            handle,
        }
    }

    /// The `http://127.0.0.1:<port>` base URL used as the transport base.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Every `Authorization` header value received so far, in order.
    pub fn authorization_headers(&self) -> Vec<String> {
        self.auth
            .lock()
            .expect("mock auth lock")
            .iter()
            .flatten()
            .cloned()
            .collect()
    }

    /// The last `Authorization` header value received, if any.
    pub fn last_authorization(&self) -> Option<String> {
        self.authorization_headers().into_iter().last()
    }

    /// Stop the listener and wait for the server task to exit.
    pub async fn shutdown(mut self) {
        if let Some(sender) = self.shutdown.take() {
            let _ = sender.send(());
        }
        let _ = self.handle.await;
    }
}

async fn serve(
    listener: TcpListener,
    routes: MockRoutes,
    auth: Arc<Mutex<Vec<Option<String>>>>,
    mut shutdown: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let routes = routes.clone();
                let auth = auth.clone();
                tokio::spawn(async move {
                    let _ = handle_connection(stream, routes, auth).await;
                });
            }
        }
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    routes: MockRoutes,
    auth: Arc<Mutex<Vec<Option<String>>>>,
) -> std::io::Result<()> {
    let request = match read_request(&mut stream).await {
        Ok(request) => request,
        Err(_) => return Ok(()),
    };
    auth.lock()
        .expect("mock auth lock")
        .push(request.authorization);
    if routes.oversized {
        return write_oversized(&mut stream).await;
    }
    let response = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/models") => {
            http_response(routes.models_status, "application/json", routes.models_body)
        }
        ("POST", "/chat/completions") => sse_response(routes.chat_status, &routes.chat_events),
        ("POST", "/v1/messages") => sse_response(routes.messages_status, &routes.messages_events),
        _ => http_response(404, "text/plain", b"not found".to_vec()),
    };
    stream.write_all(&response).await
}

struct Request {
    method: String,
    path: String,
    authorization: Option<String>,
}

async fn read_request(stream: &mut TcpStream) -> std::io::Result<Request> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        if let Some(position) = find_subslice(&buffer, b"\r\n\r\n") {
            break position;
        }
        if buffer.len() > 64 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "mock request headers too large",
            ));
        }
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "mock request ended early",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let header = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header.split("\r\n");
    let mut parts = lines.next().unwrap_or_default().split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();

    let mut authorization = None;
    let mut content_length = 0usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("authorization") {
                authorization = Some(value.trim().to_owned());
            }
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }

    let body_start = header_end + 4;
    if buffer.len() < body_start + content_length {
        buffer.resize(body_start + content_length, 0);
        stream.read_exact(&mut buffer[body_start..]).await?;
    }
    let _ = &buffer[body_start..body_start + content_length];

    Ok(Request {
        method,
        path,
        authorization,
    })
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn http_response(status: u16, content_type: &str, body: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(
        format!(
            "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            status_text(status),
            body.len()
        )
        .as_bytes(),
    );
    out.extend_from_slice(&body);
    out
}

fn sse_response(status: u16, events: &[String]) -> Vec<u8> {
    let mut body = String::new();
    for event in events {
        body.push_str("data: ");
        body.push_str(event);
        body.push_str("\n\n");
    }
    http_response(status, "text/event-stream", body.into_bytes())
}

async fn write_oversized(stream: &mut TcpStream) -> std::io::Result<()> {
    stream
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
        )
        .await?;
    let chunk = vec![b'x'; 64 * 1024];
    for _ in 0..144 {
        stream.write_all(&chunk).await?;
    }
    Ok(())
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "Status",
    }
}
