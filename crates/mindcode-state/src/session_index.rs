//! Durable SQLite session metadata index for MindCode.
//!
//! The index deliberately stores only session metadata and paths.  Transcript
//! contents, credentials, and other secrets never enter this database.

use crate::{
    configure_connection, ensure_secure_state_dir, reject_database_symlink,
    resolve_mindcode_config_dir, secure_database_files, StateError, StateResult,
    JS_MAX_SAFE_INTEGER,
};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::env;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const SESSION_INDEX_SCHEMA_VERSION: u64 = 1;
pub const DEFAULT_SESSION_LIMIT: u64 = 100;
pub const MAX_SESSION_LIMIT: u64 = 1_000;
pub const MAX_SESSION_ID_BYTES: usize = 256;
pub const MAX_SESSION_PROJECT_PATH_BYTES: usize = 4_096;
pub const MAX_SESSION_TRANSCRIPT_PATH_BYTES: usize = 4_096;
pub const MAX_SESSION_TITLE_BYTES: usize = 4_096;
pub const MAX_SESSION_FIRST_PROMPT_BYTES: usize = 16 * 1024;
pub const MAX_SESSION_QUERY_BYTES: usize = 4_096;

const SESSION_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS session_index_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO session_index_meta(key, value) VALUES ('schema_version', '1');

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  project_path TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  modified_at_ms INTEGER NOT NULL CHECK (modified_at_ms BETWEEN 0 AND 9007199254740991),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 9007199254740991),
  title TEXT,
  first_prompt TEXT
);
"#;

const SELECT_SESSION: &str =
    "SELECT session_id,project_path,transcript_path,modified_at_ms,size_bytes,title,first_prompt FROM sessions";

#[derive(Debug, Clone)]
pub struct SessionIndexConfig {
    pub state_dir: PathBuf,
}

impl SessionIndexConfig {
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
        }
    }

    pub fn with_state_dir(state_dir: impl Into<PathBuf>) -> Self {
        Self {
            state_dir: state_dir.into(),
        }
    }
}

