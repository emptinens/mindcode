//! Fail-closed HTTP transport for the MindCode provider protocols.
//!
//! Owns the two wire protocols of the 0.1.3 multi-provider contract:
//! `openai-compatible` (`GET /models`, `POST /chat/completions`) and
//! `anthropic-compatible` (`GET /v1/models`, `POST /v1/messages`). Both
//! authenticate with a
//! `Bearer` header built exclusively from the opaque [`SecretKey`]; the key
//! value can never appear in any [`TransportError`] `Display`, `Debug`, or
//! serialized diagnostic. Response bodies are never echoed into errors, all
//! reads are size-bounded, and every malformed response fails closed with a
//! typed [`TransportError`] instead of a panic.
//!
//! `https` is permitted for any host; `http` is permitted only on loopback
//! hosts. No OAuth, marketplace, preset, or transport fallback exists.

#![forbid(unsafe_code)]

use futures_util::stream::{unfold, Stream};
use futures_util::StreamExt;
use mindcode_provider::{ModelId, Protocol, SecretKey};
use mindcode_vexzy::WorkerEffort;
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

pub mod soft_interrupt;

/// Connection establishment timeout for every provider request.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Overall timeout for every provider request, including streamed bodies.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Hard cap on the total number of response bytes read from a provider.
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// Hard cap on a single SSE line; a longer line is a bounded error.
pub const MAX_SSE_LINE_BYTES: usize = 1024 * 1024;
/// Bounded channel capacity between the streaming reader and the consumer.
const SSE_CHANNEL_CAPACITY: usize = 16;
/// Number of retries after the initial provider attempt for transient failures.
const MAX_RETRIES: usize = 2;
/// Deterministic backoff base; a small clock-derived jitter avoids synchronized
/// retry storms without adding a random-number dependency.
const RETRY_BASE_DELAY: Duration = Duration::from_millis(500);

/// A coarse, secret-free classification of an unsuccessful provider status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpFailureKind {
    Unauthorized,
    Forbidden,
    NotFound,
    RateLimited,
    ClientError,
    ServerError,
    Redirect,
    Other,
}

impl HttpFailureKind {
    fn classify(status: StatusCode) -> Self {
        match status.as_u16() {
            401 => Self::Unauthorized,
            403 => Self::Forbidden,
            404 => Self::NotFound,
            429 => Self::RateLimited,
            300..=399 => Self::Redirect,
            400..=499 => Self::ClientError,
            500..=599 => Self::ServerError,
            _ => Self::Other,
        }
    }
}

impl fmt::Display for HttpFailureKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not found",
            Self::RateLimited => "rate limited",
            Self::ClientError => "client error",
            Self::ServerError => "server error",
            Self::Redirect => "redirect",
            Self::Other => "other",
        })
    }
}

/// A typed transport failure.
///
/// Every variant is secret-free and body-free: neither the credential value
/// nor any response payload is ever stored or rendered here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransportError {
    InvalidUrl,
    UnsupportedScheme,
    Http { status: u16, kind: HttpFailureKind },
    ResponseTooLarge { limit_bytes: usize },
    InvalidJson,
    InvalidCatalog { index: usize },
    ProviderError,
    RequestTimeout,
    ConnectFailed,
    RequestFailed,
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUrl => f.write_str("provider base URL is invalid"),
            Self::UnsupportedScheme => f.write_str(
                "provider base URL must be https; http is allowed only on loopback hosts",
            ),
            Self::Http { status, kind } => {
                write!(f, "provider returned HTTP {status} ({kind})")
            }
            Self::ResponseTooLarge { limit_bytes } => {
                write!(f, "provider response exceeded the {limit_bytes}-byte limit")
            }
            Self::InvalidJson => f.write_str("provider response body is not valid JSON"),
            Self::InvalidCatalog { index } => {
                write!(
                    f,
                    "provider model catalog contains an invalid entry at index {index}"
                )
            }
            Self::ProviderError => f.write_str("provider reported a stream error"),
            Self::RequestTimeout => f.write_str("provider request timed out"),
            Self::ConnectFailed => f.write_str("failed to connect to provider"),
            Self::RequestFailed => f.write_str("provider request failed"),
        }
    }
}

impl std::error::Error for TransportError {}

/// One row of an `openai-compatible` model catalog projection.
///
/// Only secret-free, minimal fields are projected; provider-specific extras
/// are ignored so a future provider addition cannot make the catalog
/// unparsable.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CatalogRow {
    pub id: String,
    #[serde(default)]
    pub object: Option<String>,
    #[serde(default)]
    pub created: Option<u64>,
    #[serde(default)]
    pub owned_by: Option<String>,
}

/// The typed `openai-compatible` `GET {base_url}/models` response.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ModelCatalog {
    pub object: String,
    pub data: Vec<CatalogRow>,
}

/// One row of the `anthropic-compatible` `GET {base_url}/v1/models` list.
///
/// The wire shape is deliberately strict: every field must be present and
/// unknown fields are rejected, so a malformed page fails closed instead of
/// being partially projected.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AnthropicModelRow {
    pub id: String,
    pub r#type: String,
    pub created_at: String,
    pub display_name: String,
}

/// The typed `anthropic-compatible` `GET {base_url}/v1/models` response.
///
/// The pagination fields (`has_more`, `first_id`, `last_id`) are projected
/// for completeness; the 0.1.3 transport returns the first page only and
/// never follows `has_more`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AnthropicModelList {
    pub data: Vec<AnthropicModelRow>,
    pub has_more: bool,
    pub first_id: Option<String>,
    pub last_id: Option<String>,
}

/// One request message shared by both chat protocols.
///
/// The neutral shape also carries tool-call requests (on `role:
/// "assistant"` messages) and tool results (`role: "tool"` plus
/// `tool_result_id`). The body builders translate these into each
/// protocol's wire format: OpenAI keeps them natively, Anthropic rewrites
/// them into `tool_use` / `tool_result` content blocks.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// Assistant tool-call requests (OpenAI-native shape).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Correlation id for a `role: "tool"` result message: `tool_call_id` on
    /// OpenAI, `tool_use_id` on Anthropic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_result_id: Option<String>,
}

