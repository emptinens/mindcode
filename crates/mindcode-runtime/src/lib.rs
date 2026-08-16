//! Shared runtime resolution for MindCode.
//!
//! This crate owns the provider/model/credential selection surface plus the
//! model client that powers Worker agents, so the native CLI and the daemon
//! resolve the active profile identically without either one reimplementing
//! it.  It performs no I/O beyond reading the settings/secret store and the
//! optional secret-free `pricing.json` override.

#![forbid(unsafe_code)]

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use mindcode_provider::{default_store_path, load_store, Protocol, SecretKey};
use mindcode_settings::{
    default_settings_path, load_settings, save_settings, CredentialRef, ModelId, NativeSettings,
    ProviderConfig, ProviderId, WorkerEffort,
};
use mindcode_transport::{
    ChatCompletionsRequest, ChatMessage, ChatUsage, MessagesRequest, ToolSpec, Transport,
};
use mindcode_worker::{ModelClient, ModelTurn, ResolvedToolCall, WorkerError, WorkerResult};
use serde_json::Value;
use std::{collections::BTreeMap, env, fs, future::Future, path::PathBuf, pin::Pin};
use tokio_util::sync::CancellationToken;

/// Resolve a model from explicit settings or the profile allowlist.  Every
/// profile is allowlist-driven and fails closed: a selected model must be a
/// member of the allowlist, and an empty allowlist selects no model.
pub fn select_chat_model(
    settings: &NativeSettings,
    provider: &ProviderConfig,
    override_model: Option<&str>,
) -> Result<String> {
    let selected = override_model
        .map(str::to_owned)
        .or_else(|| settings.global_worker_model.clone())
        .or_else(|| provider.allowlist.first().map(ModelId::to_string))
        .ok_or_else(|| {
            anyhow!("active provider has no selected model (allowlist is empty, fails closed)")
        })?;
    if !provider
        .allowlist
        .iter()
        .any(|model| model.as_str() == selected)
    {
        return Err(anyhow!(
            "selected model is not in the active provider allowlist (fail closed)"
        ));
    }
    Ok(selected)
}

/// The outcome of one chat request: the streamed text plus the token usage
/// the provider reported (zeroed when it reports none) and the model that
/// actually served the request (§10.3).
#[derive(Clone, Debug, Default)]
pub struct ChatOutcome {
    pub text: String,
    pub usage: ChatUsage,
    pub model: String,
    /// False when the provider omitted a usage object; the cost ledger keeps
    /// that attempt explicitly unknown.
    pub usage_reported: bool,
}

/// Estimated per-1K-token price (input, output) in USD.  The optional
/// `pricing.json` in the config dir overrides the built-in table
/// (`{"gpt-x": [0.001, 0.002]}` for $/1K input/output); unknown models fall
/// back to a conservative default so the footer can always estimate (§10.7).
pub fn model_price_per_1k(model: &str) -> (f64, f64) {
    if let Some(override_table) = load_pricing_override() {
        if let Some(price) = override_table.get(model) {
            return *price;
        }
    }
    match model {
        "moonshotai/Kimi-K3" | "kimi-k3" => (0.0006, 0.0024),
        "opencode-go" => (0.0002, 0.0006),
        _ => (0.0005, 0.0015),
    }
}

/// The `pricing.json` override: `{"model-id": [input_per_1k, output_per_1k]}`.
/// Secret-free by contract; a missing or malformed file yields no overrides.
fn load_pricing_override() -> Option<std::collections::HashMap<String, (f64, f64)>> {
    let dir = native_settings_path().ok()?.parent()?.to_path_buf();
    let raw = fs::read(dir.join("pricing.json")).ok()?;
    let serde_json::Value::Object(map) = serde_json::from_slice::<serde_json::Value>(&raw).ok()?
    else {
        return None;
    };
    let mut out = std::collections::HashMap::new();
    for (model, value) in map {
        let Some(pair) = value.as_array() else {
            continue;
        };
        let (Some(input), Some(output)) = (
            pair.first().and_then(serde_json::Value::as_f64),
            pair.get(1).and_then(serde_json::Value::as_f64),
        ) else {
            continue;
        };
        out.insert(model, (input, output));
    }
    (!out.is_empty()).then_some(out)
}

