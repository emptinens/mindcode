//! The agentic worker loop: drive the worker model, execute its tool calls
//! through the scope + guard, gate approvals through the [`ApprovalGate`], and
//! fold the whole run into a structured [`WorkerReport`].

use crate::error::{WorkerError, WorkerResult};
use crate::guard::OwnershipGuard;
use crate::hooks::{run_pre_tool, HookDecision, HookSet};
use crate::permission::PermissionTier;
use crate::report::{CommandRun, WorkerReport, WorkerStatus};
use crate::risk::{classify, ShellRisk};
use crate::scope::WorkerScope;
use crate::tools;
use mindcode_core_tools::ProcessRunResult;
use mindcode_transport::{ChatMessage, ChatUsage, ToolCall, ToolCallFunction, ToolSpec};
use serde_json::Value;
use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

pub type DecisionFuture = Pin<Box<dyn Future<Output = ApprovalDecision> + Send>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalDecision {
    AllowOnce,
    AllowWorker,
    Deny,
}

#[derive(Clone, Debug)]
pub struct ApprovalRequest {
    pub worker_id: String,
    pub tool: String,
    pub target: String,
}

/// Decides how to resolve a tool call that the permission guard flagged as
/// needing approval. The real TUI implements an interactive prompt; tests use
/// [`DenyAllGate`] / [`AllowAllGate`].
pub trait ApprovalGate: Send + Sync {
    fn decide(&self, request: ApprovalRequest) -> DecisionFuture;
}

pub struct DenyAllGate;

impl ApprovalGate for DenyAllGate {
    fn decide(&self, _request: ApprovalRequest) -> DecisionFuture {
        Box::pin(async { ApprovalDecision::Deny })
    }
}

pub struct AllowAllGate;

impl ApprovalGate for AllowAllGate {
    fn decide(&self, _request: ApprovalRequest) -> DecisionFuture {
        Box::pin(async { ApprovalDecision::AllowOnce })
    }
}

/// One tool call the worker model requested, with its arguments parsed.
#[derive(Clone, Debug)]
pub struct ResolvedToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// One completed model turn: text, tool calls, and token/cost usage.
#[derive(Clone, Debug, Default)]
pub struct ModelTurn {
    pub text: String,
    pub tool_calls: Vec<ResolvedToolCall>,
    pub usage: ChatUsage,
    pub cost: f64,
}