/// One assistant tool-call request in a message. Serializes to the OpenAI
/// `{id, type: "function", function: {name, arguments}}` shape; the Anthropic
/// builder translates it into a `tool_use` content block.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: ToolCallFunction,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ToolCallFunction {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// JSON-encoded arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
}

/// A tool the model may call, in a provider-neutral shape. The request body
/// builders translate it into each protocol's wire format.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema describing the tool arguments.
    pub parameters: Value,
}

/// The `openai-compatible` chat request; `stream` is always set to `true` by
/// the client and is not part of this shape.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatCompletionsRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// Tools offered to the model; empty is omitted from the wire body.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolSpec>,
    /// Optional global Worker effort lock. `none` is omitted from the wire.
    #[serde(skip)]
    pub reasoning_effort: Option<WorkerEffort>,
}

/// The `anthropic-compatible` messages request; `stream` is always set to
/// `true` by the client and is not part of this shape.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MessagesRequest {
    pub model: String,
    pub max_tokens: u64,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// Tools offered to the model; empty is omitted from the wire body.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolSpec>,
    /// Optional global Worker effort lock. `none` is omitted from the wire.
    #[serde(skip)]
    pub reasoning_effort: Option<WorkerEffort>,
}

/// One streamed `openai-compatible` chat chunk (`data: {...}` line).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatChunk {
    pub id: String,
    pub object: String,
    #[serde(default)]
    pub created: u64,
    pub model: String,
    #[serde(default)]
    pub error: Option<Value>,
    pub choices: Vec<ChatChoice>,
    /// Final-chunk token usage (`prompt_tokens`/`completion_tokens`) when the
    /// gateway reports it (§10.3).
    #[serde(default)]
    pub usage: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatChoice {
    pub index: u64,
    pub delta: ChatDelta,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ChatDelta {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    /// Streamed tool-call fragments (`index` groups them; `arguments` may
    /// arrive across several chunks).
    #[serde(default)]
    pub tool_calls: Vec<ChatToolCallDelta>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ChatToolCallDelta {
    #[serde(default)]
    pub index: u64,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub function: Option<ChatToolCallFunction>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ChatToolCallFunction {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<String>,
}

/// One streamed `anthropic-compatible` messages event (`data: {...}` line).
///
/// `message_stop` terminates the stream and is not yielded to consumers.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MessageChunk {
    pub r#type: String,
    #[serde(default)]
    pub index: Option<u64>,
    #[serde(default)]
    pub delta: Option<MessageDelta>,
    #[serde(default)]
    pub message: Option<MessageStart>,
    #[serde(default)]
    pub content_block: Option<ContentBlock>,
    #[serde(default)]
    pub usage: Option<Value>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct MessageDelta {
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub stop_reason: Option<String>,
    /// Incremental `input_json_delta` for a `tool_use` block.
    #[serde(default)]
    pub partial_json: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ContentBlock {
    pub r#type: String,
    #[serde(default)]
    pub text: Option<String>,
    /// `tool_use` block fields: id, name, and the (possibly partial) input.
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub input: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MessageStart {
    pub id: String,
    pub r#type: String,
    pub role: String,
    pub model: String,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub content: Vec<Value>,
    /// `message_start.message.usage`: `{"input_tokens":…,"output_tokens":…}`.
    #[serde(default)]
    pub usage: Option<Value>,
}

/// Token usage reported by a provider for one request (§10.3).  All fields
/// default to zero when a provider does not report usage.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ChatUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Prompt tokens read from the provider cache this request, billed at the
    /// discounted cache-read rate (§10.3).
    pub cached_read_tokens: u64,
    /// Prompt tokens written to the provider cache this request, billed at the
    /// cache-write rate (§10.3).
    pub cache_creation_tokens: u64,
}

impl ChatUsage {
    /// Parse a usage object tolerant of both wire dialects: OpenAI reports
    /// `prompt_tokens`/`completion_tokens` with cached prompt tokens under
    /// `prompt_tokens_details.cached_tokens`, Anthropic reports
    /// `input_tokens`/`output_tokens` with `cache_read_input_tokens` and
    /// `cache_creation_input_tokens`.  Missing or non-numeric fields are
    /// treated as zero so a partial report never poisons the counters.
    pub fn parse(value: Option<&Value>) -> Option<ChatUsage> {
        let object = value?.as_object()?;
        let number = |keys: &[&str]| -> u64 {
            keys.iter()
                .find_map(|key| object.get(*key))
                .and_then(|value| value.as_u64())
                .unwrap_or(0)
        };
        let cached_read_tokens = object
            .get("cache_read_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .max(
                object
                    .get("prompt_tokens_details")
                    .and_then(Value::as_object)
                    .and_then(|details| details.get("cached_tokens"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            );
        Some(ChatUsage {
            input_tokens: number(&["input_tokens", "prompt_tokens"]),
            output_tokens: number(&["output_tokens", "completion_tokens"]),
            cached_read_tokens,
            cache_creation_tokens: number(&["cache_creation_input_tokens"]),
        })
    }
}

/// Fail-closed HTTP transport bound to one provider `base_url`.
#[derive(Clone)]
pub struct Transport {
    client: Client,
    base_url: String,
}

impl Transport {
    /// Build a transport for a provider `base_url`.
    ///
    /// `https` is accepted for any host; `http` is accepted only for loopback
    /// hosts (`127.0.0.0/8`, `::1`, `localhost`). Any other scheme or an
    /// unparsable URL fails closed before a request can be made.
    pub fn new(base_url: &str) -> Result<Self, TransportError> {
        let base_url = base_url.trim_end_matches('/');
        let url = reqwest::Url::parse(base_url).map_err(|_| TransportError::InvalidUrl)?;
        match url.scheme() {
            "https" => {}
            "http" => {
                let host = url.host_str().unwrap_or_default();
                if !is_loopback_host(host) {
                    return Err(TransportError::UnsupportedScheme);
                }
            }
            _ => return Err(TransportError::UnsupportedScheme),
        }
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| TransportError::RequestFailed)?;
        Ok(Self {
            client,
            base_url: base_url.to_owned(),
        })
    }

    /// The normalized provider base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Fetch the typed `openai-compatible` model catalog from
    /// `GET {base_url}/models`.
    pub async fn fetch_catalog(&self, key: &SecretKey) -> Result<ModelCatalog, TransportError> {
        let response =
            get_with_retry(&self.client, &format!("{}/models", self.base_url), key).await?;
        let response = expect_success(response)?;
        let body = read_bounded_body(response, MAX_RESPONSE_BYTES).await?;
        serde_json::from_slice(&body).map_err(|_| TransportError::InvalidJson)
    }

    /// Fetch the bounded JSON catalog body for a provider-specific eligibility
    /// parser. Unknown fields are preserved in memory only; callers decide how
    /// to validate the schema, and the response is still byte-capped.
    pub async fn fetch_catalog_value(&self, key: &SecretKey) -> Result<Value, TransportError> {
        let response =
            get_with_retry(&self.client, &format!("{}/models", self.base_url), key).await?;
        let response = expect_success(response)?;
        let body = read_bounded_body(response, MAX_RESPONSE_BYTES).await?;
        serde_json::from_slice(&body).map_err(|_| TransportError::InvalidJson)
    }

    /// Fetch and validate model ids from the `openai-compatible` catalog.
    ///
    /// Rows with an invalid or duplicated id fail closed.
    pub async fn fetch_model_ids(&self, key: &SecretKey) -> Result<Vec<ModelId>, TransportError> {
        let catalog = self.fetch_catalog(key).await?;
        let mut seen = HashSet::with_capacity(catalog.data.len());
        let mut ids = Vec::with_capacity(catalog.data.len());
        for (index, row) in catalog.data.iter().enumerate() {
            let id = ModelId::new(row.id.clone())
                .map_err(|_| TransportError::InvalidCatalog { index })?;
            if !seen.insert(id.clone()) {
                return Err(TransportError::InvalidCatalog { index });
            }
            ids.push(id);
        }
        Ok(ids)
    }

    /// Fetch and validate model ids from the `anthropic-compatible`
    /// `GET {base_url}/v1/models` endpoint.
    ///
    /// Parses the Anthropic list format (`data` rows with `id`, `type`,
    /// `created_at`, and `display_name`). Only the first page is returned:
    /// `has_more` pagination is intentionally not followed in this release.
    /// A page with a malformed row, an invalid id, or a duplicated id fails
    /// closed.
    pub async fn fetch_anthropic_models(
        &self,
        key: &SecretKey,
    ) -> Result<Vec<ModelId>, TransportError> {
        let response =
            get_with_retry(&self.client, &format!("{}/v1/models", self.base_url), key).await?;
        let response = expect_success(response)?;
        let body = read_bounded_body(response, MAX_RESPONSE_BYTES).await?;
        let list: AnthropicModelList =
            serde_json::from_slice(&body).map_err(|_| TransportError::InvalidJson)?;
        let mut seen = HashSet::with_capacity(list.data.len());
        let mut ids = Vec::with_capacity(list.data.len());
        for (index, row) in list.data.iter().enumerate() {
            let id = ModelId::new(row.id.clone())
                .map_err(|_| TransportError::InvalidCatalog { index })?;
            if !seen.insert(id.clone()) {
                return Err(TransportError::InvalidCatalog { index });
            }
            ids.push(id);
        }
        Ok(ids)
    }

    /// Fetch and validate model ids through the active provider protocol.
    ///
    /// Dispatches to the protocol's model-list endpoint:
    /// `openai-compatible` fetches `GET {base_url}/models`,
    /// `anthropic-compatible` fetches `GET {base_url}/v1/models`. Errors are
    /// typed and never contain the credential value or any response body.
    pub async fn fetch_provider_model_ids(
        &self,
        protocol: &Protocol,
        key: &SecretKey,
    ) -> Result<Vec<ModelId>, TransportError> {
        match protocol {
            Protocol::OpenAiCompatible => self.fetch_model_ids(key).await,
            Protocol::AnthropicCompatible => self.fetch_anthropic_models(key).await,
        }
    }

    /// Stream `openai-compatible` chat chunks from
    /// `POST {base_url}/chat/completions`.
    ///
    /// The request always carries `"stream": true`. The returned stream ends
    /// after the provider's `[DONE]` marker, on a clean end-of-stream, or
    /// with a typed error item followed by a closed stream.
    pub fn chat_completions(
        &self,
        key: &SecretKey,
        request: &ChatCompletionsRequest,
    ) -> Result<
        impl Stream<Item = Result<ChatChunk, TransportError>> + Send + 'static,
        TransportError,
    > {
        let body = inject_chat_body(request)?;
        let url = format!("{}/chat/completions", self.base_url);
        let stream = spawn_sse_stream(self.client.clone(), url, key.clone(), body, SseMode::Chat);
        Ok(stream.filter_map(|item| async move {
            match item {
                Ok(SsePayload::Chat(chunk)) => Some(Ok(chunk)),
                Ok(SsePayload::Messages(_)) => None,
                Err(error) => Some(Err(error)),
            }
        }))
    }

    /// Stream `anthropic-compatible` message events from
    /// `POST {base_url}/v1/messages`.
    ///
    /// The request always carries `"stream": true`. The returned stream ends
    /// after the provider's `message_stop` event, on a clean end-of-stream,
    /// or with a typed error item followed by a closed stream.
    pub fn messages(
        &self,
        key: &SecretKey,
        request: &MessagesRequest,
    ) -> Result<
        impl Stream<Item = Result<MessageChunk, TransportError>> + Send + 'static,
        TransportError,
    > {
        let body = inject_messages_body(request)?;
        let url = format!("{}/v1/messages", self.base_url);
        let stream = spawn_sse_stream(
            self.client.clone(),
            url,
            key.clone(),
            body,
            SseMode::Messages,
        );
        Ok(stream.filter_map(|item| async move {
            match item {
                Ok(SsePayload::Messages(chunk)) => Some(Ok(*chunk)),
                Ok(SsePayload::Chat(_)) => None,
                Err(error) => Some(Err(error)),
            }
        }))
    }
}

fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let host = host
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return ip.is_loopback();
    }
    if let Ok(ip) = host.parse::<Ipv6Addr>() {
        return ip.is_loopback();
    }
    false
}

fn map_reqwest_error(error: reqwest::Error) -> TransportError {
    if error.is_timeout() {
        TransportError::RequestTimeout
    } else if error.is_connect() {
        TransportError::ConnectFailed
    } else {
        TransportError::RequestFailed
    }
}

fn is_retryable_status(status: StatusCode) -> bool {
    matches!(
        HttpFailureKind::classify(status),
        HttpFailureKind::RateLimited | HttpFailureKind::ServerError
    )
}

fn is_retryable_error(error: &TransportError) -> bool {
    matches!(
        error,
        TransportError::RequestTimeout
            | TransportError::ConnectFailed
            | TransportError::RequestFailed
    )
}

fn retry_delay(response: Option<&Response>, attempt: usize) -> Duration {
    if let Some(seconds) = response
        .and_then(|response| response.headers().get("retry-after"))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
    {
        return Duration::from_secs(seconds.min(30));
    }
    let multiplier = 1_u32 << attempt.min(1);
    let jitter = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::from(duration.subsec_millis() % 101))
        .unwrap_or(0);
    RETRY_BASE_DELAY
        .saturating_mul(multiplier)
        .saturating_add(Duration::from_millis(jitter))
}

async fn get_with_retry(
    client: &Client,
    url: &str,
    key: &SecretKey,
) -> Result<Response, TransportError> {
    for attempt in 0..=MAX_RETRIES {
        match client.get(url).bearer_auth(key.as_secret()).send().await {
            Ok(response) if response.status().is_success() => return Ok(response),
            Ok(response) => {
                let retry = attempt < MAX_RETRIES && is_retryable_status(response.status());
                if retry {
                    let delay = retry_delay(Some(&response), attempt);
                    drop(response);
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return expect_success(response);
            }
            Err(error) => {
                let mapped = map_reqwest_error(error);
                if attempt < MAX_RETRIES && is_retryable_error(&mapped) {
                    tokio::time::sleep(retry_delay(None, attempt)).await;
                    continue;
                }
                return Err(mapped);
            }
        }
    }
    unreachable!("retry loop always returns")
}

async fn post_with_retry(
    client: &Client,
    url: &str,
    key: &SecretKey,
    body: &Value,
) -> Result<Response, TransportError> {
    for attempt in 0..=MAX_RETRIES {
        match client
            .post(url)
            .bearer_auth(key.as_secret())
            .json(body)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return Ok(response),
            Ok(response) => {
                let retry = attempt < MAX_RETRIES && is_retryable_status(response.status());
                if retry {
                    let delay = retry_delay(Some(&response), attempt);
                    drop(response);
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return expect_success(response);
            }
            Err(error) => {
                let mapped = map_reqwest_error(error);
                if attempt < MAX_RETRIES && is_retryable_error(&mapped) {
                    tokio::time::sleep(retry_delay(None, attempt)).await;
                    continue;
                }
                return Err(mapped);
            }
        }
    }
    unreachable!("retry loop always returns")
}

fn expect_success(response: Response) -> Result<Response, TransportError> {
    let status = response.status();
    if status.is_success() {
        Ok(response)
    } else {
        Err(TransportError::Http {
            status: status.as_u16(),
            kind: HttpFailureKind::classify(status),
        })
    }
}

/// Read a response body with a hard byte cap. Oversized responses fail
/// closed; the payload is never retained or echoed.
async fn read_bounded_body(response: Response, limit: usize) -> Result<Vec<u8>, TransportError> {
    if let Some(length) = response.content_length() {
        if length > limit as u64 {
            return Err(TransportError::ResponseTooLarge { limit_bytes: limit });
        }
    }
    let mut stream = response.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(map_reqwest_error)?;
        if out.len().saturating_add(chunk.len()) > limit {
            return Err(TransportError::ResponseTooLarge { limit_bytes: limit });
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

fn inject_stream_flag(request: &impl Serialize) -> Result<Value, TransportError> {
    let mut value = serde_json::to_value(request).map_err(|_| TransportError::InvalidJson)?;
    if let Some(object) = value.as_object_mut() {
        object.insert("stream".to_owned(), Value::Bool(true));
    }
    Ok(value)
}

/// Build the `openai-compatible` chat body: force `stream: true`, translate
/// neutral tool specs into the `{"type":"function","function":{...}}` shape,
/// and rename `tool_result_id` into the OpenAI `tool_call_id` field.
fn inject_chat_body(request: &ChatCompletionsRequest) -> Result<Value, TransportError> {
    let mut value = inject_stream_flag(request)?;
    apply_openai_tools(&mut value);
    apply_openai_tool_results(&mut value);
    apply_openai_effort(&mut value, request.reasoning_effort);
    Ok(value)
}

/// Put the neutral Worker effort on the OpenAI-compatible wire. `none` and an
/// unset lock are deliberately omitted so providers retain their defaults.
fn apply_openai_effort(value: &mut Value, effort: Option<WorkerEffort>) {
    let Some(effort) = effort else {
        return;
    };
    if effort != WorkerEffort::None {
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "reasoning_effort".to_owned(),
                Value::String(effort.to_string()),
            );
        }
    }
}

/// Rename the neutral `tool_result_id` on `role: "tool"` messages into the
/// OpenAI `tool_call_id` correlation field.
fn apply_openai_tool_results(value: &mut Value) {
    let Some(messages) = value.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages.iter_mut() {
        let Some(object) = message.as_object_mut() else {
            continue;
        };
        if object.get("role").and_then(Value::as_str) != Some("tool") {
            continue;
        }
        if let Some(id) = object.remove("tool_result_id") {
            object.insert("tool_call_id".to_owned(), id);
        }
    }
}

/// Translate neutral `{name,description,parameters}` tool specs into the
/// OpenAI function-calling wire shape.
fn apply_openai_tools(value: &mut Value) {
    let Some(tools) = value.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools.iter_mut() {
        let Some(object) = tool.as_object_mut() else {
            continue;
        };
        let name = object.remove("name");
        let description = object.remove("description");
        let parameters = object
            .remove("parameters")
            .unwrap_or_else(|| serde_json::json!({}));
        object.insert("type".to_owned(), Value::String("function".to_owned()));
        object.insert(
            "function".to_owned(),
            serde_json::json!({
                "name": name,
                "description": description,
                "parameters": parameters,
            }),
        );
    }
}

/// Translate neutral `{name,description,parameters}` tool specs into the
/// Anthropic `{name,description,input_schema}` wire shape.
fn apply_anthropic_tools(value: &mut Value) {
    let Some(tools) = value.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools.iter_mut() {
        let Some(object) = tool.as_object_mut() else {
            continue;
        };
        let parameters = object.remove("parameters");
        object.insert(
            "input_schema".to_owned(),
            parameters.unwrap_or_else(|| serde_json::json!({})),
        );
    }
}

/// Build the `anthropic-compatible` `/v1/messages` body: force `stream: true`
/// and mark the newest turn with a `cache_control` breakpoint so the
/// conversation prefix is cached and read back on later turns (§10.3).
/// A single-message request is left unmarked: writing a one-shot prompt to the
/// cache costs more than it can ever save.
fn inject_messages_body(request: &MessagesRequest) -> Result<Value, TransportError> {
    let mut value = inject_stream_flag(request)?;
    apply_anthropic_tools(&mut value);
    apply_anthropic_messages(&mut value);
    apply_anthropic_effort(&mut value, request.reasoning_effort);
    Ok(value)
}

/// Translate the neutral effort lock into Anthropic's extended-thinking shape.
/// Budget values are bounded and monotonic; the request's `max_tokens` is
/// raised when necessary because Anthropic requires the thinking budget to fit
/// inside that request budget.
fn apply_anthropic_effort(value: &mut Value, effort: Option<WorkerEffort>) {
    let Some(effort) = effort else {
        return;
    };
    let budget_tokens = match effort {
        WorkerEffort::None => return,
        WorkerEffort::Low => 512,
        WorkerEffort::Medium => 1_024,
        WorkerEffort::High => 2_048,
        WorkerEffort::Xhigh => 4_096,
        WorkerEffort::Max => 8_192,
    };
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let max_tokens = object
        .get("max_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if max_tokens < budget_tokens {
        object.insert("max_tokens".to_owned(), Value::from(budget_tokens));
    }
    object.insert(
        "thinking".to_owned(),
        serde_json::json!({
            "type": "enabled",
            "budget_tokens": budget_tokens,
        }),
    );
}

/// Rewrite neutral messages into the Anthropic wire shape: pull `system`
/// messages into the top-level `system` field, translate tool results into
/// `tool_result` blocks and assistant tool calls into `tool_use` blocks, then
/// put a `cache_control` breakpoint on the last content block when there is a
/// prefix worth caching (§10.3).
fn apply_anthropic_messages(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let Some(messages) = object.remove("messages") else {
        return;
    };
    let Some(messages) = messages.as_array() else {
        object.insert("messages".to_owned(), messages);
        return;
    };

    let mut system_parts: Vec<String> = Vec::new();
    let mut translated: Vec<Value> = Vec::new();
    for message in messages.iter() {
        let Some(message) = message.as_object() else {
            translated.push(message.clone());
            continue;
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let content = message
            .get("content")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new()));

        if role == "system" {
            if let Value::String(text) = &content {
                if !text.trim().is_empty() {
                    system_parts.push(text.clone());
                }
            }
            continue;
        }

        if role == "tool" {
            let tool_use_id = message
                .get("tool_result_id")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new()));
            translated.push(serde_json::json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                }],
            }));
            continue;
        }

        if role == "assistant" {
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                let mut blocks: Vec<Value> = Vec::new();
                if let Value::String(text) = &content {
                    if !text.is_empty() {
                        blocks.push(serde_json::json!({ "type": "text", "text": text }));
                    }
                }
                for call in calls {
                    if let Some(call) = call.as_object() {
                        let id = call
                            .get("id")
                            .cloned()
                            .unwrap_or_else(|| Value::String(String::new()));
                        let function = call.get("function").cloned();
                        let name = function
                            .as_ref()
                            .and_then(|f| f.get("name"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        let arguments = function
                            .as_ref()
                            .and_then(|f| f.get("arguments"))
                            .and_then(Value::as_str)
                            .and_then(|arguments| serde_json::from_str::<Value>(arguments).ok())
                            .unwrap_or_else(|| serde_json::json!({}));
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": arguments,
                        }));
                    }
                }
                translated.push(serde_json::json!({ "role": "assistant", "content": blocks }));
                continue;
            }
        }

        translated.push(serde_json::json!({ "role": role, "content": content }));
    }

    if !system_parts.is_empty() {
        object.insert(
            "system".to_owned(),
            Value::String(system_parts.join("\n\n")),
        );
    }
    if translated.len() >= 2 {
        if let Some(last) = translated.last_mut().and_then(Value::as_object_mut) {
            apply_cache_control_to_last_block(last);
        }
    }
    object.insert("messages".to_owned(), Value::Array(translated));
}

