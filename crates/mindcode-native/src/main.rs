//! Rust-first single-executable foundation for MindCode.
//!
//! The native binary deliberately keeps the supported surface small: daemon
//! lifecycle, multi-provider profile management, secret-free settings
//! persistence, provider-aware authentication status, live chat through the
//! active provider, and the in-process TUI are native today.

use anyhow::{anyhow, Context, Result};
use clap::{error::ErrorKind, Parser, Subcommand};
use futures_util::StreamExt;
use mindcode_protocol::ui::{UiActionInput, UiInputEventKind, UiMessage};
use mindcode_provider::{
    default_store_path, load_store, save_store, CredentialRef, ModelId, Protocol, ProviderConfig,
    ProviderId, SecretKey,
};
use mindcode_settings::{
    default_settings_path, load_settings, save_settings, CredState, NativeSettings,
};
use mindcode_transport::{
    ChatCompletionsRequest, ChatMessage, ChatUsage, MessagesRequest, ToolSpec, Transport,
};
use mindcode_tui::TuiConfig;
use mindcode_tui::debug_visual::{sanitize_frame_text, FrameDump, FrameRecorder};
use mindcode_tui::terminal_caps::{terminal_setup_report, TerminalProbe};
use mindcode_tui::ui::{default_graphite_sakura, generate_palette, score_palette, PaletteSpec, Rgb, Role};
use mindcode_tui_server::{
    ConnectionInput, ControlServer, ControlServerConfig, InputHandler, PermissionInput,
    ProjectionInput, ProviderInput, StatusInput, TelemetryInput, TranscriptInput, WriterInput,
};
use mindcode_vexzy::{
    eligible_worker_models, parse_vexzy_model_catalog, VexzyModel, VexzyModelCatalog, WorkerEffort,
};
use mindcode_worker::{
    ApprovalDecision, ApprovalGate, ApprovalRequest, DecisionFuture, HookSet, ModelClient,
    ModelTurn, OwnershipGuard, PermissionTier, PoolOutcome, ResolvedToolCall, WorkerAgent,
    WorkerError, WorkerPool, WorkerReport, WorkerResult, WorkerScope, WorkerStatus, WorkerUsage,
    DEFAULT_MAX_CONCURRENT,
};
use mindcoded::{Daemon, DaemonConfig};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fs,
    future::Future,
    io,
    io::BufRead,
    path::{Path, PathBuf},
    pin::Pin,
    process,
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, Mutex},
    time::Duration,
    time::Instant,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const VERSION: &str = "0.1.3";
const API_KEY_ENV: &str = "VEXZY_API_KEY";
/// The only stdout write of `settings key`; asserting the constant guarantees
/// the credential value and the store path can never be echoed.
const SETTINGS_KEY_CONFIRMATION: &str = "configured";
/// Minimum delay between TUI snapshot republishes while a chat turn streams;
/// tokens still accumulate locally between publishes.
const STREAM_REPUBLISH_INTERVAL: Duration = Duration::from_millis(120);
/// Default conversation-memory budget in estimated tokens (§11.3).  The
/// estimate is a cheap local heuristic (`chars/4`); real usage comes from
/// the provider response.  The base is 200K always; a settings override may
/// raise or lower it.
const CONTEXT_TOKEN_BUDGET: usize = 200_000;

#[derive(Debug, Parser)]
#[command(
    name = "mindcode",
    version = VERSION,
    about = "MindCode native Rust foundation (multi-provider)",
    after_help = "Commands:\n  auth status       Show active provider authentication status\n  model eligible    Inspect eligible Worker models of the active provider\n  effort worker     Validate a Worker model and optional effort lock\n  provider          Manage provider profiles (list, use, add, remove, edit)\n  settings          Manage settings (show, key, allowlist, model, effort lock)\n  setup-token       Show credential setup instructions\n  doctor            Check native foundation health\n  update            Show local checkout update instructions\n  daemon            Run the native mindcoded daemon in-process\n  tui               Run the native terminal interface\n  chat              Complete a chat request through the active provider"
)]
struct RootArgs {
    #[arg(
        value_name = "PROMPT",
        trailing_var_arg = true,
        help = "Complete a chat request through the active provider"
    )]
    prompt: Vec<String>,
}

#[derive(Debug, Parser)]
#[command(
    name = "mindcode chat",
    version = VERSION,
    about = "Complete a chat request through the active provider"
)]
struct ChatArgs {
    #[arg(long, value_name = "MODEL_ID", help = "Model id override")]
    model: Option<String>,
    #[arg(value_name = "PROMPT", required = true)]
    prompt: Vec<String>,
}

#[derive(Debug, Parser)]
#[command(
    name = "mindcode auth",
    version = VERSION,
    about = "Provider-aware authentication"
)]
struct AuthArgs {
    #[command(subcommand)]
    command: AuthCommand,
}

#[derive(Debug, Subcommand)]
enum AuthCommand {
    #[command(name = "status", about = "Show active provider authentication status")]
    Status(AuthStatusArgs),
}

#[derive(Debug, Parser)]
struct AuthStatusArgs {
    #[arg(
        long,
        conflicts_with = "text",
        help = "Output machine-readable JSON (default)"
    )]
    json: bool,
    #[arg(long, help = "Output human-readable status")]
    text: bool,
}

#[derive(Debug, Parser)]
#[command(
    name = "mindcode model",
    version = VERSION,
    about = "Inspect VEXZY Worker eligibility from a supplied catalog"
)]
struct ModelArgs {
    #[command(subcommand)]
    command: ModelCommand,
}

#[derive(Debug, Subcommand)]
enum ModelCommand {
    #[command(
        name = "eligible",
        about = "List eligible Worker models from a supplied catalog"
    )]
    Eligible(CatalogArgs),
}

#[derive(Debug, Parser)]
struct CatalogArgs {
    #[arg(
        long,
        value_name = "JSON|@PATH",
        help = "Inline VEXZY catalog JSON or @PATH to a local catalog JSON file"
    )]
    catalog: String,
}

#[derive(Debug, Parser)]
#[command(
    name = "mindcode effort",
    version = VERSION,
    about = "Validate Worker effort policy from a supplied VEXZY catalog"
)]
struct EffortArgs {
    #[command(subcommand)]
    command: EffortCommand,
}

#[derive(Debug, Subcommand)]
enum EffortCommand {
    #[command(
        name = "worker",
        about = "Validate an eligible Worker model and optional global effort lock"
    )]
    Worker(WorkerEffortArgs),
}

#[derive(Debug, Parser)]
struct WorkerEffortArgs {
    #[arg(
        long,
        value_name = "JSON|@PATH",
        help = "Inline VEXZY catalog JSON or @PATH to a local catalog JSON file"
    )]
    catalog: String,
    #[arg(
        long,
        value_name = "MODEL_ID",
        help = "Exact eligible VEXZY Worker model ID"
    )]
    model: String,
    #[arg(
        long,
        value_name = "EFFORT|off",
        help = "Optional global Worker effort lock: none, low, medium, high, xhigh, max, or off"
    )]
    lock: Option<String>,
}

#[derive(Debug, Parser)]
#[command(
    name = "mindcode provider",
    version = VERSION,
    about = "Manage provider profiles"
)]
struct ProviderArgs {
    #[command(subcommand)]
    command: ProviderCommand,
}

#[derive(Debug, Subcommand)]
enum ProviderCommand {
    #[command(name = "list", about = "List provider profiles with the active marker")]
    List,
    #[command(name = "use", about = "Set the active provider profile (persisted)")]
    Use(ProviderIdArg),
    #[command(name = "add", about = "Add a provider profile")]
    Add(ProviderAddArgs),
    #[command(name = "remove", about = "Remove a provider profile")]
    Remove(ProviderIdArg),
    #[command(name = "edit", about = "Edit a provider profile (id is immutable)")]
    Edit(ProviderEditArgs),
}

#[derive(Debug, Parser)]
struct ProviderIdArg {
    #[arg(value_name = "ID", help = "Provider profile id")]
    id: String,
}

#[derive(Debug, Parser)]
struct ProviderAddArgs {
    #[arg(long, value_name = "ID", help = "Profile id (immutable afterwards)")]
    id: String,
    #[arg(long, value_name = "NAME", help = "Display name")]
    name: String,
    #[arg(
        long,
        value_name = "PROTOCOL",
        help = "openai-compatible or anthropic-compatible"
    )]
    protocol: String,
    #[arg(
        long,
        value_name = "URL",
        help = "Absolute https:// or http:// base URL"
    )]
    base_url: String,
    #[arg(
        long,
        value_name = "ENV_VAR",
        conflicts_with = "credential_store",
        help = "Credential environment variable name"
    )]
    credential_env: Option<String>,
    #[arg(
        long,
        value_name = "STORE_ID",
        conflicts_with = "credential_env",
        help = "Credential secret-store key"
    )]
    credential_store: Option<String>,
    #[arg(
        long,
        value_name = "ID,ID,...",
        help = "Comma-separated Worker model allowlist"
    )]
    allowlist: Option<String>,
}

#[derive(Debug, Parser)]
struct ProviderEditArgs {
    #[arg(value_name = "ID", help = "Provider profile id (immutable)")]
    id: String,
    #[arg(long, value_name = "NAME")]
    name: Option<String>,
    #[arg(
        long,
        value_name = "PROTOCOL",
        help = "openai-compatible or anthropic-compatible"
    )]
    protocol: Option<String>,
    #[arg(long, value_name = "URL")]
    base_url: Option<String>,
    #[arg(long, value_name = "ID,ID,...")]
    allowlist: Option<String>,
}

#[derive(Debug, Parser)]
#[command(
    name = "mindcode settings",
    version = VERSION,
    about = "Manage secret-free native settings"
)]
struct SettingsArgs {
    #[command(subcommand)]
    command: SettingsCommand,
}

#[derive(Debug, Subcommand)]
enum SettingsCommand {
    #[command(
        name = "show",
        about = "Show active provider, profiles, Worker model and effort lock"
    )]
    Show,
    #[command(
        name = "key",
        about = "Write a credential into the secret store (value never echoed)"
    )]
    Key(SettingsKeyArgs),
    #[command(name = "allowlist", about = "Set a profile's Worker model allowlist")]
    Allowlist(SettingsAllowlistArgs),
    #[command(name = "model", about = "Set the global Worker model")]
    Model(SettingsModelArgs),
    #[command(name = "effort", about = "Manage the global Worker effort lock")]
    Effort(SettingsEffortArgs),
}

#[derive(Debug, Parser)]
struct SettingsKeyArgs {
    #[arg(
        value_name = "PROVIDER_ID",
        help = "Provider id the credential is stored under"
    )]
    provider_id: String,
    #[arg(
        long,
        value_name = "ENV_VAR",
        help = "Read the credential from this environment variable"
    )]
    from_env: Option<String>,
}

#[derive(Debug, Parser)]
struct SettingsAllowlistArgs {
    #[arg(value_name = "PROVIDER_ID")]
    provider_id: String,
    #[arg(
        value_name = "ID,ID,...",
        help = "Comma-separated model ids; empty clears the allowlist"
    )]
    allowlist: String,
}

#[derive(Debug, Parser)]
struct SettingsModelArgs {
    #[arg(value_name = "MODEL_ID")]
    id: String,
}

#[derive(Debug, Parser)]
struct SettingsEffortArgs {
    #[command(subcommand)]
    command: SettingsEffortCommand,
}

#[derive(Debug, Subcommand)]
enum SettingsEffortCommand {
    #[command(name = "lock", about = "Set or unset the global Worker effort lock")]
    Lock(SettingsEffortLockArgs),
}

#[derive(Debug, Parser)]
struct SettingsEffortLockArgs {
    #[arg(
        value_name = "EFFORT|off",
        help = "off, none, low, medium, high, xhigh, or max"
    )]
    value: String,
}

#[derive(Debug, Parser)]
#[command(
    name = "mindcode setup-token",
    version = VERSION,
    about = "Show VEXZY API key setup instructions"
)]
struct SetupTokenArgs {}

#[derive(Debug, Parser)]
#[command(
    name = "mindcode doctor",
    version = VERSION,
    about = "Check native/VEXZY foundation health"
)]
struct DoctorArgs {}

#[derive(Debug, Parser)]
#[command(
    name = "mindcode update",
    version = VERSION,
    about = "Show local checkout update instructions"
)]
struct UpdateArgs {}

#[derive(Debug, Parser)]
#[command(
    name = "mindcode tui",
    version = VERSION,
    about = "Run the native terminal interface (in-process control server)"
)]
struct TuiArgs {
    #[arg(long, value_name = "ID", help = "TUI session id (defaults to 'tui')")]
    session_id: Option<String>,
}

#[derive(Debug, Parser)]
#[command(name = "mindcode daemon", version = VERSION, about = "Run the native mindcoded daemon")]
struct DaemonArgs {
    #[arg(long, value_name = "PATH", default_value_os_t = DaemonConfig::default_socket())]
    socket: PathBuf,
    #[arg(long, value_name = "PATH")]
    state_dir: Option<PathBuf>,
    #[arg(long, value_name = "SECONDS", default_value_t = 1_800)]
    idle_seconds: u64,
    #[arg(long, value_name = "SECONDS", default_value_t = 5)]
    handshake_timeout_seconds: u64,
    #[arg(long, value_name = "BUILD_ID", default_value = "dev")]
    build_id: String,
}

#[tokio::main]
async fn main() {
    let arguments = env::args_os().skip(1).collect::<Vec<_>>();
    let code = match dispatch(arguments).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("mindcode: {error:#}");
            1
        }
    };
    process::exit(code);
}

async fn dispatch(arguments: Vec<OsString>) -> Result<i32> {
    let (options, arguments) = scan_run_options(&arguments).map_err(anyhow::Error::msg)?;
    let run_active = match options.provider {
        Some(id) => Some(resolve_run_provider(&id)?),
        None => None,
    };
    let run_worker_model = options
        .worker_model
        .as_deref()
        .map(parse_worker_model_override)
        .transpose()?;
    if let Some(lock) = options.worker_effort_lock.as_deref() {
        parse_effort_lock_override(lock)?;
    }

    let Some(first) = arguments.first().and_then(|arg| arg.to_str()) else {
        // The TUI is the main interface: a bare invocation opens it.
        return run_tui(arguments).await;
    };

    match first {
        "auth" => run_auth(arguments, run_active.as_ref()),
        "model" => run_model(arguments),
        "effort" => run_effort(arguments),
        "provider" => run_provider(arguments, run_active.as_ref()),
        "settings" => run_settings(arguments, run_active.as_ref()),
        "setup-token" => run_setup_token(arguments),
        "doctor" => run_doctor(arguments),
        "update" | "upgrade" => run_update(arguments),
        "daemon" => run_daemon(arguments).await,
        "tui" => run_tui(arguments).await,
        "chat" => run_chat(arguments, run_active.as_ref(), run_worker_model.as_deref()).await,
        "-h" | "--help" | "-V" | "--version" => {
            run_root_parser(arguments, run_active.as_ref()).await
        }
        value if value.starts_with('-') => run_root_parser(arguments, run_active.as_ref()).await,
        // Removed TUI commands surface as a stable unknown-command error
        // before any prompt path runs. No alias or hidden route is registered.
        "config" | "submodel" => run_removed_command(first),
        value if value.starts_with('/') => run_removed_command(value),
        _ => {
            let prompt = arguments
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            run_regular_prompt(&prompt, run_active.as_ref()).await
        }
    }
}

/// Run-scoped global options extracted from the raw argument list before clap
/// parsing.  Each option accepts both `--flag value` and `--flag=value`
/// spellings anywhere on the command line, including before the subcommand
/// name, and none of them persist anything.
#[derive(Debug, Default)]
struct RunOptions {
    provider: Option<String>,
    worker_model: Option<String>,
    worker_effort_lock: Option<String>,
}

fn scan_run_options(arguments: &[OsString]) -> Result<(RunOptions, Vec<OsString>), String> {
    let mut options = RunOptions::default();
    let mut remaining = Vec::new();
    let mut iter = arguments.iter();
    while let Some(argument) = iter.next() {
        let Some(text) = argument.to_str() else {
            remaining.push(argument.clone());
            continue;
        };
        match text {
            "--provider" | "--worker-model" | "--worker-effort-lock" => {
                let Some(value) = iter.next().and_then(|value| value.to_str()) else {
                    return Err(format!("{text} requires a value"));
                };
                assign_run_option(&mut options, text, value);
                continue;
            }
            _ => {}
        }
        if let Some(value) = text
            .strip_prefix("--provider=")
            .or_else(|| text.strip_prefix("--worker-model="))
            .or_else(|| text.strip_prefix("--worker-effort-lock="))
        {
            assign_run_option(
                &mut options,
                &text[..text.find('=').unwrap_or(text.len())],
                value,
            );
            continue;
        }
        remaining.push(argument.clone());
    }
    Ok((options, remaining))
}

fn assign_run_option(options: &mut RunOptions, flag: &str, value: &str) {
    match flag {
        "--provider" => options.provider = Some(value.to_owned()),
        "--worker-model" => options.worker_model = Some(value.to_owned()),
        "--worker-effort-lock" => options.worker_effort_lock = Some(value.to_owned()),
        _ => {}
    }
}

/// Validate a run-scoped `--worker-model` value without persisting it.
fn parse_worker_model_override(value: &str) -> Result<String> {
    if value.trim().is_empty() || value.chars().any(char::is_whitespace) {
        return Err(anyhow!(
            "--worker-model requires a non-empty model id without whitespace"
        ));
    }
    Ok(value.to_owned())
}

/// Validate a run-scoped `--worker-effort-lock` value (`off` clears the lock)
/// without persisting it.  Fail-closed on an unknown effort.
fn parse_effort_lock_override(value: &str) -> Result<Option<WorkerEffort>> {
    if value == "off" {
        return Ok(None);
    }
    value.parse::<WorkerEffort>().map(Some).map_err(|_| {
        anyhow!("--worker-effort-lock must be none, low, medium, high, xhigh, max, or off")
    })
}

/// Validate a run-selected `--provider` id against the persisted profile
/// table.  Unknown, empty, or malformed ids fail closed with exit 1.
fn resolve_run_provider(id: &str) -> Result<ProviderId, anyhow::Error> {
    if id.trim().is_empty() {
        return Err(anyhow!("--provider requires a provider id value"));
    }
    let provider_id = ProviderId::new(id.to_owned()).map_err(anyhow::Error::msg)?;
    let settings = load_native_settings()?;
    if settings.provider(&provider_id).is_none() {
        return Err(anyhow!("provider '{id}' is not configured"));
    }
    Ok(provider_id)
}

async fn run_root_parser(arguments: Vec<OsString>, run_active: Option<&ProviderId>) -> Result<i32> {
    match RootArgs::try_parse_from(with_program_name(arguments)) {
        Ok(args) => run_regular_prompt(&args.prompt, run_active).await,
        Err(error) => Ok(print_clap_error(error)),
    }
}

/// Stable, bounded diagnostic for commands removed from the native surface.
/// The literal `unknown_command` marker keeps the exit contract greppable.
fn removed_command_error(command: &str) -> String {
    format!("unknown_command: '{command}' is not a native mindcode command")
}

fn run_removed_command(command: &str) -> Result<i32> {
    eprintln!("mindcode: {}", removed_command_error(command));
    Ok(1)
}

fn run_auth(arguments: Vec<OsString>, run_active: Option<&ProviderId>) -> Result<i32> {
    let parsed =
        match AuthArgs::try_parse_from(with_command_program_name(arguments, "mindcode auth")) {
            Ok(args) => args,
            Err(error) => return Ok(print_clap_error(error)),
        };
    match parsed.command {
        AuthCommand::Status(options) => run_auth_status(options, run_active),
    }
}

/// Resolve the active provider's credential (env -> secret store -> fail
/// closed) and report only a secret-free status.  Exit 1 whenever the active
/// provider's credential is missing or invalid.
fn run_auth_status(options: AuthStatusArgs, run_active: Option<&ProviderId>) -> Result<i32> {
    let settings = load_native_settings()?;
    let Some(provider) = run_active_provider_config(&settings, run_active) else {
        return Err(anyhow!("no active provider is configured"));
    };
    let store = load_store(&native_store_path()?).map_err(anyhow::Error::msg)?;
    let configured = store
        .resolve(&provider.credential, |name| env::var(name).ok())
        .is_ok();
    if options.text {
        println!(
            "{}: {}",
            auth_provider_summary(provider),
            if configured {
                "configured"
            } else {
                "not configured"
            }
        );
    } else {
        println!("{}", auth_status_value(provider, configured));
    }
    Ok(i32::from(!configured))
}

fn run_model(arguments: Vec<OsString>) -> Result<i32> {
    let parsed =
        match ModelArgs::try_parse_from(with_command_program_name(arguments, "mindcode model")) {
            Ok(args) => args,
            Err(error) => return Ok(print_clap_error(error)),
        };

    match parsed.command {
        ModelCommand::Eligible(args) => match eligible_models_output(&args.catalog) {
            Ok(output) => {
                println!("{output}");
                Ok(0)
            }
            Err(message) => {
                eprintln!("mindcode: {message}");
                Ok(1)
            }
        },
    }
}

fn run_effort(arguments: Vec<OsString>) -> Result<i32> {
    let parsed =
        match EffortArgs::try_parse_from(with_command_program_name(arguments, "mindcode effort")) {
            Ok(args) => args,
            Err(error) => return Ok(print_clap_error(error)),
        };

    match parsed.command {
        EffortCommand::Worker(args) => {
            match worker_effort_output(&args.catalog, &args.model, args.lock.as_deref()) {
                Ok(output) => {
                    println!("{output}");
                    Ok(0)
                }
                Err(message) => {
                    eprintln!("mindcode: {message}");
                    Ok(1)
                }
            }
        }
    }
}

fn run_provider(arguments: Vec<OsString>, run_active: Option<&ProviderId>) -> Result<i32> {
    let parsed = match ProviderArgs::try_parse_from(with_command_program_name(
        arguments,
        "mindcode provider",
    )) {
        Ok(args) => args,
        Err(error) => return Ok(print_clap_error(error)),
    };

    match parsed.command {
        ProviderCommand::List => run_provider_list(run_active),
        ProviderCommand::Use(args) => run_provider_use(&args.id),
        ProviderCommand::Add(args) => run_provider_add(args),
        ProviderCommand::Remove(args) => run_provider_remove(&args.id),
        ProviderCommand::Edit(args) => run_provider_edit(args),
    }
}

fn run_provider_list(run_active: Option<&ProviderId>) -> Result<i32> {
    let settings = load_native_settings()?;
    println!(
        "{}",
        json!(providers_list_value(
            &settings,
            effective_active(&settings, run_active)
        ))
    );
    Ok(0)
}

fn run_provider_use(id: &str) -> Result<i32> {
    let id = parse_provider_id(id)?;
    let mut settings = load_native_settings()?;
    settings
        .set_active_provider(&id)
        .map_err(anyhow::Error::msg)?;
    save_native_settings(&settings)?;
    println!("active provider: {id}");
    Ok(0)
}

