//! Durable SQLite task graph state for MindCode.
//!
//! The state object is synchronous by design.  `mindcoded` runs every method
//! through `tokio::task::spawn_blocking`; keeping all SQLite handles on the
//! blocking side makes cancellation a transaction boundary rather than a
//! partially-applied mutation.

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use uuid::Uuid;

pub mod session_index;
pub use session_index::{
    SessionIndex, SessionIndexConfig, SessionListOptions, SessionRecord, SessionSearchOptions,
};

pub mod harness_import;
pub use harness_import::{
    import_session, HarnessImportError, ImportedMessage, ImportedSession, ResumeTarget,
};

pub mod ares;
pub use ares::{ares_classify, AresDecision, AresSignals};

pub mod dag_preset;
pub use dag_preset::{
    fix_node_for, validate_dag, DagNode, DagPreset, DagValidationError, NodeKind, NodeStatus,
    VerifyArtifact,
};

pub mod memory_graph;
pub use memory_graph::{
    contains_credential_shaped, Embedder, HashingEmbedder, MemoryError, MemoryRecord, MemoryScope,
    MemorySearchResult, MemoryStore, MemoryType,
};

pub mod preference;
pub use preference::{PreferenceLearner, PreferenceSignal, DEFAULT_MIN_OBSERVATIONS};

pub const TASK_GRAPH_SCHEMA_VERSION: u64 = 3;
pub const SQLITE_BUSY_TIMEOUT_MS: u64 = 5_000;
pub const DEFAULT_LEASE_TTL_MS: u64 = 30_000;
pub const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const TARGET_SCOPE_PREFIX: &str = ".mindcode-target-scope/";
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS task_graph_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO task_graph_meta(key, value) VALUES ('graph_version', '0');
INSERT OR IGNORE INTO task_graph_meta(key, value) VALUES ('schema_version', '3');

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'blocked', 'cancelled')),
  owner TEXT,
  kind TEXT NOT NULL DEFAULT 'implement' CHECK (kind IN ('research', 'implement', 'verify', 'integrate')),
  effort TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  priority INTEGER NOT NULL DEFAULT 0,
  blocked_by TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blocked_by)),
  claimed_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  files_touched TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_touched)),
  read_set TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(read_set)),
  write_set TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(write_set)),
  isolation TEXT NOT NULL DEFAULT 'shared' CHECK (isolation IN ('shared', 'worktree')),
  sets_explicit INTEGER NOT NULL DEFAULT 0 CHECK (sets_explicit IN (0, 1)),
  lease_id TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  policy_epoch INTEGER NOT NULL DEFAULT 0 CHECK (policy_epoch >= 0),
  policy_digest TEXT CHECK (
    policy_digest IS NULL OR
    (length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*')
  ),
  report_id TEXT
);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner);
CREATE INDEX IF NOT EXISTS tasks_lease_idx ON tasks(lease_id);

CREATE TABLE IF NOT EXISTS task_leases (
  lease_id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS task_leases_active_task_idx
  ON task_leases(task_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS task_leases_expiry_idx
  ON task_leases(expires_at) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS task_idempotency (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    Claimed,
    Running,
    Completed,
    Failed,
    Blocked,
    Cancelled,
}

impl TaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Claimed => "claimed",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "claimed" => Self::Claimed,
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "blocked" => Self::Blocked,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }

    fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Research,
    Implement,
    Verify,
    Integrate,
}