impl Default for SessionIndexConfig {
    fn default() -> Self {
        Self::from_env()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRecord {
    pub session_id: String,
    pub project_path: String,
    pub transcript_path: String,
    pub modified_at_ms: u64,
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionListOptions {
    pub project_path: Option<String>,
    pub limit: Option<u64>,
    pub before_modified_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSearchOptions {
    pub query: String,
    pub project_path: Option<String>,
    pub limit: Option<u64>,
    pub before_modified_at_ms: Option<u64>,
}

#[derive(Debug)]
pub struct SessionIndex {
    config: SessionIndexConfig,
    initialized: OnceLock<StateResult<()>>,
}

impl SessionIndex {
    pub fn new(config: SessionIndexConfig) -> Self {
        Self {
            config,
            initialized: OnceLock::new(),
        }
    }

    pub fn open(config: SessionIndexConfig) -> StateResult<Self> {
        let index = Self::new(config);
        index.initialize()?;
        Ok(index)
    }

    pub fn from_env() -> Self {
        Self::new(SessionIndexConfig::from_env())
    }

    pub fn state_dir(&self) -> &Path {
        &self.config.state_dir
    }

    pub fn database_path(&self) -> PathBuf {
        self.config.state_dir.join("sessions.db")
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

    pub fn upsert(&self, record: SessionRecord) -> StateResult<SessionRecord> {
        validate_record(&record)?;
        let mut connection = self.connection()?;
        let transaction = Transaction::new(&mut connection, TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO sessions(session_id,project_path,transcript_path,modified_at_ms,size_bytes,title,first_prompt) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(session_id) DO UPDATE SET project_path=CASE WHEN excluded.modified_at_ms >= sessions.modified_at_ms THEN excluded.project_path ELSE sessions.project_path END, transcript_path=CASE WHEN excluded.modified_at_ms >= sessions.modified_at_ms THEN excluded.transcript_path ELSE sessions.transcript_path END, modified_at_ms=CASE WHEN excluded.modified_at_ms >= sessions.modified_at_ms THEN excluded.modified_at_ms ELSE sessions.modified_at_ms END, size_bytes=CASE WHEN excluded.modified_at_ms >= sessions.modified_at_ms THEN excluded.size_bytes ELSE sessions.size_bytes END, title=CASE WHEN excluded.title = '' THEN NULL ELSE COALESCE(excluded.title, sessions.title) END, first_prompt=CASE WHEN excluded.first_prompt = '' THEN NULL ELSE COALESCE(excluded.first_prompt, sessions.first_prompt) END",
            params![
                record.session_id,
                record.project_path,
                record.transcript_path,
                to_sql_i64(record.modified_at_ms, "modified_at_ms")?,
                to_sql_i64(record.size_bytes, "size_bytes")?,
                record.title,
                record.first_prompt,
            ],
        )?;
        let stored = read_session(&transaction, &record.session_id)?
            .ok_or_else(|| StateError::InvalidSession("upserted session disappeared".into()))?;
        secure_database_files(&self.database_path())?;
        transaction.commit()?;
        Ok(stored)
    }

    pub fn get(&self, session_id: &str) -> StateResult<Option<SessionRecord>> {
        let session_id = validate_required_string(session_id, "session_id", MAX_SESSION_ID_BYTES)?;
        let connection = self.connection()?;
        read_session(&connection, &session_id)
    }

    pub fn list(&self, options: SessionListOptions) -> StateResult<Vec<SessionRecord>> {
        let (project_path, before_modified_at_ms, limit) = validate_list_options(&options)?;
        let connection = self.connection()?;
        let limit = to_sql_i64(limit, "limit")?;
        let before = before_modified_at_ms
            .map(|value| to_sql_i64(value, "before_modified_at_ms"))
            .transpose()?;
        let mut statement = connection.prepare(&format!(
            "{SELECT_SESSION} WHERE (?1 IS NULL OR project_path = ?1) AND (?2 IS NULL OR modified_at_ms < ?2) ORDER BY modified_at_ms DESC, session_id ASC LIMIT ?3"
        ))?;
        let rows = statement.query_map(
            params![project_path.as_deref(), before, limit],
            session_from_row,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StateError::from)
    }

    pub fn search(&self, options: SessionSearchOptions) -> StateResult<Vec<SessionRecord>> {
        let query = validate_required_string(&options.query, "query", MAX_SESSION_QUERY_BYTES)?;
        let needle = query.to_lowercase();
        let (project_path, before_modified_at_ms, limit) =
            validate_list_options(&SessionListOptions {
                project_path: options.project_path,
                limit: options.limit,
                before_modified_at_ms: options.before_modified_at_ms,
            })?;
        let connection = self.connection()?;
        let before = before_modified_at_ms
            .map(|value| to_sql_i64(value, "before_modified_at_ms"))
            .transpose()?;
        let mut statement = connection.prepare(&format!(
            "{SELECT_SESSION} WHERE (?1 IS NULL OR project_path = ?1) AND (?2 IS NULL OR modified_at_ms < ?2) ORDER BY modified_at_ms DESC, session_id ASC"
        ))?;
        let rows =
            statement.query_map(params![project_path.as_deref(), before], session_from_row)?;
        let mut matches = Vec::new();
        for row in rows {
            let record = row.map_err(StateError::from)?;
            if [
                record.title.as_deref().unwrap_or_default(),
                record.first_prompt.as_deref().unwrap_or_default(),
                record.project_path.as_str(),
            ]
            .iter()
            .any(|field| field.to_lowercase().contains(&needle))
            {
                matches.push(record);
                if matches.len() >= limit as usize {
                    break;
                }
            }
        }
        Ok(matches)
    }

    pub fn remove(&self, session_id: &str) -> StateResult<bool> {
        let session_id = validate_required_string(session_id, "session_id", MAX_SESSION_ID_BYTES)?;
        let mut connection = self.connection()?;
        let transaction = Transaction::new(&mut connection, TransactionBehavior::Immediate)?;
        let removed = transaction.execute(
            "DELETE FROM sessions WHERE session_id=?1",
            params![session_id],
        )?;
        secure_database_files(&self.database_path())?;
        transaction.commit()?;
        Ok(removed == 1)
    }
}

fn validate_record(record: &SessionRecord) -> StateResult<()> {
    validate_required_string(&record.session_id, "session_id", MAX_SESSION_ID_BYTES)?;
    validate_required_string(
        &record.project_path,
        "project_path",
        MAX_SESSION_PROJECT_PATH_BYTES,
    )?;
    validate_required_string(
        &record.transcript_path,
        "transcript_path",
        MAX_SESSION_TRANSCRIPT_PATH_BYTES,
    )?;
    validate_js_nonnegative(record.modified_at_ms, "modified_at_ms")?;
    validate_js_nonnegative(record.size_bytes, "size_bytes")?;
    validate_optional_string(record.title.as_deref(), "title", MAX_SESSION_TITLE_BYTES)?;
    validate_optional_string(
        record.first_prompt.as_deref(),
        "first_prompt",
        MAX_SESSION_FIRST_PROMPT_BYTES,
    )?;
    Ok(())
}

fn validate_list_options(
    options: &SessionListOptions,
) -> StateResult<(Option<String>, Option<u64>, u64)> {
    let project_path = options
        .project_path
        .as_deref()
        .map(|value| {
            validate_required_string(value, "project_path", MAX_SESSION_PROJECT_PATH_BYTES)
        })
        .transpose()?;
    if let Some(value) = options.before_modified_at_ms {
        validate_js_nonnegative(value, "before_modified_at_ms")?;
    }
    let limit = options.limit.unwrap_or(DEFAULT_SESSION_LIMIT);
    if limit > MAX_SESSION_LIMIT {
        return Err(StateError::InvalidSession(format!(
            "limit must be between 0 and {MAX_SESSION_LIMIT}"
        )));
    }
    Ok((project_path, options.before_modified_at_ms, limit))
}

fn validate_required_string(value: &str, field: &str, max_bytes: usize) -> StateResult<String> {
    if value.is_empty() {
        return Err(StateError::InvalidSession(format!(
            "{field} must not be empty"
        )));
    }
    if value.len() > max_bytes {
        return Err(StateError::InvalidSession(format!(
            "{field} exceeds maximum length of {max_bytes} bytes"
        )));
    }
    Ok(value.to_owned())
}

fn validate_optional_string(value: Option<&str>, field: &str, max_bytes: usize) -> StateResult<()> {
    if let Some(value) = value {
        if value.len() > max_bytes {
            return Err(StateError::InvalidSession(format!(
                "{field} exceeds maximum length of {max_bytes} bytes"
            )));
        }
    }
    Ok(())
}

fn validate_js_nonnegative(value: u64, field: &str) -> StateResult<()> {
    if value > JS_MAX_SAFE_INTEGER {
        return Err(StateError::InvalidSession(format!(
            "{field} must be a nonnegative JavaScript-safe integer"
        )));
    }
    Ok(())
}

fn to_sql_i64(value: u64, field: &str) -> StateResult<i64> {
    validate_js_nonnegative(value, field)?;
    i64::try_from(value).map_err(|_| StateError::InvalidSession(format!("{field} is too large")))
}

fn session_from_row(row: &Row<'_>) -> rusqlite::Result<SessionRecord> {
    let record = SessionRecord {
        session_id: row.get(0)?,
        project_path: row.get(1)?,
        transcript_path: row.get(2)?,
        modified_at_ms: stored_u64(row.get(3)?, "modified_at_ms")?,
        size_bytes: stored_u64(row.get(4)?, "size_bytes")?,
        title: row.get(5)?,
        first_prompt: row.get(6)?,
    };
    validate_record(&record)
        .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))?;
    Ok(record)
}

fn stored_u64(value: i64, field: &str) -> rusqlite::Result<u64> {
    let value = u64::try_from(value).map_err(|_| {
        rusqlite::Error::InvalidParameterName(format!("stored {field} is negative"))
    })?;
    if value > JS_MAX_SAFE_INTEGER {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "stored {field} is not JavaScript-safe"
        )));
    }
    Ok(value)
}

