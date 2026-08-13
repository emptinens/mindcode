//! Rust-first single-executable foundation for MindCode.
//!
//! The native binary deliberately keeps the supported surface small: daemon
//! lifecycle, multi-provider profile management, secret-free settings
//! persistence, and provider-aware authentication status are native today;
//! regular chat prompts remain an explicit migration diagnostic.

use anyhow::{anyhow, Context, Result};
use clap::{error::ErrorKind, Parser, Subcommand};
use futures_util::StreamExt;
use mindcode_provider::{
    default_store_path, load_store, save_store, CredentialRef, ModelId, Protocol, ProviderConfig,
    ProviderId, SecretKey,
};
use mindcode_settings::{default_settings_path, load_settings, save_settings, NativeSettings};
use mindcode_transport::{ChatCompletionsRequest, ChatMessage, MessagesRequest, Transport};
use mindcode_tui::TuiConfig;
use mindcode_tui_server::{
    ConnectionInput, ControlServer, ControlServerConfig, ProjectionInput, StatusInput,
    TelemetryInput,
};
use mindcode_vexzy::{
    eligible_worker_models, parse_vexzy_model_catalog, VexzyModel, VexzyModelCatalog, WorkerEffort,
};
use mindcoded::{Daemon, DaemonConfig};
use serde_json::{json, Value};
use std::{env, ffi::OsString, fs, io, io::BufRead, path::PathBuf, process, time::Duration};

const VERSION: &str = "0.1.3";
const API_KEY_ENV: &str = "VEXZY_API_KEY";
const NATIVE_CHAT_NOT_MIGRATED: &str = "native chat runtime is not migrated yet";
/// The only stdout write of `settings key`; asserting the constant guarantees
/// the credential value and the store path can never be echoed.
const SETTINGS_KEY_CONFIRMATION: &str = "configured";