impl TaskKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Research => "research",
            Self::Implement => "implement",
            Self::Verify => "verify",
            Self::Integrate => "integrate",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "research" => Self::Research,
            "implement" => Self::Implement,
            "verify" => Self::Verify,
            "integrate" => Self::Integrate,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskEffort {
    None,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl TaskEffort {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "none" => Self::None,
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            "xhigh" => Self::Xhigh,
            "max" => Self::Max,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskIsolation {
    Shared,
    Worktree,
}

impl TaskIsolation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Shared => "shared",
            Self::Worktree => "worktree",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "shared" => Self::Shared,
            "worktree" => Self::Worktree,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ConflictMode {
    #[default]
    Block,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskRecord {
    pub id: String,
    pub status: TaskStatus,
    pub owner: Option<String>,
    pub kind: TaskKind,
    pub effort: TaskEffort,
    pub priority: i64,
    pub blocked_by: Vec<String>,
    pub claimed_at: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub files_touched: Vec<String>,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
    pub isolation: TaskIsolation,
    pub lease_id: Option<String>,
    pub version: u64,
    pub policy_epoch: u64,
    pub policy_digest: Option<String>,
    pub report_id: Option<String>,
}

fn deserialize_optional_nullable_digest<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskInput {
    pub id: Option<String>,
    pub status: Option<TaskStatus>,
    pub owner: Option<String>,
    pub kind: Option<TaskKind>,
    pub effort: Option<TaskEffort>,
    pub priority: Option<i64>,
    pub blocked_by: Option<Vec<String>>,
    pub depends_on: Option<Vec<String>>,
    pub claimed_at: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub files_touched: Option<Vec<String>>,
    pub read_set: Option<Vec<String>>,
    pub write_set: Option<Vec<String>>,
    pub isolation: Option<TaskIsolation>,
    pub lease_id: Option<String>,
    pub policy_epoch: Option<u64>,
    /// `None` means the field was omitted; `Some(None)` is an explicit null.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_nullable_digest"
    )]
    pub policy_digest: Option<Option<String>>,
    pub report_id: Option<String>,
    #[serde(alias = "idempotencyKey")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClaimOptions {
    pub lease_id: Option<String>,
    pub ttl_ms: Option<u64>,
    pub expected_version: Option<u64>,
    pub now: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ListOptions {
    pub status: Option<Vec<TaskStatus>>,
    pub owner: Option<Option<String>>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskLease {
    pub lease_id: String,
    pub task_id: String,
    pub owner: String,
    pub acquired_at: String,
    pub expires_at: String,
    pub released_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlapConflict {
    pub task_id: String,
    pub paths: Vec<String>,
    pub kinds: Vec<String>,
    pub existing_isolation: TaskIsolation,
    pub new_isolation: TaskIsolation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlapDecision {
    pub action: String,
    pub allowed: bool,
    pub mode: ConflictMode,
    pub isolation: TaskIsolation,
    pub conflicts: Vec<OverlapConflict>,
    pub blocked_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteResult {
    pub task: Option<TaskRecord>,
    pub created: bool,
    pub decision: OverlapDecision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimSuccess {
    pub ok: bool,
    pub task: TaskRecord,
    pub lease: TaskLease,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimFailure {
    pub ok: bool,
    pub reason: String,
    pub task: Option<TaskRecord>,
    pub blocked_by: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_version: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ClaimResult {
    Success(ClaimSuccess),
    Failure(ClaimFailure),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryResult {
    pub expired_leases: Vec<TaskLease>,
    pub recovered_tasks: Vec<TaskRecord>,
    pub leases: Vec<TaskLease>,
    pub tasks: Vec<TaskRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskGraphSnapshot {
    pub version: u64,
    pub graph_version: u64,
    pub captured_at: String,
    pub tasks: Vec<TaskRecord>,
}

#[derive(Debug, Clone)]
pub struct TaskGraphConfig {
    pub state_dir: PathBuf,
    pub lease_ttl_ms: u64,
}

impl TaskGraphConfig {
    pub fn from_env() -> Self {
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let home = env::var_os("HOME").map(PathBuf::from);
        let config_dir = resolve_mindcode_config_dir(
            env::var("MINDCODE_CONFIG_DIR").ok().as_deref(),
            home.as_deref(),
            &cwd,
        );
        Self {
            state_dir: config_dir.join("state"),
            lease_ttl_ms: DEFAULT_LEASE_TTL_MS,
        }
    }

    pub fn with_state_dir(state_dir: impl Into<PathBuf>) -> Self {
        Self {
            state_dir: state_dir.into(),
            ..Self::from_env()
        }
    }
}

/// Resolve MINDCODE_CONFIG_DIR using the same lexical rules as the TypeScript
/// fallback: trim whitespace, expand `~` and `~/`, and resolve relative paths
/// against the current working directory without touching the filesystem.
pub fn resolve_mindcode_config_dir(
    configured: Option<&str>,
    home: Option<&Path>,
    cwd: &Path,
) -> PathBuf {
    let configured = configured.map(str::trim).filter(|value| !value.is_empty());
    let home = home.unwrap_or(cwd);
    let raw = configured.unwrap_or("~/.mindcode");
    let expanded = if raw == "~" {
        home.to_path_buf()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(raw)
    };
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    };
    normalize_absolute_path(absolute)
}

fn normalize_absolute_path(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = normalized.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

impl Default for TaskGraphConfig {
    fn default() -> Self {
        Self::from_env()
    }
}

#[derive(Debug, Clone)]
pub enum StateError {
    InvalidTask(String),
    InvalidSession(String),
    TaskNotFound(String),
    DuplicateTask(String),
    DependencyNotFound {
        task_id: String,
        dependency_id: String,
    },
    DependencyCycle(Vec<String>),
    VersionConflict {
        task_id: String,
        expected: u64,
        actual: u64,
    },
    LeaseConflict(String),
    LeaseOwnerMismatch(String),
    DatabaseClosed,
    Io(String),
    Sqlite(String),
}

impl StateError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidTask(_) => "INVALID_TASK",
            Self::InvalidSession(_) => "INVALID_SESSION",
            Self::TaskNotFound(_) => "TASK_NOT_FOUND",
            Self::DuplicateTask(_) => "DUPLICATE_TASK",
            Self::DependencyNotFound { .. } => "DEPENDENCY_NOT_FOUND",
            Self::DependencyCycle(_) => "DEPENDENCY_CYCLE",
            Self::VersionConflict { .. } => "VERSION_CONFLICT",
            Self::LeaseConflict(_) => "LEASE_CONFLICT",
            Self::LeaseOwnerMismatch(_) => "LEASE_OWNER_MISMATCH",
            Self::DatabaseClosed => "DATABASE_CLOSED",
            Self::Io(_) => "STATE_IO",
            Self::Sqlite(_) => "DATABASE_ERROR",
        }
    }
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTask(message) | Self::InvalidSession(message) => write!(f, "{message}"),
            Self::TaskNotFound(id) => write!(f, "Task does not exist: {id}"),
            Self::DuplicateTask(id) => write!(f, "Task already exists: {id}"),
            Self::DependencyNotFound {
                task_id,
                dependency_id,
            } => {
                write!(
                    f,
                    "Task {task_id} references missing dependency {dependency_id}"
                )
            }
            Self::DependencyCycle(cycle) => {
                write!(f, "Dependency cycle rejected: {}", cycle.join(" -> "))
            }
            Self::VersionConflict {
                task_id,
                expected,
                actual,
            } => {
                write!(
                    f,
                    "Version conflict for {task_id}: expected {expected}, actual {actual}"
                )
            }
            Self::LeaseConflict(id) => write!(f, "Lease is already in use: {id}"),
            Self::LeaseOwnerMismatch(id) => write!(f, "Lease owner mismatch: {id}"),
            Self::DatabaseClosed => write!(f, "Task graph database is closed"),
            Self::Io(message) | Self::Sqlite(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for StateError {}

impl From<rusqlite::Error> for StateError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error.to_string())
    }
}

impl From<std::io::Error> for StateError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

pub type StateResult<T> = Result<T, StateError>;

#[derive(Debug, Clone)]
struct TaskWithSets {
    task: TaskRecord,
    explicit_sets: bool,
}

#[derive(Debug, Clone)]
struct TaskRow {
    task: TaskRecord,
    explicit_sets: bool,
}

#[derive(Debug, Clone)]
struct LeaseRow {
    lease: TaskLease,
}

#[derive(Debug)]
pub struct TaskGraph {
    config: TaskGraphConfig,
    initialized: OnceLock<StateResult<()>>,
}

impl TaskGraph {
    pub fn new(config: TaskGraphConfig) -> Self {
        Self {
            config,
            initialized: OnceLock::new(),
        }
    }

    pub fn open(config: TaskGraphConfig) -> StateResult<Self> {
        let graph = Self::new(config);
        graph.initialize()?;
        Ok(graph)
    }

    pub fn state_dir(&self) -> &Path {
        &self.config.state_dir
    }

    pub fn database_path(&self) -> PathBuf {
        self.config.state_dir.join("tasks.db")
    }

    pub fn initialize(&self) -> StateResult<()> {
        self.initialized
            .get_or_init(|| self.initialize_inner())
            .clone()
    }

    fn initialize_inner(&self) -> StateResult<()> {
        ensure_secure_state_dir(&self.config.state_dir)?;
        let database_path = self.database_path();
        reject_database_symlink(&database_path)?;
        let mut connection = Connection::open(&database_path)?;
        configure_connection(&connection)?;
        secure_database_files(&database_path)?;
        migrate_schema(&mut connection, &database_path)?;
        Ok(())
    }

    fn connection(&self) -> StateResult<Connection> {
        self.initialize()?;
        let database_path = self.database_path();
        reject_database_symlink(&database_path)?;
        let connection = Connection::open(&database_path)?;
        configure_connection(&connection)?;
        secure_database_files(&database_path)?;
        Ok(connection)
    }

    pub fn create(&self, input: TaskInput) -> StateResult<TaskRecord> {
        let prepared = PreparedTask::from_input(input, None)?;
        self.write_transaction(|tx| {
            if let Some(key) = &prepared.idempotency_key {
                if let Some(task_id) = idempotent_task_id(tx, key)? {
                    return read_task(tx, &task_id)?.ok_or_else(|| {
                        StateError::InvalidTask(format!(
                            "Idempotency key points to missing task: {key}"
                        ))
                    });
                }
            }
            if read_task(tx, &prepared.id)?.is_some() {
                return Err(StateError::DuplicateTask(prepared.id.clone()));
            }
            validate_dependencies(tx, &prepared.id, &prepared.blocked_by)?;
            insert_prepared(tx, &prepared)?;
            if let Some(key) = &prepared.idempotency_key {
                tx.execute(
                    "INSERT INTO task_idempotency(idempotency_key, task_id) VALUES (?1, ?2)",
                    params![key, prepared.id],
                )?;
            }
            bump_graph_version(tx)?;
            read_task(tx, &prepared.id)?
                .ok_or_else(|| StateError::TaskNotFound(prepared.id.clone()))
        })
    }

    pub fn route(&self, input: TaskInput, mode: ConflictMode) -> StateResult<RouteResult> {
        if matches!(
            input.status,
            Some(TaskStatus::Claimed | TaskStatus::Running)
        ) {
            return Err(StateError::InvalidTask(
                "route cannot create claimed or running tasks".into(),
            ));
        }
        if input.lease_id.is_some() {
            return Err(StateError::InvalidTask(
                "route cannot attach a lease_id to a task".into(),
            ));
        }
        let prepared = PreparedTask::from_input(input, None)?;
        self.write_transaction(|tx| {
            if let Some(key) = &prepared.idempotency_key {
                if let Some(task_id) = idempotent_task_id(tx, key)? {
                    let task = read_task(tx, &task_id)?.ok_or_else(|| {
                        StateError::InvalidTask(format!(
                            "Idempotency key points to missing task: {key}"
                        ))
                    })?;
                    return Ok(RouteResult {
                        decision: overlap_decision(
                            "idempotent",
                            mode,
                            task.isolation,
                            Vec::new(),
                            task.blocked_by.clone(),
                            true,
                        ),
                        task: Some(task),
                        created: false,
                    });
                }
            }
            if read_task(tx, &prepared.id)?.is_some() {
                return Err(StateError::DuplicateTask(prepared.id.clone()));
            }

            let existing = read_all_tasks_with_sets(tx)?;
            let conflicts = if prepared.status.terminal() {
                Vec::new()
            } else {
                find_overlaps(&prepared, &existing)
            };
            let conflict_ids: Vec<String> =
                conflicts.iter().map(|item| item.task_id.clone()).collect();
            let mut blocked_by = prepared.blocked_by.clone();
            if matches!(prepared.isolation, TaskIsolation::Shared)
                && matches!(mode, ConflictMode::Block)
            {
                append_unique(&mut blocked_by, conflict_ids.iter().cloned());
            }
            let decision =
                make_overlap_decision(prepared.isolation, mode, conflicts, blocked_by.clone());
            if !decision.allowed {
                return Ok(RouteResult {
                    task: None,
                    created: false,
                    decision,
                });
            }
            validate_dependencies(tx, &prepared.id, &blocked_by)?;
            let blocked = decision.action == "blocked";
            let inserted = prepared.with_blocked_by(
                blocked_by,
                if blocked {
                    TaskStatus::Pending
                } else {
                    prepared.status
                },
                if blocked {
                    None
                } else {
                    prepared.owner.clone()
                },
                if blocked {
                    None
                } else {
                    prepared.claimed_at.clone()
                },
                if blocked {
                    None
                } else {
                    prepared.started_at.clone()
                },
                if blocked {
                    None
                } else {
                    prepared.finished_at.clone()
                },
                if blocked {
                    None
                } else {
                    prepared.lease_id.clone()
                },
            );
            insert_prepared(tx, &inserted)?;
            if let Some(key) = &inserted.idempotency_key {
                tx.execute(
                    "INSERT INTO task_idempotency(idempotency_key, task_id) VALUES (?1, ?2)",
                    params![key, inserted.id],
                )?;
            }
            bump_graph_version(tx)?;
            Ok(RouteResult {
                task: read_task(tx, &inserted.id)?,
                created: true,
                decision,
            })
        })
    }

    pub fn read(&self, task_id: &str) -> StateResult<Option<TaskRecord>> {
        let id = nonempty(task_id, "task_id")?;
        let connection = self.connection()?;
        read_task(&connection, &id)
    }

    pub fn list(&self, options: ListOptions) -> StateResult<Vec<TaskRecord>> {
        let connection = self.connection()?;
        let mut sql = String::from(SELECT_TASKS);
        let mut clauses = Vec::new();
        let mut values: Vec<SqlValue> = Vec::new();
        if let Some(statuses) = &options.status {
            if statuses.is_empty() {
                return Ok(Vec::new());
            }
            let placeholders = std::iter::repeat_n("?", statuses.len())
                .collect::<Vec<_>>()
                .join(", ");
            clauses.push(format!("status IN ({placeholders})"));
            values.extend(
                statuses
                    .iter()
                    .map(|status| SqlValue::Text(status.as_str().to_owned())),
            );
        }
        if let Some(owner) = &options.owner {
            clauses.push("owner IS ?".into());
            values.push(match owner {
                Some(value) => SqlValue::Text(nonempty(value, "owner")?),
                None => SqlValue::Null,
            });
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY id ASC");
        if let Some(limit) = options.limit {
            let limit = sqlite_integer(limit, "limit")?;
            sql.push_str(" LIMIT ?");
            values.push(SqlValue::Integer(limit));
            if let Some(offset) = options.offset {
                sql.push_str(" OFFSET ?");
                values.push(SqlValue::Integer(sqlite_integer(offset, "offset")?));
            }
        } else if let Some(offset) = options.offset {
            sql.push_str(" LIMIT -1 OFFSET ?");
            values.push(SqlValue::Integer(sqlite_integer(offset, "offset")?));
        }
        let mut statement = connection.prepare(&sql)?;
        let params = values.iter().map(SqlValue::as_ref).collect::<Vec<_>>();
        let rows = statement.query_map(rusqlite::params_from_iter(params), task_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StateError::from)
    }

    pub fn list_dependents(&self, task_id: &str) -> StateResult<Vec<TaskRecord>> {
        let id = nonempty(task_id, "task_id")?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(&format!(
            "{SELECT_TASKS} WHERE EXISTS (SELECT 1 FROM json_each(tasks.blocked_by) WHERE json_each.value=?1) ORDER BY id ASC"
        ))?;
        let rows = statement.query_map(params![id], task_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StateError::from)
    }

    /// Atomically validate overlap and apply a patch to an existing task.
    ///
    /// This is the update equivalent of `route`: conflict discovery and the
    /// versioned write happen in the same SQLite transaction, so callers never
    /// have a read/validate/write TOCTOU window.
    pub fn route_update(
        &self,
        task_id: &str,
        patch: Value,
        mode: ConflictMode,
        expected_version: Option<u64>,
    ) -> StateResult<RouteResult> {
        let id = nonempty(task_id, "task_id")?;
        validate_patch_keys(&patch)?;
        let expected_version = extract_expected_version(&patch, expected_version)?;
        if let Some(version) = expected_version {
            ensure_u64(version, "expected_version")?;
        }
        self.write_transaction(|tx| {
            let current =
                read_task(tx, &id)?.ok_or_else(|| StateError::TaskNotFound(id.clone()))?;
            if let Some(expected) = expected_version {
                if current.version != expected {
                    return Err(StateError::VersionConflict {
                        task_id: id.clone(),
                        expected,
                        actual: current.version,
                    });
                }
            }
            let object = patch
                .as_object()
                .ok_or_else(|| StateError::InvalidTask("patch must be an object".into()))?;

            let mut merged = serde_json::to_value(TaskInput {
                id: Some(current.id.clone()),
                status: Some(current.status),
                owner: current.owner.clone(),
                kind: Some(current.kind),
                effort: Some(current.effort),
                priority: Some(current.priority),
                blocked_by: Some(current.blocked_by.clone()),
                depends_on: None,
                claimed_at: current.claimed_at.clone(),
                started_at: current.started_at.clone(),
                finished_at: current.finished_at.clone(),
                files_touched: Some(current.files_touched.clone()),
                read_set: Some(current.read_set.clone()),
                write_set: Some(current.write_set.clone()),
                isolation: Some(current.isolation),
                lease_id: current.lease_id.clone(),
                policy_epoch: Some(current.policy_epoch),
                policy_digest: Some(current.policy_digest.clone()),
                report_id: current.report_id.clone(),
                idempotency_key: None,
            })
            .map_err(|error| StateError::InvalidTask(error.to_string()))?;
            let merged_object = merged
                .as_object_mut()
                .ok_or_else(|| StateError::InvalidTask("task input must be an object".into()))?;
            if object.contains_key("blocked_by") || object.contains_key("depends_on") {
                merged_object.remove("blocked_by");
                merged_object.remove("depends_on");
            }
            for (key, value) in object {
                if !matches!(
                    key.as_str(),
                    "expectedVersion" | "expected_version" | "version"
                ) {
                    merged_object.insert(key.clone(), value.clone());
                }
            }
            let candidate_input: TaskInput = serde_json::from_value(merged)
                .map_err(|error| StateError::InvalidTask(error.to_string()))?;
            let mut candidate = PreparedTask::from_input(candidate_input, None)?;
            candidate.explicit_sets =
                if object.contains_key("read_set") || object.contains_key("write_set") {
                    true
                } else {
                    current_sets_explicit(tx, &id)?
                };
            let conflicts = if candidate.status.terminal() {
                Vec::new()
            } else {
                find_overlaps(&candidate, &read_all_tasks_with_sets(tx)?)
            };
            let mut merged_blocked_by = candidate.blocked_by.clone();
            if matches!(candidate.isolation, TaskIsolation::Shared)
                && matches!(mode, ConflictMode::Block)
            {
                append_unique(
                    &mut merged_blocked_by,
                    conflicts.iter().map(|conflict| conflict.task_id.clone()),
                );
            }
            let decision = make_overlap_decision(
                candidate.isolation,
                mode,
                conflicts,
                merged_blocked_by.clone(),
            );
            if !decision.allowed {
                return Ok(RouteResult {
                    task: Some(current),
                    created: false,
                    decision,
                });
            }
            validate_dependencies(tx, &id, &merged_blocked_by)?;

            let mut update_object = object.clone();
            if !merged_blocked_by.is_empty()
                || object.contains_key("blocked_by")
                || object.contains_key("depends_on")
            {
                update_object.insert(
                    "blocked_by".into(),
                    serde_json::to_value(&merged_blocked_by)
                        .map_err(|error| StateError::InvalidTask(error.to_string()))?,
                );
            }
            if decision.action == "blocked" {
                update_object.insert("status".into(), Value::String("pending".into()));
                update_object.insert("owner".into(), Value::Null);
                update_object.insert("claimed_at".into(), Value::Null);
                update_object.insert("lease_id".into(), Value::Null);
            }
            let task = self.update_in_transaction(
                tx,
                &id,
                &Value::Object(update_object),
                expected_version,
            )?;
            Ok(RouteResult {
                task: Some(task),
                created: false,
                decision,
            })
        })
    }

    pub fn update(
        &self,
        task_id: &str,
        patch: Value,
        expected_version: Option<u64>,
    ) -> StateResult<TaskRecord> {
        let id = nonempty(task_id, "task_id")?;
        validate_patch_keys(&patch)?;
        let expected_version = extract_expected_version(&patch, expected_version)?;
        if let Some(version) = expected_version {
            ensure_u64(version, "expected_version")?;
        }
        self.write_transaction(|tx| self.update_in_transaction(tx, &id, &patch, expected_version))
    }

    fn update_in_transaction(
        &self,
        tx: &Connection,
        id: &str,
        patch: &Value,
        expected_version: Option<u64>,
    ) -> StateResult<TaskRecord> {
        let id = id.to_owned();
        let current = read_task(tx, &id)?.ok_or_else(|| StateError::TaskNotFound(id.clone()))?;
        if let Some(expected) = expected_version {
            if current.version != expected {
                return Err(StateError::VersionConflict {
                    task_id: id.clone(),
                    expected,
                    actual: current.version,
                });
            }
        }
        if !patch_is_object(patch)? {
            return Err(StateError::InvalidTask("patch must be an object".into()));
        }
        let object = patch.as_object().expect("validated object");
        if object.is_empty() {
            return Ok(current);
        }
        if object.contains_key("policy_epoch") != object.contains_key("policy_digest") {
            return Err(StateError::InvalidTask(
                "policy_epoch and policy_digest must be provided together in a patch".into(),
            ));
        }
        let mutable = [
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
            "policy_digest",
            "report_id",
        ];
        if !mutable.iter().any(|key| object.contains_key(*key)) {
            return Ok(current);
        }

        let next_status =
            optional_enum(object, "status", TaskStatus::parse)?.unwrap_or(current.status);
        let next_owner = if let Some(value) = object.get("owner") {
            nullable_string(value, "owner")?
        } else {
            current.owner.clone()
        };
        let next_kind = optional_enum(object, "kind", TaskKind::parse)?.unwrap_or(current.kind);
        let next_effort =
            optional_enum(object, "effort", TaskEffort::parse)?.unwrap_or(current.effort);
        let next_priority = if let Some(value) = object.get("priority") {
            json_i64(value, "priority")?
        } else {
            current.priority
        };
        let next_blocked_by =
            if object.contains_key("blocked_by") || object.contains_key("depends_on") {
                let value = object
                    .get("blocked_by")
                    .filter(|value| !value.is_null())
                    .or_else(|| object.get("depends_on").filter(|value| !value.is_null()));
                normalize_strings(
                    json_string_array(value.unwrap_or(&Value::Array(Vec::new())), "blocked_by")?,
                    "blocked_by",
                )?
            } else {
                current.blocked_by.clone()
            };
        let next_claimed_at = optional_nullable_string(object, "claimed_at")?
            .unwrap_or_else(|| current.claimed_at.clone());
        let next_started_at = optional_nullable_string(object, "started_at")?
            .unwrap_or_else(|| current.started_at.clone());
        let next_finished_at = optional_nullable_string(object, "finished_at")?
            .unwrap_or_else(|| current.finished_at.clone());
        let next_files = if let Some(value) = object.get("files_touched") {
            normalize_targets_json(value, "files_touched")?
        } else {
            current.files_touched.clone()
        };
        let next_read = if let Some(value) = object.get("read_set") {
            normalize_targets_json(value, "read_set")?
        } else {
            current.read_set.clone()
        };
        let next_write = if let Some(value) = object.get("write_set") {
            normalize_targets_json(value, "write_set")?
        } else {
            current.write_set.clone()
        };
        let next_isolation =
            optional_enum(object, "isolation", TaskIsolation::parse)?.unwrap_or(current.isolation);
        let explicit_sets = object.contains_key("read_set")
            || object.contains_key("write_set")
            || current_sets_explicit(tx, &id)?;
        let next_lease_id = if let Some(value) = object.get("lease_id") {
            nullable_string(value, "lease_id")?
        } else {
            current.lease_id.clone()
        };
        let next_policy_epoch = if let Some(value) = object.get("policy_epoch") {
            json_u64(value, "policy_epoch")?
        } else {
            current.policy_epoch
        };
        let next_policy_digest = if object.contains_key("policy_digest") {
            nullable_policy_digest(
                object
                    .get("policy_digest")
                    .expect("policy_digest key was checked"),
                "policy_digest",
            )?
        } else {
            current.policy_digest.clone()
        };
        let next_report_id = optional_nullable_string(object, "report_id")?
            .unwrap_or_else(|| current.report_id.clone());
        let status = next_status;
        let mut owner = next_owner;
        let mut claimed_at = next_claimed_at;
        let mut started_at = next_started_at;
        let mut finished_at = next_finished_at;
        let mut lease_id = next_lease_id;

        if matches!(status, TaskStatus::Running) && started_at.is_none() {
            started_at = Some(now_string(None)?);
        }
        if status.terminal() && finished_at.is_none() {
            finished_at = Some(now_string(None)?);
        }
        if object.contains_key("blocked_by") || object.contains_key("depends_on") {
            validate_dependencies(tx, &id, &next_blocked_by)?;
        }
        if matches!(
            status,
            TaskStatus::Pending
                | TaskStatus::Completed
                | TaskStatus::Failed
                | TaskStatus::Blocked
                | TaskStatus::Cancelled
        ) {
            lease_id = None;
        }
        if matches!(status, TaskStatus::Pending) && current.status != TaskStatus::Pending {
            owner = None;
            claimed_at = None;
        }
        if matches!(status, TaskStatus::Claimed | TaskStatus::Running)
            && (owner.is_none() || lease_id.is_none())
        {
            return Err(StateError::InvalidTask(
                "claimed and running tasks require owner and lease_id".into(),
            ));
        }
        if let Some(next_lease) = &lease_id {
            let lease = read_lease(tx, next_lease)?;
            if lease
                .as_ref()
                .map(|item| {
                    item.lease.task_id != id
                        || item.lease.released_at.is_some()
                        || owner.as_deref() != Some(item.lease.owner.as_str())
                })
                .unwrap_or(true)
            {
                return Err(
                    if lease
                        .as_ref()
                        .is_some_and(|item| item.lease.owner != owner.clone().unwrap_or_default())
                    {
                        StateError::LeaseOwnerMismatch(next_lease.clone())
                    } else {
                        StateError::LeaseConflict(next_lease.clone())
                    },
                );
            }
        }
        if lease_id.is_none() {
            if let Some(current_lease_id) = current.lease_id.as_ref() {
                tx.execute(
                        "UPDATE task_leases SET released_at = COALESCE(released_at, ?1) WHERE lease_id = ?2",
                        params![now_string(None)?, current_lease_id],
                    )?;
            }
        }
        if matches!(status, TaskStatus::Claimed) && claimed_at.is_none() {
            claimed_at = Some(now_string(None)?);
        }

        let mut sql = String::from("UPDATE tasks SET status=?1, owner=?2, kind=?3, effort=?4, priority=?5, blocked_by=?6, claimed_at=?7, started_at=?8, finished_at=?9, files_touched=?10, read_set=?11, write_set=?12, isolation=?13, sets_explicit=?14, lease_id=?15, version=version+1, policy_epoch=?16, policy_digest=?17, report_id=?18 WHERE id=?19");
        if expected_version.is_some() {
            sql.push_str(" AND version=?20");
        }
        let mut bind = vec![
            SqlValue::Text(status.as_str().into()),
            SqlValue::optional_text(owner),
            SqlValue::Text(next_kind.as_str().into()),
            SqlValue::Text(next_effort.as_str().into()),
            SqlValue::Integer(next_priority),
            SqlValue::Text(json_array(&next_blocked_by)?),
            SqlValue::optional_text(claimed_at),
            SqlValue::optional_text(started_at),
            SqlValue::optional_text(finished_at),
            SqlValue::Text(json_array(&next_files)?),
            SqlValue::Text(json_array(&next_read)?),
            SqlValue::Text(json_array(&next_write)?),
            SqlValue::Text(next_isolation.as_str().into()),
            SqlValue::Integer(if explicit_sets { 1 } else { 0 }),
            SqlValue::optional_text(lease_id),
            SqlValue::Integer(u64_to_i64(next_policy_epoch, "policy_epoch")?),
            SqlValue::optional_text(next_policy_digest),
            SqlValue::optional_text(next_report_id),
            SqlValue::Text(id.clone()),
        ];
        if let Some(expected) = expected_version {
            bind.push(SqlValue::Integer(u64_to_i64(expected, "expected_version")?));
        }
        let refs = bind.iter().map(SqlValue::as_ref).collect::<Vec<_>>();
        let changed = tx.execute(&sql, rusqlite::params_from_iter(refs))?;
        if changed != 1 {
            let actual = read_task(tx, &id)?
                .ok_or_else(|| StateError::TaskNotFound(id.clone()))?
                .version;
            return Err(StateError::VersionConflict {
                task_id: id.clone(),
                expected: expected_version.unwrap_or(current.version),
                actual,
            });
        }
        bump_graph_version(tx)?;
        read_task(tx, &id)?.ok_or(StateError::TaskNotFound(id))
    }

    pub fn claim(
        &self,
        task_id: &str,
        owner: &str,
        options: ClaimOptions,
    ) -> StateResult<ClaimResult> {
        let id = nonempty(task_id, "task_id")?;
        let owner = nonempty(owner, "owner")?;
        let lease_id = options
            .lease_id
            .as_deref()
            .map(|value| nonempty(value, "lease_id"))
            .transpose()?;
        let ttl = positive_u64(
            options.ttl_ms.unwrap_or(self.config.lease_ttl_ms),
            "lease TTL",
        )?;
        if let Some(expected) = options.expected_version {
            ensure_u64(expected, "expected_version")?;
        }
        let now = now_string(options.now.as_deref())?;
        let expires_at = add_millis(&now, ttl)?;
        self.write_transaction(|tx| {
            let _ = expire_leases(tx, &now)?;
            let Some(current) = read_task(tx, &id)? else {
                return Ok(ClaimResult::Failure(ClaimFailure { ok: false, reason: "not_found".into(), task: None, blocked_by: Vec::new(), expected_version: None, actual_version: None }));
            };
            if let Some(expected) = options.expected_version {
                if current.version != expected {
                    return Ok(ClaimResult::Failure(ClaimFailure { ok: false, reason: "version_conflict".into(), task: Some(current.clone()), blocked_by: current.blocked_by.clone(), expected_version: Some(expected), actual_version: Some(current.version) }));
                }
            }
            if let Some(requested) = &lease_id {
                if let Some(existing) = read_lease(tx, requested)? {
                    if existing.lease.released_at.is_none()
                        && existing.lease.task_id == id
                        && existing.lease.owner == owner
                        && current.lease_id.as_deref() == Some(requested.as_str())
                        && current.owner.as_deref() == Some(owner.as_str())
                    {
                        return Ok(ClaimResult::Success(ClaimSuccess { ok: true, task: current, lease: existing.lease }));
                    }
                    return Ok(ClaimResult::Failure(ClaimFailure { ok: false, reason: "lease_conflict".into(), task: Some(current.clone()), blocked_by: current.blocked_by.clone(), expected_version: None, actual_version: None }));
                }
            }
            if !matches!(current.status, TaskStatus::Pending) {
                return Ok(ClaimResult::Failure(ClaimFailure { ok: false, reason: "status_not_pending".into(), task: Some(current.clone()), blocked_by: current.blocked_by.clone(), expected_version: None, actual_version: None }));
            }
            let incomplete = incomplete_dependencies(tx, &current.blocked_by)?;
            if !incomplete.is_empty() {
                return Ok(ClaimResult::Failure(ClaimFailure { ok: false, reason: "dependencies_incomplete".into(), task: Some(current), blocked_by: incomplete, expected_version: None, actual_version: None }));
            }
            if read_active_lease_for_task(tx, &id)?.is_some() {
                return Ok(ClaimResult::Failure(ClaimFailure { ok: false, reason: "lease_active".into(), task: Some(current.clone()), blocked_by: current.blocked_by.clone(), expected_version: None, actual_version: None }));
            }
            let new_lease_id = lease_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            let changed = tx.execute(
                "UPDATE tasks SET status='claimed', owner=?1, claimed_at=?2, lease_id=?3, version=version+1 WHERE id=?4 AND status='pending' AND version=?5 AND NOT EXISTS (SELECT 1 FROM task_leases WHERE task_id=tasks.id AND released_at IS NULL) AND NOT EXISTS (SELECT 1 FROM json_each(tasks.blocked_by) AS dependency_id LEFT JOIN tasks AS dependency ON dependency.id=dependency_id.value WHERE dependency.id IS NULL OR dependency.status <> 'completed')",
                params![owner, now, new_lease_id, id, u64_to_i64(current.version, "version")?],
            )?;
            if changed != 1 {
                let latest = read_task(tx, &id)?;
                return Ok(match latest {
                    None => ClaimResult::Failure(ClaimFailure { ok: false, reason: "not_found".into(), task: None, blocked_by: Vec::new(), expected_version: None, actual_version: None }),
                    Some(task) => ClaimResult::Failure(ClaimFailure { ok: false, reason: if task.version != current.version { "version_conflict" } else if !matches!(task.status, TaskStatus::Pending) { "status_not_pending" } else { "dependencies_incomplete" }.into(), blocked_by: incomplete_dependencies(tx, &task.blocked_by)?, expected_version: options.expected_version, actual_version: Some(task.version), task: Some(task) }),
                });
            }
            tx.execute("INSERT INTO task_leases(lease_id, task_id, owner, acquired_at, expires_at, released_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)", params![new_lease_id, id, owner, now, expires_at])?;
            bump_graph_version(tx)?;
            let task = read_task(tx, &id)?.ok_or_else(|| StateError::TaskNotFound(id.clone()))?;
            let lease = read_lease(tx, &new_lease_id)?.ok_or_else(|| StateError::LeaseConflict(new_lease_id.clone()))?.lease;
            Ok(ClaimResult::Success(ClaimSuccess { ok: true, task, lease }))
        })
    }

    pub fn renew_lease(
        &self,
        lease_id: &str,
        owner: Option<&str>,
        ttl_ms: Option<u64>,
        now: Option<&str>,
    ) -> StateResult<Option<TaskLease>> {
        let id = nonempty(lease_id, "lease_id")?;
        let owner = owner.map(|value| nonempty(value, "owner")).transpose()?;
        let ttl = positive_u64(ttl_ms.unwrap_or(self.config.lease_ttl_ms), "lease TTL")?;
        let now = now_string(now)?;
        let expires_at = add_millis(&now, ttl)?;
        self.write_transaction(|tx| {
            let _ = expire_leases(tx, &now)?;
            let Some(existing) = read_lease(tx, &id)? else {
                return Ok(None);
            };
            if let Some(expected_owner) = owner {
                if existing.lease.owner != expected_owner {
                    return Err(StateError::LeaseOwnerMismatch(id));
                }
            }
            if existing.lease.released_at.is_some() {
                return Ok(Some(existing.lease));
            }
            let Some(task) = read_task(tx, &existing.lease.task_id)? else {
                return Ok(Some(existing.lease));
            };
            if task.lease_id.as_deref() != Some(id.as_str())
                || !matches!(task.status, TaskStatus::Claimed | TaskStatus::Running)
            {
                return Ok(Some(existing.lease));
            }
            if task.owner.as_deref() != Some(existing.lease.owner.as_str()) {
                return Err(StateError::LeaseOwnerMismatch(id));
            }
            tx.execute(
                "UPDATE task_leases SET expires_at=?1 WHERE lease_id=?2 AND released_at IS NULL",
                params![expires_at, id],
            )?;
            bump_graph_version(tx)?;
            Ok(Some(
                read_lease(tx, &id)?
                    .ok_or_else(|| StateError::LeaseConflict(id.clone()))?
                    .lease,
            ))
        })
    }

    pub fn release_lease(
        &self,
        lease_id: &str,
        owner: Option<&str>,
        now: Option<&str>,
    ) -> StateResult<Option<TaskLease>> {
        let id = nonempty(lease_id, "lease_id")?;
        let owner = owner.map(|value| nonempty(value, "owner")).transpose()?;
        let now = now_string(now)?;
        self.write_transaction(|tx| {
            let Some(existing) = read_lease(tx, &id)? else { return Ok(None); };
            if let Some(expected_owner) = owner {
                if existing.lease.owner != expected_owner { return Err(StateError::LeaseOwnerMismatch(id)); }
            }
            if existing.lease.released_at.is_some() { return Ok(Some(existing.lease)); }
            let task = read_task(tx, &existing.lease.task_id)?;
            tx.execute("UPDATE task_leases SET released_at=?1 WHERE lease_id=?2 AND released_at IS NULL", params![now, id])?;
            if let Some(task) = task {
                if task.lease_id.as_deref() == Some(id.as_str()) {
                    if task.owner.as_deref() != Some(existing.lease.owner.as_str()) {
                        return Err(StateError::LeaseOwnerMismatch(id));
                    }
                    if matches!(task.status, TaskStatus::Claimed | TaskStatus::Running) {
                        tx.execute("UPDATE tasks SET status='pending', owner=NULL, claimed_at=NULL, lease_id=NULL, version=version+1 WHERE id=?1 AND lease_id=?2", params![task.id, id])?;
                    } else {
                        tx.execute("UPDATE tasks SET lease_id=NULL, version=version+1 WHERE id=?1 AND lease_id=?2", params![task.id, id])?;
                    }
                }
            }
            bump_graph_version(tx)?;
            Ok(Some(read_lease(tx, &id)?.ok_or_else(|| StateError::LeaseConflict(id.clone()))?.lease))
        })
    }

    pub fn recover(&self, now: Option<&str>) -> StateResult<RecoveryResult> {
        let now = now_string(now)?;
        self.write_transaction(|tx| expire_leases(tx, &now))
    }

    pub fn snapshot(&self) -> StateResult<TaskGraphSnapshot> {
        let connection = self.connection()?;
        let tx = connection.unchecked_transaction()?;
        let graph_version = read_graph_version(&tx)?;
        let tasks = read_all_tasks(&tx)?;
        tx.commit()?;
        let captured_at = now_string(None)?;
        Ok(TaskGraphSnapshot {
            version: graph_version,
            graph_version,
            captured_at,
            tasks,
        })
    }

    pub fn graph_version(&self) -> StateResult<u64> {
        let connection = self.connection()?;
        read_graph_version(&connection)
    }

    fn write_transaction<T, F>(&self, callback: F) -> StateResult<T>
    where
        F: FnOnce(&Transaction<'_>) -> StateResult<T>,
    {
        let mut connection = self.connection()?;
        let tx = Transaction::new(&mut connection, TransactionBehavior::Immediate)?;
        match callback(&tx) {
            Ok(value) => {
                secure_database_files(&self.database_path())?;
                tx.commit()?;
                Ok(value)
            }
            Err(error) => {
                drop(tx);
                Err(error)
            }
        }
    }
}

const SELECT_TASKS: &str = "SELECT id,status,owner,kind,effort,priority,blocked_by,claimed_at,started_at,finished_at,files_touched,read_set,write_set,isolation,sets_explicit,lease_id,version,policy_epoch,policy_digest,report_id FROM tasks";

#[derive(Debug, Clone)]
enum SqlValue {
    Null,
    Text(String),
    Integer(i64),
}

fn validate_policy_digest(value: Option<String>, field: &str) -> StateResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(StateError::InvalidTask(format!(
            "{field} must be a lowercase SHA-256 digest"
        )));
    }
    Ok(Some(value))
}

fn nullable_policy_digest(value: &Value, field: &str) -> StateResult<Option<String>> {
    if value.is_null() {
        return Ok(None);
    }
    let value = value
        .as_str()
        .ok_or_else(|| StateError::InvalidTask(format!("{field} must be a string or null")))?;
    validate_policy_digest(Some(value.to_owned()), field)
}

fn validate_stored_policy_digests(connection: &Connection) -> StateResult<()> {
    let mut statement = connection.prepare("SELECT id, policy_digest FROM tasks")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    for row in rows {
        let (id, digest) = row?;
        validate_policy_digest(digest, &format!("policy_digest for task {id}"))?;
    }
    Ok(())
}

impl SqlValue {
    fn as_ref(&self) -> &dyn rusqlite::ToSql {
        match self {
            Self::Null => &rusqlite::types::Null,
            Self::Text(value) => value,
            Self::Integer(value) => value,
        }
    }

    fn optional_text(value: Option<String>) -> Self {
        value.map(Self::Text).unwrap_or(Self::Null)
    }
}

pub(crate) fn configure_connection(connection: &Connection) -> StateResult<()> {
    connection.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
    )?;
    Ok(())
}

fn migrate_schema(connection: &mut Connection, database_path: &Path) -> StateResult<()> {
    let existing_version = read_existing_schema_version(connection)?;
    if let Some(schema_version) = existing_version {
        if schema_version > TASK_GRAPH_SCHEMA_VERSION {
            return Err(StateError::InvalidTask(format!(
                "Unsupported future task graph schema version: {schema_version}"
            )));
        }
    }
    let transaction = Transaction::new(connection, TransactionBehavior::Immediate)?;
    // Keep schema creation, validation, column additions, and index creation
    // in one transaction. A malformed legacy row must not leave partial DDL
    // behind for the next daemon startup.
    transaction.execute_batch(SCHEMA)?;
    let schema_version = read_schema_version(&transaction)?;
    let columns = table_columns(&transaction, "tasks")?;
    validate_stored_json_columns(&transaction, &columns)?;
    let additions = [
        ("status", "TEXT NOT NULL DEFAULT 'pending'"),
        ("owner", "TEXT"),
        ("kind", "TEXT NOT NULL DEFAULT 'implement'"),
        ("effort", "TEXT NOT NULL DEFAULT 'medium'"),
        ("priority", "INTEGER NOT NULL DEFAULT 0"),
        ("blocked_by", "TEXT NOT NULL DEFAULT '[]'"),
        ("claimed_at", "TEXT"),
        ("started_at", "TEXT"),
        ("finished_at", "TEXT"),
        ("files_touched", "TEXT NOT NULL DEFAULT '[]'"),
        ("read_set", "TEXT NOT NULL DEFAULT '[]'"),
        ("write_set", "TEXT NOT NULL DEFAULT '[]'"),
        ("isolation", "TEXT NOT NULL DEFAULT 'shared'"),
        ("sets_explicit", "INTEGER NOT NULL DEFAULT 0"),
        ("lease_id", "TEXT"),
        ("version", "INTEGER NOT NULL DEFAULT 0"),
        ("policy_epoch", "INTEGER NOT NULL DEFAULT 0"),
        ("policy_digest", "TEXT"),
        ("report_id", "TEXT"),
    ];
    for (name, definition) in additions {
        if !columns.contains(name) {
            transaction.execute(
                &format!("ALTER TABLE tasks ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }
    transaction.execute("UPDATE tasks SET kind='implement' WHERE kind IS NULL OR kind NOT IN ('research','implement','verify','integrate')", [])?;
    transaction.execute("UPDATE tasks SET effort='medium' WHERE effort IS NULL OR effort NOT IN ('none','low','medium','high','xhigh','max')", [])?;
    transaction.execute("UPDATE tasks SET priority=0 WHERE priority IS NULL", [])?;
    validate_stored_policy_digests(&transaction)?;
    transaction.execute(
        "INSERT OR IGNORE INTO task_graph_meta(key,value) VALUES ('graph_version','0')",
        [],
    )?;
    transaction.execute(
        "INSERT OR IGNORE INTO task_graph_meta(key,value) VALUES ('schema_version','3')",
        [],
    )?;
    if schema_version < TASK_GRAPH_SCHEMA_VERSION {
        transaction.execute(
            "UPDATE task_graph_meta SET value='3' WHERE key='schema_version'",
            [],
        )?;
    }
    transaction.execute_batch("CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status); CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner); CREATE INDEX IF NOT EXISTS tasks_lease_idx ON tasks(lease_id); CREATE UNIQUE INDEX IF NOT EXISTS task_leases_active_task_idx ON task_leases(task_id) WHERE released_at IS NULL; CREATE INDEX IF NOT EXISTS task_leases_expiry_idx ON task_leases(expires_at) WHERE released_at IS NULL;")?;
    secure_database_files(database_path)?;
    transaction.commit()?;
    Ok(())
}

fn read_existing_schema_version(connection: &Connection) -> StateResult<Option<u64>> {
    let table_exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_graph_meta')",
        [],
        |row| row.get::<_, i64>(0),
    )? == 1;
    if !table_exists {
        return Ok(None);
    }
    let Some(value): Option<String> = connection
        .query_row(
            "SELECT value FROM task_graph_meta WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let version = value
        .parse::<u64>()
        .map_err(|_| StateError::InvalidTask("Invalid task graph schema version".into()))?;
    ensure_u64(version, "schema_version").map(Some)
}

fn table_columns(connection: &Connection, table: &str) -> StateResult<HashSet<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect::<Result<HashSet<_>, _>>()
        .map_err(StateError::from)
}

fn read_schema_version(connection: &Connection) -> StateResult<u64> {
    let value: String = connection.query_row(
        "SELECT value FROM task_graph_meta WHERE key='schema_version'",
        [],
        |row| row.get(0),
    )?;
    let version = value
        .parse::<u64>()
        .map_err(|_| StateError::InvalidTask("Invalid task graph schema version".into()))?;
    ensure_u64(version, "schema_version")
}

fn validate_stored_json_columns(
    connection: &Connection,
    columns: &HashSet<String>,
) -> StateResult<()> {
    for field in ["blocked_by", "files_touched", "read_set", "write_set"] {
        if !columns.contains(field) {
            continue;
        }
        let mut statement =
            connection.prepare(&format!("SELECT id, {field} FROM tasks ORDER BY id ASC"))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let task_id: String = row.get(0)?;
            let value: Option<String> = row.get(1)?;
            let value = value.ok_or_else(|| {
                StateError::InvalidTask(format!(
                    "Malformed stored {field} for task {task_id}: value is NULL"
                ))
            })?;
            parse_json_array(&value).map_err(|error| {
                StateError::InvalidTask(format!(
                    "Malformed stored {field} for task {task_id}: {error}"
                ))
            })?;
        }
    }
    Ok(())
}

pub(crate) fn ensure_secure_state_dir(path: &Path) -> StateResult<()> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(StateError::Io(format!(
            "state path is not a real directory: {}",
            path.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() as u32 } {
            return Err(StateError::Io(format!(
                "state directory is not owned by current user: {}",
                path.display()
            )));
        }
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions)?;
        let verified = fs::symlink_metadata(path)?;
        if verified.permissions().mode() & 0o777 != 0o700
            || verified.uid() != unsafe { libc::geteuid() as u32 }
        {
            return Err(StateError::Io(format!(
                "state directory failed security checks: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

pub(crate) fn reject_database_symlink(path: &Path) -> StateResult<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(StateError::Io(format!(
                "database path is not a regular file: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

pub(crate) fn secure_database_files(path: &Path) -> StateResult<()> {
    for candidate in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        if let Ok(metadata) = fs::symlink_metadata(&candidate) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(StateError::Io(format!(
                    "database sidecar is not a regular file: {}",
                    candidate.display()
                )));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                let uid = unsafe { libc::geteuid() as u32 };
                if metadata.uid() != uid {
                    return Err(StateError::Io(format!(
                        "database file is not owned by current user: {}",
                        candidate.display()
                    )));
                }
                let mut permissions = metadata.permissions();
                permissions.set_mode(0o600);
                fs::set_permissions(&candidate, permissions)?;
                let verified = fs::symlink_metadata(&candidate)?;
                if verified.uid() != uid || verified.permissions().mode() & 0o777 != 0o600 {
                    return Err(StateError::Io(format!(
                        "database file failed security checks: {}",
                        candidate.display()
                    )));
                }
            }
        }
    }
    Ok(())
}

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<TaskRecord> {
    let status: String = row.get(1)?;
    let kind: String = row.get(3)?;
    let effort: String = row.get(4)?;
    let isolation: String = row.get(13)?;
    let priority = row.get::<_, i64>(5)?;
    let version = row.get::<_, i64>(16)?;
    let policy_epoch = row.get::<_, i64>(17)?;
    let policy_digest: Option<String> = row.get(18)?;
    Ok(TaskRecord {
        id: row.get(0)?,
        status: TaskStatus::parse(&status).ok_or_else(|| {
            rusqlite::Error::InvalidParameterName(format!("invalid task status: {status}"))
        })?,
        owner: row.get(2)?,
        kind: TaskKind::parse(&kind).ok_or_else(|| {
            rusqlite::Error::InvalidParameterName(format!("invalid task kind: {kind}"))
        })?,
        effort: TaskEffort::parse(&effort).ok_or_else(|| {
            rusqlite::Error::InvalidParameterName(format!("invalid task effort: {effort}"))
        })?,
        priority: safe_sql_i64(priority, "priority")?,
        blocked_by: parse_json_array(&row.get::<_, String>(6)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        claimed_at: row.get(7)?,
        started_at: row.get(8)?,
        finished_at: row.get(9)?,
        files_touched: parse_json_array(&row.get::<_, String>(10)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        read_set: parse_json_array(&row.get::<_, String>(11)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        write_set: parse_json_array(&row.get::<_, String>(12)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        isolation: TaskIsolation::parse(&isolation).ok_or_else(|| {
            rusqlite::Error::InvalidParameterName(format!("invalid task isolation: {isolation}"))
        })?,
        lease_id: row.get(15)?,
        version: safe_sql_u64(version, "version")?,
        policy_epoch: safe_sql_u64(policy_epoch, "policy_epoch")?,
        policy_digest: validate_policy_digest(policy_digest, "stored policy_digest")
            .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))?,
        report_id: row.get(19)?,
    })
}

fn task_row_from_row(row: &Row<'_>) -> rusqlite::Result<TaskRow> {
    let task = task_from_row(row)?;
    Ok(TaskRow {
        explicit_sets: row.get::<_, i64>(14)? == 1,
        task,
    })
}

fn read_task(connection: &Connection, id: &str) -> StateResult<Option<TaskRecord>> {
    connection
        .query_row(
            &format!("{SELECT_TASKS} WHERE id=?1"),
            params![id],
            task_from_row,
        )
        .optional()
        .map_err(StateError::from)
}

fn read_all_tasks(connection: &Connection) -> StateResult<Vec<TaskRecord>> {
    let mut statement = connection.prepare(&format!("{SELECT_TASKS} ORDER BY id ASC"))?;
    let rows = statement.query_map([], task_from_row)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(StateError::from)
}

fn read_all_tasks_with_sets(connection: &Connection) -> StateResult<Vec<TaskWithSets>> {
    let mut statement = connection.prepare(&format!("{SELECT_TASKS} ORDER BY id ASC"))?;
    let rows = statement.query_map([], task_row_from_row)?;
    rows.map(|row| {
        row.map(|value| TaskWithSets {
            task: value.task,
            explicit_sets: value.explicit_sets,
        })
        .map_err(StateError::from)
    })
    .collect()
}

fn read_lease(connection: &Connection, id: &str) -> StateResult<Option<LeaseRow>> {
    connection.query_row("SELECT lease_id,task_id,owner,acquired_at,expires_at,released_at FROM task_leases WHERE lease_id=?1", params![id], |row| Ok(LeaseRow { lease: TaskLease { lease_id: row.get(0)?, task_id: row.get(1)?, owner: row.get(2)?, acquired_at: row.get(3)?, expires_at: row.get(4)?, released_at: row.get(5)? } })).optional().map_err(StateError::from)
}

fn read_active_lease_for_task(connection: &Connection, id: &str) -> StateResult<Option<LeaseRow>> {
    connection.query_row("SELECT lease_id,task_id,owner,acquired_at,expires_at,released_at FROM task_leases WHERE task_id=?1 AND released_at IS NULL LIMIT 1", params![id], |row| Ok(LeaseRow { lease: TaskLease { lease_id: row.get(0)?, task_id: row.get(1)?, owner: row.get(2)?, acquired_at: row.get(3)?, expires_at: row.get(4)?, released_at: row.get(5)? } })).optional().map_err(StateError::from)
}

fn idempotent_task_id(connection: &Connection, key: &str) -> StateResult<Option<String>> {
    connection
        .query_row(
            "SELECT task_id FROM task_idempotency WHERE idempotency_key=?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(StateError::from)
}

fn current_sets_explicit(connection: &Connection, id: &str) -> StateResult<bool> {
    Ok(connection
        .query_row(
            "SELECT sets_explicit FROM tasks WHERE id=?1",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0)
        == 1)
}

fn read_graph_version(connection: &Connection) -> StateResult<u64> {
    let value: String = connection.query_row(
        "SELECT value FROM task_graph_meta WHERE key='graph_version'",
        [],
        |row| row.get(0),
    )?;
    let value = value
        .parse::<u64>()
        .map_err(|_| StateError::InvalidTask("Invalid task graph version".into()))?;
    ensure_u64(value, "graph_version")
}

fn bump_graph_version(connection: &Connection) -> StateResult<u64> {
    connection.execute("UPDATE task_graph_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='graph_version'", [])?;
    read_graph_version(connection)
}

fn insert_prepared(connection: &Connection, task: &PreparedTask) -> StateResult<()> {
    connection.execute("INSERT INTO tasks(id,status,owner,kind,effort,priority,blocked_by,claimed_at,started_at,finished_at,files_touched,read_set,write_set,isolation,sets_explicit,lease_id,version,policy_epoch,policy_digest,report_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,0,?17,?18,?19)", params![task.id, task.status.as_str(), task.owner, task.kind.as_str(), task.effort.as_str(), task.priority, json_array(&task.blocked_by)?, task.claimed_at, task.started_at, task.finished_at, json_array(&task.files_touched)?, json_array(&task.read_set)?, json_array(&task.write_set)?, task.isolation.as_str(), if task.explicit_sets { 1 } else { 0 }, task.lease_id, u64_to_i64(task.policy_epoch, "policy_epoch")?, task.policy_digest, task.report_id])?;
    Ok(())
}

fn validate_dependencies(
    connection: &Connection,
    task_id: &str,
    dependencies: &[String],
) -> StateResult<()> {
    let id = nonempty(task_id, "id")?;
    if dependencies.iter().any(|dependency| dependency == &id) {
        return Err(StateError::DependencyCycle(vec![id.clone(), id]));
    }
    let mut graph: HashMap<String, Vec<String>> = HashMap::new();
    let mut statement = connection.prepare("SELECT id,blocked_by FROM tasks")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (node, values) = row?;
        graph.insert(node, parse_json_array(&values)?);
    }
    graph.insert(id.clone(), dependencies.to_vec());
    for dependency in dependencies {
        if !graph.contains_key(dependency) {
            return Err(StateError::DependencyNotFound {
                task_id: id,
                dependency_id: dependency.clone(),
            });
        }
    }
    let nodes: Vec<String> = graph.keys().cloned().collect();
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    let mut path = Vec::new();
    for node in nodes {
        visit_dependency(&graph, &node, &mut visiting, &mut visited, &mut path)?;
    }
    Ok(())
}

fn visit_dependency(
    graph: &HashMap<String, Vec<String>>,
    node: &str,
    visiting: &mut HashSet<String>,
    visited: &mut HashSet<String>,
    path: &mut Vec<String>,
) -> StateResult<()> {
    if visiting.contains(node) {
        let start = path.iter().position(|value| value == node).unwrap_or(0);
        let mut cycle = path[start..].to_vec();
        cycle.push(node.to_owned());
        return Err(StateError::DependencyCycle(cycle));
    }
    if visited.contains(node) {
        return Ok(());
    }
    visiting.insert(node.to_owned());
    path.push(node.to_owned());
    if let Some(dependencies) = graph.get(node) {
        for dependency in dependencies {
            visit_dependency(graph, dependency, visiting, visited, path)?;
        }
    }
    path.pop();
    visiting.remove(node);
    visited.insert(node.to_owned());
    Ok(())
}

fn incomplete_dependencies(
    connection: &Connection,
    dependencies: &[String],
) -> StateResult<Vec<String>> {
    if dependencies.is_empty() {
        return Ok(Vec::new());
    }
    let unique: Vec<&String> = dependencies
        .iter()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let placeholders = std::iter::repeat_n("?", unique.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut statement = connection.prepare(&format!(
        "SELECT id,status FROM tasks WHERE id IN ({placeholders})"
    ))?;
    let values = unique
        .iter()
        .map(|value| *value as &dyn rusqlite::ToSql)
        .collect::<Vec<_>>();
    let rows = statement.query_map(rusqlite::params_from_iter(values), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let statuses = rows.collect::<Result<HashMap<_, _>, _>>()?;
    Ok(dependencies
        .iter()
        .filter(|dependency| {
            !statuses
                .get(*dependency)
                .map(|status| status == "completed")
                .unwrap_or(false)
        })
        .cloned()
        .collect())
}

fn expire_leases(connection: &Connection, now: &str) -> StateResult<RecoveryResult> {
    let mut statement = connection.prepare("SELECT lease_id,task_id,owner,acquired_at,expires_at,released_at FROM task_leases WHERE released_at IS NULL AND expires_at <= ?1 ORDER BY expires_at ASC, lease_id ASC")?;
    let rows = statement.query_map(params![now], |row| {
        Ok(TaskLease {
            lease_id: row.get(0)?,
            task_id: row.get(1)?,
            owner: row.get(2)?,
            acquired_at: row.get(3)?,
            expires_at: row.get(4)?,
            released_at: row.get(5)?,
        })
    })?;
    let leases = rows.collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let mut expired = Vec::new();
    let mut recovered = Vec::new();
    for lease in leases {
        connection.execute(
            "UPDATE task_leases SET released_at=?1 WHERE lease_id=?2 AND released_at IS NULL",
            params![now, lease.lease_id],
        )?;
        let task = read_task(connection, &lease.task_id)?;
        if let Some(task) = task {
            if task.lease_id.as_deref() == Some(lease.lease_id.as_str()) {
                let recovered_task = if matches!(
                    task.status,
                    TaskStatus::Claimed | TaskStatus::Running
                ) {
                    connection.execute("UPDATE tasks SET status='pending',owner=NULL,claimed_at=NULL,lease_id=NULL,version=version+1 WHERE id=?1 AND lease_id=?2", params![task.id, lease.lease_id])?;
                    let mut task = task;
                    task.status = TaskStatus::Pending;
                    task.owner = None;
                    task.claimed_at = None;
                    task.lease_id = None;
                    task.version += 1;
                    task
                } else {
                    connection.execute("UPDATE tasks SET lease_id=NULL,version=version+1 WHERE id=?1 AND lease_id=?2", params![task.id, lease.lease_id])?;
                    let mut task = task;
                    task.lease_id = None;
                    task.version += 1;
                    task
                };
                recovered.push(recovered_task);
            }
        }
        let mut released = lease;
        released.released_at = Some(now.to_owned());
        expired.push(released);
        bump_graph_version(connection)?;
    }
    Ok(RecoveryResult {
        expired_leases: expired.clone(),
        recovered_tasks: recovered.clone(),
        leases: expired,
        tasks: recovered,
    })
}

fn find_overlaps(candidate: &PreparedTask, existing: &[TaskWithSets]) -> Vec<OverlapConflict> {
    let (candidate_read, candidate_write) = effective_target_sets(
        &candidate.files_touched,
        &candidate.read_set,
        &candidate.write_set,
        candidate.explicit_sets,
    );
    let mut conflicts = Vec::new();
    for item in existing {
        if item.task.id == candidate.id || item.task.status.terminal() {
            continue;
        }
        let (existing_read, existing_write) = effective_target_sets(
            &item.task.files_touched,
            &item.task.read_set,
            &item.task.write_set,
            item.explicit_sets,
        );
        let existing_write = index_targets(&existing_write);
        let existing_read = index_targets(&existing_read);
        let mut paths = HashSet::new();
        let mut kinds = HashSet::new();
        for path in &candidate_write {
            if targets_overlap(path, &existing_write) {
                paths.insert(path.clone());
                kinds.insert("write_write".to_owned());
            }
            if targets_overlap(path, &existing_read) {
                paths.insert(path.clone());
                kinds.insert("write_read".to_owned());
            }
        }
        for path in &candidate_read {
            if targets_overlap(path, &existing_write) {
                paths.insert(path.clone());
                kinds.insert("write_read".to_owned());
            }
        }
        if !paths.is_empty() {
            let mut paths = paths.into_iter().collect::<Vec<_>>();
            paths.sort();
            let mut kinds = kinds.into_iter().collect::<Vec<_>>();
            kinds.sort();
            conflicts.push(OverlapConflict {
                task_id: item.task.id.clone(),
                paths,
                kinds,
                existing_isolation: item.task.isolation,
                new_isolation: candidate.isolation,
            });
        }
    }
    conflicts.sort_by(|left, right| left.task_id.cmp(&right.task_id));
    conflicts
}

fn effective_target_sets(
    files: &[String],
    read: &[String],
    write: &[String],
    explicit: bool,
) -> (Vec<String>, Vec<String>) {
    if explicit || !read.is_empty() || !write.is_empty() {
        (read.to_vec(), write.to_vec())
    } else {
        (Vec::new(), files.to_vec())
    }
}

#[derive(Debug, Default)]
struct TargetLookup {
    exact: HashSet<String>,
    legacy: HashSet<String>,
    scoped_by_path: HashMap<String, HashSet<String>>,
}

fn parse_scoped_target(target: &str) -> Option<(&str, &str)> {
    let value = target.strip_prefix(TARGET_SCOPE_PREFIX)?;
    let separator = value.find('/')?;
    if separator == 0 || separator + 1 >= value.len() {
        return None;
    }
    Some((&value[..separator], &value[separator + 1..]))
}

fn index_targets(targets: &[String]) -> TargetLookup {
    let mut result = TargetLookup::default();
    for target in targets {
        result.exact.insert(target.clone());
        if let Some((hash, path)) = parse_scoped_target(target) {
            result
                .scoped_by_path
                .entry(path.to_owned())
                .or_default()
                .insert(hash.to_owned());
        } else {
            result.legacy.insert(target.clone());
        }
    }
    result
}

fn targets_overlap(target: &str, existing: &TargetLookup) -> bool {
    if existing.exact.contains(target) {
        return true;
    }
    if let Some((_, path)) = parse_scoped_target(target) {
        existing.legacy.contains(path)
    } else {
        existing.scoped_by_path.contains_key(target)
    }
}

fn make_overlap_decision(
    isolation: TaskIsolation,
    mode: ConflictMode,
    conflicts: Vec<OverlapConflict>,
    blocked_by: Vec<String>,
) -> OverlapDecision {
    if conflicts.is_empty() {
        return overlap_decision("allow", mode, isolation, conflicts, blocked_by, true);
    }
    if matches!(isolation, TaskIsolation::Worktree) {
        return overlap_decision(
            "worktree_isolated",
            mode,
            isolation,
            conflicts,
            blocked_by,
            true,
        );
    }
    if matches!(mode, ConflictMode::Reject) {
        return overlap_decision("rejected", mode, isolation, conflicts, blocked_by, false);
    }
    overlap_decision("blocked", mode, isolation, conflicts, blocked_by, true)
}

fn overlap_decision(
    action: &str,
    mode: ConflictMode,
    isolation: TaskIsolation,
    conflicts: Vec<OverlapConflict>,
    blocked_by: Vec<String>,
    allowed: bool,
) -> OverlapDecision {
    OverlapDecision {
        action: action.to_owned(),
        allowed,
        mode,
        isolation,
        conflicts,
        blocked_by,
    }
}

#[derive(Debug, Clone)]
struct PreparedTask {
    id: String,
    status: TaskStatus,
    owner: Option<String>,
    kind: TaskKind,
    effort: TaskEffort,
    priority: i64,
    blocked_by: Vec<String>,
    claimed_at: Option<String>,
    started_at: Option<String>,
    finished_at: Option<String>,
    files_touched: Vec<String>,
    read_set: Vec<String>,
    write_set: Vec<String>,
    isolation: TaskIsolation,
    explicit_sets: bool,
    lease_id: Option<String>,
    policy_epoch: u64,
    policy_digest: Option<String>,
    report_id: Option<String>,
    idempotency_key: Option<String>,
}

impl PreparedTask {
    fn from_input(input: TaskInput, generated_id: Option<String>) -> StateResult<Self> {
        let id = input
            .id
            .or(generated_id)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let id = nonempty(&id, "id")?;
        let status = input.status.unwrap_or(TaskStatus::Pending);
        let owner = input
            .owner
            .map(|value| nonempty(&value, "owner"))
            .transpose()?;
        let kind = input.kind.unwrap_or(TaskKind::Implement);
        let priority = input.priority.unwrap_or(0);
        ensure_js_safe_i64(priority, "priority")?;
        let explicit_sets = input.read_set.is_some() || input.write_set.is_some();
        let blocked_by = normalize_strings(
            input.blocked_by.or(input.depends_on).unwrap_or_default(),
            "blocked_by",
        )?;
        let files_touched =
            normalize_targets(input.files_touched.unwrap_or_default(), "files_touched")?;
        let read_set = normalize_targets(input.read_set.unwrap_or_default(), "read_set")?;
        let write_set = normalize_targets(input.write_set.unwrap_or_default(), "write_set")?;
        // Explicit effort always wins; otherwise the deterministic Ares
        // heuristic classifies the step before dispatch (§6.3).
        let effort = input.effort.unwrap_or_else(|| {
            ares_classify(AresSignals {
                kind,
                read_set_len: read_set.len(),
                write_set_len: write_set.len(),
                blocked_by_len: blocked_by.len(),
            })
            .effort
        });
        let isolation = input.isolation.unwrap_or(TaskIsolation::Shared);
        let lease_id = input
            .lease_id
            .map(|value| nonempty(&value, "lease_id"))
            .transpose()?;
        let policy_epoch = input.policy_epoch.unwrap_or(0);
        ensure_u64(policy_epoch, "policy_epoch")?;
        if input.policy_epoch.is_some() != input.policy_digest.is_some() {
            return Err(StateError::InvalidTask(
                "policy_epoch and policy_digest must be provided together".into(),
            ));
        }
        let policy_digest = validate_policy_digest(input.policy_digest.flatten(), "policy_digest")?;
        let report_id = input
            .report_id
            .map(|value| nonempty(&value, "report_id"))
            .transpose()?;
        let claimed_at = input
            .claimed_at
            .map(|value| nonempty(&value, "claimed_at"))
            .transpose()?;
        let started_input = input
            .started_at
            .map(|value| nonempty(&value, "started_at"))
            .transpose()?;
        let finished_input = input
            .finished_at
            .map(|value| nonempty(&value, "finished_at"))
            .transpose()?;
        let lifecycle_now = if started_input.is_none()
            && finished_input.is_none()
            && (matches!(status, TaskStatus::Running) || status.terminal())
        {
            Some(now_string(None)?)
        } else {
            None
        };
        let started_at = started_input.or_else(|| {
            matches!(status, TaskStatus::Running)
                .then(|| lifecycle_now.clone())
                .flatten()
        });
        let finished_at =
            finished_input.or_else(|| status.terminal().then(|| lifecycle_now.clone()).flatten());
        if matches!(status, TaskStatus::Claimed | TaskStatus::Running)
            && (owner.is_none() || lease_id.is_none())
        {
            return Err(StateError::InvalidTask(
                "claimed and running tasks require owner and lease_id".into(),
            ));
        }
        let idempotency_key = input
            .idempotency_key
            .map(|value| nonempty(&value, "idempotency_key"))
            .transpose()?;
        Ok(Self {
            id,
            status,
            owner,
            kind,
            effort,
            priority,
            blocked_by,
            claimed_at,
            started_at,
            finished_at,
            files_touched,
            read_set,
            write_set,
            isolation,
            explicit_sets,
            lease_id,
            policy_epoch,
            policy_digest,
            report_id,
            idempotency_key,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn with_blocked_by(
        &self,
        blocked_by: Vec<String>,
        status: TaskStatus,
        owner: Option<String>,
        claimed_at: Option<String>,
        started_at: Option<String>,
        finished_at: Option<String>,
        lease_id: Option<String>,
    ) -> Self {
        let mut copy = self.clone();
        copy.blocked_by = blocked_by;
        copy.status = status;
        copy.owner = owner;
        copy.claimed_at = claimed_at;
        copy.started_at = started_at;
        copy.finished_at = finished_at;
        copy.lease_id = lease_id;
        copy
    }
}

fn append_unique(target: &mut Vec<String>, values: impl IntoIterator<Item = String>) {
    for value in values {
        if !target.contains(&value) {
            target.push(value);
        }
    }
}

fn normalize_strings(values: Vec<String>, field: &str) -> StateResult<Vec<String>> {
    let mut result = Vec::new();
    for value in values {
        let normalized = nonempty(&value, field)?;
        if !result.contains(&normalized) {
            result.push(normalized);
        }
    }
    Ok(result)
}

fn normalize_targets(values: Vec<String>, field: &str) -> StateResult<Vec<String>> {
    let mut result = Vec::new();
    for value in values {
        let normalized = normalize_target(&value, field)?;
        if !result.contains(&normalized) {
            result.push(normalized);
        }
    }
    Ok(result)
}

fn normalize_target(value: &str, field: &str) -> StateResult<String> {
    let raw = value.trim();
    if raw.is_empty() {
        return Err(StateError::InvalidTask(format!(
            "{field} must not contain empty targets"
        )));
    }
    if raw.contains('\0') {
        return Err(StateError::InvalidTask(format!(
            "{field} contains a NUL byte"
        )));
    }
    let portable = raw.replace('\\', "/");
    let drive_path =
        portable.len() >= 3 && portable.as_bytes()[1] == b':' && portable.as_bytes()[2] == b'/';
    if portable.starts_with('/')
        || portable.starts_with("//")
        || drive_path
        || portable.starts_with('~')
    {
        return Err(StateError::InvalidTask(format!(
            "{field} must be cwd-relative: {value:?}"
        )));
    }
    let parts = portable.split('/').collect::<Vec<_>>();
    if parts.contains(&"..") {
        return Err(StateError::InvalidTask(format!(
            "{field} must not traverse outside the cwd: {value:?}"
        )));
    }
    let parts = parts
        .into_iter()
        .filter(|part| *part != ".")
        .collect::<Vec<_>>();
    if parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        return Err(StateError::InvalidTask(format!(
            "{field} contains an ambiguous target: {value:?}"
        )));
    }
    Ok(parts.join("/"))
}

fn nonempty(value: &str, field: &str) -> StateResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(StateError::InvalidTask(format!(
            "{field} must be a non-empty string"
        )));
    }
    Ok(value.to_owned())
}

fn positive_u64(value: u64, field: &str) -> StateResult<u64> {
    ensure_u64(value, field)?;
    if value == 0 {
        return Err(StateError::InvalidTask(format!("{field} must be positive")));
    }
    Ok(value)
}

fn ensure_u64(value: u64, field: &str) -> StateResult<u64> {
    if value > JS_MAX_SAFE_INTEGER {
        return Err(StateError::InvalidTask(format!(
            "{field} must be a JavaScript safe integer"
        )));
    }
    Ok(value)
}

fn ensure_js_safe_i64(value: i64, field: &str) -> StateResult<i64> {
    if value < -(JS_MAX_SAFE_INTEGER as i64) || value > JS_MAX_SAFE_INTEGER as i64 {
        return Err(StateError::InvalidTask(format!(
            "{field} must be a JavaScript safe integer"
        )));
    }
    Ok(value)
}

fn safe_sql_i64(value: i64, field: &str) -> rusqlite::Result<i64> {
    ensure_js_safe_i64(value, field).map_err(|_| rusqlite::Error::InvalidQuery)
}

fn safe_sql_u64(value: i64, field: &str) -> rusqlite::Result<u64> {
    if value < 0 || value as u64 > JS_MAX_SAFE_INTEGER {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let _ = field;
    Ok(value as u64)
}

fn u64_to_i64(value: u64, field: &str) -> StateResult<i64> {
    ensure_u64(value, field).map(|value| value as i64)
}
fn sqlite_integer(value: u64, field: &str) -> StateResult<i64> {
    u64_to_i64(value, field)
}

fn json_array(values: &[String]) -> StateResult<String> {
    serde_json::to_string(values).map_err(|error| StateError::InvalidTask(error.to_string()))
}

fn parse_json_array(value: &str) -> StateResult<Vec<String>> {
    let parsed: Value =
        serde_json::from_str(value).map_err(|error| StateError::InvalidTask(error.to_string()))?;
    Ok(deduplicate_preserving_order(json_string_array(
        &parsed,
        "stored array",
    )?))
}

fn deduplicate_preserving_order(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn json_string_array(value: &Value, field: &str) -> StateResult<Vec<String>> {
    let Some(values) = value.as_array() else {
        return Err(StateError::InvalidTask(format!(
            "{field} must be an array of strings"
        )));
    };
    values
        .iter()
        .map(|value| {
            value.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                StateError::InvalidTask(format!("{field} must be an array of strings"))
            })
        })
        .collect()
}

fn normalize_targets_json(value: &Value, field: &str) -> StateResult<Vec<String>> {
    normalize_targets(json_string_array(value, field)?, field)
}
fn json_i64(value: &Value, field: &str) -> StateResult<i64> {
    let value = value
        .as_i64()
        .ok_or_else(|| StateError::InvalidTask(format!("{field} must be an integer")))?;
    ensure_js_safe_i64(value, field)
}
fn json_u64(value: &Value, field: &str) -> StateResult<u64> {
    let value = value.as_u64().ok_or_else(|| {
        StateError::InvalidTask(format!("{field} must be a non-negative integer"))
    })?;
    ensure_u64(value, field)
}

fn extract_expected_version(patch: &Value, explicit: Option<u64>) -> StateResult<Option<u64>> {
    if let Some(version) = explicit {
        return ensure_u64(version, "expected_version").map(Some);
    }
    let Some(object) = patch.as_object() else {
        return Ok(None);
    };
    for field in ["expectedVersion", "expected_version", "version"] {
        if let Some(value) = object.get(field) {
            return json_u64(value, field).map(Some);
        }
    }
    Ok(None)
}

fn nullable_string(value: &Value, field: &str) -> StateResult<Option<String>> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(|value| nonempty(value, field))
        .transpose()
}

fn optional_nullable_string(
    object: &Map<String, Value>,
    field: &str,
) -> StateResult<Option<Option<String>>> {
    object
        .get(field)
        .map(|value| nullable_string(value, field))
        .transpose()
}

fn optional_enum<T>(
    object: &Map<String, Value>,
    field: &str,
    parse: impl Fn(&str) -> Option<T>,
) -> StateResult<Option<T>> {
    let Some(value) = object.get(field) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| StateError::InvalidTask(format!("{field} must be a string")))?;
    parse(value)
        .ok_or_else(|| StateError::InvalidTask(format!("Unknown {field}: {value}")))
        .map(Some)
}

fn patch_is_object(value: &Value) -> StateResult<bool> {
    if value.is_object() {
        Ok(true)
    } else {
        Ok(false)
    }
}

fn validate_patch_keys(patch: &Value) -> StateResult<()> {
    let Some(object) = patch.as_object() else {
        return Err(StateError::InvalidTask("patch must be an object".into()));
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
        "policy_digest",
        "report_id",
        "expectedVersion",
        "expected_version",
        "version",
    ];
    if let Some(unknown) = object.keys().find(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(StateError::InvalidTask(format!(
            "unknown patch field: {unknown}"
        )));
    }
    Ok(())
}

fn now_string(value: Option<&str>) -> StateResult<String> {
    let now = match value {
        Some(value) => DateTime::parse_from_rfc3339(value)
            .map(|date| date.with_timezone(&Utc))
            .map_err(|error| {
                StateError::InvalidTask(format!("now must be a valid date: {error}"))
            })?,
        None => Utc::now(),
    };
    Ok(now.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn add_millis(value: &str, milliseconds: u64) -> StateResult<String> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Utc))
        .map_err(|error| StateError::InvalidTask(format!("now must be a valid date: {error}")))?;
    let millis = i64::try_from(milliseconds)
        .map_err(|_| StateError::InvalidTask("lease TTL is too large".into()))?;
    Ok(
        (parsed + ChronoDuration::milliseconds(millis))
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    )
}

#[cfg(unix)]
mod unix_permissions {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    #[allow(dead_code)]
    pub fn current_uid() -> u32 {
        unsafe { libc::geteuid() as u32 }
    }

    #[allow(dead_code)]
    pub fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
        let metadata = fs::metadata(path)?;
        let mut permissions = metadata.permissions();
        permissions.set_mode(mode);
        fs::set_permissions(path, permissions)
    }

    #[allow(dead_code)]
    pub fn uid(metadata: &fs::Metadata) -> u32 {
        metadata.uid()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn graph() -> TaskGraph {
        TaskGraph::open(TaskGraphConfig {
            state_dir: tempdir().unwrap().keep(),
            lease_ttl_ms: 1_000,
        })
        .unwrap()
    }

    #[test]
    fn defaults_and_normalization_match_wire_contract() {
        let graph = graph();
        let task = graph
            .create(TaskInput {
                id: Some("a".into()),
                files_touched: Some(vec!["./src\\main.rs".into()]),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(task.status, TaskStatus::Pending);
        assert_eq!(task.effort, TaskEffort::Medium);
        assert_eq!(task.files_touched, vec!["src/main.rs"]);
        assert_eq!(task.version, 0);
    }

    #[test]
    fn route_is_idempotent_and_blocks_conflicts() {
        let graph = graph();
        graph
            .route(
                TaskInput {
                    id: Some("a".into()),
                    files_touched: Some(vec!["src/a.rs".into()]),
                    idempotency_key: Some("k".into()),
                    ..Default::default()
                },
                ConflictMode::Block,
            )
            .unwrap();
        let result = graph
            .route(
                TaskInput {
                    id: Some("b".into()),
                    files_touched: Some(vec!["src/a.rs".into()]),
                    ..Default::default()
                },
                ConflictMode::Block,
            )
            .unwrap();
        assert_eq!(result.decision.action, "blocked");
        assert_eq!(result.task.unwrap().blocked_by, vec!["a"]);
        let replay = graph
            .route(
                TaskInput {
                    id: Some("different".into()),
                    idempotency_key: Some("k".into()),
                    ..Default::default()
                },
                ConflictMode::Block,
            )
            .unwrap();
        assert!(!replay.created);
        assert_eq!(replay.decision.action, "idempotent");
    }

    #[test]
    fn dependency_and_lease_lifecycle_is_atomic() {
        let graph = graph();
        graph
            .create(TaskInput {
                id: Some("dep".into()),
                ..Default::default()
            })
            .unwrap();
        graph
            .create(TaskInput {
                id: Some("child".into()),
                blocked_by: Some(vec!["dep".into()]),
                ..Default::default()
            })
            .unwrap();
        let blocked = graph
            .claim("child", "worker", ClaimOptions::default())
            .unwrap();
        assert!(
            matches!(blocked, ClaimResult::Failure(ClaimFailure { reason, .. }) if reason == "dependencies_incomplete")
        );
        graph
            .update("dep", json!({"status":"completed"}), None)
            .unwrap();
        let claimed = graph
            .claim(
                "child",
                "worker",
                ClaimOptions {
                    lease_id: Some("lease".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(matches!(claimed, ClaimResult::Success(_)));
        let released = graph
            .release_lease("lease", Some("worker"), Some("2026-08-06T00:00:00Z"))
            .unwrap()
            .unwrap();
        assert_eq!(
            released.released_at.as_deref(),
            Some("2026-08-06T00:00:00.000Z")
        );
    }

    #[test]
    fn snapshot_is_owned() {
        let graph = graph();
        graph
            .create(TaskInput {
                id: Some("a".into()),
                ..Default::default()
            })
            .unwrap();
        let snapshot = graph.snapshot().unwrap();
        graph
            .update("a", json!({"status":"completed"}), None)
            .unwrap();
        assert_eq!(snapshot.tasks[0].status, TaskStatus::Pending);
        assert_eq!(snapshot.version, snapshot.graph_version);
    }
}