/// Estimated `(cost, savings)` for one request (§10.3).  `cost` is the
/// cache-aware price; `savings` is how much the provider cache saved versus
/// billing every input token at the full input rate.
///
/// Cache rates follow the standard Anthropic scheme relative to the input
/// price: writes cost 1.25×, reads cost 0.1×.  The same multipliers are used
/// for OpenAI-compatible `cached_tokens` reports.
pub fn estimate_turn_cost(outcome: &ChatOutcome) -> Option<(f64, f64)> {
    if !outcome.usage_reported {
        return None;
    }
    let (input_per_1k, output_per_1k) = model_price_per_1k(&outcome.model);
    let usage = outcome.usage;
    let uncached_input = usage
        .input_tokens
        .saturating_sub(usage.cached_read_tokens)
        .saturating_sub(usage.cache_creation_tokens);
    let cache_write_per_1k = input_per_1k * 1.25;
    let cache_read_per_1k = input_per_1k * 0.1;
    let cost = uncached_input as f64 / 1000.0 * input_per_1k
        + usage.cache_creation_tokens as f64 / 1000.0 * cache_write_per_1k
        + usage.cached_read_tokens as f64 / 1000.0 * cache_read_per_1k
        + usage.output_tokens as f64 / 1000.0 * output_per_1k;
    let naive = usage.input_tokens as f64 / 1000.0 * input_per_1k
        + usage.output_tokens as f64 / 1000.0 * output_per_1k;
    Some((cost, (naive - cost).max(0.0)))
}

/// The credential reference kind only — `env:NAME` or `store:KEY`.  The
/// credential value itself never appears in any output path.
pub fn credential_ref_kind(provider: &ProviderConfig) -> String {
    match &provider.credential {
        CredentialRef::Env(name) => format!("env:{name}"),
        CredentialRef::Store(key) => format!("store:{key}"),
    }
}

/// The run-active profile: the `--provider` override when present, otherwise
/// the persisted active profile.
pub fn run_active_provider_config<'a>(
    settings: &'a NativeSettings,
    run_active: Option<&'a ProviderId>,
) -> Option<&'a ProviderConfig> {
    match run_active {
        Some(id) => settings.provider(id),
        None => settings.active_provider_config(),
    }
}

/// The active-provider model client that powers worker agents (§10.4).  It
/// resolves the active profile once, then streams each model turn over the
/// matching protocol, accumulating text, tool calls, and token usage.
pub struct TransportModelClient {
    provider: ProviderConfig,
    key: SecretKey,
    model: String,
    effort: Option<WorkerEffort>,
}

impl TransportModelClient {
    /// Resolve the active provider, its credential (env -> store ->
    /// fail-closed), and allowlist-eligible model, applying the global lock
    /// or the local Ares effort when no lock is set.
    pub async fn resolve_with_effort(
        settings: &NativeSettings,
        automatic_effort: Option<WorkerEffort>,
    ) -> Result<Self> {
        let provider = run_active_provider_config(settings, None)
            .ok_or_else(|| anyhow!("no active provider is configured"))?;
        let store = load_store(&native_store_path()?).map_err(anyhow::Error::msg)?;
        let key = store
            .resolve(&provider.credential, |name| env::var(name).ok())
            .map_err(|_| {
                anyhow!(
                    "credential for provider '{}' is not configured ({})",
                    provider.id,
                    credential_ref_kind(provider)
                )
            })?;
        // An explicit global lock always wins over the local Ares heuristic.
        let effort = settings.worker_effort_lock.or(automatic_effort);
        let model = select_chat_model(settings, provider, None)?;
        Ok(Self {
            provider: provider.clone(),
            key,
            model,
            effort,
        })
    }
}