/// The protocol-agnostic model client the loop drives. Implemented over the
/// real [`mindcode_transport::Transport`] in the native binary; mocked in tests.
pub trait ModelClient: Send + Sync {
    fn turn(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = WorkerResult<ModelTurn>> + Send>>;
}

pub const DEFAULT_MAX_ITERATIONS: usize = 32;

const DEFAULT_WORKER_SYSTEM_PROMPT: &str = "\
You are a MindCode worker agent. Complete the task by calling the available \
tools. Touch only files inside your ownership scope, never read credentials, \
and finish with a concise summary of what you changed and why.";

/// The worker tools exposed to the model (§10.4.3, §11.10).
pub fn default_tool_defs() -> Vec<ToolSpec> {
    let object = |properties: Value| -> Value {
        serde_json::json!({
            "type": "object",
            "properties": properties,
        })
    };
    vec![
        ToolSpec {
            name: "read_file".to_owned(),
            description: "Read a workspace-relative file (capped)".to_owned(),
            parameters: object(serde_json::json!({"path": {"type": "string"}})),
        },
        ToolSpec {
            name: "write_file".to_owned(),
            description: "Write (replace) a workspace-relative file".to_owned(),
            parameters: object(serde_json::json!({
                "path": {"type": "string"},
                "content": {"type": "string"},
            })),
        },
        ToolSpec {
            name: "append_file".to_owned(),
            description: "Append to a workspace-relative file".to_owned(),
            parameters: object(serde_json::json!({
                "path": {"type": "string"},
                "content": {"type": "string"},
            })),
        },
        ToolSpec {
            name: "run_shell".to_owned(),
            description: "Run a shell command in the workspace".to_owned(),
            parameters: object(
                serde_json::json!({"argv": {"type": "array", "items": {"type": "string"}}}),
            ),
        },
        ToolSpec {
            name: "git".to_owned(),
            description: "Run a read-only git subcommand".to_owned(),
            parameters: object(
                serde_json::json!({"args": {"type": "array", "items": {"type": "string"}}}),
            ),
        },
        ToolSpec {
            name: "rg".to_owned(),
            description: "Search the workspace with ripgrep".to_owned(),
            parameters: object(serde_json::json!({
                "pattern": {"type": "string"},
                "path": {"type": "string"},
            })),
        },
        ToolSpec {
            name: "todo".to_owned(),
            description: "Track this worker's own task list (list/add/check/uncheck/clear)"
                .to_owned(),
            parameters: object(serde_json::json!({
                "action": {"type": "string"},
                "item": {"type": "string"},
            })),
        },
        ToolSpec {
            name: "agentgrep".to_owned(),
            description:
                "Context-aware search: directory outline plus matches with context, adaptively trimmed"
                    .to_owned(),
            parameters: object(serde_json::json!({
                "query": {"type": "string"},
                "path": {"type": "string"},
            })),
        },
    ]
}

/// The orchestration unit: model client, approval gate, ownership scope, and
/// permission guard. One agent == one worker == one disjoint scope.
pub struct WorkerAgent {
    worker_id: String,
    client: Arc<dyn ModelClient>,
    gate: Arc<dyn ApprovalGate>,
    scope: WorkerScope,
    guard: OwnershipGuard,
    todos: Mutex<crate::tools::TodoList>,
    reflected_shell: Mutex<HashSet<String>>,
    hooks: Option<Arc<HookSet>>,
    tools: Vec<ToolSpec>,
    system_prompt: String,
    max_iterations: usize,
}

impl WorkerAgent {
    pub fn new(
        worker_id: impl Into<String>,
        client: Arc<dyn ModelClient>,
        gate: Arc<dyn ApprovalGate>,
        scope: WorkerScope,
        guard: OwnershipGuard,
    ) -> Self {
        Self {
            worker_id: worker_id.into(),
            client,
            gate,
            scope,
            guard,
            todos: Mutex::new(crate::tools::TodoList::default()),
            reflected_shell: Mutex::new(HashSet::new()),
            hooks: None,
            tools: default_tool_defs(),
            system_prompt: DEFAULT_WORKER_SYSTEM_PROMPT.to_owned(),
            max_iterations: DEFAULT_MAX_ITERATIONS,
        }
    }

    pub fn with_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.system_prompt = prompt.into();
        self
    }

    pub fn with_tools(mut self, tools: Vec<ToolSpec>) -> Self {
        self.tools = tools;
        self
    }

    pub fn with_max_iterations(mut self, limit: usize) -> Self {
        self.max_iterations = limit;
        self
    }

    /// Install a `pre_tool` hook set (§11.4). Hooks gate worker tools only.
    pub fn with_hooks(mut self, hooks: HookSet) -> Self {
        self.hooks = Some(Arc::new(hooks));
        self
    }

    /// Run the worker to completion (or until cancel/timeout), returning the
    /// structured report. Never panics; every failure folds into the report.
    pub async fn run(&self, task: &str, cancel: CancellationToken) -> WorkerReport {
        let started = Instant::now();
        let mut report = WorkerReport {
            id: self.worker_id.clone(),
            ..Default::default()
        };
        let mut messages = vec![
            ChatMessage {
                role: "system".to_owned(),
                content: self.system_prompt.clone(),
                ..Default::default()
            },
            ChatMessage {
                role: "user".to_owned(),
                content: task.to_owned(),
                ..Default::default()
            },
        ];
        let mut allow_worker: Option<String> = None;
        let mut finished = false;

        for _ in 0..self.max_iterations {
            if cancel.is_cancelled() {
                report.status = WorkerStatus::Cancelled;
                break;
            }
            let turn = match self
                .client
                .turn(&messages, &self.tools, cancel.clone())
                .await
            {
                Ok(turn) => turn,
                Err(error) => {
                    report.status = WorkerStatus::Failed;
                    report.deviations.push(error.to_string());
                    break;
                }
            };
            report.usage.input_tokens += turn.usage.input_tokens;
            report.usage.output_tokens += turn.usage.output_tokens;
            report.usage.cached_tokens += turn.usage.cached_read_tokens;
            report.usage.cost += turn.cost;

            if turn.tool_calls.is_empty() {
                report.summary = turn.text.trim().to_owned();
                report.status = WorkerStatus::Success;
                finished = true;
                break;
            }

            messages.push(ChatMessage {
                role: "assistant".to_owned(),
                content: turn.text.clone(),
                tool_calls: turn
                    .tool_calls
                    .iter()
                    .map(|call| ToolCall {
                        id: call.id.clone(),
                        kind: "function".to_owned(),
                        function: ToolCallFunction {
                            name: Some(call.name.clone()),
                            arguments: Some(call.arguments.to_string()),
                        },
                    })
                    .collect(),
                ..Default::default()
            });

            for call in &turn.tool_calls {
                if cancel.is_cancelled() {
                    report.status = WorkerStatus::Cancelled;
                    break;
                }
                let (result, command) = self
                    .execute_tool(call, &mut allow_worker, &mut report, cancel.clone())
                    .await;
                if let Some(command) = command {
                    report.commands_run.push(command);
                }
                messages.push(ChatMessage {
                    role: "tool".to_owned(),
                    content: result,
                    tool_result_id: Some(call.id.clone()),
                    ..Default::default()
                });
            }
            if cancel.is_cancelled() {
                report.status = WorkerStatus::Cancelled;
                break;
            }
        }

        if !finished && report.status == WorkerStatus::Success {
            report.status = WorkerStatus::Failed;
            report
                .risks
                .push("iteration limit reached without a final answer".to_owned());
        }
        report.elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        report
    }