fn run_provider_add(args: ProviderAddArgs) -> Result<i32> {
    let id = parse_provider_id(&args.id)?;
    if args.name.trim().is_empty() {
        return Err(anyhow!("provider name must not be empty"));
    }
    let protocol = args
        .protocol
        .parse::<Protocol>()
        .map_err(anyhow::Error::msg)?;
    let scheme = validate_base_url(&args.base_url)?;
    if scheme == "http" && !base_url_host_is_loopback(&args.base_url) {
        eprintln!("mindcode: warning: non-loopback http base URL may be refused by the transport");
    }
    let credential = match (args.credential_env, args.credential_store) {
        (Some(name), None) => {
            if name.trim().is_empty() || name.chars().any(char::is_whitespace) {
                return Err(anyhow!(
                    "credential environment variable name must be a non-empty string without whitespace"
                ));
            }
            CredentialRef::Env(name)
        }
        (None, Some(key)) => CredentialRef::Store(parse_provider_id(&key)?.to_string()),
        (Some(_), Some(_)) => {
            unreachable!("clap conflicts_with prevents both credential options")
        }
        (None, None) => {
            return Err(anyhow!(
                "one of --credential-env or --credential-store is required"
            ));
        }
    };
    let allowlist = parse_allowlist(args.allowlist.as_deref())?;
    let mut settings = load_native_settings()?;
    settings
        .add_provider(ProviderConfig {
            id: id.clone(),
            name: args.name,
            protocol,
            base_url: args.base_url,
            credential,
            allowlist,
            active: false,
        })
        .map_err(anyhow::Error::msg)?;
    save_native_settings(&settings)?;
    println!("added provider: {id}");
    Ok(0)
}

fn run_provider_remove(id: &str) -> Result<i32> {
    let id = parse_provider_id(id)?;
    let mut settings = load_native_settings()?;
    settings.remove_provider(&id).map_err(anyhow::Error::msg)?;
    save_native_settings(&settings)?;
    println!("removed provider: {id}");
    Ok(0)
}

fn run_provider_edit(args: ProviderEditArgs) -> Result<i32> {
    let id = parse_provider_id(&args.id)?;
    let mut settings = load_native_settings()?;
    let mut edited = settings
        .provider(&id)
        .cloned()
        .ok_or_else(|| anyhow!("provider profile not found ({id})"))?;
    if let Some(name) = args.name {
        if name.trim().is_empty() {
            return Err(anyhow!("provider name must not be empty"));
        }
        edited.name = name;
    }
    if let Some(protocol) = args.protocol {
        edited.protocol = protocol.parse::<Protocol>().map_err(anyhow::Error::msg)?;
    }
    if let Some(base_url) = args.base_url {
        let scheme = validate_base_url(&base_url)?;
        if scheme == "http" && !base_url_host_is_loopback(&base_url) {
            eprintln!(
                "mindcode: warning: non-loopback http base URL may be refused by the transport"
            );
        }
        edited.base_url = base_url;
    }
    if let Some(allowlist) = args.allowlist {
        edited.allowlist = parse_allowlist(Some(&allowlist))?;
    }
    settings.edit_provider(edited).map_err(anyhow::Error::msg)?;
    save_native_settings(&settings)?;
    println!("updated provider: {id}");
    Ok(0)
}

fn run_settings(arguments: Vec<OsString>, run_active: Option<&ProviderId>) -> Result<i32> {
    let parsed = match SettingsArgs::try_parse_from(with_command_program_name(
        arguments,
        "mindcode settings",
    )) {
        Ok(args) => args,
        Err(error) => return Ok(print_clap_error(error)),
    };

    match parsed.command {
        SettingsCommand::Show => run_settings_show(run_active),
        SettingsCommand::Key(args) => run_settings_key(args),
        SettingsCommand::Allowlist(args) => run_settings_allowlist(args),
        SettingsCommand::Model(args) => run_settings_model(args),
        SettingsCommand::Effort(args) => run_settings_effort(args),
    }
}

fn run_settings_show(run_active: Option<&ProviderId>) -> Result<i32> {
    let settings = load_native_settings()?;
    println!(
        "{}",
        settings_show_value(&settings, effective_active(&settings, run_active))
    );
    Ok(0)
}

fn run_settings_key(args: SettingsKeyArgs) -> Result<i32> {
    let id = parse_provider_id(&args.provider_id)?;
    let value = match args.from_env.as_deref() {
        Some(name) => {
            env::var(name).map_err(|_| anyhow!("environment variable '{name}' is not set"))?
        }
        None => read_credential_line(io::stdin().lock())?,
    };
    if value.trim().is_empty() {
        return Err(anyhow!("credential value must not be empty"));
    }
    let path = native_store_path()?;
    let mut store = load_store(&path).map_err(anyhow::Error::msg)?;
    store.write(id, SecretKey::new(value));
    save_store(&path, &store).map_err(anyhow::Error::msg)?;
    println!("{SETTINGS_KEY_CONFIRMATION}");
    Ok(0)
}

fn run_settings_allowlist(args: SettingsAllowlistArgs) -> Result<i32> {
    let id = parse_provider_id(&args.provider_id)?;
    let allowlist = parse_allowlist(Some(&args.allowlist))?;
    let mut settings = load_native_settings()?;
    settings
        .set_allowlist(&id, allowlist)
        .map_err(anyhow::Error::msg)?;
    save_native_settings(&settings)?;
    println!("allowlist for {id}: {}", args.allowlist);
    Ok(0)
}

fn run_settings_model(args: SettingsModelArgs) -> Result<i32> {
    let model = ModelId::new(args.id.clone()).map_err(anyhow::Error::msg)?;
    let mut settings = load_native_settings()?;
    settings.global_worker_model = Some(model.to_string());
    save_native_settings(&settings)?;
    println!("global worker model: {model}");
    Ok(0)
}

fn run_settings_effort(args: SettingsEffortArgs) -> Result<i32> {
    match args.command {
        SettingsEffortCommand::Lock(args) => run_settings_effort_lock(args),
    }
}

fn run_settings_effort_lock(args: SettingsEffortLockArgs) -> Result<i32> {
    let lock = parse_worker_lock(Some(&args.value)).map_err(anyhow::Error::msg)?;
    let mut settings = load_native_settings()?;
    settings.worker_effort_lock = lock;
    save_native_settings(&settings)?;
    match lock {
        Some(effort) => println!("worker effort lock: {effort}"),
        None => println!("worker effort lock: off"),
    }
    Ok(0)
}

/// Read a catalog supplied explicitly by the caller.  This is deliberately
/// offline: no VEXZY request, cache update, or persisted setting is touched.
fn read_catalog_input(value: &str) -> Result<String, &'static str> {
    match value.strip_prefix('@') {
        Some("") => Err("catalog file path is empty"),
        Some(path) => fs::read_to_string(path).map_err(|_| "could not read supplied catalog"),
        None => Ok(value.to_owned()),
    }
}

fn parse_supplied_catalog(value: &str) -> Result<VexzyModelCatalog, &'static str> {
    let input = read_catalog_input(value)?;
    parse_vexzy_model_catalog(&input).map_err(|_| "supplied VEXZY catalog is invalid")
}

fn allowed_effort_names(model: &VexzyModel) -> Vec<&'static str> {
    model
        .supported_worker_efforts()
        .into_iter()
        .map(WorkerEffort::as_str)
        .collect()
}

/// Pure JSON projection used by the command and by parity tests.  It contains
/// provider metadata only, never the supplied catalog body or credentials.
fn eligible_models_value(catalog: &VexzyModelCatalog) -> serde_json::Value {
    let models = eligible_worker_models(catalog)
        .into_iter()
        .map(|model| {
            json!({
                "id": model.id,
                "allowedEfforts": allowed_effort_names(model),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "provider": "vexzy",
        "models": models,
    })
}

fn eligible_models_output(catalog_input: &str) -> Result<serde_json::Value, &'static str> {
    let catalog = parse_supplied_catalog(catalog_input)?;
    Ok(eligible_models_value(&catalog))
}

fn parse_worker_lock(value: Option<&str>) -> Result<Option<WorkerEffort>, &'static str> {
    match value {
        None | Some("off") => Ok(None),
        Some(value) => value
            .parse::<WorkerEffort>()
            .map(Some)
            .map_err(|_| "Worker effort lock must be none, low, medium, high, xhigh, max, or off"),
    }
}

/// Validate a selected Worker model exactly as it appears in the supplied
/// catalog.  The value does not alter global state; persistence is a later
/// migration package.
fn worker_effort_value(
    catalog: &VexzyModelCatalog,
    model_id: &str,
    lock: Option<&str>,
) -> Result<serde_json::Value, &'static str> {
    let model = eligible_worker_models(catalog)
        .into_iter()
        .find(|candidate| candidate.id == model_id)
        .ok_or("selected Worker model is absent or ineligible")?;
    let lock = parse_worker_lock(lock)?;
    if let Some(lock) = lock {
        if !model.supports_worker_effort(lock) {
            return Err("selected Worker model does not support the requested effort lock");
        }
    }

    Ok(json!({
        "provider": "vexzy",
        "model": model.id,
        "allowedEfforts": allowed_effort_names(model),
        "workerEffortLock": lock.map(WorkerEffort::as_str),
    }))
}

fn worker_effort_output(
    catalog_input: &str,
    model_id: &str,
    lock: Option<&str>,
) -> Result<serde_json::Value, &'static str> {
    let catalog = parse_supplied_catalog(catalog_input)?;
    worker_effort_value(&catalog, model_id, lock)
}

fn setup_token_text() -> String {
    "MindCode resolves each provider credential environment-first, then from\nthe on-disk secret store (~/.config/mindcode/credentials.json).\n\nThe built-in VEXZY profile uses the VEXZY_API_KEY environment variable:\n  export VEXZY_API_KEY=\"forge-…\"\n\nCustom providers store their key in the secret store instead; manage\nproviders and keys with `mindcode provider` and `mindcode settings key`.\n\nThe legacy OAuth setup flow is not used by MindCode."
        .to_owned()
}

fn run_setup_token(arguments: Vec<OsString>) -> Result<i32> {
    if let Err(error) =
        SetupTokenArgs::try_parse_from(with_command_program_name(arguments, "mindcode setup-token"))
    {
        return Ok(print_clap_error(error));
    }
    println!("{}", setup_token_text());
    Ok(0)
}

fn doctor_text() -> String {
    let configured = current_api_key().is_some();
    format!(
        "MindCode native doctor\n{API_KEY_ENV}: {}\nAuthentication: multi-provider (env -> secret store, fail-closed)\nDaemon: available (in-process mindcoded::Daemon)\nChat runtime: live (mindcode-transport, both protocols)",
        if configured {
            "configured"
        } else {
            "not configured"
        }
    )
}

fn run_doctor(arguments: Vec<OsString>) -> Result<i32> {
    if let Err(error) =
        DoctorArgs::try_parse_from(with_command_program_name(arguments, "mindcode doctor"))
    {
        return Ok(print_clap_error(error));
    }
    println!("{}", doctor_text());
    Ok(0)
}

fn update_text() -> String {
    format!(
        "Current version: {VERSION}\nMindCode uses the local Git checkout for updates; no remote updater is configured.\nApply changes in the local MindCode repository, then rebuild the local bundle."
    )
}

fn run_update(arguments: Vec<OsString>) -> Result<i32> {
    if let Err(error) =
        UpdateArgs::try_parse_from(with_command_program_name(arguments, "mindcode update"))
    {
        return Ok(print_clap_error(error));
    }
    println!("{}", update_text());
    Ok(0)
}

async fn run_daemon(arguments: Vec<OsString>) -> Result<i32> {
    let args =
        match DaemonArgs::try_parse_from(with_command_program_name(arguments, "mindcode daemon")) {
            Ok(args) => args,
            Err(error) => return Ok(print_clap_error(error)),
        };
    Daemon::new(DaemonConfig {
        socket: args.socket,
        state_dir: args.state_dir,
        idle_seconds: Some(args.idle_seconds),
        handshake_timeout: Duration::from_secs(args.handshake_timeout_seconds),
        build_id: args.build_id,
    })
    .run()
    .await
    .context("native daemon exited with an error")?;
    Ok(0)
}

const DEFAULT_TUI_SESSION_ID: &str = "tui";

/// Runtime directory shared with the daemon (`~/.mindcode/run`).
fn tui_runtime_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".mindcode/run")
}

fn tui_socket_path(session_id: &str) -> PathBuf {
    tui_runtime_dir().join(format!("native-tui-{session_id}.sock"))
}

/// Map the persisted profiles to a secret-free provider snapshot: the
/// credential is represented only by its reference kind, never its value, and
/// the selectable model ids are metadata only.
fn providers_input(settings: &NativeSettings) -> Vec<ProviderInput> {
    let active = settings.active_provider.as_ref();
    settings
        .providers()
        .iter()
        .map(|provider| ProviderInput {
            id: provider.id.to_string(),
            name: provider.name.clone(),
            protocol: provider.protocol.to_string(),
            base_url: provider.base_url.clone(),
            active: Some(active == Some(&provider.id)),
            credential: Some(credential_ref_kind(provider)),
            configured: Some(provider_credential_configured(provider)),
            allowlist: provider_allowlist_input(provider),
        })
        .collect()
}

/// The model ids the profile offers for interactive selection.  Custom
/// profiles expose their allowlist verbatim; the built-in VEXZY profile is
/// catalog-driven, so an empty allowlist surfaces the documented fallback
/// model rather than an empty picker.
fn provider_allowlist_input(provider: &ProviderConfig) -> Vec<String> {
    let mut models: Vec<String> = provider.allowlist.iter().map(ModelId::to_string).collect();
    if models.is_empty() && provider.id.as_str() == mindcode_settings::BUILTIN_VEXZY_PROVIDER_ID {
        models.push("gpt-5.6-luna".to_owned());
    }
    models
}

/// Secret-free "is this profile usable right now" check: env → store →
/// fail-closed.  The resolved value is never retained or projected.
fn provider_credential_configured(provider: &ProviderConfig) -> bool {
    let Ok(path) = native_store_path() else {
        return false;
    };
    let Ok(store) = load_store(&path) else {
        return false;
    };
    store
        .resolve(&provider.credential, |name| env::var(name).ok())
        .is_ok()
}

/// Secret-free credential source for `/status` (§12.3): `env`, `store`, or
/// `missing`. The credential value is never read into this string.
fn credential_source(provider: &ProviderConfig) -> &'static str {
    let name = provider.credential.name();
    if env::var(name).map(|value| !value.is_empty()).unwrap_or(false) {
        return "env";
    }
    match native_store_path().ok().and_then(|path| load_store(&path).ok()) {
        Some(store) if store.resolve(&provider.credential, |_| None).is_ok() => "store",
        _ => "missing",
    }
}

/// The onboarding state (§12.4) derivable without a network call: `Present`
/// when a credential resolves, otherwise `Absent`. `Verified`/`Stale`/
/// `Rejected` require a provider round-trip and are folded in by the transport
/// error path.
fn credential_state(provider: &ProviderConfig) -> CredState {
    if provider_credential_configured(provider) {
        CredState::Present
    } else {
        CredState::Absent
    }
}

/// Secret-free `/status` transcript line (§12.3): session usage, cost, and the
/// active provider's credential source + context budget. No credential value.
fn status_line(stats: &SessionStats) -> String {
    let settings = load_native_settings().ok();
    let provider = settings
        .as_ref()
        .and_then(|settings| settings.active_provider_config())
        .cloned();
    let budget = settings
        .as_ref()
        .and_then(|settings| settings.context_token_budget)
        .map(|budget| budget.to_string())
        .unwrap_or_else(|| "200000".to_owned());
    let mut lines = vec![
        format!(
            "session: {} in · {} out tokens",
            stats.input_tokens, stats.output_tokens
        ),
        format!("cost: ${:.4} (saved ${:.4})", stats.cost, stats.savings),
        format!("context budget: {budget} tokens (base 200000)"),
    ];
    match provider {
        Some(provider) => lines.push(format!(
            "provider: {} ({} · {} · credential: {}/{})",
            provider.id,
            provider.protocol,
            provider.base_url,
            credential_source(&provider),
            credential_state(&provider).as_str(),
        )),
        None => lines.push("provider: none configured".to_owned()),
    }
    lines.join("\n")
}

/// Effective `/colors` palette (§11.6): the frozen default merged with any
/// secret-free `color_overrides` from settings.
fn effective_palette(settings: &NativeSettings) -> PaletteSpec {
    let mut palette = default_graphite_sakura();
    if let Some(overrides) = &settings.color_overrides {
        for (label, hex) in overrides {
            let (Some(role), Ok(color)) = (Role::from_label(label), Rgb::from_hex(hex)) else {
                continue;
            };
            palette = palette.with_override(role, color);
        }
    }
    palette
}

/// `/colors` command (§11.6): `list` | `set <role> <#rrggbb>` | `generate
/// <#rrggbb>` | `harmony` | `export` | `reset`.  All output is secret-free;
/// overrides are metadata stored in `settings.json`.
fn colors_command(argument: &str) -> Result<String> {
    let mut tokens = argument.split_whitespace();
    let sub = tokens.next().unwrap_or("list");
    let mut settings = load_native_settings()?;
    match sub {
        "list" => {
            let palette = effective_palette(&settings);
            let mut lines = vec!["palette roles:".to_owned()];
            for role in Role::ALL {
                lines.push(format!("  {:<15} {}", role.label(), palette.color(role).to_hex()));
            }
            Ok(lines.join("\n"))
        }
        "generate" => {
            let Some(hex) = tokens.next() else {
                return Err(anyhow!("usage: /colors generate <#rrggbb>"));
            };
            let seed = Rgb::from_hex(hex).map_err(anyhow::Error::msg)?;
            let palette = generate_palette(seed);
            let report = score_palette(&palette);
            let mut lines = vec![format!("generated from {}:", seed.to_hex()), palette.to_toml()];
            lines.push(format!(
                "harmony: {:.3} (readability {:.2}, distinctness {:.2}, colourblind {:.2})",
                report.score, report.readability, report.distinctness, report.colourblind
            ));
            Ok(lines.join("\n"))
        }
        "harmony" => {
            let palette = effective_palette(&settings);
            let report = score_palette(&palette);
            Ok(format!(
                "harmony {:.3}: readability {:.2} · distinctness {:.2} · hue {:.2} · chroma {:.2} · colourblind {:.2}",
                report.score,
                report.readability,
                report.distinctness,
                report.hue_harmony,
                report.chroma_coherence,
                report.colourblind,
            ))
        }
        "export" => Ok(effective_palette(&settings).to_toml()),
        "reset" => {
            settings.color_overrides = None;
            save_native_settings(&settings)?;
            Ok("palette reset to the default".to_owned())
        }
        "set" => {
            let Some(label) = tokens.next() else {
                return Err(anyhow!("usage: /colors set <role> <#rrggbb>"));
            };
            let Some(hex) = tokens.next() else {
                return Err(anyhow!("usage: /colors set <role> <#rrggbb>"));
            };
            let role = Role::from_label(label).ok_or_else(|| anyhow!("unknown role '{label}'"))?;
            let color = Rgb::from_hex(hex).map_err(anyhow::Error::msg)?;
            settings
                .color_overrides
                .get_or_insert_with(Default::default)
                .insert(role.label().to_owned(), color.to_hex());
            save_native_settings(&settings)?;
            Ok(format!("{} set to {}", role.label(), color.to_hex()))
        }
        other => Err(anyhow!(
            "unknown /colors subcommand '{other}' (list|set|generate|harmony|export|reset)"
        )),
    }
}