/// Attach an ephemeral `cache_control` breakpoint to a message's last content
/// block, converting a plain string content into a single text block first.
fn apply_cache_control_to_last_block(message: &mut serde_json::Map<String, Value>) {
    let cache_control = serde_json::json!({ "type": "ephemeral" });
    match message.get("content") {
        Some(Value::String(_)) => {
            let Some(content) = message.remove("content") else {
                return;
            };
            message.insert(
                "content".to_owned(),
                Value::Array(vec![serde_json::json!({
                    "type": "text",
                    "text": content,
                    "cache_control": cache_control,
                })]),
            );
        }
        Some(Value::Array(blocks)) => {
            let mut blocks = blocks.clone();
            if let Some(last) = blocks.last_mut().and_then(Value::as_object_mut) {
                last.insert("cache_control".to_owned(), cache_control);
            }
            message.insert("content".to_owned(), Value::Array(blocks));
        }
        _ => {}
    }
}

#[derive(Clone, Copy)]
enum SseMode {
    Chat,
    Messages,
}

#[derive(Clone, Debug)]
enum SsePayload {
    Chat(ChatChunk),
    Messages(Box<MessageChunk>),
}

/// Spawn a bounded streaming session: the reader runs in a task and forwards
/// typed items through a bounded channel, so memory stays bounded even when
/// the consumer is slow or drops the stream early.
fn spawn_sse_stream(
    client: Client,
    url: String,
    key: SecretKey,
    body: Value,
    mode: SseMode,
) -> impl Stream<Item = Result<SsePayload, TransportError>> + Send + 'static {
    let (sender, receiver) = mpsc::channel(SSE_CHANNEL_CAPACITY);
    tokio::spawn(async move {
        run_sse_session(client, url, key, body, mode, sender).await;
    });
    unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    })
}