#[derive(Debug, Parser)]
#[command(
    name = "mindcode",
    version = VERSION,
    about = "MindCode native Rust foundation (multi-provider)",
    after_help = "Commands:\n  auth status       Show active provider authentication status\n  model eligible    Inspect eligible Worker models in a supplied VEXZY catalog\n  effort worker     Validate a Worker model and optional effort lock in a supplied catalog\n  provider          Manage provider profiles (list, use, add, remove, edit)\n  settings          Manage settings (show, key, allowlist, model, effort lock)\n  setup-token       Show VEXZY_API_KEY setup instructions\n  doctor            Check native/VEXZY foundation health\n  update            Show local checkout update instructions\n  daemon            Run the native mindcoded daemon in-process\n  tui               Run the native terminal interface\n  chat              Complete a chat request through the active provider"
)]
struct RootArgs {
    #[arg(
        value_name = "PROMPT",
        trailing_var_arg = true,
        help = "Regular prompt (chat runtime is not migrated yet)"
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
        return run_regular_prompt(None, run_active.as_ref());
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
        "-h" | "--help" | "-V" | "--version" => run_root_parser(arguments, run_active.as_ref()),
        value if value.starts_with('-') => run_root_parser(arguments, run_active.as_ref()),
        // Removed TUI commands surface as a stable unknown-command error
        // before any prompt path runs. No alias or hidden route is registered.
        "config" | "submodel" => run_removed_command(first),
        value if value.starts_with('/') => run_removed_command(value),
        _ => run_regular_prompt(Some(first), run_active.as_ref()),
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

fn run_root_parser(arguments: Vec<OsString>, run_active: Option<&ProviderId>) -> Result<i32> {
    match RootArgs::try_parse_from(with_program_name(arguments)) {
        Ok(args) => run_regular_prompt(args.prompt.first().map(String::as_str), run_active),
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

fn run_setup_token(arguments: Vec<OsString>) -> Result<i32> {
    if let Err(error) =
        SetupTokenArgs::try_parse_from(with_command_program_name(arguments, "mindcode setup-token"))
    {
        return Ok(print_clap_error(error));
    }
    println!(
        "VEXZY authentication uses VEXZY_API_KEY.\n\nSet it in your shell:\n  export VEXZY_API_KEY=\"forge-…\"\n\nThe legacy OAuth setup flow is not used by MindCode."
    );
    Ok(0)
}

fn run_doctor(arguments: Vec<OsString>) -> Result<i32> {
    if let Err(error) =
        DoctorArgs::try_parse_from(with_command_program_name(arguments, "mindcode doctor"))
    {
        return Ok(print_clap_error(error));
    }
    let configured = current_api_key().is_some();
    println!("MindCode native doctor");
    println!(
        "{API_KEY_ENV}: {}",
        if configured {
            "configured"
        } else {
            "not configured"
        }
    );
    println!("Authentication: multi-provider (env -> secret store, fail-closed)");
    println!("Daemon: available (in-process mindcoded::Daemon)");
    println!("Chat runtime: {NATIVE_CHAT_NOT_MIGRATED}");
    Ok(0)
}

fn run_update(arguments: Vec<OsString>) -> Result<i32> {
    if let Err(error) =
        UpdateArgs::try_parse_from(with_command_program_name(arguments, "mindcode update"))
    {
        return Ok(print_clap_error(error));
    }
    println!("Current version: {VERSION}");
    println!("MindCode uses the local Git checkout for updates; no remote updater is configured.");
    println!("Apply changes in the local MindCode repository, then rebuild the local bundle.");
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
    let server = ControlServer::new(
        ControlServerConfig::new(session_id.clone(), &socket_path),
        None,
    )
    .map_err(anyhow::Error::msg)?;
    server.start().await.map_err(anyhow::Error::msg)?;
    let _ = server.publish(&tui_initial_input()).await;

    let tui_config = TuiConfig {
        control_socket: socket_path,
        session_id,
    };
    let outcome = tokio::task::spawn_blocking(move || mindcode_tui::run(tui_config)).await;
    server.close().await;
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
    let prompt = args.prompt.join(" ");
    let settings = load_native_settings()?;
    let Some(provider) = run_active_provider_config(&settings, run_active) else {
        return Err(anyhow!("no active provider is configured"));
    };
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
    let model = select_chat_model(
        &settings,
        provider,
        args.model.as_deref().or(run_worker_model),
    )?;
    let transport = Transport::new(&provider.base_url).map_err(anyhow::Error::msg)?;

    match provider.protocol {
        Protocol::OpenAiCompatible => {
            let request = ChatCompletionsRequest {
                model,
                messages: vec![ChatMessage {
                    role: "user".to_owned(),
                    content: prompt,
                }],
                max_tokens: None,
                temperature: None,
            };
            let stream = transport
                .chat_completions(&key, &request)
                .map_err(anyhow::Error::msg)?;
            futures_util::pin_mut!(stream);
            while let Some(item) = stream.next().await {
                let chunk = item.map_err(anyhow::Error::msg)?;
                for choice in chunk.choices {
                    if let Some(content) = choice.delta.content {
                        print!("{content}");
                    }
                }
            }
        }
        Protocol::AnthropicCompatible => {
            let request = MessagesRequest {
                model,
                max_tokens: 1024,
                messages: vec![ChatMessage {
                    role: "user".to_owned(),
                    content: prompt,
                }],
                system: None,
                temperature: None,
            };
            let stream = transport
                .messages(&key, &request)
                .map_err(anyhow::Error::msg)?;
            futures_util::pin_mut!(stream);
            while let Some(item) = stream.next().await {
                let chunk = item.map_err(anyhow::Error::msg)?;
                if let Some(delta) = chunk.delta {
                    if let Some(text) = delta.text {
                        print!("{text}");
                    }
                }
                if let Some(block) = chunk.content_block {
                    if let Some(text) = block.text {
                        print!("{text}");
                    }
                }
            }
        }
    }
    println!();
    Ok(0)
}

fn run_regular_prompt(_prompt: Option<&str>, run_active: Option<&ProviderId>) -> Result<i32> {
    let settings = load_native_settings()?;
    let Some(provider) = run_active_provider_config(&settings, run_active) else {
        eprintln!("mindcode: no active provider is configured");
        return Ok(1);
    };
    let store = load_store(&native_store_path()?).map_err(anyhow::Error::msg)?;
    if store
        .resolve(&provider.credential, |name| env::var(name).ok())
        .is_err()
    {
        eprintln!(
            "mindcode: credential for provider '{}' is not configured ({})",
            provider.id,
            credential_ref_kind(provider)
        );
        return Ok(1);
    }
    eprintln!(
        "{NATIVE_CHAT_NOT_MIGRATED}: regular prompts are not available in this native foundation."
    );
    Ok(1)
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
        assert!(help.contains("VEXZY"));
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
    fn regular_prompt_diagnostic_is_explicit() {
        assert_eq!(
            NATIVE_CHAT_NOT_MIGRATED,
            "native chat runtime is not migrated yet"
        );
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