fn read_session(connection: &Connection, session_id: &str) -> StateResult<Option<SessionRecord>> {
    connection
        .query_row(
            &format!("{SELECT_SESSION} WHERE session_id=?1"),
            params![session_id],
            session_from_row,
        )
        .optional()
        .map_err(StateError::from)
}

fn migrate_schema(connection: &mut Connection, database_path: &Path) -> StateResult<()> {
    let existing_version = read_schema_version(connection)?;
    if let Some(version) = existing_version {
        if version > SESSION_INDEX_SCHEMA_VERSION {
            return Err(StateError::InvalidSession(format!(
                "unsupported future session index schema version: {version}"
            )));
        }
    }
    let transaction = Transaction::new(connection, TransactionBehavior::Immediate)?;
    transaction.execute_batch(SESSION_SCHEMA)?;
    let columns = table_columns(&transaction, "sessions")?;
    if !columns.contains("session_id") {
        return Err(StateError::InvalidSession(
            "sessions table is missing session_id".into(),
        ));
    }
    let additions = [
        ("project_path", "TEXT NOT NULL DEFAULT ''"),
        ("transcript_path", "TEXT NOT NULL DEFAULT ''"),
        ("modified_at_ms", "INTEGER NOT NULL DEFAULT 0"),
        ("size_bytes", "INTEGER NOT NULL DEFAULT 0"),
        ("title", "TEXT"),
        ("first_prompt", "TEXT"),
    ];
    for (name, definition) in additions {
        if !columns.contains(name) {
            transaction.execute(
                &format!("ALTER TABLE sessions ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }
    transaction.execute_batch(
        "CREATE INDEX IF NOT EXISTS sessions_modified_idx ON sessions(modified_at_ms DESC, session_id ASC); CREATE INDEX IF NOT EXISTS sessions_project_modified_idx ON sessions(project_path, modified_at_ms DESC, session_id ASC);",
    )?;
    transaction.execute(
        "INSERT OR IGNORE INTO session_index_meta(key,value) VALUES ('schema_version','1')",
        [],
    )?;
    transaction.execute(
        "UPDATE session_index_meta SET value='1' WHERE key='schema_version'",
        [],
    )?;
    secure_database_files(database_path)?;
    transaction.commit()?;
    Ok(())
}

fn read_schema_version(connection: &Connection) -> StateResult<Option<u64>> {
    let table_exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_index_meta')",
        [],
        |row| row.get::<_, i64>(0),
    )? == 1;
    if !table_exists {
        return Ok(None);
    }
    let Some(value): Option<String> = connection
        .query_row(
            "SELECT value FROM session_index_meta WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let version = value
        .parse::<u64>()
        .map_err(|_| StateError::InvalidSession("invalid session index schema version".into()))?;
    Ok(Some(version))
}

fn table_columns(
    connection: &Connection,
    table: &str,
) -> StateResult<std::collections::HashSet<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(StateError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::Arc;
    use tempfile::tempdir;

    fn record(id: &str, modified_at_ms: u64) -> SessionRecord {
        SessionRecord {
            session_id: id.into(),
            project_path: "/project".into(),
            transcript_path: format!("/transcripts/{id}.jsonl"),
            modified_at_ms,
            size_bytes: 42,
            title: Some(format!("Title {id}")),
            first_prompt: Some(format!("Prompt {id}")),
        }
    }

    fn index() -> (SessionIndex, tempfile::TempDir) {
        let directory = tempdir().unwrap();
        let index =
            SessionIndex::open(SessionIndexConfig::with_state_dir(directory.path())).unwrap();
        (index, directory)
    }

    #[test]
    fn upsert_get_list_search_and_remove_store_metadata_only() {
        let (index, _directory) = index();
        index.upsert(record("a", 10)).unwrap();
        index.upsert(record("b", 20)).unwrap();
        assert_eq!(index.get("a").unwrap().unwrap().session_id, "a");
        assert_eq!(
            index
                .list(SessionListOptions::default())
                .unwrap()
                .into_iter()
                .map(|item| item.session_id)
                .collect::<Vec<_>>(),
            vec!["b", "a"]
        );
        assert_eq!(
            index
                .search(SessionSearchOptions {
                    query: "TITLE A".into(),
                    ..Default::default()
                })
                .unwrap()
                .len(),
            1
        );
        assert!(index.remove("a").unwrap());
        assert!(!index.remove("a").unwrap());
    }

    #[test]
    fn migration_adds_columns_and_permissions_are_private() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("sessions.db");
        let database = Connection::open(&database_path).unwrap();
        database
            .execute_batch("CREATE TABLE sessions (session_id TEXT PRIMARY KEY NOT NULL);")
            .unwrap();
        drop(database);
        let index =
            SessionIndex::open(SessionIndexConfig::with_state_dir(directory.path())).unwrap();
        index.upsert(record("legacy", 1)).unwrap();
        assert!(index.get("legacy").unwrap().is_some());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(directory.path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&database_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            for suffix in ["-wal", "-shm"] {
                let path = PathBuf::from(format!("{}{}", database_path.display(), suffix));
                if path.exists() {
                    assert_eq!(
                        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                }
            }
        }
    }

    #[test]
    fn concurrent_upserts_are_transactional() {
        let (index, _directory) = index();
        let index = Arc::new(index);
        let threads = (0..24)
            .map(|i| {
                let index = Arc::clone(&index);
                std::thread::spawn(move || {
                    index.upsert(record("same", i)).map(|item| item.session_id)
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            assert_eq!(thread.join().unwrap().unwrap(), "same");
        }
        let sessions = index.list(SessionListOptions::default()).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].modified_at_ms, 23);
    }

    #[test]
    fn optional_metadata_merges_after_stat_flush_and_empty_values_clear() {
        let (index, _directory) = index();
        let mut stat_only = record("merge", 1);
        stat_only.title = None;
        stat_only.first_prompt = None;
        index.upsert(stat_only.clone()).unwrap();
        assert!(index.get("merge").unwrap().unwrap().title.is_none());

        let enriched = record("merge", 2);
        index.upsert(enriched).unwrap();
        let mut second_stat_flush = stat_only;
        second_stat_flush.modified_at_ms = 3;
        index.upsert(second_stat_flush).unwrap();
        let preserved = index.get("merge").unwrap().unwrap();
        assert_eq!(preserved.title.as_deref(), Some("Title merge"));
        assert_eq!(preserved.first_prompt.as_deref(), Some("Prompt merge"));

        let mut clear = record("merge", 4);
        clear.title = Some(String::new());
        clear.first_prompt = Some(String::new());
        index.upsert(clear).unwrap();
        let cleared = index.get("merge").unwrap().unwrap();
        assert!(cleared.title.is_none());
        assert!(cleared.first_prompt.is_none());
    }

    #[test]
    fn older_upsert_cannot_regress_newer_stat_metadata() {
        let (index, _directory) = index();
        let mut newer = record("ordered", 200);
        newer.project_path = "/projects/new".into();
        newer.transcript_path = "/transcripts/new.jsonl".into();
        newer.size_bytes = 200;
        newer.title = Some("New title".into());
        newer.first_prompt = None;
        index.upsert(newer).unwrap();

        let mut older = record("ordered", 100);
        older.project_path = "/projects/old".into();
        older.transcript_path = "/transcripts/old.jsonl".into();
        older.size_bytes = 100;
        older.title = None;
        older.first_prompt = Some("Late enrichment".into());
        index.upsert(older).unwrap();

        let stored = index.get("ordered").unwrap().unwrap();
        assert_eq!(stored.project_path, "/projects/new");
        assert_eq!(stored.transcript_path, "/transcripts/new.jsonl");
        assert_eq!(stored.modified_at_ms, 200);
        assert_eq!(stored.size_bytes, 200);
        assert_eq!(stored.title.as_deref(), Some("New title"));
        assert_eq!(stored.first_prompt.as_deref(), Some("Late enrichment"));
    }

    #[test]
    fn rejects_unbounded_and_unsafe_values() {
        let (index, _directory) = index();
        let mut value = record("x", 0);
        value.title = Some("x".repeat(MAX_SESSION_TITLE_BYTES + 1));
        assert!(matches!(
            index.upsert(value),
            Err(StateError::InvalidSession(_))
        ));
        assert!(matches!(
            index.upsert(record("x", JS_MAX_SAFE_INTEGER + 1)),
            Err(StateError::InvalidSession(_))
        ));
        assert!(matches!(
            index.list(SessionListOptions {
                limit: Some(MAX_SESSION_LIMIT + 1),
                ..Default::default()
            }),
            Err(StateError::InvalidSession(_))
        ));
    }
}
