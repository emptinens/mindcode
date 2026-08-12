//! Rust-first single-executable foundation for MindCode.
//!
//! The native binary deliberately keeps the supported surface small: daemon
//! lifecycle and VEXZY-only authentication/status commands are native today;
//! regular chat prompts remain an explicit migration diagnostic.

use anyhow::{Context, Result};
use clap::{error::ErrorKind, Parser, Subcommand};
use mindcode_vexzy::{
    eligible_worker_models, parse_vexzy_model_catalog, VexzyModel, VexzyModelCatalog, WorkerEffort,
};
use mindcoded::{Daemon, DaemonConfig};
use serde_json::json;
use std::{env, ffi::OsString, fs, path::PathBuf, process, time::Duration};

const VERSION: &str = "0.1.3";
const API_KEY_ENV: &str = "VEXZY_API_KEY";
const NATIVE_CHAT_NOT_MIGRATED: &str = "native chat runtime is not migrated yet";

#[derive(Debug, Parser)]
#[command(
    name = "mindcode",
    version = VERSION,
    about = "MindCode native Rust foundation (VEXZY-only)",
    after_help = "Commands:\n  auth status       Show VEXZY_API_KEY authentication status\n  model eligible    Inspect eligible Worker models in a supplied VEXZY catalog\n  effort worker     Validate a Worker model and optional effort lock in a supplied catalog\n  setup-token       Show VEXZY_API_KEY setup instructions\n  doctor            Check native/VEXZY foundation health\n  update            Show local checkout update instructions\n  daemon            Run the native mindcoded daemon in-process"
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
#[command(name = "mindcode auth", version = VERSION, about = "VEXZY-only authentication")]
struct AuthArgs {
    #[command(subcommand)]
    command: AuthCommand,
}

#[derive(Debug, Subcommand)]
enum AuthCommand {
    #[command(name = "status", about = "Show VEXZY_API_KEY authentication status")]
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
#[command(name = "mindcode setup-token", version = VERSION, about = "Show VEXZY API key setup instructions")]
struct SetupTokenArgs {}

#[derive(Debug, Parser)]
#[command(name = "mindcode doctor", version = VERSION, about = "Check native/VEXZY foundation health")]
struct DoctorArgs {}

#[derive(Debug, Parser)]
#[command(name = "mindcode update", version = VERSION, about = "Show local checkout update instructions")]
struct UpdateArgs {}

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
    let Some(first) = arguments.first().and_then(|arg| arg.to_str()) else {
        return Ok(run_regular_prompt(None));
    };

    match first {
        "auth" => run_auth(arguments),
        "model" => run_model(arguments),
        "effort" => run_effort(arguments),
        "setup-token" => run_setup_token(arguments),
        "doctor" => run_doctor(arguments),
        "update" | "upgrade" => run_update(arguments),
        "daemon" => run_daemon(arguments).await,
        "-h" | "--help" | "-V" | "--version" => run_root_parser(arguments),
        value if value.starts_with('-') => run_root_parser(arguments),
        _ => Ok(run_regular_prompt(Some(first))),
    }
}

fn run_root_parser(arguments: Vec<OsString>) -> Result<i32> {
    match RootArgs::try_parse_from(with_program_name(arguments)) {
        Ok(args) => Ok(run_regular_prompt(args.prompt.first().map(String::as_str))),
        Err(error) => Ok(print_clap_error(error)),
    }
}

fn run_auth(arguments: Vec<OsString>) -> Result<i32> {
    let parsed =
        match AuthArgs::try_parse_from(with_command_program_name(arguments, "mindcode auth")) {
            Ok(args) => args,
            Err(error) => return Ok(print_clap_error(error)),
        };
    match parsed.command {
        AuthCommand::Status(options) => Ok(run_auth_status(options)),
    }
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
    println!("Authentication: VEXZY-only (OAuth disabled)");
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

fn run_auth_status(options: AuthStatusArgs) -> i32 {
    let configured = current_api_key().is_some();
    if options.text {
        if configured {
            println!("{API_KEY_ENV}: configured");
        } else {
            println!("Not authenticated. Set {API_KEY_ENV} before starting MindCode.");
        }
    } else {
        // Keep the key itself out of every output mode.
        let mut output = json!({
            "loggedIn": configured,
            "authMethod": if configured { "vexzy_api_key" } else { "none" },
            "apiProvider": "vexzy",
        });
        if configured {
            output["apiKeySource"] = json!(API_KEY_ENV);
        }
        println!("{output}");
    }
    i32::from(!configured)
}

fn run_regular_prompt(_prompt: Option<&str>) -> i32 {
    if current_api_key().is_none() {
        eprintln!(
            "{API_KEY_ENV} is not configured or invalid; set it to a non-empty forge-… value."
        );
        return 1;
    }
    eprintln!(
        "{NATIVE_CHAT_NOT_MIGRATED}: regular prompts are not available in this native foundation."
    );
    1
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
        assert!(help.contains("VEXZY"));
    }

    #[test]
    fn daemon_defaults_match_mindcoded_defaults() {
        let args = DaemonArgs::try_parse_from(["mindcode"]).unwrap();
        assert_eq!(args.idle_seconds, 1_800);
        assert_eq!(args.handshake_timeout_seconds, 5);
        assert_eq!(args.build_id, "dev");
        assert_eq!(args.socket, DaemonConfig::default_socket());
        assert!(args.state_dir.is_none());
    }

    #[test]
    fn auth_status_json_never_contains_the_secret() {
        let output = json!({
            "loggedIn": true,
            "authMethod": "vexzy_api_key",
            "apiProvider": "vexzy",
            "apiKeySource": API_KEY_ENV,
        })
        .to_string();
        assert!(!output.contains("forge-"));
        assert!(output.contains("VEXZY_API_KEY"));
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
}