    async fn execute_tool(
        &self,
        call: &ResolvedToolCall,
        allow_worker: &mut Option<String>,
        report: &mut WorkerReport,
        cancel: CancellationToken,
    ) -> (String, Option<CommandRun>) {
        let outcome = self
            .execute_tool_inner(call, allow_worker, report, cancel.clone())
            .await;
        match outcome {
            Ok(result) => result,
            Err(WorkerError::Denied { path }) => (format!("denied: {}", path.display()), None),
            Err(WorkerError::RiskDenied { command }) => {
                (format!("denied: catastrophic shell risk: {command}"), None)
            }
            Err(WorkerError::HookBlocked(reason)) => {
                (format!("blocked by hook: {reason}"), None)
            }
            Err(WorkerError::OutOfScope { path }) => {
                (format!("out of scope: {}", path.display()), None)
            }
            Err(WorkerError::NeedsApproval { path }) => {
                (format!("approval denied: {}", path.display()), None)
            }
            Err(WorkerError::Cancelled) => ("cancelled".to_owned(), None),
            Err(error) => (format!("error: {error}"), None),
        }
    }

    async fn execute_tool_inner(
        &self,
        call: &ResolvedToolCall,
        allow_worker: &mut Option<String>,
        report: &mut WorkerReport,
        cancel: CancellationToken,
    ) -> WorkerResult<(String, Option<CommandRun>)> {
        // §11.4: the pre_tool hook gate runs before every worker tool call and
        // sees a secret-free payload. A block becomes a tool error.
        if let Some(hooks) = &self.hooks {
            let scope = if self.scope.is_all() {
                serde_json::Value::String("*".to_owned())
            } else {
                serde_json::json!(self.scope.entries())
            };
            let payload = serde_json::json!({
                "tool": &call.name,
                "args": &call.arguments,
                "worker_id": &self.worker_id,
                "scope": scope,
            });
            if let HookDecision::Block(reason) = run_pre_tool(hooks, &payload, &cancel).await {
                return Err(WorkerError::HookBlocked(reason));
            }
        }
        match call.name.as_str() {
            "read_file" => {
                let path = arg_path(&call.arguments)?;
                self.authorize_file(&path, false, &call.name, allow_worker)
                    .await?;
                let guard = self.exec_guard();
                let result =
                    tools::read_file(&self.scope, &guard, Path::new(&path), &cancel).await?;
                report.files_read.push(path);
                Ok((
                    if result.truncated {
                        format!("{}…\n[truncated]", result.content)
                    } else {
                        result.content
                    },
                    None,
                ))
            }
            "write_file" => {
                let path = arg_path(&call.arguments)?;
                let content = arg_content(&call.arguments)?;
                self.authorize_file(&path, true, &call.name, allow_worker)
                    .await?;
                let guard = self.exec_guard();
                let written =
                    tools::write_file(&self.scope, &guard, Path::new(&path), &content, &cancel)
                        .await?;
                report.files_changed.push(path);
                Ok((format!("wrote {written} bytes"), None))
            }
            "append_file" => {
                let path = arg_path(&call.arguments)?;
                let content = arg_content(&call.arguments)?;
                self.authorize_file(&path, true, &call.name, allow_worker)
                    .await?;
                let guard = self.exec_guard();
                let written =
                    tools::append_file(&self.scope, &guard, Path::new(&path), &content, &cancel)
                        .await?;
                report.files_changed.push(path);
                Ok((format!("appended {written} bytes"), None))
            }
            "run_shell" => {
                let argv = arg_strings(&call.arguments, "argv")?;
                let command = argv.join(" ");
                // §11.1 risk filter runs before the ownership guard and before
                // execution: `Deny` is fail-closed, `Confirm` needs one
                // reflection turn, `Safe` goes through the normal tier gate.
                match classify(&command) {
                    ShellRisk::Deny => {
                        return Err(WorkerError::RiskDenied { command });
                    }
                    ShellRisk::Confirm => {
                        // Tier 3 (full-access) is not reflection-gated by
                        // definition (§11.1); only `Deny`/ProtectedPaths stay
                        // fail-closed there. Tiers 1–2 require exactly one
                        // reflection turn before the re-issued command runs.
                        if self.guard.tier() != PermissionTier::FullAccess
                            && !self.mark_reflected(&command)?
                        {
                            return Ok((reflection_prompt(&command), None));
                        }
                    }
                    ShellRisk::Safe => {
                        self.authorize_command(&call.name, &command, allow_worker)
                            .await?;
                    }
                }
                let guard = self.exec_guard();
                let result = tools::run_shell(&guard, &argv, &cancel).await?;
                Ok((
                    process_result_text(&result),
                    Some(command_run(&argv, &result)),
                ))
            }
            "git" => {
                let args = arg_strings(&call.arguments, "args")?;
                self.authorize_command(&call.name, &args.join(" "), allow_worker)
                    .await?;
                let guard = self.exec_guard();
                let output = tools::run_git(&guard, &args, &cancel).await?;
                let mut argv = vec!["git".to_owned()];
                argv.extend(args);
                Ok((
                    output.clone(),
                    Some(CommandRun {
                        command: argv.join(" "),
                        exit_code: Some(0),
                        output_len: output.len() as u64,
                    }),
                ))
            }
            "rg" => {
                let pattern = arg_string(&call.arguments, "pattern")?;
                let path = arg_optional_string(&call.arguments, "path");
                if let Some(path) = &path {
                    self.authorize_file(path, false, &call.name, allow_worker)
                        .await?;
                } else {
                    self.authorize_command(&call.name, &pattern, allow_worker)
                        .await?;
                }
                let guard = self.exec_guard();
                let output = tools::run_rg(
                    &self.scope,
                    &guard,
                    &pattern,
                    path.as_deref().map(Path::new),
                    &cancel,
                )
                .await?;
                Ok((output, None))
            }
            "todo" => {
                let action = arg_string(&call.arguments, "action")?;
                let item = arg_optional_string(&call.arguments, "item");
                let mut todos = self.todos.lock().map_err(|_| {
                    WorkerError::InvalidRequest("todo list is poisoned".to_owned())
                })?;
                let rendered = todos.apply(&action, item.as_deref())?;
                Ok((rendered, None))
            }
            "agentgrep" => {
                let query = arg_string(&call.arguments, "query")?;
                let path = arg_optional_string(&call.arguments, "path");
                if let Some(path) = &path {
                    self.authorize_file(path, false, &call.name, allow_worker)
                        .await?;
                } else {
                    self.authorize_command(&call.name, &query, allow_worker)
                        .await?;
                }
                let guard = self.exec_guard();
                let output = tools::run_agentgrep(
                    &self.scope,
                    &guard,
                    &query,
                    path.as_deref().map(Path::new),
                    &cancel,
                )
                .await?;
                Ok((output, None))
            }
            other => Err(WorkerError::InvalidRequest(format!(
                "unknown tool '{other}'"
            ))),
        }
    }