async fn run_sse_session(
    client: Client,
    url: String,
    key: SecretKey,
    body: Value,
    mode: SseMode,
    sender: mpsc::Sender<Result<SsePayload, TransportError>>,
) {
    let response = match post_with_retry(&client, &url, &key, &body).await {
        Ok(response) => response,
        Err(error) => {
            let _ = sender.send(Err(error)).await;
            return;
        }
    };

    let mut reader = SseLineReader::new(response);
    loop {
        let line = match reader.next_line().await {
            Ok(line) => line,
            Err(error) => {
                let _ = sender.send(Err(error)).await;
                return;
            }
        };
        let Some(line) = line else { return };
        let Ok(line_text) = std::str::from_utf8(&line) else {
            let _ = sender.send(Err(TransportError::InvalidJson)).await;
            return;
        };
        let Some(payload) = line_text.strip_prefix("data:") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            return;
        }
        let sent = match mode {
            SseMode::Chat => {
                let Ok(chunk) = serde_json::from_str::<ChatChunk>(payload) else {
                    let _ = sender.send(Err(TransportError::InvalidJson)).await;
                    return;
                };
                if chunk.error.is_some() {
                    let _ = sender.send(Err(TransportError::ProviderError)).await;
                    return;
                }
                sender.send(Ok(SsePayload::Chat(chunk))).await.is_ok()
            }
            SseMode::Messages => {
                let Ok(chunk) = serde_json::from_str::<MessageChunk>(payload) else {
                    let _ = sender.send(Err(TransportError::InvalidJson)).await;
                    return;
                };
                if chunk.r#type == "message_stop" {
                    return;
                }
                if chunk.r#type == "error" {
                    let _ = sender.send(Err(TransportError::ProviderError)).await;
                    return;
                }
                sender
                    .send(Ok(SsePayload::Messages(Box::new(chunk))))
                    .await
                    .is_ok()
            }
        };
        if !sent {
            return;
        }
    }
}