impl ModelClient for TransportModelClient {
    fn turn(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkerResult<ModelTurn>> + Send>> {
        let provider = self.provider.clone();
        let key = self.key.clone();
        let model = self.model.clone();
        let effort = self.effort;
        let messages = messages.to_vec();
        let tools = tools.to_vec();
        Box::pin(async move {
            let transport = Transport::new(&provider.base_url)
                .map_err(|error| WorkerError::Io(error.to_string()))?;
            let (text, tool_calls, usage, usage_reported) = match provider.protocol {
                Protocol::OpenAiCompatible => {
                    let request = ChatCompletionsRequest {
                        model: model.clone(),
                        messages,
                        max_tokens: None,
                        temperature: None,
                        tools,
                        reasoning_effort: effort,
                    };
                    let stream = transport
                        .chat_completions(&key, &request)
                        .map_err(|error| WorkerError::Io(error.to_string()))?;
                    futures_util::pin_mut!(stream);
                    let mut text = String::new();
                    let mut usage = ChatUsage::default();
                    let mut usage_reported = false;
                    // (id, name, accumulated arguments) grouped by tool-call index.
                    let mut calls: BTreeMap<u64, (String, String, String)> = BTreeMap::new();
                    while let Some(item) = stream.next().await {
                        if cancel.is_cancelled() {
                            return Err(WorkerError::Cancelled);
                        }
                        let chunk = item.map_err(|error| WorkerError::Io(error.to_string()))?;
                        if let Some(reported) = ChatUsage::parse(chunk.usage.as_ref()) {
                            usage_reported = true;
                            if reported.input_tokens > 0 || reported.output_tokens > 0 {
                                usage = reported;
                            }
                        }
                        for choice in chunk.choices {
                            if let Some(content) = choice.delta.content {
                                text.push_str(&content);
                            }
                            for call in choice.delta.tool_calls {
                                let entry = calls.entry(call.index).or_default();
                                if let Some(id) = call.id {
                                    if !id.is_empty() {
                                        entry.0 = id;
                                    }
                                }
                                if let Some(function) = call.function {
                                    if let Some(name) = function.name {
                                        if !name.is_empty() {
                                            entry.1 = name;
                                        }
                                    }
                                    if let Some(arguments) = function.arguments {
                                        entry.2.push_str(&arguments);
                                    }
                                }
                            }
                        }
                    }
                    let tool_calls = calls
                        .into_iter()
                        .map(|(_, (id, name, arguments))| ResolvedToolCall {
                            id,
                            name,
                            arguments: serde_json::from_str(&arguments)
                                .unwrap_or(Value::String(arguments)),
                        })
                        .collect();
                    (text, tool_calls, usage, usage_reported)
                }
                Protocol::AnthropicCompatible => {
                    let request = MessagesRequest {
                        model: model.clone(),
                        max_tokens: 1024,
                        messages,
                        system: None,
                        temperature: None,
                        tools,
                        reasoning_effort: effort,
                    };
                    let stream = transport
                        .messages(&key, &request)
                        .map_err(|error| WorkerError::Io(error.to_string()))?;
                    futures_util::pin_mut!(stream);
                    let mut text = String::new();
                    let mut usage = ChatUsage::default();
                    let mut usage_reported = false;
                    // (id, name, accumulated partial_json) grouped by block index.
                    let mut calls: BTreeMap<u64, (String, String, String)> = BTreeMap::new();
                    while let Some(item) = stream.next().await {
                        if cancel.is_cancelled() {
                            return Err(WorkerError::Cancelled);
                        }
                        let chunk = item.map_err(|error| WorkerError::Io(error.to_string()))?;
                        if let Some(start) = &chunk.message {
                            if let Some(reported) = ChatUsage::parse(start.usage.as_ref()) {
                                usage_reported = true;
                                usage.input_tokens = reported.input_tokens;
                                usage.cached_read_tokens = reported.cached_read_tokens;
                                usage.cache_creation_tokens = reported.cache_creation_tokens;
                                if reported.output_tokens > usage.output_tokens {
                                    usage.output_tokens = reported.output_tokens;
                                }
                            }
                        }
                        if let Some(reported) = ChatUsage::parse(chunk.usage.as_ref()) {
                            usage_reported = true;
                            if reported.output_tokens > usage.output_tokens {
                                usage.output_tokens = reported.output_tokens;
                            }
                        }
                        let index = chunk.index.unwrap_or(0);
                        if let Some(block) = chunk.content_block {
                            if block.r#type == "tool_use" {
                                let entry = calls.entry(index).or_default();
                                if let Some(id) = block.id {
                                    if !id.is_empty() {
                                        entry.0 = id;
                                    }
                                }
                                if let Some(name) = block.name {
                                    if !name.is_empty() {
                                        entry.1 = name;
                                    }
                                }
                            } else if let Some(content) = block.text {
                                text.push_str(&content);
                            }
                        }
                        if let Some(delta) = chunk.delta {
                            if let Some(content) = delta.text {
                                text.push_str(&content);
                            }
                            if let Some(partial_json) = delta.partial_json {
                                calls.entry(index).or_default().2.push_str(&partial_json);
                            }
                        }
                    }
                    let tool_calls = calls
                        .into_iter()
                        .map(|(_, (id, name, arguments))| ResolvedToolCall {
                            id,
                            name,
                            arguments: serde_json::from_str(&arguments)
                                .unwrap_or(Value::String(arguments)),
                        })
                        .collect();
                    (text, tool_calls, usage, usage_reported)
                }
            };
            let cost_outcome = ChatOutcome {
                text: String::new(),
                usage,
                model,
                usage_reported,
            };
            let (cost, cost_known) = estimate_turn_cost(&cost_outcome)
                .map(|(cost, _)| (cost, true))
                .unwrap_or((0.0, false));
            Ok(ModelTurn {
                text,
                tool_calls,
                usage,
                cost,
                cost_known,
            })
        })
    }
}

pub fn native_settings_path() -> Result<PathBuf> {
    default_settings_path().map_err(|_| anyhow!("MindCode config home is unavailable"))
}

pub fn native_store_path() -> Result<PathBuf> {
    default_store_path().map_err(|_| anyhow!("MindCode config home is unavailable"))
}

pub fn load_native_settings() -> Result<NativeSettings> {
    load_settings(&native_settings_path()?).map_err(anyhow::Error::msg)
}

pub fn save_native_settings(settings: &NativeSettings) -> Result<()> {
    save_settings(&native_settings_path()?, settings).map_err(anyhow::Error::msg)
}