    /// Decide a file-path action against the real tier; on `NeedsApproval`,
    /// consult the gate (cached by tool name via `allow_worker`).
    async fn authorize_file(
        &self,
        path: &str,
        write: bool,
        tool_name: &str,
        allow_worker: &mut Option<String>,
    ) -> WorkerResult<()> {
        match tools::resolve_path(&self.scope, &self.guard, Path::new(path), write) {
            Ok(_) => Ok(()),
            Err(WorkerError::NeedsApproval { path }) => {
                if self
                    .approve(tool_name, &path.display().to_string(), allow_worker)
                    .await
                {
                    Ok(())
                } else {
                    Err(WorkerError::NeedsApproval { path })
                }
            }
            Err(error) => Err(error),
        }
    }

    /// Decide a command-based action (shell/git/whole-workspace rg).
    async fn authorize_command(
        &self,
        tool_name: &str,
        target: &str,
        allow_worker: &mut Option<String>,
    ) -> WorkerResult<()> {
        match self.guard.check_command() {
            crate::guard::ToolAccess::Allowed => Ok(()),
            crate::guard::ToolAccess::NeedsApproval => {
                if self.approve(tool_name, target, allow_worker).await {
                    Ok(())
                } else {
                    Err(WorkerError::NeedsApproval {
                        path: self.guard.workspace_root().to_path_buf(),
                    })
                }
            }
            crate::guard::ToolAccess::Denied => Err(WorkerError::Denied {
                path: self.guard.workspace_root().to_path_buf(),
            }),
        }
    }