/// Incremental SSE line decoder with hard size caps.
struct SseLineReader {
    stream: std::pin::Pin<Box<dyn Stream<Item = reqwest::Result<bytes::Bytes>> + Send + 'static>>,
    buffer: Vec<u8>,
    total_bytes: usize,
    done: bool,
}

impl SseLineReader {
    fn new(response: Response) -> Self {
        Self {
            stream: Box::pin(response.bytes_stream()),
            buffer: Vec::new(),
            total_bytes: 0,
            done: false,
        }
    }

    /// Yield the next line without its trailing newline, `Ok(None)` at end
    /// of stream. Oversized lines and total bodies fail closed.
    async fn next_line(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        loop {
            if let Some(position) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let mut line: Vec<u8> = self.buffer.drain(..=position).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(Some(line));
            }
            if self.done {
                return Ok(None);
            }
            let Some(chunk) = self.stream.next().await else {
                if self.buffer.is_empty() {
                    return Ok(None);
                }
                self.done = true;
                let mut line = std::mem::take(&mut self.buffer);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(Some(line));
            };
            let chunk = chunk.map_err(map_reqwest_error)?;
            self.total_bytes = self.total_bytes.saturating_add(chunk.len());
            if self.total_bytes > MAX_RESPONSE_BYTES {
                return Err(TransportError::ResponseTooLarge {
                    limit_bytes: MAX_RESPONSE_BYTES,
                });
            }
            self.buffer.extend_from_slice(&chunk);
            if self.buffer.len() > MAX_SSE_LINE_BYTES {
                return Err(TransportError::ResponseTooLarge {
                    limit_bytes: MAX_SSE_LINE_BYTES,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat_request() -> ChatCompletionsRequest {
        ChatCompletionsRequest {
            model: "model-alpha".to_owned(),
            messages: vec![ChatMessage {
                role: "user".to_owned(),
                content: "ping".to_owned(),
                ..Default::default()
            }],
            max_tokens: Some(16),
            temperature: None,
            tools: Vec::new(),
            reasoning_effort: None,
        }
    }

    #[test]
    fn scheme_policy_allows_https_and_loopback_http_only() {
        assert!(Transport::new("https://api.echogate.one/v1").is_ok());
        assert!(Transport::new("https://example.com").is_ok());
        assert!(Transport::new("http://127.0.0.1:9000").is_ok());
        assert!(Transport::new("http://localhost:9000").is_ok());
        assert!(Transport::new("http://[::1]:9000").is_ok());
        assert!(matches!(
            Transport::new("http://example.com"),
            Err(TransportError::UnsupportedScheme)
        ));
        assert!(matches!(
            Transport::new("ftp://example.com"),
            Err(TransportError::UnsupportedScheme)
        ));
        assert!(matches!(
            Transport::new("not a url"),
            Err(TransportError::InvalidUrl)
        ));
    }

    #[test]
    fn base_url_trailing_slash_is_normalized() {
        let transport = Transport::new("https://api.echogate.one/v1/").unwrap();
        assert_eq!(transport.base_url(), "https://api.echogate.one/v1");
    }

    #[test]
    fn stream_request_bodies_force_streaming() {
        let chat = inject_stream_flag(&chat_request()).unwrap();
        assert_eq!(chat["stream"], Value::Bool(true));
        assert_eq!(chat["model"], Value::String("model-alpha".to_owned()));
        let messages = inject_stream_flag(&MessagesRequest {
            model: "model-alpha".to_owned(),
            max_tokens: 16,
            messages: vec![ChatMessage {
                role: "user".to_owned(),
                content: "ping".to_owned(),
                ..Default::default()
            }],
            system: None,
            temperature: None,
            tools: Vec::new(),
            reasoning_effort: None,
        })
        .unwrap();
        assert_eq!(messages["stream"], Value::Bool(true));
        assert_eq!(messages["max_tokens"], Value::from(16));
    }

    #[test]
    fn worker_effort_reaches_both_protocol_wire_shapes() {
        let openai = inject_chat_body(&ChatCompletionsRequest {
            reasoning_effort: Some(WorkerEffort::High),
            ..chat_request()
        })
        .unwrap();
        assert_eq!(openai["reasoning_effort"], "high");

        let openai_none = inject_chat_body(&ChatCompletionsRequest {
            reasoning_effort: Some(WorkerEffort::None),
            ..chat_request()
        })
        .unwrap();
        assert!(openai_none.get("reasoning_effort").is_none());

        let anthropic = inject_messages_body(&MessagesRequest {
            reasoning_effort: Some(WorkerEffort::Max),
            ..MessagesRequest {
                model: "model-alpha".to_owned(),
                max_tokens: 16,
                messages: vec![ChatMessage {
                    role: "user".to_owned(),
                    content: "ping".to_owned(),
                    ..Default::default()
                }],
                system: None,
                temperature: None,
                tools: Vec::new(),
                reasoning_effort: None,
            }
        })
        .unwrap();
        assert_eq!(anthropic["thinking"]["type"], "enabled");
        assert_eq!(anthropic["thinking"]["budget_tokens"], 8192);
        assert_eq!(anthropic["max_tokens"], 8192);
    }

    #[test]
    fn transport_error_output_is_secret_free_and_body_free() {
        let errors = [
            TransportError::InvalidUrl,
            TransportError::UnsupportedScheme,
            TransportError::Http {
                status: 401,
                kind: HttpFailureKind::Unauthorized,
            },
            TransportError::Http {
                status: 400,
                kind: HttpFailureKind::ClientError,
            },
            TransportError::ResponseTooLarge {
                limit_bytes: 8 * 1024 * 1024,
            },
            TransportError::InvalidJson,
            TransportError::InvalidCatalog { index: 2 },
            TransportError::ProviderError,
            TransportError::RequestTimeout,
            TransportError::ConnectFailed,
            TransportError::RequestFailed,
        ];
        for error in errors {
            let display = error.to_string();
            let debug = format!("{error:?}");
            for output in [&display, &debug] {
                assert!(
                    !output.contains("test-transport-key"),
                    "leaked key material: {output}"
                );
                assert!(
                    !output.contains(r#"{"error""#),
                    "echoed a response body: {output}"
                );
            }
        }
    }

    #[test]
    fn chat_usage_parses_both_wire_dialects() {
        // OpenAI final chunk dialect.
        let openai = serde_json::json!({
            "prompt_tokens": 12,
            "completion_tokens": 3,
            "total_tokens": 15,
        });
        let parsed = ChatUsage::parse(Some(&openai)).unwrap();
        assert_eq!(parsed.input_tokens, 12);
        assert_eq!(parsed.output_tokens, 3);

        // Anthropic dialect.
        let anthropic = serde_json::json!({
            "input_tokens": 40,
            "output_tokens": 9,
        });
        let parsed = ChatUsage::parse(Some(&anthropic)).unwrap();
        assert_eq!(parsed.input_tokens, 40);
        assert_eq!(parsed.output_tokens, 9);

        // Partial reports never poison the counters.
        let partial = serde_json::json!({ "output_tokens": 7 });
        let parsed = ChatUsage::parse(Some(&partial)).unwrap();
        assert_eq!(parsed.input_tokens, 0);
        assert_eq!(parsed.output_tokens, 7);

        // Absent usage reports nothing; callers keep their defaults.
        assert_eq!(ChatUsage::parse(None), None);
    }

    #[test]
    fn chat_usage_parses_cached_tokens_from_both_dialects() {
        // OpenAI final-chunk dialect: cached tokens nested under details.
        let openai = serde_json::json!({
            "prompt_tokens": 12,
            "completion_tokens": 3,
            "prompt_tokens_details": { "cached_tokens": 8 },
        });
        let parsed = ChatUsage::parse(Some(&openai)).unwrap();
        assert_eq!(parsed.cached_read_tokens, 8);
        assert_eq!(parsed.cache_creation_tokens, 0);

        // Anthropic dialect: explicit cache read + creation counters.
        let anthropic = serde_json::json!({
            "input_tokens": 40,
            "output_tokens": 9,
            "cache_read_input_tokens": 30,
            "cache_creation_input_tokens": 6,
        });
        let parsed = ChatUsage::parse(Some(&anthropic)).unwrap();
        assert_eq!(parsed.cached_read_tokens, 30);
        assert_eq!(parsed.cache_creation_tokens, 6);

        // A report without cache fields stays at zero.
        let plain = serde_json::json!({ "prompt_tokens": 5, "completion_tokens": 1 });
        let parsed = ChatUsage::parse(Some(&plain)).unwrap();
        assert_eq!(parsed.cached_read_tokens, 0);
        assert_eq!(parsed.cache_creation_tokens, 0);
    }

    #[test]
    fn messages_body_marks_last_turn_with_cache_control() {
        let two_turns = inject_messages_body(&MessagesRequest {
            model: "model-alpha".to_owned(),
            max_tokens: 16,
            messages: vec![
                ChatMessage {
                    role: "user".to_owned(),
                    content: "first".to_owned(),
                    ..Default::default()
                },
                ChatMessage {
                    role: "user".to_owned(),
                    content: "second".to_owned(),
                    ..Default::default()
                },
            ],
            system: None,
            temperature: None,
            tools: Vec::new(),
            reasoning_effort: None,
        })
        .unwrap();
        assert_eq!(two_turns["stream"], Value::Bool(true));
        let messages = two_turns["messages"].as_array().unwrap();
        // The first turn keeps its plain string content.
        assert_eq!(messages[0]["content"], Value::String("first".to_owned()));
        // The last turn is wrapped in a cache_control breakpoint block.
        let last = messages[1]["content"].as_array().unwrap();
        assert_eq!(last.len(), 1);
        assert_eq!(last[0]["type"], Value::String("text".to_owned()));
        assert_eq!(last[0]["text"], Value::String("second".to_owned()));
        assert_eq!(
            last[0]["cache_control"]["type"],
            Value::String("ephemeral".to_owned())
        );

        // A single message is left unmarked: nothing to cache, so no
        // cache-write cost is incurred.
        let one_turn = inject_messages_body(&MessagesRequest {
            model: "model-alpha".to_owned(),
            max_tokens: 16,
            messages: vec![ChatMessage {
                role: "user".to_owned(),
                content: "only".to_owned(),
                ..Default::default()
            }],
            system: None,
            temperature: None,
            tools: Vec::new(),
            reasoning_effort: None,
        })
        .unwrap();
        let messages = one_turn["messages"].as_array().unwrap();
        assert_eq!(messages[0]["content"], Value::String("only".to_owned()));
    }

    #[test]
    fn tool_specs_translate_to_both_wire_shapes() {
        let spec = ToolSpec {
            name: "read_file".to_owned(),
            description: "read a file".to_owned(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string" } }
            }),
        };

        let chat = inject_chat_body(&ChatCompletionsRequest {
            model: "model-alpha".to_owned(),
            messages: vec![],
            max_tokens: None,
            temperature: None,
            tools: vec![spec.clone()],
            reasoning_effort: None,
        })
        .unwrap();
        let tool = &chat["tools"][0];
        assert_eq!(tool["type"], Value::String("function".to_owned()));
        assert_eq!(
            tool["function"]["name"],
            Value::String("read_file".to_owned())
        );
        assert_eq!(tool["function"]["parameters"]["type"], "object");

        let messages = inject_messages_body(&MessagesRequest {
            model: "model-alpha".to_owned(),
            max_tokens: 16,
            messages: vec![],
            system: None,
            temperature: None,
            tools: vec![spec],
            reasoning_effort: None,
        })
        .unwrap();
        let tool = &messages["tools"][0];
        assert_eq!(tool["name"], Value::String("read_file".to_owned()));
        assert_eq!(tool["input_schema"]["type"], "object");

        // Empty tool lists are omitted from the wire body entirely.
        let no_tools = inject_chat_body(&chat_request()).unwrap();
        assert!(no_tools.get("tools").is_none());
    }

    #[test]
    fn tool_messages_translate_to_both_wire_shapes() {
        // OpenAI: assistant tool_calls pass through; role "tool" + the neutral
        // tool_result_id becomes the OpenAI tool_call_id.
        let chat = inject_chat_body(&ChatCompletionsRequest {
            model: "model-alpha".to_owned(),
            messages: vec![
                ChatMessage {
                    role: "assistant".to_owned(),
                    content: String::new(),
                    tool_calls: vec![ToolCall {
                        id: "call_1".to_owned(),
                        kind: "function".to_owned(),
                        function: ToolCallFunction {
                            name: Some("read_file".to_owned()),
                            arguments: Some(r#"{"path":"a.txt"}"#.to_owned()),
                        },
                    }],
                    ..Default::default()
                },
                ChatMessage {
                    role: "tool".to_owned(),
                    content: "hello".to_owned(),
                    tool_result_id: Some("call_1".to_owned()),
                    ..Default::default()
                },
            ],
            max_tokens: None,
            temperature: None,
            tools: Vec::new(),
            reasoning_effort: None,
        })
        .unwrap();
        let messages = chat["messages"].as_array().unwrap();
        assert_eq!(
            messages[0]["tool_calls"][0]["function"]["name"],
            Value::String("read_file".to_owned())
        );
        assert_eq!(messages[1]["role"], Value::String("tool".to_owned()));
        assert_eq!(
            messages[1]["tool_call_id"],
            Value::String("call_1".to_owned())
        );
        assert!(messages[1].get("tool_result_id").is_none());

        // Anthropic: assistant tool_calls -> tool_use blocks; role "tool" -> a
        // user tool_result block.
        let body = inject_messages_body(&MessagesRequest {
            model: "model-alpha".to_owned(),
            max_tokens: 16,
            messages: vec![
                ChatMessage {
                    role: "user".to_owned(),
                    content: "read a.txt".to_owned(),
                    ..Default::default()
                },
                ChatMessage {
                    role: "assistant".to_owned(),
                    content: String::new(),
                    tool_calls: vec![ToolCall {
                        id: "toolu_1".to_owned(),
                        kind: "function".to_owned(),
                        function: ToolCallFunction {
                            name: Some("read_file".to_owned()),
                            arguments: Some(r#"{"path":"a.txt"}"#.to_owned()),
                        },
                    }],
                    ..Default::default()
                },
                ChatMessage {
                    role: "tool".to_owned(),
                    content: "hello".to_owned(),
                    tool_result_id: Some("toolu_1".to_owned()),
                    ..Default::default()
                },
            ],
            system: None,
            temperature: None,
            tools: Vec::new(),
            reasoning_effort: None,
        })
        .unwrap();
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[1]["role"], Value::String("assistant".to_owned()));
        assert_eq!(messages[1]["content"][0]["type"], "tool_use");
        assert_eq!(messages[1]["content"][0]["name"], "read_file");
        assert_eq!(messages[1]["content"][0]["input"]["path"], "a.txt");
        assert_eq!(messages[2]["role"], Value::String("user".to_owned()));
        assert_eq!(messages[2]["content"][0]["type"], "tool_result");
        assert_eq!(messages[2]["content"][0]["tool_use_id"], "toolu_1");
        assert_eq!(messages[2]["content"][0]["content"], "hello");
    }

    #[test]
    fn anthropic_system_messages_move_to_the_system_field() {
        let body = inject_messages_body(&MessagesRequest {
            model: "model-alpha".to_owned(),
            max_tokens: 16,
            messages: vec![
                ChatMessage {
                    role: "system".to_owned(),
                    content: "you are a coding agent".to_owned(),
                    ..Default::default()
                },
                ChatMessage {
                    role: "user".to_owned(),
                    content: "hi".to_owned(),
                    ..Default::default()
                },
            ],
            system: None,
            temperature: None,
            tools: Vec::new(),
            reasoning_effort: None,
        })
        .unwrap();
        assert_eq!(
            body["system"],
            Value::String("you are a coding agent".to_owned())
        );
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], Value::String("user".to_owned()));
    }
}