/// `/debug-visual` frame dump (§11.8): record the current transcript as one
/// sanitized frame into `~/.config/mindcode/debug/frames-<session>.jsonl` and
/// report the path.  The file is only created when the command runs.
fn debug_visual_dump(session_id: &str, transcript: &TuiTranscript) -> Result<String> {
    let dir = sessions_dir()?.parent().map(Path::to_path_buf).ok_or_else(|| {
        anyhow!("MindCode config home is unavailable")
    })?;
    let path = dir.join("debug").join(format!("frames-{session_id}.jsonl"));
    let render_text = transcript
        .entries
        .iter()
        .filter_map(|entry| match entry {
            TranscriptInput::Entry { role, text, .. } => {
                Some(format!("{}: {}", role, text.trim_end()))
            }
            TranscriptInput::Block(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut recorder = FrameRecorder::new(100);
    recorder.record(FrameDump {
        frame_id: 0,
        timestamp_ms: now_unix_millis(),
        terminal_size: None,
        render_text: sanitize_frame_text(&render_text),
        state: serde_json::json!({ "session_id": session_id, "entries": transcript.entries.len() }),
        timing_ms: 0,
        anomalies: Vec::new(),
    });
    recorder.write_jsonl(&path).map_err(anyhow::Error::msg)?;
    Ok(format!("frame dump appended: {}", path.display()))
}

fn now_unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Secret-free initial snapshot published once on start so the renderer has
/// state to show before any live session data exists.
fn tui_initial_input() -> ProjectionInput {
    let settings = load_native_settings().ok();
    ProjectionInput {
        status: StatusInput {
            state: Some("ready".to_owned()),
            ..Default::default()
        },
        telemetry: TelemetryInput {
            model: settings
                .as_ref()
                .and_then(|s| s.global_worker_model.clone()),
            effort: settings
                .as_ref()
                .and_then(|s| s.worker_effort_lock)
                .map(|effort| effort.to_string()),
            connection: ConnectionInput {
                state: Some("connected".to_owned()),
                ..Default::default()
            },
            ..Default::default()
        },
        providers: settings.as_ref().map(providers_input).unwrap_or_default(),
        // The native TUI is a single in-process client and is always the
        // writer; marking it `observer` (the projection default) would render
        // the composer read-only.
        writer: WriterInput {
            mode: Some("writer".to_owned()),
            ..Default::default()
        },
        ..Default::default()
    }
}

async fn run_tui(arguments: Vec<OsString>) -> Result<i32> {
    let args = match TuiArgs::try_parse_from(with_command_program_name(arguments, "mindcode tui")) {
        Ok(args) => args,
        Err(error) => return Ok(print_clap_error(error)),
    };
    let session_id = args
        .session_id
        .unwrap_or_else(|| DEFAULT_TUI_SESSION_ID.to_owned());
    if session_id.is_empty()
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(anyhow!(
            "tui session id must contain only ASCII path-safe characters"
        ));
    }
    let socket_path = tui_socket_path(&session_id);

    // The renderer is a dumb client: provider setup actions arrive as input
    // events, this channel hands them to a task that mutates settings and
    // republishes a fresh snapshot.
    let (action_tx, mut action_rx) = tokio::sync::mpsc::unbounded_channel::<UiActionInput>();
    let handler: InputHandler = Arc::new(move |message| {
        if let UiMessage::InputEvent {
            event: UiInputEventKind::Action(action),
            ..
        } = message
        {
            let _ = action_tx.send(action);
        }
    });

    let server = ControlServer::new(
        ControlServerConfig::new(session_id.clone(), &socket_path),
        Some(handler),
    )
    .map_err(anyhow::Error::msg)?;
    server.start().await.map_err(anyhow::Error::msg)?;
    // Resume the conversation from disk if a session file exists (§10.1);
    // an empty conversation falls back to the start hint.  Token/cost
    // counters resume too (§10.3) and are shared between the processor and
    // the mid-stream republish closure.
    let (mut transcript, loaded_stats) = load_session(&session_id);
    let stats = Arc::new(std::sync::Mutex::new(loaded_stats));
    let initial_stats = *stats.lock().unwrap();
    let _ = server
        .publish(&tui_snapshot(&transcript.entries, initial_stats, &[]))
        .await;

    let processor_server = server.clone();
    let processor_session_id = session_id.clone();
    let processor_stats = stats.clone();
    // Shared approval registry: worker agents register a permission request
    // here and the processor loop publishes it + forwards the user's decision.
    let pending: Arc<Mutex<PendingApprovals>> = Arc::new(Mutex::new(PendingApprovals::default()));
    // Worker events: a worker finished, or a worker asked for permission and
    // the processor must republish the snapshot with the pending request.
    let (worker_event_tx, mut worker_event_rx) = mpsc::unbounded_channel::<WorkerEvent>();
    let worker_pool = WorkerPool::with_defaults(DEFAULT_MAX_CONCURRENT)
        .map_err(|error| anyhow!(error.to_string()))?;
    let processor = tokio::spawn(async move {
        // Session-scoped worker permission tier (§10.4.2); default is the
        // safest (ask-everything) and it resets on every TUI launch.
        let mut tier = PermissionTier::default();
        loop {
            tokio::select! {
                Some(action) = action_rx.recv() => {
                    if action.action == "permission_decision" {
                        let decision = match action.value.as_deref() {
                            Some("once") => ApprovalDecision::AllowOnce,
                            Some("project") => ApprovalDecision::AllowWorker,
                            _ => ApprovalDecision::Deny,
                        };
                        if let Some(id) = action.target.as_deref() {
                            if let Some(request) = pending.lock().unwrap().requests.remove(id) {
                                let _ = request.sender.send(decision);
                            }
                        }
                        let current = *processor_stats.lock().unwrap();
                        let permissions = pending_permission_inputs(&pending);
                        let _ = processor_server
                            .publish(&tui_snapshot(&transcript.entries, current, &permissions))
                            .await;
                        continue;
                    }
                    if action.action == "composer_submit" {
                        let Some(text) = action.value else { continue };
                        // `/work` spawns a worker agent and returns immediately;
                        // it needs the server + approval registry, so it is
                        // handled here rather than in the generic dispatcher.
                        // `/status` shows session usage + provider credential
                        // status (§12.3); handled here for access to the stats.
                        if let Some(("status", _)) = slash_command(&text) {
                            let current = *processor_stats.lock().unwrap();
                            transcript.push("system", status_line(&current));
                            let current = *processor_stats.lock().unwrap();
                            let permissions = pending_permission_inputs(&pending);
                            let _ = processor_server
                                .publish(&tui_snapshot(&transcript.entries, current, &permissions))
                                .await;
                            continue;
                        }
                        // `/debug-visual` dumps the current transcript as a
                        // sanitized frame for offline visual debugging (§11.8).
                        if let Some(("debug-visual", _)) = slash_command(&text) {
                            let message = match debug_visual_dump(&processor_session_id, &transcript) {
                                Ok(ok) => ok,
                                Err(error) => format!("debug dump failed: {error:#}"),
                            };
                            transcript.push("system", message);
                            let current = *processor_stats.lock().unwrap();
                            let permissions = pending_permission_inputs(&pending);
                            let _ = processor_server
                                .publish(&tui_snapshot(&transcript.entries, current, &permissions))
                                .await;
                            continue;
                        }
                        if let Some(("work", task)) = slash_command(&text) {
                            if task.is_empty() {
                                transcript.push("system", "usage: /work <task>");
                            } else {
                                match spawn_worker(
                                    task,
                                    tier,
                                    pending.clone(),
                                    worker_event_tx.clone(),
                                    worker_pool.clone(),
                                ) {
                                    Ok(message) => transcript.push("system", message),
                                    Err(error) => {
                                        transcript.push("system", format!("error: {error:#}"))
                                    }
                                }
                            }
                            let current = *processor_stats.lock().unwrap();
                            let permissions = pending_permission_inputs(&pending);
                            let _ = processor_server
                                .publish(&tui_snapshot(&transcript.entries, current, &permissions))
                                .await;
                            continue;
                        }
                        // Republish a fresh snapshot as the assistant turn streams so
                        // tokens appear incrementally, throttled so the socket is not
                        // flooded on every delta.
                        let republish = {
                            let server = processor_server.clone();
                            let stats = processor_stats.clone();
                            let pending = pending.clone();
                            let mut last_publish = Instant::now() - STREAM_REPUBLISH_INTERVAL;
                            move |transcript: &TuiTranscript| {
                                let now = Instant::now();
                                if now.duration_since(last_publish) >= STREAM_REPUBLISH_INTERVAL {
                                    last_publish = now;
                                    // Fire-and-forget: the projection revision is
                                    // monotonic, so the client drops any intermediate
                                    // snapshot that lands after the final one.
                                    let current = *stats.lock().unwrap();
                                    let permissions = pending_permission_inputs(&pending);
                                    let snapshot = tui_streaming_snapshot(
                                        &transcript.entries,
                                        current,
                                        &permissions,
                                    );
                                    let server = server.clone();
                                    tokio::spawn(async move {
                                        let _ = server.publish(&snapshot).await;
                                    });
                                }
                            }
                        };
                        let outcome =
                            dispatch_tui_input_streaming(&text, &mut transcript, republish, &mut tier)
                                .await;
                        match outcome {
                            Ok((true, Some(turn))) => {
                                processor_stats.lock().unwrap().record(&turn);
                                let current = *processor_stats.lock().unwrap();
                                let permissions = pending_permission_inputs(&pending);
                                let _ = processor_server
                                    .publish(&tui_snapshot(&transcript.entries, current, &permissions))
                                    .await;
                                let _ = save_session(&processor_session_id, &transcript, current);
                            }
                            Ok((true, None)) => {
                                let current = *processor_stats.lock().unwrap();
                                let permissions = pending_permission_inputs(&pending);
                                let _ = processor_server
                                    .publish(&tui_snapshot(&transcript.entries, current, &permissions))
                                    .await;
                                let _ = save_session(&processor_session_id, &transcript, current);
                            }
                            Ok((false, _)) => {}
                            Err(error) => {
                                transcript.push("system", format!("error: {error:#}"));
                                let current = *processor_stats.lock().unwrap();
                                let permissions = pending_permission_inputs(&pending);
                                let _ = processor_server
                                    .publish(&tui_snapshot(&transcript.entries, current, &permissions))
                                    .await;
                                let _ = save_session(&processor_session_id, &transcript, current);
                            }
                        }
                        continue;
                    }
                    match apply_tui_action(&action) {
                        Ok(true) => {
                            let current = *processor_stats.lock().unwrap();
                            let permissions = pending_permission_inputs(&pending);
                            let _ = processor_server
                                .publish(&tui_snapshot(&transcript.entries, current, &permissions))
                                .await;
                        }
                        Ok(false) => {}
                        Err(error) => eprintln!("mindcode: {error:#}"),
                    }
                }
                Some(event) = worker_event_rx.recv() => {
                    if let WorkerEvent::Finished(report) = event {
                        processor_stats.lock().unwrap().record_worker(&report.usage);
                        transcript.push("system", worker_report_text(&report));
                        let current = *processor_stats.lock().unwrap();
                        let _ = save_session(&processor_session_id, &transcript, current);
                    }
                    let current = *processor_stats.lock().unwrap();
                    let permissions = pending_permission_inputs(&pending);
                    let _ = processor_server
                        .publish(&tui_snapshot(&transcript.entries, current, &permissions))
                        .await;
                }
                else => break,
            }
        }
    });

    let tui_config = TuiConfig {
        control_socket: socket_path,
        session_id,
    };
    let outcome = tokio::task::spawn_blocking(move || mindcode_tui::run(tui_config)).await;
    server.close().await;
    processor.abort();
    match outcome {
        Ok(Ok(())) => Ok(0),
        Ok(Err(error)) => {
            eprintln!("mindcode: {error}");
            Ok(1)
        }
        Err(error) => {
            eprintln!("mindcode: {error}");
            Ok(1)
        }
    }
}

/// In-memory TUI conversation state: the transcript republished on every turn.
#[derive(Default)]
struct TuiTranscript {
    entries: Vec<TranscriptInput>,
    next_sequence: u64,
}

impl TuiTranscript {
    fn push(&mut self, role: &str, text: impl Into<String>) {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.entries.push(TranscriptInput::Entry {
            sequence,
            role: role.to_owned(),
            text: text.into(),
        });
    }

    /// Append a streamed delta to the most recent entry (the in-progress
    /// assistant turn), leaving a `Block` entry untouched.
    fn append_last(&mut self, text: &str) {
        let Some(TranscriptInput::Entry { text: current, .. }) = self.entries.last_mut() else {
            return;
        };
        current.push_str(text);
    }

    /// Replace the most recent entry's role and text (used to finalize an
    /// assistant turn as a `system` line on empty/error, keeping it out of
    /// the dialog history sent back to the provider).
    fn finish_last(&mut self, role: &str, text: impl Into<String>) {
        let Some(TranscriptInput::Entry {
            role: current_role,
            text: current_text,
            ..
        }) = self.entries.last_mut()
        else {
            return;
        };
        *current_role = role.to_owned();
        *current_text = text.into();
    }
}

/// The transcript entry shown on a fresh dashboard, before the first turn.
fn tui_hint() -> TranscriptInput {
    TranscriptInput::Entry {
        sequence: 0,
        role: "system".to_owned(),
        text:
            "MindCode 0.1.3 — type a message to chat, /help for commands, Ctrl+P for provider setup"
                .to_owned(),
    }
}

/// Build a republish snapshot from a fresh settings read (so `/model`,
/// `/effort` and `/provider use` changes surface immediately) carrying the
/// current conversation transcript.  An empty conversation keeps the start
/// hint so the dashboard never opens blank.
fn tui_snapshot(
    transcript: &[TranscriptInput],
    stats: SessionStats,
    permissions: &[PermissionInput],
) -> ProjectionInput {
    let mut input = tui_initial_input();
    input.transcript = if transcript.is_empty() {
        vec![tui_hint()]
    } else {
        transcript.to_vec()
    };
    input.telemetry.input_tokens = Some(stats.input_tokens);
    input.telemetry.output_tokens = Some(stats.output_tokens);
    input.telemetry.credits = Some(stats.cost);
    input.telemetry.last_input_tokens = Some(stats.last_input_tokens);
    input.telemetry.last_output_tokens = Some(stats.last_output_tokens);
    input.telemetry.last_cost = Some(stats.last_cost);
    input.telemetry.last_savings = Some(stats.last_savings);
    input.telemetry.savings = Some(stats.savings);
    input.permissions = permissions.to_vec();
    input
}

/// A snapshot published mid-stream: the last assistant turn is marked
/// `streaming` so the renderer shows the shimmer + cursor (§10.2).
fn tui_streaming_snapshot(
    transcript: &[TranscriptInput],
    stats: SessionStats,
    permissions: &[PermissionInput],
) -> ProjectionInput {
    let mut input = tui_snapshot(transcript, stats, permissions);
    input.streaming = true;
    input
}

/// Directory holding persisted TUI conversations (§10.1).
fn sessions_dir() -> Result<PathBuf, anyhow::Error> {
    let settings_path = native_settings_path()?;
    settings_path
        .parent()
        .map(|parent| parent.join("sessions"))
        .ok_or_else(|| anyhow!("MindCode config home is unavailable"))
}

fn session_path(session_id: &str) -> Result<PathBuf, anyhow::Error> {
    Ok(sessions_dir()?.join(format!("{session_id}.json")))
}

/// Persist the dialog (user/assistant turns only, secret-free) for one TUI
/// session id (§10.1).  Never writes a credential; the file is plain
/// conversation text.
fn save_session(
    session_id: &str,
    transcript: &TuiTranscript,
    stats: SessionStats,
) -> Result<(), anyhow::Error> {
    let path = session_path(session_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let messages: Vec<serde_json::Value> = transcript
        .entries
        .iter()
        .filter_map(|entry| match entry {
            TranscriptInput::Entry { role, text, .. }
                if (role == "user" || role == "assistant") && !text.trim().is_empty() =>
            {
                Some(serde_json::json!({ "role": role, "text": text }))
            }
            _ => None,
        })
        .collect();
    let message_count = messages.len();
    let now = now_unix_seconds();
    let created_at = existing_created_at(&path).unwrap_or(now);
    let title = session_title_from_transcript(session_id, transcript);
    let value = serde_json::json!({
        "id": session_id,
        // Auto-name from the first user prompt (§11.2); metadata only, no
        // message text is duplicated outside `messages`.
        "title": title,
        "created_at": created_at,
        "updated_at": now,
        "messages": messages,
        // Secret-free counters so a resumed session keeps its running totals
        // (§10.3); the per-turn `last_*` values are transient and not stored.
        "usage": {
            "input_tokens": stats.input_tokens,
            "output_tokens": stats.output_tokens,
            "cost": stats.cost,
            "savings": stats.savings,
        },
    });
    fs::write(&path, serde_json::to_vec_pretty(&value)?)?;
    update_session_index(session_id, &title, created_at, now, message_count)?;
    Ok(())
}

/// Load a persisted TUI conversation and its token/cost counters; an absent
/// or malformed file yields an empty transcript and zeroed counters (fail
/// open for display; credentials never involved).
fn load_session(session_id: &str) -> (TuiTranscript, SessionStats) {
    let mut transcript = TuiTranscript::default();
    let mut stats = SessionStats::default();
    let Ok(path) = session_path(session_id) else {
        return (transcript, stats);
    };
    let Ok(raw) = fs::read(&path) else {
        return (transcript, stats);
    };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_slice::<serde_json::Value>(&raw)
    else {
        return (transcript, stats);
    };
    if let Some(serde_json::Value::Object(usage)) = map.get("usage") {
        stats.input_tokens = usage
            .get("input_tokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        stats.output_tokens = usage
            .get("output_tokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        stats.cost = usage
            .get("cost")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        stats.savings = usage
            .get("savings")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
    }
    let Some(serde_json::Value::Array(messages)) = map.get("messages") else {
        return (transcript, stats);
    };
    for message in messages {
        let (Some(serde_json::Value::String(role)), Some(serde_json::Value::String(text))) =
            (message.get("role"), message.get("text"))
        else {
            continue;
        };
        if (role == "user" || role == "assistant") && !text.trim().is_empty() {
            transcript.push(role, text);
        }
    }
    (transcript, stats)
}

fn now_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn existing_created_at(path: &Path) -> Option<u64> {
    let raw = fs::read(path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    value.get("created_at").and_then(serde_json::Value::as_u64)
}

/// Auto-name for a session (§11.2): the first user prompt trimmed to 60 chars,
/// or a stable `session-<id>` fallback when there is no user turn yet.
fn session_title_from_transcript(session_id: &str, transcript: &TuiTranscript) -> String {
    for entry in &transcript.entries {
        if let TranscriptInput::Entry { role, text, .. } = entry {
            if role == "user" && !text.trim().is_empty() {
                let trimmed = text.trim();
                let mut title: String = trimmed.chars().take(60).collect();
                if trimmed.chars().count() > 60 {
                    title.push('…');
                }
                return title;
            }
        }
    }
    format!("session-{session_id}")
}

/// Maintain the secret-free session index (`sessions/index.json`, §11.2): one
/// metadata row per session, no message text and no credentials.
fn update_session_index(
    session_id: &str,
    title: &str,
    created_at: u64,
    updated_at: u64,
    message_count: usize,
) -> Result<(), anyhow::Error> {
    let dir = sessions_dir()?;
    fs::create_dir_all(&dir)?;
    let path = dir.join("index.json");
    let mut entries: Vec<serde_json::Value> = match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let provider_id = load_native_settings()
        .ok()
        .and_then(|settings| settings.active_provider)
        .map(|id| id.to_string());
    entries.retain(|entry| {
        entry.get("id").and_then(serde_json::Value::as_str) != Some(session_id)
    });
    entries.push(serde_json::json!({
        "id": session_id,
        "title": title,
        "provider_id": provider_id,
        "created_at": created_at,
        "updated_at": updated_at,
        "message_count": message_count,
    }));
    entries.sort_by(|a, b| {
        let a = a.get("updated_at").and_then(serde_json::Value::as_u64).unwrap_or(0);
        let b = b.get("updated_at").and_then(serde_json::Value::as_u64).unwrap_or(0);
        b.cmp(&a)
    });
    fs::write(&path, serde_json::to_vec_pretty(&entries)?)?;
    Ok(())
}

/// Render the session index as a `/sessions` transcript list (§11.2).
fn sessions_index_summary() -> Result<Option<String>, anyhow::Error> {
    let path = sessions_dir()?.join("index.json");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return Ok(None),
    };
    let entries: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap_or_default();
    if entries.is_empty() {
        return Ok(None);
    }
    let lines = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(serde_json::Value::as_str)?;
            let title = entry
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(id);
            let count = entry
                .get("message_count")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            Some(format!("- {title} [{id}] ({count} messages)"))
        })
        .collect::<Vec<_>>();
    Ok(Some(format!("sessions:\n{}", lines.join("\n"))))
}

const TUI_HELP: &str = "\
Commands (type and press Enter):
  <text>                chat with the active provider
  /chat <text>          same as typing text directly
  /model                pick a model from the active provider's list
  /model <id>           set the global Worker model directly
  /effort               pick the effort lock (none|low|medium|high|xhigh|max)
  /effort <level>|off   set the effort lock directly, or clear it with off
  /provider             list provider profiles (* = active)
  /provider use <id>    switch the active provider
  /provider remove <id> remove a provider profile
  /allowlist <id> <m,…> set a profile's Worker model allowlist (empty clears)
  /settings             open the settings popup
  /permissions [<tier>] show or set worker access (ask-everything|workspace|full-access)
  /work <task>          run a task with a worker agent (asks before risky tools)
  /status               show session usage and provider status
  /auth                 show active provider auth status
  /eligible             show eligible Worker models of the active provider
  /doctor               native health check
  /setup-token          credential setup instructions
  /update               update instructions
  /sessions             list saved sessions (auto-named)
  /colors <sub>          list/set/generate/harmony/export/reset palette
  /terminal-setup       diagnose Shift+Enter / kitty keyboard support
  /debug-visual         dump a sanitized frame for offline visual debugging
  /help                 show this help
  Ctrl+P                provider setup screen (add / remove / switch)";

/// Route one composer submission.  A leading `/` is a slash command, anything
/// else is a live chat turn through the active provider.  Returns `Ok(true)`
/// when the snapshot must be republished (a transcript entry was added or
/// settings changed); the credential value never enters the transcript.
#[cfg(test)]
async fn dispatch_tui_input(text: &str, transcript: &mut TuiTranscript) -> Result<bool> {
    let mut tier = PermissionTier::default();
    dispatch_tui_input_streaming(text, transcript, |_| {}, &mut tier)
        .await
        .map(|(republish, _)| republish)
}

/// Like [`dispatch_tui_input`], but republishes through `on_progress` while a
/// live chat turn streams, so the renderer can show tokens as they arrive.
/// Returns `(republish, outcome)`: the outcome is present only for a
/// successful live chat turn so the caller can record token usage (§10.3).
async fn dispatch_tui_input_streaming(
    text: &str,
    transcript: &mut TuiTranscript,
    mut on_progress: impl FnMut(&TuiTranscript),
    tier: &mut PermissionTier,
) -> Result<(bool, Option<ChatOutcome>)> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok((false, None));
    }
    let Some(rest) = trimmed.strip_prefix('/') else {
        let outcome = chat_tui_turn(trimmed, transcript, &mut on_progress).await?;
        return Ok((true, outcome));
    };
    let mut tokens = rest.splitn(2, char::is_whitespace);
    let command = tokens.next().unwrap_or("").trim();
    let argument = tokens.next().map(str::trim).unwrap_or("");
    match command {
        "help" => {
            transcript.push("system", TUI_HELP);
            Ok((true, None))
        }
        "sessions" => {
            let message = match sessions_index_summary() {
                Ok(Some(text)) => text,
                Ok(None) => "no sessions found (type a message to start one)".to_owned(),
                Err(error) => format!("sessions unavailable: {error:#}"),
            };
            transcript.push("system", message);
            Ok((true, None))
        }
        "colors" => {
            let message = colors_command(argument)?;
            transcript.push("system", message);
            Ok((true, None))
        }
        "terminal-setup" => {
            let probe = TerminalProbe::from_env();
            transcript.push("system", terminal_setup_report(&probe));
            Ok((true, None))
        }
        "model" => {
            let mut settings = load_native_settings()?;
            let message = if argument.is_empty() {
                match &settings.global_worker_model {
                    Some(model) => format!("worker model: {model}"),
                    None => "worker model: not set (first allowlist entry is used)".to_owned(),
                }
            } else {
                settings.global_worker_model = Some(argument.to_owned());
                save_native_settings(&settings)?;
                format!("worker model set to {argument}")
            };
            transcript.push("system", message);
            Ok((true, None))
        }
        "effort" => {
            let mut settings = load_native_settings()?;
            let message = if argument.is_empty() {
                match settings.worker_effort_lock {
                    Some(effort) => format!("worker effort lock: {}", effort.as_str()),
                    None => "worker effort lock: off".to_owned(),
                }
            } else if argument == "off" {
                settings.worker_effort_lock = None;
                save_native_settings(&settings)?;
                "worker effort lock cleared".to_owned()
            } else {
                let effort: WorkerEffort = argument.parse().map_err(|_| {
                    anyhow!(
                        "invalid effort level '{argument}'; expected none|low|medium|high|xhigh|max"
                    )
                })?;
                settings.worker_effort_lock = Some(effort);
                save_native_settings(&settings)?;
                format!("worker effort lock set to {}", effort.as_str())
            };
            transcript.push("system", message);
            Ok((true, None))
        }
        "permissions" => {
            let message = if argument.is_empty() {
                format!("permission tier: {tier} (ask-everything|workspace|full-access)")
            } else {
                *tier = argument
                    .parse::<PermissionTier>()
                    .map_err(anyhow::Error::msg)?;
                format!("permission tier set to {tier}")
            };
            transcript.push("system", message);
            Ok((true, None))
        }
        "provider" => {
            let mut sub_tokens = argument.splitn(2, char::is_whitespace);
            let sub = sub_tokens.next().unwrap_or("").trim();
            match sub {
                "use" => {
                    let id = sub_tokens.next().map(str::trim).unwrap_or("");
                    if id.is_empty() {
                        return Err(anyhow!("usage: /provider use <id>"));
                    }
                    let mut settings = load_native_settings()?;
                    let provider_id = ProviderId::new(id.to_owned()).map_err(anyhow::Error::msg)?;
                    settings
                        .set_active_provider(&provider_id)
                        .map_err(anyhow::Error::msg)?;
                    save_native_settings(&settings)?;
                    transcript.push("system", format!("active provider: {id}"));
                }
                "remove" => {
                    let id = sub_tokens.next().map(str::trim).unwrap_or("");
                    if id.is_empty() {
                        return Err(anyhow!("usage: /provider remove <id>"));
                    }
                    let mut settings = load_native_settings()?;
                    let provider_id = ProviderId::new(id.to_owned()).map_err(anyhow::Error::msg)?;
                    settings
                        .remove_provider(&provider_id)
                        .map_err(anyhow::Error::msg)?;
                    save_native_settings(&settings)?;
                    transcript.push("system", format!("removed provider: {id}"));
                }
                "" => {
                    let settings = load_native_settings()?;
                    let mut lines = Vec::new();
                    for provider in settings.providers() {
                        let marker = if settings.active_provider.as_ref() == Some(&provider.id) {
                            "*"
                        } else {
                            " "
                        };
                        lines.push(format!(
                            "{marker} {} ({}) — {}",
                            provider.id, provider.protocol, provider.name
                        ));
                    }
                    transcript.push(
                        "system",
                        if lines.is_empty() {
                            "no providers configured".to_owned()
                        } else {
                            lines.join("\n")
                        },
                    );
                }
                _ => {
                    return Err(anyhow!(
                        "unknown provider subcommand '{sub}'; try /provider or /provider use <id>"
                    ));
                }
            }
            Ok((true, None))
        }
        "chat" => {
            if argument.is_empty() {
                return Err(anyhow!("usage: /chat <text>"));
            }
            chat_tui_turn(argument, transcript, &mut on_progress).await?;
            Ok((true, None))
        }
        "allowlist" => {
            let mut tokens = argument.splitn(2, char::is_whitespace);
            let id = tokens.next().unwrap_or("").trim();
            let models = tokens.next().map(str::trim).unwrap_or("");
            if id.is_empty() {
                return Err(anyhow!("usage: /allowlist <id> <model,…> (empty clears)"));
            }
            let allowlist = parse_allowlist(if models.is_empty() {
                None
            } else {
                Some(models)
            })
            .map_err(anyhow::Error::msg)?;
            let mut settings = load_native_settings()?;
            let provider_id = ProviderId::new(id.to_owned()).map_err(anyhow::Error::msg)?;
            settings
                .set_allowlist(&provider_id, allowlist)
                .map_err(anyhow::Error::msg)?;
            save_native_settings(&settings)?;
            transcript.push(
                "system",
                if models.is_empty() {
                    format!("allowlist for {id} cleared")
                } else {
                    format!("allowlist for {id}: {models}")
                },
            );
            Ok((true, None))
        }
        "settings" => {
            let settings = load_native_settings()?;
            transcript.push("system", settings_summary_text(&settings));
            Ok((true, None))
        }
        "auth" => {
            transcript.push("system", auth_status_text()?);
            Ok((true, None))
        }
        "eligible" => {
            transcript.push("system", eligible_text()?);
            Ok((true, None))
        }
        "doctor" => {
            transcript.push("system", doctor_text());
            Ok((true, None))
        }
        "setup-token" => {
            transcript.push("system", setup_token_text());
            Ok((true, None))
        }
        "update" => {
            transcript.push("system", update_text());
            Ok((true, None))
        }
        _ => {
            transcript.push(
                "system",
                format!("unknown command /{command}; type /help for the command list"),
            );
            Ok((true, None))
        }
    }
}

/// Append the user prompt, stream a completion through the active provider and
/// append the assistant reply (or a secret-free error line) to the transcript.
/// Each text delta is appended to the in-progress assistant entry and handed to
/// `on_progress` so the renderer can repaint tokens as they arrive.  Returns
/// the completed outcome (text + token usage) for the caller to record into
/// the session counters; `None` means the turn produced no billable usage
/// (empty response or a failed request).
async fn chat_tui_turn(
    prompt: &str,
    transcript: &mut TuiTranscript,
    mut on_progress: impl FnMut(&TuiTranscript),
) -> Result<Option<ChatOutcome>> {
    transcript.push("user", prompt);
    transcript.push("assistant", String::new());
    // Send the dialog history (trimmed to the token budget) so the model
    // sees prior turns; system/UI lines never enter the request (§10.1).
    let messages = conversation_messages(&transcript.entries, effective_context_budget());
    let outcome = chat_completion_with_chunks(&messages, None, None, |delta| {
        transcript.append_last(delta);
        on_progress(transcript);
    })
    .await;
    match outcome {
        Ok(outcome) => {
            let text = outcome.text.trim();
            if text.is_empty() {
                transcript.finish_last("system", "(empty response)");
                Ok(None)
            } else {
                transcript.finish_last("assistant", text);
                Ok(Some(outcome))
            }
        }
        Err(error) => {
            transcript.finish_last("system", format!("chat failed: {error:#}"));
            Ok(None)
        }
    }
}

/// The dialog history sent to the provider: only completed user/assistant
/// turns with non-empty text, walking from the newest backwards until the
/// token budget is exhausted.  The newest turn is always included (its
/// text is truncated if it alone exceeds the budget); older turns are
/// hard-dropped, never summarized (§10.1).  System/UI lines are never part
/// of the conversation.
fn conversation_messages(entries: &[TranscriptInput], budget: usize) -> Vec<ChatMessage> {
    let mut turns: Vec<ChatMessage> = Vec::new();
    for entry in entries {
        let TranscriptInput::Entry { role, text, .. } = entry else {
            continue;
        };
        if (role == "user" || role == "assistant") && !text.trim().is_empty() {
            turns.push(ChatMessage {
                role: role.clone(),
                content: text.clone(),
                ..Default::default()
            });
        }
    }
    let mut kept: Vec<ChatMessage> = Vec::new();
    let mut used = 0usize;
    for (index, message) in turns.into_iter().rev().enumerate() {
        let is_newest = index == 0;
        let estimated = estimate_tokens(&message.content);
        if !is_newest && used.saturating_add(estimated) > budget {
            break;
        }
        let mut content = message.content;
        if is_newest && estimated > budget {
            content = truncate_to_estimate(content, budget);
            used = estimate_tokens(&content);
        } else {
            used = used.saturating_add(estimated);
        }
        kept.push(ChatMessage {
            role: message.role,
            content,
            ..Default::default()
        });
    }
    kept.reverse();
    kept
}

/// Local token estimate (`chars/4`): cheap, deterministic, no LLM call.
fn estimate_tokens(text: &str) -> usize {
    text.chars().count().div_ceil(4)
}

/// Truncate one message's text to fit `max_estimate` estimated tokens.
fn truncate_to_estimate(text: String, max_estimate: usize) -> String {
    let max_chars = max_estimate.saturating_mul(4).max(4);
    let mut truncated: String = text.chars().take(max_chars).collect();
    if truncated.chars().count() < text.chars().count() {
        truncated.push('…');
    }
    truncated
}

/// Resolve the conversation-memory budget: the settings override when present,
/// otherwise the 200K base (§11.3).  An unreadable settings file falls back to
/// the base rather than failing the turn.
fn effective_context_budget() -> usize {
    load_native_settings()
        .ok()
        .and_then(|settings| settings.context_token_budget)
        .unwrap_or(CONTEXT_TOKEN_BUDGET)
}

/// Secret-free settings summary rendered as a `/settings` transcript line.
fn settings_summary_text(settings: &NativeSettings) -> String {
    let active = settings
        .active_provider
        .as_ref()
        .map(ProviderId::as_str)
        .unwrap_or("none");
    let model = settings.global_worker_model.as_deref().unwrap_or("not set");
    let effort = settings
        .worker_effort_lock
        .map(WorkerEffort::as_str)
        .unwrap_or("off");
    let providers = settings
        .providers()
        .iter()
        .map(|provider| {
            let marker = if settings.active_provider.as_ref() == Some(&provider.id) {
                "*"
            } else {
                " "
            };
            format!(
                "{marker} {} ({}) — {}",
                provider.id, provider.protocol, provider.name
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "active provider: {active}\nworker model: {model}\nworker effort lock: {effort}\nproviders:\n{providers}"
    )
}

/// Secret-free auth summary for the active provider (`/auth`).
fn auth_status_text() -> Result<String> {
    let settings = load_native_settings()?;
    let Some(provider) = settings.active_provider_config() else {
        return Ok("no active provider is configured".to_owned());
    };
    let store = load_store(&native_store_path()?).map_err(anyhow::Error::msg)?;
    let configured = store
        .resolve(&provider.credential, |name| env::var(name).ok())
        .is_ok();
    Ok(format!(
        "{}: {}\ncredential: {}",
        provider.id,
        if configured {
            "logged in"
        } else {
            "not logged in"
        },
        credential_ref_kind(provider),
    ))
}

/// Eligible Worker models of the active provider, secret-free (`/eligible`).
fn eligible_text() -> Result<String> {
    let settings = load_native_settings()?;
    let Some(provider) = settings.active_provider_config() else {
        return Ok("no active provider is configured".to_owned());
    };
    if provider.id.as_str() == mindcode_settings::BUILTIN_VEXZY_PROVIDER_ID {
        return Ok(format!(
            "{}: catalog-driven; worker model {}",
            provider.id,
            settings
                .global_worker_model
                .as_deref()
                .unwrap_or("gpt-5.6-luna")
        ));
    }
    let models = provider
        .allowlist
        .iter()
        .map(ModelId::as_str)
        .collect::<Vec<_>>();
    if models.is_empty() {
        Ok(format!(
            "{}: no eligible models (allowlist is empty, fails closed)",
            provider.id
        ))
    } else {
        Ok(format!("{}: {}", provider.id, models.join(", ")))
    }
}

/// The provider-add payload sent by the renderer as a JSON action value.
#[derive(Debug)]
struct TuiProviderAdd {
    id: String,
    name: String,
    protocol: String,
    base_url: String,
    credential_env: String,
    allowlist: Vec<String>,
}

fn parse_tui_provider_add(value: &str) -> Result<TuiProviderAdd> {
    let parsed: Value = serde_json::from_str(value)
        .map_err(|_| anyhow!("provider add action is not valid JSON"))?;
    let field = |name: &str| -> Result<String> {
        parsed
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("provider add requires a {name}"))
    };
    let allowlist = parsed
        .get("allowlist")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Ok(TuiProviderAdd {
        id: field("id")?,
        name: field("name")?,
        protocol: field("protocol")?,
        base_url: field("base_url")?,
        credential_env: field("credential_env")?,
        allowlist,
    })
}

/// Apply one provider setup action to the persisted settings.  Returns
/// `Ok(true)` when the settings changed (the caller republishes), `Ok(false)`
/// for unknown or malformed actions, and `Err` for a failed mutation.  No
/// credential value ever enters settings or the republished snapshot.
fn apply_tui_action(action: &UiActionInput) -> Result<bool> {
    let mut settings = load_native_settings()?;
    let changed = match action.action.as_str() {
        "provider_switch" => {
            let id = ProviderId::new(
                action
                    .target
                    .clone()
                    .ok_or_else(|| anyhow!("provider_switch requires a target"))?,
            )
            .map_err(anyhow::Error::msg)?;
            settings
                .set_active_provider(&id)
                .map_err(anyhow::Error::msg)?;
            true
        }
        "provider_remove" => {
            let id = ProviderId::new(
                action
                    .target
                    .clone()
                    .ok_or_else(|| anyhow!("provider_remove requires a target"))?,
            )
            .map_err(anyhow::Error::msg)?;
            settings.remove_provider(&id).map_err(anyhow::Error::msg)?;
            true
        }
        "provider_add" => {
            let value = action
                .value
                .clone()
                .ok_or_else(|| anyhow!("provider_add requires a value"))?;
            let payload = parse_tui_provider_add(&value)?;
            let id = parse_provider_id(&payload.id)?;
            if payload.name.trim().is_empty() {
                return Err(anyhow!("provider name must not be empty"));
            }
            let protocol = payload
                .protocol
                .parse::<Protocol>()
                .map_err(anyhow::Error::msg)?;
            validate_base_url(&payload.base_url)?;
            let credential_env = payload.credential_env;
            if credential_env.trim().is_empty() || credential_env.chars().any(char::is_whitespace) {
                return Err(anyhow!(
                    "credential environment variable name must be a non-empty string without whitespace"
                ));
            }
            let allowlist = payload
                .allowlist
                .into_iter()
                .map(|entry| ModelId::new(entry).map_err(anyhow::Error::msg))
                .collect::<Result<Vec<_>>>()?;
            settings
                .add_provider(ProviderConfig {
                    id: id.clone(),
                    name: payload.name,
                    protocol,
                    base_url: payload.base_url,
                    credential: CredentialRef::env(credential_env),
                    allowlist,
                    active: false,
                })
                .map_err(anyhow::Error::msg)?;
            // Adding a profile switches to it, matching the first-run setup
            // expectation ("add and use").
            settings
                .set_active_provider(&id)
                .map_err(anyhow::Error::msg)?;
            true
        }
        "model_select" => {
            let model = ModelId::new(
                action
                    .target
                    .clone()
                    .ok_or_else(|| anyhow!("model_select requires a target"))?,
            )
            .map_err(anyhow::Error::msg)?;
            settings.global_worker_model = Some(model.to_string());
            true
        }
        "effort_select" => {
            let level = action
                .target
                .clone()
                .ok_or_else(|| anyhow!("effort_select requires a target"))?;
            let effort: WorkerEffort = level
                .parse()
                .map_err(|_| anyhow!("invalid effort level '{level}'"))?;
            settings.worker_effort_lock = Some(effort);
            true
        }
        _ => false,
    };
    if changed {
        save_native_settings(&settings)?;
    }
    Ok(changed)
}

/// Resolve the model id for a chat request: the `--model` override wins, then
/// the global Worker model, then the first custom allowlist entry; VEXZY falls
/// back to the documented Worker model and custom profiles fail closed on an
/// empty allowlist.
fn select_chat_model(
    settings: &NativeSettings,
    provider: &ProviderConfig,
    override_model: Option<&str>,
) -> Result<String> {
    if let Some(model) = override_model {
        return Ok(model.to_owned());
    }
    if let Some(model) = &settings.global_worker_model {
        return Ok(model.clone());
    }
    if provider.id.as_str() == mindcode_settings::BUILTIN_VEXZY_PROVIDER_ID {
        return Ok("gpt-5.6-luna".to_owned());
    }
    provider
        .allowlist
        .first()
        .map(ModelId::to_string)
        .ok_or_else(|| anyhow!("active provider has an empty model allowlist (fail closed)"))
}

async fn run_chat(
    arguments: Vec<OsString>,
    run_active: Option<&ProviderId>,
    run_worker_model: Option<&str>,
) -> Result<i32> {
    let args = match ChatArgs::try_parse_from(with_command_program_name(arguments, "mindcode chat"))
    {
        Ok(args) => args,
        Err(error) => return Ok(print_clap_error(error)),
    };
    stream_chat_response(
        &args.prompt.join(" "),
        args.model.as_deref().or(run_worker_model),
        run_active,
    )
    .await
}

/// Resolve the active provider, its credential (env -> store -> fail-closed)
/// and model, then stream one chat completion over the matching protocol,
/// accumulating the assistant text into a single string.  The credential value
/// never reaches output.
async fn chat_completion_text(
    prompt: &str,
    model_override: Option<&str>,
    run_active: Option<&ProviderId>,
) -> Result<String> {
    let messages = vec![ChatMessage {
        role: "user".to_owned(),
        content: prompt.to_owned(),
        ..Default::default()
    }];
    chat_completion_with_chunks(&messages, model_override, run_active, |_| {})
        .await
        .map(|outcome| outcome.text)
}

/// The outcome of one chat request: the streamed text plus the token usage
/// the provider reported (zeroed when it reports none) and the model that
/// actually served the request (§10.3).
#[derive(Clone, Debug, Default)]
struct ChatOutcome {
    text: String,
    usage: ChatUsage,
    model: String,
}

/// Running token/cost counters for the current TUI session (§10.3).  The
/// `last_*` fields hold the most recent request (shown per-turn in the
/// footer), the others accumulate over the session.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct SessionStats {
    input_tokens: u64,
    output_tokens: u64,
    cost: f64,
    savings: f64,
    last_input_tokens: u64,
    last_output_tokens: u64,
    last_cost: f64,
    last_savings: f64,
}

impl SessionStats {
    fn record(&mut self, outcome: &ChatOutcome) {
        let (turn_cost, turn_savings) = estimate_turn_cost(outcome);
        self.input_tokens = self.input_tokens.saturating_add(outcome.usage.input_tokens);
        self.output_tokens = self
            .output_tokens
            .saturating_add(outcome.usage.output_tokens);
        self.cost += turn_cost;
        self.savings += turn_savings;
        self.last_input_tokens = outcome.usage.input_tokens;
        self.last_output_tokens = outcome.usage.output_tokens;
        self.last_cost = turn_cost;
        self.last_savings = turn_savings;
    }

    /// Fold one finished worker's usage into the running session counters
    /// (§10.4.7).  The worker's `cost` is already cache-aware, so it is added
    /// verbatim; per-worker savings are not tracked in this release.
    fn record_worker(&mut self, usage: &WorkerUsage) {
        self.input_tokens = self.input_tokens.saturating_add(usage.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(usage.output_tokens);
        self.cost += usage.cost;
        self.last_input_tokens = usage.input_tokens;
        self.last_output_tokens = usage.output_tokens;
        self.last_cost = usage.cost;
        self.last_savings = 0.0;
    }
}

/// Estimated per-1K-token price (input, output) in USD.  The optional
/// `pricing.json` in the config dir overrides the built-in table
/// (`{"gpt-x": [0.001, 0.002]}` for $/1K input/output); unknown models fall
/// back to a conservative default so the footer can always estimate (§10.7).
fn model_price_per_1k(model: &str) -> (f64, f64) {
    if let Some(override_table) = load_pricing_override() {
        if let Some(price) = override_table.get(model) {
            return *price;
        }
    }
    match model {
        "gpt-5.6-luna" => (0.0010, 0.0020),
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
fn estimate_turn_cost(outcome: &ChatOutcome) -> (f64, f64) {
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
    (cost, (naive - cost).max(0.0))
}

/// Like [`chat_completion_text`], but sends a full message history (so the
/// model sees prior turns) and hands every received text delta to `on_chunk`
/// as it arrives so a live caller can repaint incrementally.
async fn chat_completion_with_chunks(
    messages: &[ChatMessage],
    model_override: Option<&str>,
    run_active: Option<&ProviderId>,
    mut on_chunk: impl FnMut(&str),
) -> Result<ChatOutcome> {
    let settings = load_native_settings()?;
    let Some(provider) = run_active_provider_config(&settings, run_active) else {
        return Err(anyhow!("no active provider is configured"));
    };
    let store = load_store(&native_store_path()?).map_err(anyhow::Error::msg)?;
    let key = match store.resolve(&provider.credential, |name| env::var(name).ok()) {
        Ok(key) => key,
        Err(_) => {
            return Err(anyhow!(
                "credential for provider '{}' is not configured ({})",
                provider.id,
                credential_ref_kind(provider)
            ));
        }
    };
    let model = select_chat_model(&settings, provider, model_override)?;
    let transport = Transport::new(&provider.base_url).map_err(anyhow::Error::msg)?;
    let mut output = String::new();
    let mut usage = ChatUsage::default();

    match provider.protocol {
        Protocol::OpenAiCompatible => {
            let request = ChatCompletionsRequest {
                model: model.clone(),
                messages: messages.to_vec(),
                max_tokens: None,
                temperature: None,
                tools: Vec::new(),
            };
            let stream = transport
                .chat_completions(&key, &request)
                .map_err(anyhow::Error::msg)?;
            futures_util::pin_mut!(stream);
            while let Some(item) = stream.next().await {
                let chunk = item.map_err(anyhow::Error::msg)?;
                // OpenAI-compatible gateways report usage on the final chunk
                // (`prompt_tokens`/`completion_tokens`); take the last report.
                if let Some(reported) = ChatUsage::parse(chunk.usage.as_ref()) {
                    if reported.input_tokens > 0 || reported.output_tokens > 0 {
                        usage = reported;
                    }
                }
                for choice in chunk.choices {
                    if let Some(content) = choice.delta.content {
                        output.push_str(&content);
                        on_chunk(&content);
                    }
                }
            }
        }
        Protocol::AnthropicCompatible => {
            let request = MessagesRequest {
                model: model.clone(),
                max_tokens: 1024,
                messages: messages.to_vec(),
                system: None,
                temperature: None,
                tools: Vec::new(),
            };
            let stream = transport
                .messages(&key, &request)
                .map_err(anyhow::Error::msg)?;
            futures_util::pin_mut!(stream);
            while let Some(item) = stream.next().await {
                let chunk = item.map_err(anyhow::Error::msg)?;
                // Anthropic reports input tokens and cache counters on
                // `message_start.message.usage` and the cumulative output total
                // on `message_delta.usage` (§10.3).
                if let Some(start) = &chunk.message {
                    if let Some(reported) = ChatUsage::parse(start.usage.as_ref()) {
                        usage.input_tokens = reported.input_tokens;
                        usage.cached_read_tokens = reported.cached_read_tokens;
                        usage.cache_creation_tokens = reported.cache_creation_tokens;
                        if reported.output_tokens > usage.output_tokens {
                            usage.output_tokens = reported.output_tokens;
                        }
                    }
                }
                if let Some(reported) = ChatUsage::parse(chunk.usage.as_ref()) {
                    if reported.output_tokens > usage.output_tokens {
                        usage.output_tokens = reported.output_tokens;
                    }
                }
                if let Some(delta) = chunk.delta {
                    if let Some(text) = delta.text {
                        output.push_str(&text);
                        on_chunk(&text);
                    }
                }
                if let Some(block) = chunk.content_block {
                    if let Some(text) = block.text {
                        output.push_str(&text);
                        on_chunk(&text);
                    }
                }
            }
        }
    }
    Ok(ChatOutcome {
        text: output,
        usage,
        model: model.to_owned(),
    })
}

/// The active-provider model client that powers worker agents (§10.4).  It
/// resolves the active profile once, then streams each model turn over the
/// matching protocol, accumulating text, tool calls, and token usage.
struct TransportModelClient {
    provider: ProviderConfig,
    key: SecretKey,
    model: String,
}

impl TransportModelClient {
    /// Resolve the active provider, its credential (env -> store ->
    /// fail-closed), and model — the same resolution as a chat turn.
    fn resolve(settings: &NativeSettings) -> Result<Self> {
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
        let model = select_chat_model(settings, provider, None)?;
        Ok(Self {
            provider: provider.clone(),
            key,
            model,
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
        let messages = messages.to_vec();
        let tools = tools.to_vec();
        Box::pin(async move {
            let transport = Transport::new(&provider.base_url)
                .map_err(|error| WorkerError::Io(error.to_string()))?;
            let (text, tool_calls, usage) = match provider.protocol {
                Protocol::OpenAiCompatible => {
                    let request = ChatCompletionsRequest {
                        model: model.clone(),
                        messages,
                        max_tokens: None,
                        temperature: None,
                        tools,
                    };
                    let stream = transport
                        .chat_completions(&key, &request)
                        .map_err(|error| WorkerError::Io(error.to_string()))?;
                    futures_util::pin_mut!(stream);
                    let mut text = String::new();
                    let mut usage = ChatUsage::default();
                    // (id, name, accumulated arguments) grouped by tool-call index.
                    let mut calls: BTreeMap<u64, (String, String, String)> = BTreeMap::new();
                    while let Some(item) = stream.next().await {
                        if cancel.is_cancelled() {
                            return Err(WorkerError::Cancelled);
                        }
                        let chunk = item.map_err(|error| WorkerError::Io(error.to_string()))?;
                        if let Some(reported) = ChatUsage::parse(chunk.usage.as_ref()) {
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
                    (text, tool_calls, usage)
                }
                Protocol::AnthropicCompatible => {
                    let request = MessagesRequest {
                        model: model.clone(),
                        max_tokens: 1024,
                        messages,
                        system: None,
                        temperature: None,
                        tools,
                    };
                    let stream = transport
                        .messages(&key, &request)
                        .map_err(|error| WorkerError::Io(error.to_string()))?;
                    futures_util::pin_mut!(stream);
                    let mut text = String::new();
                    let mut usage = ChatUsage::default();
                    // (id, name, accumulated partial_json) grouped by block index.
                    let mut calls: BTreeMap<u64, (String, String, String)> = BTreeMap::new();
                    while let Some(item) = stream.next().await {
                        if cancel.is_cancelled() {
                            return Err(WorkerError::Cancelled);
                        }
                        let chunk = item.map_err(|error| WorkerError::Io(error.to_string()))?;
                        if let Some(start) = &chunk.message {
                            if let Some(reported) = ChatUsage::parse(start.usage.as_ref()) {
                                usage.input_tokens = reported.input_tokens;
                                usage.cached_read_tokens = reported.cached_read_tokens;
                                usage.cache_creation_tokens = reported.cache_creation_tokens;
                                if reported.output_tokens > usage.output_tokens {
                                    usage.output_tokens = reported.output_tokens;
                                }
                            }
                        }
                        if let Some(reported) = ChatUsage::parse(chunk.usage.as_ref()) {
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
                    (text, tool_calls, usage)
                }
            };
            let cost = estimate_turn_cost(&ChatOutcome {
                text: String::new(),
                usage,
                model,
            })
            .0;
            Ok(ModelTurn {
                text,
                tool_calls,
                usage,
                cost,
            })
        })
    }
}

/// One registered-but-unanswered worker permission request (§10.4.2).
struct PendingApproval {
    worker_id: String,
    tool: String,
    target: String,
    requested_at_ms: u64,
    sender: oneshot::Sender<ApprovalDecision>,
}

/// The shared approval registry keyed by request id (stable `perm-N` ids are
/// what the TUI sends back in `permission_decision.target`).
#[derive(Default)]
struct PendingApprovals {
    requests: BTreeMap<String, PendingApproval>,
    next_id: u64,
}

/// Internal worker-to-processor events: a worker wants its pending permission
/// republished, or a worker finished and its report must reach the transcript.
enum WorkerEvent {
    PermissionRequested,
    Finished(Box<WorkerReport>),
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

/// Project the currently-pending approvals into secret-free `PermissionInput`
/// entries (status `pending`) for the renderer's permission overlay.
fn pending_permission_inputs(pending: &Mutex<PendingApprovals>) -> Vec<PermissionInput> {
    let guard = pending.lock().unwrap();
    guard
        .requests
        .iter()
        .map(|(id, request)| PermissionInput {
            id: Some(id.clone()),
            tool: Some(request.tool.clone()),
            action: Some("request".to_owned()),
            resource: Some(request.target.clone()),
            reason: Some(format!(
                "worker {} wants to use {} on {}",
                request.worker_id, request.tool, request.target
            )),
            status: Some("pending".to_owned()),
            requested_at_ms: Some(request.requested_at_ms),
            expires_at_ms: None,
            task_id: Some(request.worker_id.clone()),
            agent_id: Some(request.worker_id.clone()),
        })
        .collect()
}

/// Split a composer submission into its slash command and argument, mirroring
/// the dispatcher's parsing (without the leading `/`).  Returns `None` for
/// non-slash input.
fn slash_command(text: &str) -> Option<(&str, &str)> {
    let rest = text.trim().strip_prefix('/')?;
    let mut tokens = rest.splitn(2, char::is_whitespace);
    let command = tokens.next().unwrap_or("").trim();
    let argument = tokens.next().map(str::trim).unwrap_or("");
    Some((command, argument))
}

/// Compact, secret-free rendering of a finished worker report for the
/// transcript (§10.4.5).
fn worker_report_text(report: &WorkerReport) -> String {
    let mut lines = vec![format!(
        "worker {}: {} in {:.1}s",
        report.id,
        match report.status {
            WorkerStatus::Success => "done",
            WorkerStatus::Failed => "failed",
            WorkerStatus::Cancelled => "cancelled",
            WorkerStatus::Timeout => "timed out",
        },
        report.elapsed_ms as f64 / 1000.0
    )];
    if !report.summary.is_empty() {
        lines.push(format!("  summary: {}", report.summary));
    }
    if !report.files_read.is_empty() {
        lines.push(format!("  read: {}", report.files_read.join(", ")));
    }
    if !report.files_changed.is_empty() {
        lines.push(format!("  changed: {}", report.files_changed.join(", ")));
    }
    if !report.commands_run.is_empty() {
        let commands = report
            .commands_run
            .iter()
            .map(|run| run.command.clone())
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("  commands: {commands}"));
    }
    if !report.deviations.is_empty() {
        lines.push(format!("  deviations: {}", report.deviations.join("; ")));
    }
    if !report.risks.is_empty() {
        lines.push(format!("  risks: {}", report.risks.join("; ")));
    }
    lines.push(format!(
        "  usage: ↑{} ↓{} · ${:.6}",
        report.usage.input_tokens, report.usage.output_tokens, report.usage.cost
    ));
    lines.join("\n")
}

/// The interactive approval gate for worker tool calls (§10.4.2).  A worker
/// registering an approval publishes a pending request and waits on a oneshot
/// that the processor loop resolves from the TUI's `permission_decision`.
struct TuiApprovalGate {
    pending: Arc<Mutex<PendingApprovals>>,
    worker_event_tx: mpsc::UnboundedSender<WorkerEvent>,
}

impl ApprovalGate for TuiApprovalGate {
    fn decide(&self, request: ApprovalRequest) -> DecisionFuture {
        let rx = {
            let mut pending = self.pending.lock().unwrap();
            let id = format!("perm-{}", pending.next_id);
            pending.next_id += 1;
            let (sender, receiver) = oneshot::channel();
            pending.requests.insert(
                id,
                PendingApproval {
                    worker_id: request.worker_id,
                    tool: request.tool,
                    target: request.target,
                    requested_at_ms: now_ms(),
                    sender,
                },
            );
            receiver
        };
        let _ = self.worker_event_tx.send(WorkerEvent::PermissionRequested);
        Box::pin(async move { rx.await.unwrap_or(ApprovalDecision::Deny) })
    }
}

/// Monotonic worker id source (session-local; resets on each TUI launch).
static NEXT_WORKER_ID: AtomicU64 = AtomicU64::new(1);

/// Resolve the active provider into a worker model client, build an ownership
/// guard around the launch directory, and spawn the agent on the bounded pool.
/// Returns the transcript confirmation line; the report arrives later through
/// `worker_event_tx` as [`WorkerEvent::Finished`].
fn spawn_worker(
    task: &str,
    tier: PermissionTier,
    pending: Arc<Mutex<PendingApprovals>>,
    worker_event_tx: mpsc::UnboundedSender<WorkerEvent>,
    pool: WorkerPool,
) -> Result<String> {
    let settings = load_native_settings()?;
    let client = TransportModelClient::resolve(&settings)?;
    let worker_id = format!("worker-{}", NEXT_WORKER_ID.fetch_add(1, Ordering::SeqCst));
    let gate = TuiApprovalGate {
        pending: pending.clone(),
        worker_event_tx: worker_event_tx.clone(),
    };
    let scope = WorkerScope::all();
    let config_home = native_settings_path()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow!("MindCode config home is unavailable"))?;
    let cwd = env::current_dir().map_err(anyhow::Error::msg)?;
    // §11.4: shell hooks live globally and project-locally; project-local
    // scripts shadow the global ones by name.
    let hooks = HookSet {
        global: Some(config_home.join("hooks")),
        project: Some(cwd.join(".mindcode").join("hooks")),
    };
    let guard = OwnershipGuard::new(cwd, config_home, tier).map_err(anyhow::Error::msg)?;
    let agent = Arc::new(
        WorkerAgent::new(
            worker_id.clone(),
            Arc::new(client),
            Arc::new(gate),
            scope,
            guard,
        )
        .with_hooks(hooks),
    );
    let task = task.to_owned();
    let confirmation = format!("spawned {worker_id}: {task}");
    let cancel = CancellationToken::new();
    tokio::spawn(async move {
        let run_cancel = cancel.clone();
        let outcome = pool
            .run(run_cancel, {
                let task = task.clone();
                let cancel = cancel.clone();
                let agent = Arc::clone(&agent);
                move || {
                    let task = task.clone();
                    let cancel = cancel.clone();
                    let agent = Arc::clone(&agent);
                    async move { agent.run(&task, cancel).await }
                }
            })
            .await;
        let report = match outcome {
            PoolOutcome {
                report: Some(report),
                ..
            } => report,
            PoolOutcome {
                cancelled: true, ..
            } => WorkerReport::cancelled(worker_id.clone()),
            _ => WorkerReport::timed_out(worker_id.clone()),
        };
        let _ = worker_event_tx.send(WorkerEvent::Finished(Box::new(report)));
    });
    Ok(confirmation)
}

/// CLI wrapper around [`chat_completion_text`]: stream a completion to stdout,
/// printing a secret-free diagnostic on resolution failure.
async fn stream_chat_response(
    prompt: &str,
    model_override: Option<&str>,
    run_active: Option<&ProviderId>,
) -> Result<i32> {
    match chat_completion_text(prompt, model_override, run_active).await {
        Ok(text) => {
            print!("{text}");
            println!();
            Ok(0)
        }
        Err(error) => {
            eprintln!("mindcode: {error:#}");
            Ok(1)
        }
    }
}

/// A bare prompt (`mindcode hello world`) behaves like `mindcode chat`:
/// join all trailing arguments into one prompt and stream a completion
/// through the active provider, failing closed on missing configuration.
async fn run_regular_prompt(prompt: &[String], run_active: Option<&ProviderId>) -> Result<i32> {
    stream_chat_response(&prompt.join(" "), None, run_active).await
}

fn current_api_key() -> Option<String> {
    let value = env::var(API_KEY_ENV).ok()?;
    is_valid_vexzy_api_key(&value).then_some(value)
}

fn is_valid_vexzy_api_key(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("forge-") else {
        return false;
    };
    !suffix.is_empty() && !value.chars().any(char::is_whitespace)
}

fn parse_provider_id(value: &str) -> Result<ProviderId, anyhow::Error> {
    ProviderId::new(value.to_owned()).map_err(anyhow::Error::msg)
}

fn parse_allowlist(input: Option<&str>) -> Result<Vec<ModelId>, anyhow::Error> {
    let Some(input) = input else {
        return Ok(Vec::new());
    };
    if input.trim().is_empty() {
        return Ok(Vec::new());
    }
    input
        .split(',')
        .map(|entry| ModelId::new(entry.to_owned()).map_err(anyhow::Error::msg))
        .collect()
}

/// Bounded URL validation: an absolute https:// or http:// URL with a
/// non-empty host.  Returns the scheme so callers can apply the loopback
/// warning rule for plain http.
fn validate_base_url(value: &str) -> Result<&'static str, anyhow::Error> {
    if value.chars().any(char::is_whitespace) {
        return Err(anyhow!("base URL must not contain whitespace"));
    }
    for scheme in ["https", "http"] {
        let Some(rest) = value.strip_prefix(&format!("{scheme}://")) else {
            continue;
        };
        if !rest.split(['/', '?', '#']).next().unwrap_or("").is_empty() {
            return Ok(scheme);
        }
    }
    Err(anyhow!(
        "base URL must be an absolute https:// or http:// URL"
    ))
}

fn base_url_host_is_loopback(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("http://") else {
        return false;
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]"
        || host.starts_with("127.")
}

/// The credential reference kind only — `env:NAME` or `store:KEY`.  The
/// credential value itself never appears in any output path.
fn credential_ref_kind(provider: &ProviderConfig) -> String {
    match &provider.credential {
        CredentialRef::Env(name) => format!("env:{name}"),
        CredentialRef::Store(key) => format!("store:{key}"),
    }
}

fn auth_provider_summary(provider: &ProviderConfig) -> String {
    format!(
        "{} ({}, {})",
        provider.id,
        provider.protocol,
        credential_ref_kind(provider)
    )
}

/// Secret-free `auth status` projection: status strings are exactly
/// `configured` / `not configured`; the only credential data is the reference
/// kind.
fn auth_status_value(provider: &ProviderConfig, configured: bool) -> serde_json::Value {
    json!({
        "loggedIn": configured,
        "authMethod": if configured { "provider_credential" } else { "none" },
        "apiProvider": provider.id.to_string(),
        "credential": if configured { "configured" } else { "not configured" },
        "provider": {
            "id": provider.id.to_string(),
            "protocol": provider.protocol.to_string(),
            "credential": credential_ref_kind(provider),
        },
    })
}

/// The run-active profile: the `--provider` override when present, otherwise
/// the persisted active profile.
fn effective_active<'a>(
    settings: &'a NativeSettings,
    run_active: Option<&'a ProviderId>,
) -> Option<&'a ProviderId> {
    run_active.or(settings.active_provider.as_ref())
}

fn run_active_provider_config<'a>(
    settings: &'a NativeSettings,
    run_active: Option<&'a ProviderId>,
) -> Option<&'a ProviderConfig> {
    match run_active {
        Some(id) => settings.provider(id),
        None => settings.active_provider_config(),
    }
}

fn providers_list_value(settings: &NativeSettings, active: Option<&ProviderId>) -> Vec<Value> {
    settings
        .providers()
        .iter()
        .map(|provider| {
            json!({
                "id": provider.id.to_string(),
                "name": provider.name,
                "protocol": provider.protocol.to_string(),
                "base_url": provider.base_url,
                "allowlist": provider
                    .allowlist
                    .iter()
                    .map(ModelId::to_string)
                    .collect::<Vec<_>>(),
                "credential": credential_ref_kind(provider),
                "active": active == Some(&provider.id),
            })
        })
        .collect()
}

/// Secret-free `settings show` dump mirroring the settings.json field names.
fn settings_show_value(settings: &NativeSettings, active: Option<&ProviderId>) -> Value {
    json!({
        "active_provider": active.map(ProviderId::to_string),
        "global_worker_model": settings.global_worker_model,
        "worker_effort_lock": settings.worker_effort_lock.map(|effort| effort.to_string()),
        "providers": providers_list_value(settings, active),
    })
}

fn native_settings_path() -> Result<PathBuf, anyhow::Error> {
    default_settings_path().map_err(|_| anyhow!("MindCode config home is unavailable"))
}

fn native_store_path() -> Result<PathBuf, anyhow::Error> {
    default_store_path().map_err(|_| anyhow!("MindCode config home is unavailable"))
}

fn load_native_settings() -> Result<NativeSettings, anyhow::Error> {
    load_settings(&native_settings_path()?).map_err(anyhow::Error::msg)
}

fn save_native_settings(settings: &NativeSettings) -> Result<(), anyhow::Error> {
    save_settings(&native_settings_path()?, settings).map_err(anyhow::Error::msg)
}

/// Read exactly one line from the credential input.  Only the trailing
/// newline is stripped; interior whitespace is preserved, and an empty result
/// is rejected by the caller.
fn read_credential_line(mut input: impl BufRead) -> Result<String, anyhow::Error> {
    let mut line = String::new();
    input
        .read_line(&mut line)
        .map_err(|_| anyhow!("could not read credential from stdin"))?;
    Ok(line.trim_end_matches(['\n', '\r']).to_owned())
}

fn with_command_program_name(mut arguments: Vec<OsString>, name: &str) -> Vec<OsString> {
    if !arguments.is_empty() {
        arguments.remove(0);
    }
    std::iter::once(OsString::from(name))
        .chain(arguments)
        .collect()
}

fn with_program_name(arguments: Vec<OsString>) -> Vec<OsString> {
    std::iter::once(OsString::from("mindcode"))
        .chain(arguments)
        .collect()
}

fn print_clap_error(error: clap::Error) -> i32 {
    let code = match error.kind() {
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => 0,
        _ => 2,
    };
    let _ = error.print();
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{CommandFactory, Parser};
    use mindcode_provider::SecretStore;
    use mindcode_settings::{builtin_vexzy_provider, BUILTIN_VEXZY_PROVIDER_ID};
    use std::io::Cursor;
    use std::path::Path;
    use std::sync::Mutex;
    use tempfile::tempdir;

    /// Guards every test that mutates or reads the process environment.
    /// Sandboxed tests run under this lock, and any test that reads env (e.g.
    /// via `DaemonConfig::default_socket`), including the daemon-defaults
    /// assertion, must take it too, so there is no cross-thread race.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn run_dispatch(arguments: Vec<OsString>) -> Result<i32> {
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(dispatch(arguments))
    }

    /// The process exit code a CLI invocation would produce: `Err` from
    /// `dispatch` is the domain-error path that main maps to exit 1.
    fn run_dispatch_exit(arguments: Vec<OsString>) -> i32 {
        run_dispatch(arguments).unwrap_or(1)
    }

    /// Point XDG_CONFIG_HOME and HOME at a fresh temporary directory for the
    /// duration of the test, then restore the previous values.  Never touches
    /// the real `~/.config/mindcode`.
    fn with_sandbox_env<T>(test: impl FnOnce(&Path) -> T) -> T {
        let _guard = ENV_LOCK.lock();
        let temp = tempdir().unwrap();
        let previous_xdg = env::var_os("XDG_CONFIG_HOME");
        let previous_home = env::var_os("HOME");
        env::set_var("XDG_CONFIG_HOME", temp.path());
        env::set_var("HOME", temp.path());
        let result = test(temp.path());
        match previous_xdg {
            Some(value) => env::set_var("XDG_CONFIG_HOME", value),
            None => env::remove_var("XDG_CONFIG_HOME"),
        }
        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        result
    }

    fn with_env_var<T>(name: &str, value: &str, test: impl FnOnce() -> T) -> T {
        let previous = env::var_os(name);
        env::set_var(name, value);
        let result = test();
        match previous {
            Some(value) => env::set_var(name, value),
            None => env::remove_var(name),
        }
        result
    }

    fn without_env_var<T>(name: &str, test: impl FnOnce() -> T) -> T {
        let previous = env::var_os(name);
        env::remove_var(name);
        let result = test();
        match previous {
            Some(value) => env::set_var(name, value),
            None => env::remove_var(name),
        }
        result
    }

    fn sandbox_settings_path(dir: &Path) -> PathBuf {
        dir.join("mindcode/settings.json")
    }

    fn sandbox_store_path(dir: &Path) -> PathBuf {
        dir.join("mindcode/credentials.json")
    }

    fn seed_settings(dir: &Path, settings: &NativeSettings) {
        save_settings(&sandbox_settings_path(dir), settings).unwrap();
    }

    fn load_sandbox_settings(dir: &Path) -> NativeSettings {
        load_settings(&sandbox_settings_path(dir)).unwrap()
    }

    fn seed_builtin_active(dir: &Path) {
        let mut settings = NativeSettings::default();
        settings.add_provider(builtin_vexzy_provider()).unwrap();
        settings
            .set_active_provider(&ProviderId::new(BUILTIN_VEXZY_PROVIDER_ID.to_owned()).unwrap())
            .unwrap();
        seed_settings(dir, &settings);
    }

    fn profile(
        id: &str,
        name: &str,
        protocol: Protocol,
        base_url: &str,
        credential: CredentialRef,
        allowlist: &[&str],
    ) -> ProviderConfig {
        ProviderConfig {
            id: ProviderId::new(id.to_owned()).unwrap(),
            name: name.to_owned(),
            protocol,
            base_url: base_url.to_owned(),
            credential,
            allowlist: allowlist
                .iter()
                .map(|model| ModelId::new(model.to_string()).unwrap())
                .collect(),
            active: false,
        }
    }

    #[test]
    fn validates_vexzy_key_shape_without_accepting_whitespace() {
        assert!(is_valid_vexzy_api_key("forge-test-key"));
        assert!(is_valid_vexzy_api_key("forge-…"));
        assert!(!is_valid_vexzy_api_key("forge-"));
        assert!(!is_valid_vexzy_api_key("not-forge-key"));
        assert!(!is_valid_vexzy_api_key("forge-with space"));
        assert!(!is_valid_vexzy_api_key("forge-with\nnewline"));
    }

    #[test]
    fn root_help_contains_native_commands() {
        let mut command = RootArgs::command();
        let help = command.render_help().to_string();
        assert!(help.contains("mindcode"));
        assert!(help.contains("daemon"));
        assert!(help.contains("setup-token"));
        assert!(help.contains("provider"));
        assert!(help.contains("settings"));
        assert!(help.contains("chat"));
        assert!(help.contains("multi-provider"));
    }

    #[test]
    fn daemon_defaults_match_mindcoded_defaults() {
        // Reads HOME via `DaemonConfig::default_socket`, so it must share
        // the env lock with the sandboxed tests that mutate HOME.
        let _guard = ENV_LOCK.lock();
        let args = DaemonArgs::try_parse_from(["mindcode"]).unwrap();
        assert_eq!(args.idle_seconds, 1_800);
        assert_eq!(args.handshake_timeout_seconds, 5);
        assert_eq!(args.build_id, "dev");
        assert_eq!(args.socket, DaemonConfig::default_socket());
        assert!(args.state_dir.is_none());
    }

    #[test]
    fn auth_status_json_never_contains_the_secret() {
        let provider = builtin_vexzy_provider();
        let output = auth_status_value(&provider, true).to_string();
        assert!(!output.contains("forge-"));
        assert!(output.contains("VEXZY_API_KEY"));
        assert_eq!(
            auth_status_value(&provider, true)["credential"],
            "configured"
        );
        assert_eq!(
            auth_status_value(&provider, false)["credential"],
            "not configured"
        );
    }

    #[test]
    fn provider_and_settings_parsers_accept_the_documented_subcommands() {
        let provider = ProviderArgs::try_parse_from([
            "mindcode provider",
            "add",
            "--id",
            "p1",
            "--name",
            "P1",
            "--protocol",
            "openai-compatible",
            "--base-url",
            "https://p1.example/v1",
            "--credential-env",
            "K1",
            "--allowlist",
            "a,b",
        ])
        .unwrap();
        assert!(matches!(provider.command, ProviderCommand::Add(_)));
        let settings =
            SettingsArgs::try_parse_from(["mindcode settings", "effort", "lock", "off"]).unwrap();
        assert!(matches!(settings.command, SettingsCommand::Effort(_)));
        assert!(
            SettingsArgs::try_parse_from(["mindcode settings", "effort", "lock", "auto",]).is_ok()
        );
        assert!(ProviderArgs::try_parse_from([
            "mindcode provider",
            "add",
            "--id",
            "p1",
            "--name",
            "P1",
            "--protocol",
            "openai-compatible",
            "--base-url",
            "https://p1.example/v1",
            "--credential-env",
            "K1",
            "--credential-store",
            "s1",
        ])
        .is_err());
    }

    #[test]
    fn scan_run_options_extracts_all_flags_both_spellings_and_keeps_the_rest() {
        let (options, remaining) = scan_run_options(&[
            OsString::from("--provider"),
            OsString::from("vexzy"),
            OsString::from("--worker-model"),
            OsString::from("gpt-5.6-luna"),
            OsString::from("--worker-effort-lock"),
            OsString::from("max"),
            OsString::from("auth"),
            OsString::from("status"),
        ])
        .unwrap();
        assert_eq!(options.provider.as_deref(), Some("vexzy"));
        assert_eq!(options.worker_model.as_deref(), Some("gpt-5.6-luna"));
        assert_eq!(options.worker_effort_lock.as_deref(), Some("max"));
        assert_eq!(
            remaining,
            vec![OsString::from("auth"), OsString::from("status")]
        );

        let (options, remaining) = scan_run_options(&[
            OsString::from("--provider=vexzy"),
            OsString::from("--worker-model=gpt-5.6-luna"),
            OsString::from("--worker-effort-lock=off"),
            OsString::from("list"),
        ])
        .unwrap();
        assert_eq!(options.provider.as_deref(), Some("vexzy"));
        assert_eq!(options.worker_model.as_deref(), Some("gpt-5.6-luna"));
        assert_eq!(options.worker_effort_lock.as_deref(), Some("off"));
        assert_eq!(remaining, vec![OsString::from("list")]);

        assert!(scan_run_options(&[OsString::from("--provider")]).is_err());
        assert!(scan_run_options(&[OsString::from("--worker-model")]).is_err());
        assert!(scan_run_options(&[OsString::from("--worker-effort-lock")]).is_err());
        let (options, remaining) =
            scan_run_options(&[OsString::from("provider"), OsString::from("list")]).unwrap();
        assert!(options.provider.is_none());
        assert!(options.worker_model.is_none());
        assert!(options.worker_effort_lock.is_none());
        assert_eq!(remaining.len(), 2);
    }

    #[test]
    fn worker_model_and_effort_lock_overrides_validate_fail_closed() {
        assert!(parse_worker_model_override("gpt-5.6-luna").is_ok());
        assert!(parse_worker_model_override("").is_err());
        assert!(parse_worker_model_override("two words").is_err());

        assert!(parse_effort_lock_override("off").unwrap().is_none());
        assert_eq!(
            parse_effort_lock_override("max").unwrap(),
            Some(WorkerEffort::Max)
        );
        assert!(parse_effort_lock_override("auto").is_err());
    }

    #[test]
    fn provider_list_shows_all_profiles_secret_free_with_active_marker() {
        with_sandbox_env(|dir| {
            let mut settings = NativeSettings::default();
            settings.add_provider(builtin_vexzy_provider()).unwrap();
            settings
                .add_provider(profile(
                    "custom-a",
                    "Custom A",
                    Protocol::AnthropicCompatible,
                    "https://custom.example/v1",
                    CredentialRef::Store("custom-a".to_owned()),
                    &["model-a", "model-b"],
                ))
                .unwrap();
            settings
                .set_active_provider(&ProviderId::new("vexzy".to_owned()).unwrap())
                .unwrap();
            seed_settings(dir, &settings);

            let code = run_dispatch_exit(vec![OsString::from("provider"), OsString::from("list")]);
            assert_eq!(code, 0);

            let loaded = load_sandbox_settings(dir);
            let value = providers_list_value(&loaded, effective_active(&loaded, None));
            let text = serde_json::to_string(&value).unwrap();
            assert!(text.contains("\"id\":\"vexzy\""));
            assert!(text.contains("\"credential\":\"env:VEXZY_API_KEY\""));
            assert!(text.contains("\"credential\":\"store:custom-a\""));
            assert!(text.contains("\"allowlist\":[\"model-a\",\"model-b\"]"));
            assert!(text.contains("\"active\":true"));
            assert_eq!(value[0]["active"], json!(true));
            assert_eq!(value[1]["active"], json!(false));
            assert!(!text.contains("secret"));
            assert!(!text.contains("forge-"));
        });
    }

    #[test]
    fn provider_list_marks_the_run_selected_provider_as_active_without_persisting() {
        with_sandbox_env(|dir| {
            let mut settings = NativeSettings::default();
            settings.add_provider(builtin_vexzy_provider()).unwrap();
            settings
                .add_provider(profile(
                    "custom-a",
                    "Custom A",
                    Protocol::OpenAiCompatible,
                    "https://custom.example/v1",
                    CredentialRef::Env("CUSTOM_API_KEY".to_owned()),
                    &[],
                ))
                .unwrap();
            settings
                .set_active_provider(&ProviderId::new("vexzy".to_owned()).unwrap())
                .unwrap();
            seed_settings(dir, &settings);

            let code = run_dispatch_exit(vec![
                OsString::from("--provider"),
                OsString::from("custom-a"),
                OsString::from("provider"),
                OsString::from("list"),
            ]);
            assert_eq!(code, 0);
            let loaded = load_sandbox_settings(dir);
            let custom = ProviderId::new("custom-a".to_owned()).unwrap();
            let value = providers_list_value(&loaded, Some(&custom));
            assert_eq!(value[0]["active"], json!(false));
            assert_eq!(value[1]["active"], json!(true));
            assert_eq!(
                loaded.active_provider.as_ref().map(ProviderId::as_str),
                Some("vexzy")
            );
        });
    }

    #[test]
    fn provider_use_persists_the_active_provider() {
        with_sandbox_env(|dir| {
            let mut settings = NativeSettings::default();
            settings.add_provider(builtin_vexzy_provider()).unwrap();
            settings
                .add_provider(profile(
                    "custom-a",
                    "Custom A",
                    Protocol::OpenAiCompatible,
                    "https://custom.example/v1",
                    CredentialRef::Env("CUSTOM_API_KEY".to_owned()),
                    &[],
                ))
                .unwrap();
            seed_settings(dir, &settings);

            let code = run_dispatch_exit(vec![
                OsString::from("provider"),
                OsString::from("use"),
                OsString::from("custom-a"),
            ]);
            assert_eq!(code, 0);
            let loaded = load_sandbox_settings(dir);
            assert_eq!(
                loaded.active_provider.as_ref().map(ProviderId::as_str),
                Some("custom-a")
            );
            let custom = loaded
                .provider(&ProviderId::new("custom-a".to_owned()).unwrap())
                .unwrap();
            assert!(custom.active);
            assert!(
                !loaded
                    .provider(&ProviderId::new("vexzy".to_owned()).unwrap())
                    .unwrap()
                    .active
            );
        });
    }

    #[test]
    fn provider_use_unknown_id_fails_closed_without_changing_state() {
        with_sandbox_env(|dir| {
            let mut settings = NativeSettings::default();
            settings.add_provider(builtin_vexzy_provider()).unwrap();
            settings
                .set_active_provider(&ProviderId::new("vexzy".to_owned()).unwrap())
                .unwrap();
            seed_settings(dir, &settings);

            let code = run_dispatch_exit(vec![
                OsString::from("provider"),
                OsString::from("use"),
                OsString::from("ghost"),
            ]);
            assert_eq!(code, 1);
            let loaded = load_sandbox_settings(dir);
            assert_eq!(
                loaded.active_provider.as_ref().map(ProviderId::as_str),
                Some("vexzy")
            );
        });
    }

    #[test]
    fn provider_add_persists_and_duplicate_fails_closed_without_state_change() {
        with_sandbox_env(|dir| {
            let mut settings = NativeSettings::default();
            settings.add_provider(builtin_vexzy_provider()).unwrap();
            seed_settings(dir, &settings);

            let code = run_dispatch_exit(vec![
                OsString::from("provider"),
                OsString::from("add"),
                OsString::from("--id"),
                OsString::from("custom-a"),
                OsString::from("--name"),
                OsString::from("Custom A"),
                OsString::from("--protocol"),
                OsString::from("anthropic-compatible"),
                OsString::from("--base-url"),
                OsString::from("https://custom.example/v1"),
                OsString::from("--credential-store"),
                OsString::from("custom-a"),
                OsString::from("--allowlist"),
                OsString::from("model-a,model-b"),
            ]);
            assert_eq!(code, 0);
            let loaded = load_sandbox_settings(dir);
            assert_eq!(loaded.providers().len(), 2);
            let added = loaded
                .provider(&ProviderId::new("custom-a".to_owned()).unwrap())
                .unwrap();
            assert_eq!(added.protocol, Protocol::AnthropicCompatible);
            assert_eq!(
                added.credential,
                CredentialRef::Store("custom-a".to_owned())
            );
            assert_eq!(added.base_url, "https://custom.example/v1");

            let duplicate = run_dispatch_exit(vec![
                OsString::from("provider"),
                OsString::from("add"),
                OsString::from("--id"),
                OsString::from("custom-a"),
                OsString::from("--name"),
                OsString::from("Other"),
                OsString::from("--protocol"),
                OsString::from("openai-compatible"),
                OsString::from("--base-url"),
                OsString::from("https://other.example/v1"),
                OsString::from("--credential-env"),
                OsString::from("OTHER_KEY"),
            ]);
            assert_eq!(duplicate, 1);
            let after = load_sandbox_settings(dir);
            assert_eq!(after.providers().len(), 2);
            let added = after
                .provider(&ProviderId::new("custom-a".to_owned()).unwrap())
                .unwrap();
            assert_eq!(added.name, "Custom A");
        });
    }

    #[test]
    fn provider_add_rejects_invalid_protocol_and_base_url_without_state_change() {
        with_sandbox_env(|dir| {
            let mut settings = NativeSettings::default();
            settings.add_provider(builtin_vexzy_provider()).unwrap();
            seed_settings(dir, &settings);
            let before = fs::read_to_string(sandbox_settings_path(dir)).unwrap();

            for (protocol, base_url) in [
                ("openai", "https://x.example/v1"),
                ("openai-compatible", "not-a-url"),
                ("openai-compatible", "ftp://x.example/v1"),
                ("openai-compatible", "https://"),
            ] {
                let code = run_dispatch_exit(vec![
                    OsString::from("provider"),
                    OsString::from("add"),
                    OsString::from("--id"),
                    OsString::from("custom-b"),
                    OsString::from("--name"),
                    OsString::from("Custom B"),
                    OsString::from("--protocol"),
                    OsString::from(protocol),
                    OsString::from("--base-url"),
                    OsString::from(base_url),
                    OsString::from("--credential-env"),
                    OsString::from("CUSTOM_API_KEY"),
                ]);
                assert_eq!(code, 1, "{protocol} / {base_url}");
            }
            let after = fs::read_to_string(sandbox_settings_path(dir)).unwrap();
            assert_eq!(after, before);
            assert_eq!(load_sandbox_settings(dir).providers().len(), 1);
        });
    }

    #[test]
    fn provider_remove_persists_and_removing_the_active_profile_clears_it() {
        with_sandbox_env(|dir| {
            let mut settings = NativeSettings::default();
            settings.add_provider(builtin_vexzy_provider()).unwrap();
            settings
                .add_provider(profile(
                    "custom-a",
                    "Custom A",
                    Protocol::OpenAiCompatible,
                    "https://custom.example/v1",
                    CredentialRef::Env("CUSTOM_API_KEY".to_owned()),
                    &[],
                ))
                .unwrap();
            settings
                .set_active_provider(&ProviderId::new("vexzy".to_owned()).unwrap())
                .unwrap();
            seed_settings(dir, &settings);

            let code = run_dispatch_exit(vec![
                OsString::from("provider"),
                OsString::from("remove"),
                OsString::from("vexzy"),
            ]);
            assert_eq!(code, 0);
            let loaded = load_sandbox_settings(dir);
            assert_eq!(loaded.active_provider, None);
            assert!(loaded.providers().iter().all(|provider| !provider.active));
            assert_eq!(loaded.providers().len(), 1);

            let missing = run_dispatch_exit(vec![
                OsString::from("provider"),
                OsString::from("remove"),
                OsString::from("ghost"),
            ]);
            assert_eq!(missing, 1);
        });
    }

    #[test]
    fn apply_tui_action_add_switch_and_remove_providers() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            let add = UiActionInput {
                action: "provider_add".into(),
                target: None,
                value: Some(
                    json!({
                        "id": "custom-a",
                        "name": "Custom A",
                        "protocol": "openai-compatible",
                        "base_url": "https://custom.example/v1",
                        "credential_env": "CUSTOM_KEY",
                        "allowlist": ["model-a"],
                    })
                    .to_string(),
                ),
            };
            assert!(apply_tui_action(&add).unwrap());
            let settings = load_sandbox_settings(dir);
            assert_eq!(
                settings.active_provider.as_ref().map(ProviderId::to_string),
                Some("custom-a".to_owned())
            );
            assert_eq!(settings.providers().len(), 2);
            let custom = settings
                .provider(&ProviderId::new("custom-a".to_owned()).unwrap())
                .unwrap();
            assert_eq!(custom.allowlist.len(), 1);
            assert!(
                matches!(custom.credential, CredentialRef::Env(ref name) if name == "CUSTOM_KEY")
            );

            let switch = UiActionInput {
                action: "provider_switch".into(),
                target: Some("vexzy".into()),
                value: None,
            };
            assert!(apply_tui_action(&switch).unwrap());
            assert_eq!(
                load_sandbox_settings(dir)
                    .active_provider
                    .as_ref()
                    .map(ProviderId::to_string),
                Some("vexzy".to_owned())
            );

            let remove = UiActionInput {
                action: "provider_remove".into(),
                target: Some("custom-a".into()),
                value: None,
            };
            assert!(apply_tui_action(&remove).unwrap());
            let settings = load_sandbox_settings(dir);
            assert_eq!(settings.providers().len(), 1);
            assert!(settings
                .provider(&ProviderId::new("custom-a".to_owned()).unwrap())
                .is_none());

            let unknown = UiActionInput {
                action: "bogus".into(),
                target: None,
                value: None,
            };
            assert!(!apply_tui_action(&unknown).unwrap());
        });
    }

    #[test]
    fn parse_tui_provider_add_requires_all_fields_and_valid_json() {
        assert!(parse_tui_provider_add("not json").is_err());
        assert!(parse_tui_provider_add("{}").is_err());
        let parsed = parse_tui_provider_add(
            &json!({
                "id": "x",
                "name": "X",
                "protocol": "openai-compatible",
                "base_url": "https://x/v1",
                "credential_env": "X_KEY",
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(parsed.id, "x");
        assert_eq!(parsed.protocol, "openai-compatible");
        assert_eq!(parsed.credential_env, "X_KEY");
        assert!(parsed.allowlist.is_empty());
    }

    #[test]
    fn providers_input_projects_only_credential_references() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            let inputs = providers_input(&load_sandbox_settings(dir));
            assert_eq!(inputs.len(), 1);
            assert_eq!(inputs[0].id, "vexzy");
            assert_eq!(inputs[0].credential.as_deref(), Some("env:VEXZY_API_KEY"));
            assert!(inputs.iter().all(|input| {
                !input.base_url.contains("forge-")
                    && input
                        .credential
                        .as_deref()
                        .is_none_or(|credential| !credential.contains("forge-"))
            }));
        });
    }

    #[test]
    fn providers_input_reports_whether_the_credential_resolves() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            without_env_var("VEXZY_API_KEY", || {
                let inputs = providers_input(&load_sandbox_settings(dir));
                assert_eq!(inputs[0].configured, Some(false));
            });
            with_env_var("VEXZY_API_KEY", "forge-test-key", || {
                let inputs = providers_input(&load_sandbox_settings(dir));
                assert_eq!(inputs[0].configured, Some(true));
            });
        });
    }

    #[test]
    fn providers_input_exposes_selectable_allowlist_and_vexzy_fallback() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            // The built-in VEXZY profile is catalog-driven with an empty
            // allowlist; the picker falls back to the documented model so it
            // is never blank.
            let inputs = providers_input(&load_sandbox_settings(dir));
            assert_eq!(inputs[0].allowlist, vec!["gpt-5.6-luna".to_owned()]);

            // A custom profile exposes its allowlist verbatim.
            let add = UiActionInput {
                action: "provider_add".into(),
                target: None,
                value: Some(
                    json!({
                        "id": "custom-a",
                        "name": "Custom A",
                        "protocol": "openai-compatible",
                        "base_url": "https://custom.example/v1",
                        "credential_env": "CUSTOM_KEY",
                        "allowlist": ["model-a", "model-b"],
                    })
                    .to_string(),
                ),
            };
            assert!(apply_tui_action(&add).unwrap());
            let inputs = providers_input(&load_sandbox_settings(dir));
            let custom = inputs.iter().find(|input| input.id == "custom-a").unwrap();
            assert_eq!(
                custom.allowlist,
                vec!["model-a".to_owned(), "model-b".to_owned()]
            );
        });
    }

    #[test]
    fn model_select_action_sets_the_global_worker_model() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            let select = UiActionInput {
                action: "model_select".into(),
                target: Some("kimi-k3".into()),
                value: None,
            };
            assert!(apply_tui_action(&select).unwrap());
            assert_eq!(
                load_sandbox_settings(dir).global_worker_model.as_deref(),
                Some("kimi-k3")
            );

            let missing = UiActionInput {
                action: "model_select".into(),
                target: None,
                value: None,
            };
            assert!(apply_tui_action(&missing).is_err());
        });
    }

    #[test]
    fn effort_select_action_sets_the_global_effort_lock() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            let select = UiActionInput {
                action: "effort_select".into(),
                target: Some("max".into()),
                value: None,
            };
            assert!(apply_tui_action(&select).unwrap());
            assert_eq!(
                load_sandbox_settings(dir).worker_effort_lock,
                Some(WorkerEffort::Max)
            );

            let invalid = UiActionInput {
                action: "effort_select".into(),
                target: Some("ultra".into()),
                value: None,
            };
            assert!(apply_tui_action(&invalid).is_err());
        });
    }

    /// One-shot loopback SSE server: serves a fixed `data:` event stream for a
    /// single connection.  Only used by the incremental-streaming test; the
    /// credential is a test-only placeholder.
    async fn spawn_sse_mock(
        events: &[&str],
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let body = events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect::<String>();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0_u8; 8192];
            let _ = stream.read(&mut buffer).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
        (addr, handle)
    }

    #[test]
    fn chat_completion_with_chunks_delivers_deltas_incrementally() {
        with_sandbox_env(|dir| {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                let (addr, server) = spawn_sse_mock(&[
                    r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model-alpha","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}"#,
                    r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model-alpha","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#,
                    r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model-alpha","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}"#,
                    r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model-alpha","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
                    r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"model-alpha","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}"#,
                    "[DONE]",
                ])
                .await;

                let mut settings = NativeSettings::default();
                settings
                    .add_provider(profile(
                        "mock",
                        "Mock",
                        Protocol::OpenAiCompatible,
                        &format!("http://{addr}/v1"),
                        CredentialRef::env("MOCK_KEY"),
                        &["model-alpha"],
                    ))
                    .unwrap();
                settings
                    .set_active_provider(&ProviderId::new("mock".to_owned()).unwrap())
                    .unwrap();
                seed_settings(dir, &settings);

                let previous = env::var_os("MOCK_KEY");
                env::set_var("MOCK_KEY", "mock-key");
                let mut deltas = Vec::new();
                let messages = vec![ChatMessage {
                    role: "user".to_owned(),
                    content: "hi".to_owned(),
                    ..Default::default()
                }];
                let text = chat_completion_with_chunks(&messages, None, None, |delta| {
                    deltas.push(delta.to_owned());
                })
                .await
                .unwrap();
                match previous {
                    Some(value) => env::set_var("MOCK_KEY", value),
                    None => env::remove_var("MOCK_KEY"),
                }

                assert_eq!(text.text, "Hello world");
                assert_eq!(text.usage.input_tokens, 12);
                assert_eq!(text.usage.output_tokens, 2);
                assert_eq!(deltas, ["Hello".to_owned(), " world".to_owned()]);
                server.await.unwrap();
            });
        });
    }

    #[test]
    fn conversation_messages_keeps_only_dialog_turns() {
        let entries = vec![
            TranscriptInput::Entry {
                sequence: 0,
                role: "system".into(),
                text: "hint / ui line".into(),
            },
            TranscriptInput::Entry {
                sequence: 1,
                role: "user".into(),
                text: "hello".into(),
            },
            TranscriptInput::Entry {
                sequence: 2,
                role: "assistant".into(),
                text: "hi there".into(),
            },
            TranscriptInput::Entry {
                sequence: 3,
                role: "user".into(),
                text: "second question".into(),
            },
            TranscriptInput::Entry {
                sequence: 4,
                role: "assistant".into(),
                text: String::new(),
            },
        ];
        let messages = conversation_messages(&entries, CONTEXT_TOKEN_BUDGET);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "hello");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "hi there");
        assert_eq!(messages[2].role, "user");
        assert_eq!(messages[2].content, "second question");
    }

    #[test]
    fn conversation_messages_drops_old_turns_over_budget() {
        // 4 chars each ≈ 1 estimated token.
        let entries = vec![
            TranscriptInput::Entry {
                sequence: 1,
                role: "user".into(),
                text: "aaaa".into(),
            },
            TranscriptInput::Entry {
                sequence: 2,
                role: "assistant".into(),
                text: "bbbb".into(),
            },
            TranscriptInput::Entry {
                sequence: 3,
                role: "user".into(),
                text: "cccc".into(),
            },
        ];
        let messages = conversation_messages(&entries, 2);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "bbbb");
        assert_eq!(messages[1].content, "cccc");
    }

    #[test]
    fn conversation_messages_truncates_single_oversized_newest_turn() {
        let long = "x".repeat(400); // ≈100 estimated tokens
        let entries = vec![TranscriptInput::Entry {
            sequence: 1,
            role: "user".into(),
            text: long.clone(),
        }];
        let messages = conversation_messages(&entries, 10);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert!(messages[0].content.ends_with('…'));
        assert!(messages[0].content.chars().count() <= 10 * 4 + 1);
    }

    #[test]
    fn session_save_load_round_trips_dialog_only() {
        with_sandbox_env(|dir| {
            let mut transcript = TuiTranscript::default();
            transcript.push("user", "hello");
            transcript.push("assistant", "hi");
            transcript.push("system", "ui line — never persisted");
            save_session("roundtrip", &transcript, SessionStats::default()).unwrap();

            let (loaded, stats) = load_session("roundtrip");
            assert_eq!(stats, SessionStats::default());
            assert_eq!(loaded.entries.len(), 2);
            let TranscriptInput::Entry { role, text, .. } = &loaded.entries[0] else {
                panic!("expected entry");
            };
            assert_eq!(role, "user");
            assert_eq!(text, "hello");
            let TranscriptInput::Entry { role, text, .. } = &loaded.entries[1] else {
                panic!("expected entry");
            };
            assert_eq!(role, "assistant");
            assert_eq!(text, "hi");

            // The persisted file itself is secret-free and holds no ui line.
            let raw = fs::read_to_string(session_path("roundtrip").unwrap()).unwrap();
            assert!(!raw.contains("ui line"));
            assert!(dir.join("mindcode/sessions/roundtrip.json").exists());
        });
    }

    #[test]
    fn session_save_load_round_trips_usage_counters() {
        with_sandbox_env(|_dir| {
            let transcript = TuiTranscript::default();
            let mut stats = SessionStats::default();
            stats.record(&ChatOutcome {
                text: "hi".into(),
                usage: ChatUsage {
                    input_tokens: 10,
                    output_tokens: 4,
                    cached_read_tokens: 6,
                    ..Default::default()
                },
                model: "gpt-5.6-luna".into(),
            });
            assert_eq!(stats.input_tokens, 10);
            assert_eq!(stats.output_tokens, 4);
            assert!(stats.cost > 0.0);
            assert!(stats.savings > 0.0);
            assert_eq!(stats.last_input_tokens, 10);
            assert_eq!(stats.last_output_tokens, 4);
            assert_eq!(stats.last_savings, stats.savings);

            save_session("usage", &transcript, stats).unwrap();
            let (loaded, restored) = load_session("usage");
            assert_eq!(loaded.entries.len(), 0);
            assert_eq!(restored.input_tokens, 10);
            assert_eq!(restored.output_tokens, 4);
            // Cost and savings are stored too; the last_* fields are transient.
            assert_eq!(restored.cost, stats.cost);
            assert_eq!(restored.savings, stats.savings);
            assert_eq!(restored.last_input_tokens, 0);
            assert_eq!(restored.last_savings, 0.0);
        });
    }

    #[test]
    fn session_stats_record_accumulates_across_turns() {
        let mut stats = SessionStats::default();
        for (input, output) in [(100, 20), (150, 35)] {
            stats.record(&ChatOutcome {
                text: String::new(),
                usage: ChatUsage {
                    input_tokens: input,
                    output_tokens: output,
                    ..Default::default()
                },
                model: "gpt-5.6-luna".into(),
            });
        }
        assert_eq!(stats.input_tokens, 250);
        assert_eq!(stats.output_tokens, 55);
        // Per-turn counters reflect only the last request.
        assert_eq!(stats.last_input_tokens, 150);
        assert_eq!(stats.last_output_tokens, 35);
        assert!(stats.cost > 0.0);
    }

    #[test]
    fn estimate_turn_cost_savings_accounts_for_cached_tokens() {
        // gpt-5.6-luna input is $0.001/1K; cache reads cost 0.1× that. Reading
        // 8000 cached tokens must cost far less than billing them at full rate.
        let outcome = ChatOutcome {
            text: String::new(),
            usage: ChatUsage {
                input_tokens: 10_000,
                output_tokens: 0,
                cached_read_tokens: 8_000,
                cache_creation_tokens: 0,
            },
            model: "gpt-5.6-luna".to_owned(),
        };
        let (cost, savings) = estimate_turn_cost(&outcome);
        let expected_naive = 10_000.0 / 1000.0 * 0.0010;
        let expected_cost = 2000.0 / 1000.0 * 0.0010 + 8000.0 / 1000.0 * 0.0001;
        assert!((cost - expected_cost).abs() < 1e-12, "cost = {cost}");
        assert!(
            (savings - (expected_naive - expected_cost)).abs() < 1e-12,
            "savings = {savings}"
        );
        assert!(savings > 0.0);
    }

    #[test]
    fn estimate_turn_cost_cache_write_is_billed_at_a_premium() {
        // Writing tokens to the cache costs 1.25× the input rate, so a
        // cache-creation-only turn is more expensive than the naive estimate.
        let outcome = ChatOutcome {
            text: String::new(),
            usage: ChatUsage {
                input_tokens: 1_000,
                output_tokens: 0,
                cached_read_tokens: 0,
                cache_creation_tokens: 1_000,
            },
            model: "gpt-5.6-luna".to_owned(),
        };
        let (cost, savings) = estimate_turn_cost(&outcome);
        assert!((cost - 1.25 * 0.0010).abs() < 1e-12, "cost = {cost}");
        assert_eq!(savings, 0.0);
    }

    #[test]
    fn pricing_override_json_wins_over_the_builtin_table() {
        with_sandbox_env(|dir| {
            // with_sandbox_env points the config home at dir/mindcode; write
            // pricing.json next to settings.json.
            let config_dir = dir.join("mindcode");
            fs::create_dir_all(&config_dir).unwrap();
            fs::write(
                config_dir.join("pricing.json"),
                r#"{"gpt-5.6-luna": [9.0, 18.0], "kimi": [0.1, 0.2]}"#,
            )
            .unwrap();
            let (input, output) = model_price_per_1k("gpt-5.6-luna");
            assert_eq!(input, 9.0);
            assert_eq!(output, 18.0);
            // Unknown models still fall back to the conservative default.
            let (input, output) = model_price_per_1k("model-alpha");
            assert!(input > 0.0 && output > 0.0);
        });
    }

    #[test]
    fn provider_edit_updates_points_only_and_keeps_the_id() {
        with_sandbox_env(|dir| {
            let mut settings = NativeSettings::default();
            settings.add_provider(builtin_vexzy_provider()).unwrap();
            settings
                .set_active_provider(&ProviderId::new("vexzy".to_owned()).unwrap())
                .unwrap();
            seed_settings(dir, &settings);

            let code = run_dispatch_exit(vec![
                OsString::from("provider"),
                OsString::from("edit"),
                OsString::from("vexzy"),
                OsString::from("--name"),
                OsString::from("VEXZY Edited"),
                OsString::from("--protocol"),
                OsString::from("anthropic-compatible"),
                OsString::from("--base-url"),
                OsString::from("https://edited.example/v1"),
                OsString::from("--allowlist"),
                OsString::from("gpt-5.6-luna"),
            ]);
            assert_eq!(code, 0);
            let loaded = load_sandbox_settings(dir);
            let vexzy = loaded
                .provider(&ProviderId::new("vexzy".to_owned()).unwrap())
                .unwrap();
            assert_eq!(vexzy.name, "VEXZY Edited");
            assert_eq!(vexzy.protocol, Protocol::AnthropicCompatible);
            assert_eq!(vexzy.base_url, "https://edited.example/v1");
            assert_eq!(
                vexzy
                    .allowlist
                    .iter()
                    .map(ModelId::as_str)
                    .collect::<Vec<_>>(),
                ["gpt-5.6-luna"]
            );
            assert!(vexzy.active);
            assert_eq!(
                loaded.active_provider.as_ref().map(ProviderId::as_str),
                Some("vexzy")
            );

            let invalid = run_dispatch_exit(vec![
                OsString::from("provider"),
                OsString::from("edit"),
                OsString::from("vexzy"),
                OsString::from("--base-url"),
                OsString::from("nonsense"),
            ]);
            assert_eq!(invalid, 1);
            let after = load_sandbox_settings(dir);
            let vexzy = after
                .provider(&ProviderId::new("vexzy".to_owned()).unwrap())
                .unwrap();
            assert_eq!(vexzy.base_url, "https://edited.example/v1");
        });
    }

    #[test]
    fn settings_key_from_env_writes_only_the_store_and_prints_only_configured() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            let secret = "forge-native-test-secret";
            with_env_var("MINDCODE_TEST_KEY", secret, || {
                let code = run_dispatch_exit(vec![
                    OsString::from("settings"),
                    OsString::from("key"),
                    OsString::from("vexzy"),
                    OsString::from("--from-env"),
                    OsString::from("MINDCODE_TEST_KEY"),
                ]);
                assert_eq!(code, 0);
            });
            let raw_store = fs::read_to_string(sandbox_store_path(dir)).unwrap();
            assert!(raw_store.contains(secret));
            let raw_settings = fs::read_to_string(sandbox_settings_path(dir)).unwrap();
            assert!(!raw_settings.contains(secret));
            assert_eq!(SETTINGS_KEY_CONFIRMATION, "configured");
            assert!(!SETTINGS_KEY_CONFIRMATION.contains(secret));
            assert!(!SETTINGS_KEY_CONFIRMATION.contains("credentials.json"));
        });
    }

    #[test]
    fn settings_key_rejects_missing_and_empty_env_values() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            let missing = run_dispatch_exit(vec![
                OsString::from("settings"),
                OsString::from("key"),
                OsString::from("vexzy"),
                OsString::from("--from-env"),
                OsString::from("MINDCODE_ABSENT_KEY"),
            ]);
            assert_eq!(missing, 1);
            assert!(!sandbox_store_path(dir).exists());

            without_env_var("MINDCODE_EMPTY_KEY", || {
                env::set_var("MINDCODE_EMPTY_KEY", "");
                let empty = run_dispatch_exit(vec![
                    OsString::from("settings"),
                    OsString::from("key"),
                    OsString::from("vexzy"),
                    OsString::from("--from-env"),
                    OsString::from("MINDCODE_EMPTY_KEY"),
                ]);
                assert_eq!(empty, 1);
            });
            assert!(!sandbox_store_path(dir).exists());

            let invalid_id = run_dispatch_exit(vec![
                OsString::from("settings"),
                OsString::from("key"),
                OsString::from("bad id"),
                OsString::from("--from-env"),
                OsString::from("MINDCODE_TEST_KEY"),
            ]);
            assert_eq!(invalid_id, 1);
            assert!(!sandbox_store_path(dir).exists());
        });
    }

    #[test]
    fn read_credential_line_consumes_exactly_one_line_without_the_newline() {
        let mut input = Cursor::new("forge-stdin-secret\nignored");
        assert_eq!(
            read_credential_line(&mut input).unwrap(),
            "forge-stdin-secret"
        );
        let mut empty = Cursor::new("\n");
        assert_eq!(read_credential_line(&mut empty).unwrap(), "");
    }

    #[test]
    fn settings_allowlist_persists_and_unknown_provider_fails_closed() {
        with_sandbox_env(|dir| {
            let mut settings = NativeSettings::default();
            settings.add_provider(builtin_vexzy_provider()).unwrap();
            seed_settings(dir, &settings);

            let code = run_dispatch_exit(vec![
                OsString::from("settings"),
                OsString::from("allowlist"),
                OsString::from("vexzy"),
                OsString::from("gpt-5.6-luna,model-b"),
            ]);
            assert_eq!(code, 0);
            let loaded = load_sandbox_settings(dir);
            let vexzy = loaded
                .provider(&ProviderId::new("vexzy".to_owned()).unwrap())
                .unwrap();
            assert_eq!(
                vexzy
                    .allowlist
                    .iter()
                    .map(ModelId::as_str)
                    .collect::<Vec<_>>(),
                ["gpt-5.6-luna", "model-b"]
            );

            let missing = run_dispatch_exit(vec![
                OsString::from("settings"),
                OsString::from("allowlist"),
                OsString::from("ghost"),
                OsString::from("model-a"),
            ]);
            assert_eq!(missing, 1);
            let after = load_sandbox_settings(dir);
            let vexzy = after
                .provider(&ProviderId::new("vexzy".to_owned()).unwrap())
                .unwrap();
            assert_eq!(
                vexzy
                    .allowlist
                    .iter()
                    .map(ModelId::as_str)
                    .collect::<Vec<_>>(),
                ["gpt-5.6-luna", "model-b"]
            );
        });
    }

    #[test]
    fn settings_model_persists_and_rejects_invalid_ids() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            let code = run_dispatch_exit(vec![
                OsString::from("settings"),
                OsString::from("model"),
                OsString::from("gpt-5.6-luna"),
            ]);
            assert_eq!(code, 0);
            assert_eq!(
                load_sandbox_settings(dir).global_worker_model.as_deref(),
                Some("gpt-5.6-luna")
            );

            let invalid = run_dispatch_exit(vec![
                OsString::from("settings"),
                OsString::from("model"),
                OsString::from("bad model"),
            ]);
            assert_eq!(invalid, 1);
            assert_eq!(
                load_sandbox_settings(dir).global_worker_model.as_deref(),
                Some("gpt-5.6-luna")
            );
        });
    }

    #[test]
    fn settings_effort_lock_sets_unsets_and_rejects_invalid_values() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            let set = run_dispatch_exit(vec![
                OsString::from("settings"),
                OsString::from("effort"),
                OsString::from("lock"),
                OsString::from("high"),
            ]);
            assert_eq!(set, 0);
            assert_eq!(
                load_sandbox_settings(dir).worker_effort_lock,
                Some(WorkerEffort::High)
            );

            let off = run_dispatch_exit(vec![
                OsString::from("settings"),
                OsString::from("effort"),
                OsString::from("lock"),
                OsString::from("off"),
            ]);
            assert_eq!(off, 0);
            assert_eq!(load_sandbox_settings(dir).worker_effort_lock, None);

            let invalid = run_dispatch_exit(vec![
                OsString::from("settings"),
                OsString::from("effort"),
                OsString::from("lock"),
                OsString::from("auto"),
            ]);
            assert_eq!(invalid, 1);
            assert_eq!(load_sandbox_settings(dir).worker_effort_lock, None);
        });
    }

    #[test]
    fn settings_show_dump_is_secret_free() {
        with_sandbox_env(|dir| {
            let mut settings = NativeSettings {
                global_worker_model: Some("gpt-5.6-luna".to_owned()),
                worker_effort_lock: Some(WorkerEffort::Max),
                ..Default::default()
            };
            settings.add_provider(builtin_vexzy_provider()).unwrap();
            settings
                .add_provider(profile(
                    "custom-a",
                    "Custom A",
                    Protocol::OpenAiCompatible,
                    "https://custom.example/v1",
                    CredentialRef::Store("custom-a".to_owned()),
                    &[],
                ))
                .unwrap();
            settings
                .set_active_provider(&ProviderId::new("custom-a".to_owned()).unwrap())
                .unwrap();
            seed_settings(dir, &settings);
            let mut store = SecretStore::new();
            store.write(
                ProviderId::new("custom-a".to_owned()).unwrap(),
                SecretKey::new("forge-store-secret".to_owned()),
            );
            save_store(&sandbox_store_path(dir), &store).unwrap();

            let code = run_dispatch_exit(vec![OsString::from("settings"), OsString::from("show")]);
            assert_eq!(code, 0);
            let loaded = load_sandbox_settings(dir);
            let value = settings_show_value(&loaded, effective_active(&loaded, None));
            let text = serde_json::to_string(&value).unwrap();
            assert!(text.contains("\"active_provider\":\"custom-a\""));
            assert!(text.contains("\"global_worker_model\":\"gpt-5.6-luna\""));
            assert!(text.contains("\"worker_effort_lock\":\"max\""));
            assert!(text.contains("\"credential\":\"store:custom-a\""));
            assert!(text.contains("\"protocol\":\"openai-compatible\""));
            assert!(!text.contains("forge-store-secret"));
        });
    }

    #[test]
    fn provider_flag_selects_the_run_provider_without_persisting() {
        with_sandbox_env(|dir| {
            let mut settings = NativeSettings::default();
            settings.add_provider(builtin_vexzy_provider()).unwrap();
            settings
                .add_provider(profile(
                    "custom-a",
                    "Custom A",
                    Protocol::OpenAiCompatible,
                    "https://custom.example/v1",
                    CredentialRef::Env("CUSTOM_API_KEY".to_owned()),
                    &[],
                ))
                .unwrap();
            settings
                .set_active_provider(&ProviderId::new("vexzy".to_owned()).unwrap())
                .unwrap();
            seed_settings(dir, &settings);

            with_env_var("CUSTOM_API_KEY", "forge-custom-env-secret", || {
                let code = run_dispatch_exit(vec![
                    OsString::from("--provider"),
                    OsString::from("custom-a"),
                    OsString::from("auth"),
                    OsString::from("status"),
                ]);
                assert_eq!(code, 0);
            });
            let loaded = load_sandbox_settings(dir);
            assert_eq!(
                loaded.active_provider.as_ref().map(ProviderId::as_str),
                Some("vexzy")
            );
        });
    }

    #[test]
    fn provider_flag_unknown_id_fails_closed() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            let code = run_dispatch_exit(vec![
                OsString::from("--provider"),
                OsString::from("ghost"),
                OsString::from("auth"),
                OsString::from("status"),
            ]);
            assert_eq!(code, 1);
            let code = run_dispatch_exit(vec![
                OsString::from("auth"),
                OsString::from("status"),
                OsString::from("--provider=ghost"),
            ]);
            assert_eq!(code, 1);
        });
    }

    #[test]
    fn provider_flag_missing_value_fails_closed() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            let code = run_dispatch_exit(vec![OsString::from("--provider")]);
            assert_eq!(code, 1);
            let code =
                run_dispatch_exit(vec![OsString::from("--provider="), OsString::from("auth")]);
            assert_eq!(code, 1);
        });
    }

    #[test]
    fn auth_status_with_env_credential_is_configured_and_secret_free() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            let secret = "forge-auth-env-secret";
            without_env_var(API_KEY_ENV, || {
                with_env_var(API_KEY_ENV, secret, || {
                    let code =
                        run_dispatch_exit(vec![OsString::from("auth"), OsString::from("status")]);
                    assert_eq!(code, 0);
                });
            });
            let settings = load_sandbox_settings(dir);
            let provider = settings.active_provider_config().unwrap();
            let value = auth_status_value(provider, true);
            let text = serde_json::to_string(&value).unwrap();
            assert!(text.contains("\"credential\":\"configured\""));
            assert!(text.contains("\"authMethod\":\"provider_credential\""));
            assert!(text.contains("\"apiProvider\":\"vexzy\""));
            assert!(text.contains("\"id\":\"vexzy\""));
            assert!(text.contains("\"protocol\":\"openai-compatible\""));
            assert!(text.contains("\"credential\":\"env:VEXZY_API_KEY\""));
            assert!(!text.contains(secret));
            assert!(!text.contains("forge-"));
        });
    }

    #[test]
    fn auth_status_resolves_store_credentials() {
        with_sandbox_env(|dir| {
            let mut settings = NativeSettings::default();
            settings
                .add_provider(profile(
                    "custom-a",
                    "Custom A",
                    Protocol::AnthropicCompatible,
                    "https://custom.example/v1",
                    CredentialRef::Store("custom-a".to_owned()),
                    &[],
                ))
                .unwrap();
            settings
                .set_active_provider(&ProviderId::new("custom-a".to_owned()).unwrap())
                .unwrap();
            seed_settings(dir, &settings);
            let mut store = SecretStore::new();
            store.write(
                ProviderId::new("custom-a".to_owned()).unwrap(),
                SecretKey::new("forge-store-auth-secret".to_owned()),
            );
            save_store(&sandbox_store_path(dir), &store).unwrap();

            let code = run_dispatch_exit(vec![OsString::from("auth"), OsString::from("status")]);
            assert_eq!(code, 0);
            let settings = load_sandbox_settings(dir);
            let value = auth_status_value(settings.active_provider_config().unwrap(), true);
            let text = value.to_string();
            assert!(text.contains("\"apiProvider\":\"custom-a\""));
            assert!(text.contains("\"protocol\":\"anthropic-compatible\""));
            assert!(text.contains("\"credential\":\"store:custom-a\""));
            assert!(!text.contains("forge-store-auth-secret"));
        });
    }

    #[test]
    fn auth_status_missing_credential_fails_closed() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            without_env_var(API_KEY_ENV, || {
                let code =
                    run_dispatch_exit(vec![OsString::from("auth"), OsString::from("status")]);
                assert_eq!(code, 1);
            });
            let settings = load_sandbox_settings(dir);
            let value = auth_status_value(settings.active_provider_config().unwrap(), false);
            assert_eq!(value["credential"], "not configured");
            assert_eq!(value["authMethod"], "none");
            assert_eq!(value["loggedIn"], false);
        });
    }

    #[test]
    fn auth_status_without_any_active_provider_fails_closed() {
        with_sandbox_env(|dir| {
            // First-run seeds VEXZY active; remove it so no profile is
            // active, then the command fails closed regardless of any env
            // credential in the ambient environment.
            let mut settings = load_sandbox_settings(dir);
            settings
                .remove_provider(&ProviderId::new(BUILTIN_VEXZY_PROVIDER_ID.to_owned()).unwrap())
                .unwrap();
            seed_settings(dir, &settings);

            let code = run_dispatch_exit(vec![OsString::from("auth"), OsString::from("status")]);
            assert_eq!(code, 1);
            let code = run_dispatch_exit(vec![OsString::from("hello")]);
            assert_eq!(code, 1);
        });
    }

    fn catalog_fixture() -> String {
        json!({
            "object": "list",
            "data": [
                {
                    "id": "worker-tools",
                    "available": true,
                    "capabilities": {"tools": true},
                    "supported_reasoning_efforts": ["none", "medium", "max"]
                },
                {
                    "id": "worker-stale",
                    "available": false,
                    "capabilities": {"tools": true},
                    "supported_reasoning_efforts": ["max"]
                },
                {
                    "id": "worker-no-tools",
                    "available": true,
                    "capabilities": {"tools": false},
                    "supported_reasoning_efforts": ["max"]
                }
            ]
        })
        .to_string()
    }

    #[test]
    fn catalog_projection_lists_only_eligible_models_without_echoing_input() {
        let source = catalog_fixture();
        let output = eligible_models_output(&source).unwrap();
        assert_eq!(output["provider"], "vexzy");
        assert_eq!(output["models"][0]["id"], "worker-tools");
        assert_eq!(
            output["models"][0]["allowedEfforts"],
            json!(["none", "medium", "max"])
        );
        assert_eq!(output["models"].as_array().unwrap().len(), 1);
        assert!(!output.to_string().contains("supported_reasoning_efforts"));
    }

    #[test]
    fn worker_effort_validation_is_exact_and_supports_off() {
        let source = catalog_fixture();
        let off = worker_effort_output(&source, "worker-tools", Some("off")).unwrap();
        assert_eq!(off["workerEffortLock"], serde_json::Value::Null);
        let locked = worker_effort_output(&source, "worker-tools", Some("max")).unwrap();
        assert_eq!(locked["workerEffortLock"], "max");
        assert!(worker_effort_output(&source, "worker-tools", Some("low")).is_err());
        assert!(worker_effort_output(&source, "worker-stale", None).is_err());
        assert!(worker_effort_output(&source, "worker-tools", Some("auto")).is_err());
    }

    #[test]
    fn supplied_catalog_errors_and_outputs_never_echo_api_keys() {
        let secret = "forge-private-test-secret";
        let error = eligible_models_output(secret).unwrap_err();
        assert!(!error.contains(secret));
        assert_eq!(error, "supplied VEXZY catalog is invalid");
    }

    #[test]
    fn model_and_effort_parsers_accept_the_documented_subcommands() {
        let model = ModelArgs::try_parse_from([
            "mindcode model",
            "eligible",
            "--catalog",
            "{\"object\":\"list\",\"data\":[]}",
        ])
        .unwrap();
        assert!(matches!(model.command, ModelCommand::Eligible(_)));
        let effort = EffortArgs::try_parse_from([
            "mindcode effort",
            "worker",
            "--catalog",
            "{\"object\":\"list\",\"data\":[]}",
            "--model",
            "worker-tools",
            "--lock",
            "off",
        ])
        .unwrap();
        assert!(matches!(effort.command, EffortCommand::Worker(_)));
    }

    #[test]
    fn root_help_no_longer_claims_chat_is_unmigrated() {
        let help = RootArgs::command().render_long_help().to_string();
        assert!(!help.contains("not migrated"));
        assert!(help.contains("chat request through the active provider"));
    }

    #[test]
    fn removed_command_error_is_stable_bounded_and_marked() {
        for command in ["/config", "config", "/submodel", "submodel"] {
            let message = removed_command_error(command);
            assert!(message.contains("unknown_command"), "{message}");
            assert!(!message.contains("forge-"));
        }
        assert_eq!(
            removed_command_error("/config"),
            removed_command_error("/config")
        );
    }

    #[tokio::test]
    async fn removed_slash_commands_exit_one_without_a_prompt_path() {
        for command in ["/config", "/submodel", "/settings", "/help"] {
            let code = dispatch(vec![OsString::from(command)]).await.unwrap();
            assert_eq!(code, 1, "{command} must exit 1");
        }
    }

    #[tokio::test]
    async fn removed_plain_commands_exit_one_without_a_prompt_path() {
        for command in ["config", "submodel"] {
            let code = dispatch(vec![OsString::from(command)]).await.unwrap();
            assert_eq!(code, 1, "{command} must exit 1");
        }
    }

    #[tokio::test]
    async fn unknown_slash_commands_are_not_mistaken_for_native_flags() {
        let code = dispatch(vec![OsString::from("/version")]).await.unwrap();
        assert_eq!(code, 1);
    }

    #[test]
    fn tui_args_accept_session_id() {
        let args = TuiArgs::try_parse_from(["mindcode tui", "--session-id", "abc"]).unwrap();
        assert_eq!(args.session_id.as_deref(), Some("abc"));
        let args = TuiArgs::try_parse_from(["mindcode tui"]).unwrap();
        assert!(args.session_id.is_none());
    }

    #[test]
    fn tui_socket_path_joins_home_runtime_dir() {
        with_sandbox_env(|dir| {
            assert_eq!(
                tui_socket_path("abc"),
                dir.join(".mindcode/run/native-tui-abc.sock")
            );
        });
    }

    #[test]
    fn tui_snapshot_keeps_hint_until_first_turn() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            let empty = tui_snapshot(&[], SessionStats::default(), &[]);
            assert_eq!(empty.transcript.len(), 1);
            let TranscriptInput::Entry { role, text, .. } = &empty.transcript[0] else {
                panic!("expected hint entry");
            };
            assert_eq!(role, "system");
            assert!(text.contains("MindCode"));
            assert!(text.contains("/help"));

            let mut transcript = TuiTranscript::default();
            transcript.push("user", "hi");
            let populated = tui_snapshot(&transcript.entries, SessionStats::default(), &[]);
            assert_eq!(populated.transcript.len(), 1);
        });
    }

    #[test]
    fn tui_snapshot_marks_the_client_as_writer_not_observer() {
        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            // The projection defaults to `observer` when the mode is omitted;
            // the native TUI is always the writer, otherwise the composer is
            // rendered read-only and input is rejected.
            assert_eq!(
                tui_snapshot(&[], SessionStats::default(), &[])
                    .writer
                    .mode
                    .as_deref(),
                Some("writer")
            );
        });
    }

    #[test]
    fn tui_slash_provider_remove_allowlist_and_status_commands() {
        with_sandbox_env(|dir| {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                seed_builtin_active(dir);
                let mut settings = load_sandbox_settings(dir);
                settings
                    .add_provider(profile(
                        "custom",
                        "Custom",
                        Protocol::OpenAiCompatible,
                        "http://127.0.0.1:1/v1",
                        CredentialRef::env("CUSTOM_KEY"),
                        &["m1"],
                    ))
                    .unwrap();
                seed_settings(dir, &settings);
                let mut transcript = TuiTranscript::default();

                // /provider remove removes the profile.
                assert!(
                    dispatch_tui_input("/provider remove custom", &mut transcript)
                        .await
                        .unwrap()
                );
                let id = ProviderId::new("custom".to_owned()).unwrap();
                assert!(load_sandbox_settings(dir).provider(&id).is_none());

                // Re-add with an empty allowlist, then /allowlist sets and clears.
                let mut settings = load_sandbox_settings(dir);
                settings
                    .add_provider(profile(
                        "custom",
                        "Custom",
                        Protocol::OpenAiCompatible,
                        "http://127.0.0.1:1/v1",
                        CredentialRef::env("CUSTOM_KEY"),
                        &[],
                    ))
                    .unwrap();
                seed_settings(dir, &settings);
                assert!(
                    dispatch_tui_input("/allowlist custom m1,m2", &mut transcript)
                        .await
                        .unwrap()
                );
                let loaded = load_sandbox_settings(dir);
                let provider = loaded.provider(&id).unwrap();
                assert_eq!(provider.allowlist.len(), 2);
                assert!(dispatch_tui_input("/allowlist custom", &mut transcript)
                    .await
                    .unwrap());
                let loaded = load_sandbox_settings(dir);
                let provider = loaded.provider(&id).unwrap();
                assert!(provider.allowlist.is_empty());

                // /eligible on the catalog-driven VEXZY active profile.
                assert!(dispatch_tui_input("/eligible", &mut transcript)
                    .await
                    .unwrap());
                let TranscriptInput::Entry { text, .. } = transcript.entries.last().unwrap() else {
                    panic!("expected entry");
                };
                assert!(text.contains("vexzy"));

                // /auth resolves fail-closed without a key and stays secret-free.
                let had_vexzy_key = env::var_os("VEXZY_API_KEY");
                env::remove_var("VEXZY_API_KEY");
                assert!(dispatch_tui_input("/auth", &mut transcript).await.unwrap());
                match had_vexzy_key {
                    Some(value) => env::set_var("VEXZY_API_KEY", value),
                    None => env::remove_var("VEXZY_API_KEY"),
                }
                let TranscriptInput::Entry { text, .. } = transcript.entries.last().unwrap() else {
                    panic!("expected entry");
                };
                assert!(text.contains("not logged in"));
                assert!(!text.contains("forge-"));

                // /settings summary reflects the persisted state.
                assert!(dispatch_tui_input("/settings", &mut transcript)
                    .await
                    .unwrap());
                let TranscriptInput::Entry { text, .. } = transcript.entries.last().unwrap() else {
                    panic!("expected entry");
                };
                assert!(text.contains("active provider: vexzy"));

                // /doctor, /setup-token and /update are transcript lines.
                assert!(dispatch_tui_input("/doctor", &mut transcript)
                    .await
                    .unwrap());
                assert!(dispatch_tui_input("/setup-token", &mut transcript)
                    .await
                    .unwrap());
                assert!(dispatch_tui_input("/update", &mut transcript)
                    .await
                    .unwrap());
                let TranscriptInput::Entry { text, .. } = transcript.entries.last().unwrap() else {
                    panic!("expected entry");
                };
                assert!(text.contains("Current version"));
            });
        });
    }

    #[test]
    fn tui_transcript_sequences_entries_in_order() {
        let mut transcript = TuiTranscript::default();
        transcript.push("user", "hi");
        transcript.push("assistant", "hello");
        assert_eq!(transcript.entries.len(), 2);
        let TranscriptInput::Entry {
            sequence,
            role,
            text,
        } = &transcript.entries[0]
        else {
            panic!("expected entry");
        };
        assert_eq!(*sequence, 0);
        assert_eq!(role, "user");
        assert_eq!(text, "hi");
        let TranscriptInput::Entry { sequence, role, .. } = &transcript.entries[1] else {
            panic!("expected entry");
        };
        assert_eq!(*sequence, 1);
        assert_eq!(role, "assistant");
    }

    #[test]
    fn tui_slash_model_and_effort_persist_and_report() {
        with_sandbox_env(|dir| {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                seed_builtin_active(dir);
                let mut transcript = TuiTranscript::default();

                assert!(dispatch_tui_input("/model gpt-5.6-luna", &mut transcript)
                    .await
                    .unwrap());
                assert_eq!(
                    load_sandbox_settings(dir).global_worker_model.as_deref(),
                    Some("gpt-5.6-luna")
                );
                let TranscriptInput::Entry { text, .. } = transcript.entries.last().unwrap() else {
                    panic!("expected entry");
                };
                assert!(text.contains("gpt-5.6-luna"));

                assert!(dispatch_tui_input("/effort max", &mut transcript)
                    .await
                    .unwrap());
                assert_eq!(
                    load_sandbox_settings(dir).worker_effort_lock,
                    Some(WorkerEffort::Max)
                );
                assert!(dispatch_tui_input("/effort off", &mut transcript)
                    .await
                    .unwrap());
                assert_eq!(load_sandbox_settings(dir).worker_effort_lock, None);

                // An invalid effort level is a secret-free error, not a state change.
                assert!(dispatch_tui_input("/effort nope", &mut transcript)
                    .await
                    .is_err());
                assert_eq!(load_sandbox_settings(dir).worker_effort_lock, None);
            });
        });
    }

    #[test]
    fn tui_slash_provider_use_switches_active_profile() {
        with_sandbox_env(|dir| {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                seed_builtin_active(dir);
                let mut settings = load_sandbox_settings(dir);
                settings
                    .add_provider(profile(
                        "custom",
                        "Custom",
                        Protocol::OpenAiCompatible,
                        "http://127.0.0.1:1/v1",
                        CredentialRef::env("CUSTOM_KEY"),
                        &["m1"],
                    ))
                    .unwrap();
                seed_settings(dir, &settings);

                let mut transcript = TuiTranscript::default();
                assert!(dispatch_tui_input("/provider use custom", &mut transcript)
                    .await
                    .unwrap());
                assert_eq!(
                    load_sandbox_settings(dir)
                        .active_provider
                        .as_ref()
                        .map(ProviderId::as_str),
                    Some("custom")
                );
                let TranscriptInput::Entry { text, .. } = transcript.entries.last().unwrap() else {
                    panic!("expected entry");
                };
                assert!(text.contains("custom"));
            });
        });
    }

    #[test]
    fn tui_slash_help_and_unknown_are_transcript_lines() {
        with_sandbox_env(|dir| {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                seed_builtin_active(dir);
                let mut transcript = TuiTranscript::default();
                assert!(dispatch_tui_input("/help", &mut transcript).await.unwrap());
                assert!(dispatch_tui_input("/nope", &mut transcript).await.unwrap());
                assert!(!dispatch_tui_input("   ", &mut transcript).await.unwrap());
                assert_eq!(transcript.entries.len(), 2);
                let TranscriptInput::Entry { text, .. } = &transcript.entries[0] else {
                    panic!("expected entry");
                };
                assert!(text.contains("Commands"));
                let TranscriptInput::Entry { text, .. } = &transcript.entries[1] else {
                    panic!("expected entry");
                };
                assert!(text.contains("unknown command"));
            });
        });
    }

    /// §11.5 MESSAGE_VOICE: user-facing strings stay in the user's terms.  The
    /// internal machinery (approval gates, dispatch, tiers) keeps its precise
    /// names in logs and code, but the transcript must not leak them.
    #[test]
    fn user_facing_strings_avoid_jargon() {
        // `status_line` reads settings, so pin it to a sandbox to avoid leaking
        // a real profile id/base_url into the jargon assertion.
        with_sandbox_env(|_dir| {
            const FORBIDDEN: &[&str] = &["gate", "armed", "dispatch", "continuation", "flag"];
            let user_facing = [
                TUI_HELP.to_owned(),
                status_line(&SessionStats::default()),
                worker_report_text(&WorkerReport {
                    status: WorkerStatus::Success,
                    summary: "fixed the parser bug".to_owned(),
                    ..Default::default()
                }),
            ];
            for text in user_facing {
                let lower = text.to_lowercase();
                for word in FORBIDDEN {
                    let contains_word = lower
                        .split(|character: char| !character.is_alphanumeric())
                        .any(|part| part == *word);
                    assert!(
                        !contains_word,
                        "user-facing text leaks internal jargon '{word}': {text}"
                    );
                }
            }
        });
    }

    #[test]
    fn tui_slash_permissions_sets_and_reports_the_session_tier() {
        with_sandbox_env(|dir| {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                seed_builtin_active(dir);
                let mut transcript = TuiTranscript::default();
                let mut tier = PermissionTier::default();

                // Default tier is the safest.
                assert_eq!(tier, PermissionTier::AskEverything);
                dispatch_tui_input_streaming(
                    "/permissions workspace",
                    &mut transcript,
                    |_| {},
                    &mut tier,
                )
                .await
                .unwrap();
                assert_eq!(tier, PermissionTier::Workspace);

                // Reporting the tier echoes the current value without changing it.
                dispatch_tui_input_streaming("/permissions", &mut transcript, |_| {}, &mut tier)
                    .await
                    .unwrap();
                assert_eq!(tier, PermissionTier::Workspace);
                let TranscriptInput::Entry { text, .. } = &transcript.entries[1] else {
                    panic!("expected entry");
                };
                assert!(text.contains("workspace"));

                // An invalid tier is rejected and leaves the tier untouched.
                let error = dispatch_tui_input_streaming(
                    "/permissions everything",
                    &mut transcript,
                    |_| {},
                    &mut tier,
                )
                .await
                .unwrap_err();
                assert!(error.to_string().contains("invalid permission tier"));
                assert_eq!(tier, PermissionTier::Workspace);
            });
        });
    }

    #[test]
    fn slash_command_parses_work_and_ignores_plain_input() {
        assert_eq!(
            slash_command("/work migrate the crate"),
            Some(("work", "migrate the crate"))
        );
        assert_eq!(slash_command(" /work  x "), Some(("work", "x")));
        assert_eq!(
            slash_command("/permissions workspace"),
            Some(("permissions", "workspace"))
        );
        assert_eq!(slash_command("plain prompt"), None);
        assert_eq!(slash_command(""), None);
    }

    #[test]
    fn pending_permission_inputs_projects_registered_requests_as_pending() {
        let pending = Arc::new(Mutex::new(PendingApprovals::default()));
        let (sender, _receiver) = oneshot::channel();
        pending.lock().unwrap().requests.insert(
            "perm-0".to_owned(),
            PendingApproval {
                worker_id: "worker-1".to_owned(),
                tool: "shell".to_owned(),
                target: "cargo test".to_owned(),
                requested_at_ms: 42,
                sender,
            },
        );
        let inputs = pending_permission_inputs(&pending);
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].id.as_deref(), Some("perm-0"));
        assert_eq!(inputs[0].status.as_deref(), Some("pending"));
        assert_eq!(inputs[0].tool.as_deref(), Some("shell"));
        // Secret-free: no credential material can appear in a permission prompt.
        assert!(!inputs[0].reason.as_deref().unwrap_or("").contains("sk-"));
    }

    #[test]
    fn worker_report_text_renders_a_structured_secret_free_summary() {
        use mindcode_worker::CommandRun;
        let report = WorkerReport {
            id: "worker-7".into(),
            status: WorkerStatus::Success,
            summary: "migrated".into(),
            files_read: vec!["src/a.rs".into()],
            files_changed: vec!["src/b.rs".into()],
            commands_run: vec![CommandRun {
                command: "cargo fmt".into(),
                exit_code: Some(0),
                output_len: 12,
            }],
            deviations: vec!["none".into()],
            risks: Vec::new(),
            usage: WorkerUsage {
                input_tokens: 10,
                output_tokens: 5,
                cached_tokens: 0,
                cost: 0.25,
            },
            elapsed_ms: 1500,
            ..Default::default()
        };
        let text = worker_report_text(&report);
        assert!(text.contains("worker-7"));
        assert!(text.contains("done in 1.5s"));
        assert!(text.contains("↑10 ↓5"));
        assert!(text.contains("changed: src/b.rs"));
        assert!(!text.contains("sk-"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tui_control_server_serves_snapshot_over_a_unix_socket() {
        use mindcode_protocol::ui::{
            decode_ui_frame, encode_ui_frame, UiMessage, UI_PROTOCOL_VERSION,
        };

        let temp = tempdir().unwrap();
        let socket = temp.path().join("native-tui-smoke.sock");
        let server = ControlServer::new(
            ControlServerConfig::new("smoke".to_owned(), socket.clone()),
            None,
        )
        .unwrap();
        server.start().await.unwrap();
        let _ = server.publish(&ProjectionInput::default()).await;

        let client_socket = socket.clone();
        let messages = tokio::task::spawn_blocking(move || {
            use std::io::{Read, Write};
            use std::os::unix::net::UnixStream;
            let mut stream = UnixStream::connect(&client_socket).unwrap();
            let handshake = encode_ui_frame(&UiMessage::Handshake {
                version: UI_PROTOCOL_VERSION,
                id: "smoke".to_owned(),
                client: "mindcode-tui".to_owned(),
                capabilities: [
                    "render_snapshot",
                    "input",
                    "resize",
                    "shutdown",
                    "mouse",
                    "action",
                ]
                .iter()
                .map(|value| value.to_string())
                .collect(),
            })
            .unwrap();
            stream.write_all(&handshake).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut buffer = Vec::new();
            let mut messages = Vec::new();
            loop {
                let mut chunk = [0_u8; 4096];
                let count = stream.read(&mut chunk).unwrap();
                buffer.extend_from_slice(&chunk[..count]);
                while buffer.len() >= 4 {
                    let payload = u32::from_be_bytes(buffer[..4].try_into().unwrap()) as usize;
                    if buffer.len() < 4 + payload {
                        break;
                    }
                    let frame: Vec<u8> = buffer.drain(..4 + payload).collect();
                    messages.push(decode_ui_frame(&frame).unwrap());
                }
                if messages
                    .iter()
                    .any(|message| matches!(message, UiMessage::RenderSnapshot { .. }))
                {
                    break;
                }
            }
            messages
        })
        .await
        .unwrap();

        assert!(messages
            .iter()
            .any(|message| matches!(message, UiMessage::Capabilities { .. })));
        assert!(messages
            .iter()
            .any(|message| matches!(message, UiMessage::RenderSnapshot { .. })));

        server.close().await;
    }

    #[test]
    fn tui_composer_submit_round_trips_through_the_socket() {
        use mindcode_protocol::ui::{
            decode_ui_frame, encode_ui_frame, UiActionInput, UiInputEventKind, UiMessage,
            UI_PROTOCOL_VERSION,
        };

        with_sandbox_env(|dir| {
            seed_builtin_active(dir);
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                let temp = tempdir().unwrap();
                let socket = temp.path().join("native-tui-composer.sock");

                // The same wiring as `run_tui`: handler -> channel -> processor
                // that dispatches composer submissions and republishes.
                let (action_tx, mut action_rx) =
                    tokio::sync::mpsc::unbounded_channel::<UiActionInput>();
                let handler: InputHandler = Arc::new(move |message| {
                    if let UiMessage::InputEvent {
                        event: UiInputEventKind::Action(action),
                        ..
                    } = message
                    {
                        let _ = action_tx.send(action);
                    }
                });
                let server = ControlServer::new(
                    ControlServerConfig::new("composer".to_owned(), socket.clone()),
                    Some(handler),
                )
                .unwrap();
                server.start().await.unwrap();
                let _ = server
                    .publish(&tui_snapshot(&[], SessionStats::default(), &[]))
                    .await;

                let processor_server = server.clone();
                let processor = tokio::spawn(async move {
                    let mut transcript = TuiTranscript::default();
                    while let Some(action) = action_rx.recv().await {
                        if action.action == "composer_submit" {
                            let Some(text) = action.value else { continue };
                            let _ = dispatch_tui_input(&text, &mut transcript).await;
                            let _ = processor_server
                                .publish(&tui_snapshot(
                                    &transcript.entries,
                                    SessionStats::default(),
                                    &[],
                                ))
                                .await;
                        }
                    }
                });

                let client_socket = socket.clone();
                let reply = tokio::task::spawn_blocking(move || {
                    use std::io::{Read, Write};
                    use std::os::unix::net::UnixStream;
                    let mut stream = UnixStream::connect(&client_socket).unwrap();
                    let handshake = encode_ui_frame(&UiMessage::Handshake {
                        version: UI_PROTOCOL_VERSION,
                        id: "composer".to_owned(),
                        client: "mindcode-tui".to_owned(),
                        capabilities: [
                            "render_snapshot",
                            "input",
                            "resize",
                            "shutdown",
                            "mouse",
                            "action",
                        ]
                        .iter()
                        .map(|value| value.to_string())
                        .collect(),
                    })
                    .unwrap();
                    stream.write_all(&handshake).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut buffer = Vec::new();
                    let mut messages: Vec<UiMessage> = Vec::new();
                    let mut sent = false;
                    for _ in 0..400 {
                        let mut chunk = [0_u8; 4096];
                        let count = stream.read(&mut chunk).unwrap();
                        buffer.extend_from_slice(&chunk[..count]);
                        while buffer.len() >= 4 {
                            let payload =
                                u32::from_be_bytes(buffer[..4].try_into().unwrap()) as usize;
                            if buffer.len() < 4 + payload {
                                break;
                            }
                            let frame: Vec<u8> = buffer.drain(..4 + payload).collect();
                            messages.push(decode_ui_frame(&frame).unwrap());
                        }
                        let has_snapshot = messages
                            .iter()
                            .any(|message| matches!(message, UiMessage::RenderSnapshot { .. }));
                        if !sent && has_snapshot {
                            let input = UiMessage::InputEvent {
                                version: UI_PROTOCOL_VERSION,
                                id: "composer".to_owned(),
                                sequence: 1,
                                event: UiInputEventKind::Action(UiActionInput {
                                    action: "composer_submit".to_owned(),
                                    target: None,
                                    value: Some("/model gpt-5.6-luna".to_owned()),
                                }),
                            };
                            stream.write_all(&encode_ui_frame(&input).unwrap()).unwrap();
                            sent = true;
                            continue;
                        }
                        if sent {
                            for message in &messages {
                                if let UiMessage::RenderSnapshot { transcript, .. } = message {
                                    for block in transcript {
                                        if let mindcode_protocol::ui::UiTranscriptBlock::Markdown(
                                            markdown,
                                        ) = block
                                        {
                                            if markdown.text.contains("worker model set to") {
                                                return markdown.text.clone();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    panic!("no composer_submit reply received");
                })
                .await
                .unwrap();

                assert!(reply.contains("gpt-5.6-luna"));
                assert_eq!(
                    load_sandbox_settings(dir).global_worker_model.as_deref(),
                    Some("gpt-5.6-luna")
                );
                processor.abort();
                server.close().await;
            });
        });
    }

    #[test]
    fn chat_args_parse_prompt_and_model() {
        let args =
            ChatArgs::try_parse_from(["mindcode chat", "--model", "m1", "hello", "world"]).unwrap();
        assert_eq!(args.model.as_deref(), Some("m1"));
        assert_eq!(args.prompt, vec!["hello", "world"]);
    }

    #[test]
    fn select_chat_model_precedence_and_fail_closed() {
        let mut settings = NativeSettings::default();
        let custom = profile(
            "custom-a",
            "Custom",
            Protocol::AnthropicCompatible,
            "https://c.example/v1",
            CredentialRef::Store("custom-a".to_owned()),
            &["model-a", "model-b"],
        );
        assert_eq!(
            select_chat_model(&settings, &custom, Some("override")).unwrap(),
            "override"
        );
        assert_eq!(
            select_chat_model(&settings, &custom, None).unwrap(),
            "model-a"
        );
        settings.global_worker_model = Some("global-model".to_owned());
        assert_eq!(
            select_chat_model(&settings, &custom, None).unwrap(),
            "global-model"
        );
        let vexzy = builtin_vexzy_provider();
        assert_eq!(
            select_chat_model(&NativeSettings::default(), &vexzy, None).unwrap(),
            "gpt-5.6-luna"
        );
        let empty = profile(
            "empty",
            "Empty",
            Protocol::OpenAiCompatible,
            "https://e.example/v1",
            CredentialRef::Env("E".to_owned()),
            &[],
        );
        assert!(select_chat_model(&NativeSettings::default(), &empty, None).is_err());
    }
}