    /// Record that a risky shell command has been reflected on (§11.1).
    /// Returns `true` when the command was already reflected (the re-issued
    /// call that may run), `false` when this is the first time the model has
    /// been shown the risk.
    fn mark_reflected(&self, command: &str) -> WorkerResult<bool> {
        let mut set = self.reflected_shell.lock().map_err(|_| {
            WorkerError::InvalidRequest("shell risk state is poisoned".to_owned())
        })?;
        Ok(!set.insert(command.to_owned()))
    }

    async fn approve(
        &self,
        tool_name: &str,
        target: &str,
        allow_worker: &mut Option<String>,
    ) -> bool {
        if allow_worker.as_deref() == Some(tool_name) {
            return true;
        }
        let request = ApprovalRequest {
            worker_id: self.worker_id.clone(),
            tool: tool_name.to_owned(),
            target: target.to_owned(),
        };
        match self.gate.decide(request).await {
            ApprovalDecision::AllowOnce => true,
            ApprovalDecision::AllowWorker => {
                *allow_worker = Some(tool_name.to_owned());
                true
            }
            ApprovalDecision::Deny => false,
        }
    }

    /// The guard used for execution after the agent has made its decision:
    /// full-access so the tool's internal check does not re-prompt, while the
    /// credential deny-list is still enforced.
    fn exec_guard(&self) -> OwnershipGuard {
        let mut guard = self.guard.clone();
        guard.set_tier(PermissionTier::FullAccess);
        guard
    }
}

fn arg_path(arguments: &Value) -> WorkerResult<String> {
    arg_string(arguments, "path")
}

fn arg_content(arguments: &Value) -> WorkerResult<String> {
    arg_string(arguments, "content")
}

fn arg_string(arguments: &Value, key: &str) -> WorkerResult<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| WorkerError::InvalidRequest(format!("missing string argument '{key}'")))
}

fn arg_optional_string(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
}

fn arg_strings(arguments: &Value, key: &str) -> WorkerResult<Vec<String>> {
    arguments
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<String>>()
        })
        .filter(|items| !items.is_empty())
        .ok_or_else(|| WorkerError::InvalidRequest(format!("missing array argument '{key}'")))
}

/// The tool result shown to the model for a `Confirm`-classified shell command
/// (§11.1): ask it to reflect and re-issue only if it still wants to run.
fn reflection_prompt(command: &str) -> String {
    format!(
        "risk: this shell command needs a reflection turn before execution:\n  {command}\n\
         Re-evaluate whether it is safe, necessary, and inside your scope. If you still want to\n\
         run it, call run_shell again with the same arguments; otherwise abandon it."
    )
}

fn process_result_text(result: &ProcessRunResult) -> String {
    let mut text = result.stdout.clone();
    if !result.stderr.is_empty() {
        text.push_str("\n[stderr] ");
        text.push_str(&result.stderr);
    }
    if result.timed_out {
        text.push_str("\n[timed out]");
    }
    if result.truncated {
        text.push_str("\n[truncated]");
    }
    text
}

fn command_run(argv: &[String], result: &ProcessRunResult) -> CommandRun {
    CommandRun {
        command: argv.join(" "),
        exit_code: result.exit_code,
        output_len: result.stdout.len() as u64 + result.stderr.len() as u64,
    }
}
