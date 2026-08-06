use mindcode_state::{
    ClaimFailure, ClaimOptions, ClaimResult, ConflictMode, TaskGraph, TaskGraphConfig, TaskInput,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tempfile::tempdir;

fn graph(state_dir: &std::path::Path) -> TaskGraph {
    TaskGraph::open(TaskGraphConfig {
        state_dir: state_dir.to_path_buf(),
        lease_ttl_ms: 1_000,
    })
    .unwrap()
}

#[test]
fn list_dependents_and_scoped_legacy_overlap_match_ts_contract() {
    let directory = tempdir().unwrap();
    let task_graph = graph(directory.path());
    task_graph
        .create(TaskInput {
            id: Some("dependency".into()),
            ..Default::default()
        })
        .unwrap();
    task_graph
        .create(TaskInput {
            id: Some("dependent".into()),
            blocked_by: Some(vec!["dependency".into()]),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        task_graph
            .list_dependents("dependency")
            .unwrap()
            .into_iter()
            .map(|task| task.id)
            .collect::<Vec<_>>(),
        vec!["dependent"]
    );

    let scoped = ".mindcode-target-scope/one/src/a.rs";
    let route = task_graph
        .route(
            TaskInput {
                id: Some("scoped".into()),
                read_set: Some(vec![]),
                write_set: Some(vec![scoped.into()]),
                ..Default::default()
            },
            ConflictMode::Block,
        )
        .unwrap();
    assert_eq!(route.decision.action, "allow");

    let legacy = task_graph
        .route(
            TaskInput {
                id: Some("legacy".into()),
                files_touched: Some(vec!["src/a.rs".into()]),
                ..Default::default()
            },
            ConflictMode::Block,
        )
        .unwrap();
    assert_eq!(legacy.decision.action, "blocked");
    assert_eq!(legacy.task.unwrap().blocked_by, vec!["scoped"]);
}

#[test]
fn concurrent_claims_have_one_cas_winner() {
    let directory = tempdir().unwrap();
    let task_graph = Arc::new(graph(directory.path()));
    task_graph
        .create(TaskInput {
            id: Some("race".into()),
            ..Default::default()
        })
        .unwrap();

    let mut threads = Vec::new();
    for index in 0..32 {
        let task_graph = Arc::clone(&task_graph);
        threads.push(std::thread::spawn(move || {
            task_graph
                .claim(
                    "race",
                    &format!("worker-{index}"),
                    ClaimOptions {
                        now: Some("2026-08-06T00:00:00Z".into()),
                        ..Default::default()
                    },
                )
                .unwrap()
        }));
    }

    let results = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, ClaimResult::Success(_)))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, ClaimResult::Failure(ClaimFailure { reason, .. }) if reason == "status_not_pending"))
            .count(),
        31
    );
}

#[test]
fn migrates_legacy_tasks_db_without_dropping_wire_fields() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("tasks.db");
    let database = Connection::open(&database_path).unwrap();
    database
        .execute_batch(
            r#"
            CREATE TABLE task_graph_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
            INSERT INTO task_graph_meta(key,value) VALUES ('graph_version','9');
            CREATE TABLE tasks (
              id TEXT PRIMARY KEY NOT NULL,
              status TEXT NOT NULL,
              owner TEXT,
              blocked_by TEXT NOT NULL DEFAULT '[]',
              claimed_at TEXT,
              files_touched TEXT NOT NULL DEFAULT '[]',
              lease_id TEXT,
              version INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE task_leases (
              lease_id TEXT PRIMARY KEY NOT NULL,
              task_id TEXT NOT NULL,
              owner TEXT NOT NULL,
              acquired_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              released_at TEXT
            );
            CREATE TABLE task_idempotency (
              idempotency_key TEXT PRIMARY KEY NOT NULL,
              task_id TEXT NOT NULL
            );
            INSERT INTO tasks(id,status,owner,blocked_by,claimed_at,files_touched,lease_id,version)
              VALUES ('legacy','claimed','worker','["dependency"]','2026-08-06T00:00:00.000Z','["legacy.ts"]','lease',17);
            "#,
        )
        .unwrap();
    drop(database);

    let task = graph(directory.path()).read("legacy").unwrap().unwrap();
    assert_eq!(task.id, "legacy");
    assert_eq!(task.owner.as_deref(), Some("worker"));
    assert_eq!(task.blocked_by, vec!["dependency"]);
    assert_eq!(task.files_touched, vec!["legacy.ts"]);
    assert_eq!(task.version, 17);
    assert_eq!(task.kind, mindcode_state::TaskKind::Implement);
    assert_eq!(task.effort, mindcode_state::TaskEffort::Medium);
}

#[test]
fn serialized_claim_result_is_direct_and_update_error_is_stable() {
    let directory = tempdir().unwrap();
    let task_graph = graph(directory.path());
    task_graph
        .create(TaskInput {
            id: Some("task".into()),
            ..Default::default()
        })
        .unwrap();
    let claim = task_graph
        .claim("task", "worker", ClaimOptions::default())
        .unwrap();
    let json = serde_json::to_value(&claim).unwrap();
    assert_eq!(json["ok"], true);
    assert!(json["task"].is_object());
    assert!(json["lease"].is_object());

    let error = task_graph
        .update("task", json!({"status":"completed"}), Some(0))
        .unwrap_err();
    assert_eq!(error.code(), "VERSION_CONFLICT");
}

#[test]
fn task_and_lease_owners_must_match_and_patch_fields_are_strict() {
    let directory = tempdir().unwrap();
    let task_graph = graph(directory.path());
    task_graph
        .create(TaskInput {
            id: Some("owned".into()),
            ..Default::default()
        })
        .unwrap();
    task_graph
        .claim(
            "owned",
            "worker",
            ClaimOptions {
                lease_id: Some("owned-lease".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let owner_error = task_graph
        .update("owned", json!({"owner":"other"}), None)
        .unwrap_err();
    assert_eq!(owner_error.code(), "LEASE_OWNER_MISMATCH");
    let patch_error = task_graph
        .update("owned", json!({"unexpected":true}), None)
        .unwrap_err();
    assert!(patch_error.to_string().contains("unknown patch field"));
}

#[test]
fn update_honors_all_ts_cas_aliases_and_normalizes_dependencies() {
    let directory = tempdir().unwrap();
    let task_graph = graph(directory.path());
    for dependency in ["dependency-a", "dependency-b"] {
        task_graph
            .create(TaskInput {
                id: Some(dependency.into()),
                ..Default::default()
            })
            .unwrap();
    }

    let aliases = ["version", "expected_version", "expectedVersion"];
    for (index, alias) in aliases.into_iter().enumerate() {
        let id = format!("dependent-{index}");
        task_graph
            .create(TaskInput {
                id: Some(id.clone()),
                ..Default::default()
            })
            .unwrap();
        let mut patch = serde_json::Map::new();
        patch.insert("owner".into(), json!(format!("worker-{index}")));
        patch.insert(alias.into(), json!(0));
        if index == 0 {
            patch.insert(
                "blocked_by".into(),
                json!([" dependency-a ", "dependency-a", " dependency-b "]),
            );
        }
        let updated = task_graph.update(&id, Value::Object(patch), None).unwrap();
        assert_eq!(updated.version, 1);
        if index == 0 {
            assert_eq!(updated.blocked_by, vec!["dependency-a", "dependency-b"]);
        }
    }
}

#[test]
fn migration_rejects_malformed_json_without_replacing_it() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("tasks.db");
    let malformed = "{not-json";
    let database = Connection::open(&database_path).unwrap();
    database
        .execute_batch(
            r#"
            CREATE TABLE task_graph_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
            INSERT INTO task_graph_meta(key,value) VALUES ('schema_version','1');
            CREATE TABLE tasks (
              id TEXT PRIMARY KEY NOT NULL,
              status TEXT NOT NULL,
              owner TEXT,
              blocked_by TEXT,
              lease_id TEXT
            );
            "#,
        )
        .unwrap();
    database
        .execute(
            "INSERT INTO tasks(id,status,blocked_by) VALUES ('malformed','pending',?1)",
            [malformed],
        )
        .unwrap();
    drop(database);

    let error = TaskGraph::open(TaskGraphConfig {
        state_dir: directory.path().to_path_buf(),
        lease_ttl_ms: 1_000,
    })
    .unwrap_err();
    assert!(error.to_string().contains("Malformed stored blocked_by"));

    let database = Connection::open(&database_path).unwrap();
    let stored: String = database
        .query_row(
            "SELECT blocked_by FROM tasks WHERE id='malformed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, malformed);

    let remaining_tables: Vec<String> = database
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('task_leases','task_idempotency') ORDER BY name",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(remaining_tables.is_empty());
    let schema_version: String = database
        .query_row(
            "SELECT value FROM task_graph_meta WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(schema_version, "1");
}

#[test]
fn migration_rejects_future_schema_versions() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("tasks.db");
    let database = Connection::open(&database_path).unwrap();
    database
        .execute_batch(
            r#"
            CREATE TABLE task_graph_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
            INSERT INTO task_graph_meta(key,value) VALUES ('schema_version','4');
            "#,
        )
        .unwrap();
    drop(database);

    let error = TaskGraph::open(TaskGraphConfig {
        state_dir: directory.path().to_path_buf(),
        lease_ttl_ms: 1_000,
    })
    .unwrap_err();
    assert!(error
        .to_string()
        .contains("Unsupported future task graph schema version: 4"));

    let database = Connection::open(&database_path).unwrap();
    let tables: Vec<String> = database
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks','task_leases','task_idempotency') ORDER BY name",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(tables.is_empty());
}

#[test]
fn config_dir_resolution_matches_typescript_rules() {
    let home = Path::new("/tmp/mindcode-home");
    let cwd = Path::new("/tmp/mindcode-project");
    assert_eq!(
        mindcode_state::resolve_mindcode_config_dir(Some("  ~/custom/../state  "), Some(home), cwd),
        Path::new("/tmp/mindcode-home/state")
    );
    assert_eq!(
        mindcode_state::resolve_mindcode_config_dir(
            Some("./relative/../mindcode"),
            Some(home),
            cwd
        ),
        Path::new("/tmp/mindcode-project/mindcode")
    );
    assert_eq!(
        mindcode_state::resolve_mindcode_config_dir(None, Some(home), cwd),
        Path::new("/tmp/mindcode-home/.mindcode")
    );
}

#[test]
fn rejects_values_that_are_not_javascript_safe_integers() {
    let directory = tempdir().unwrap();
    let task_graph = graph(directory.path());
    let error = task_graph
        .create(TaskInput {
            id: Some("unsafe".into()),
            priority: Some(9_007_199_254_740_992),
            ..Default::default()
        })
        .unwrap_err();
    assert!(error.to_string().contains("JavaScript safe integer"));
}

#[test]
fn claim_rejects_unsafe_expected_version_and_route_rejects_orphans() {
    let directory = tempdir().unwrap();
    let task_graph = graph(directory.path());
    let error = task_graph
        .claim(
            "missing",
            "worker",
            ClaimOptions {
                expected_version: Some(9_007_199_254_740_992),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(error.to_string().contains("JavaScript safe integer"));

    assert!(task_graph
        .route(
            TaskInput {
                id: Some("running".into()),
                status: Some(mindcode_state::TaskStatus::Running),
                ..Default::default()
            },
            ConflictMode::Block,
        )
        .unwrap_err()
        .to_string()
        .contains("route cannot create"));
    assert!(task_graph
        .route(
            TaskInput {
                id: Some("orphan-lease".into()),
                lease_id: Some("lease".into()),
                ..Default::default()
            },
            ConflictMode::Block,
        )
        .unwrap_err()
        .to_string()
        .contains("route cannot attach"));
}

#[test]
fn stored_arrays_are_deduplicated_in_wire_order() {
    let directory = tempdir().unwrap();
    let task_graph = graph(directory.path());
    task_graph
        .create(TaskInput {
            id: Some("duplicates".into()),
            ..Default::default()
        })
        .unwrap();
    let database = Connection::open(task_graph.database_path()).unwrap();
    database
        .execute(
            "UPDATE tasks SET blocked_by='[\"a\",\"a\",\"b\",\"a\"]', files_touched='[\"x\",\"x\"]' WHERE id='duplicates'",
            [],
        )
        .unwrap();
    drop(database);
    let task = task_graph.read("duplicates").unwrap().unwrap();
    assert_eq!(task.blocked_by, vec!["a", "b"]);
    assert_eq!(task.files_touched, vec!["x"]);
}

#[cfg(unix)]
#[test]
fn state_and_sqlite_files_are_private() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempdir().unwrap();
    let task_graph = graph(directory.path());
    task_graph
        .create(TaskInput {
            id: Some("permissions".into()),
            ..Default::default()
        })
        .unwrap();

    assert_eq!(
        fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let database_path = task_graph.database_path();
    assert_eq!(
        fs::metadata(&database_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    for sidecar in [
        format!("{}-wal", database_path.display()),
        format!("{}-shm", database_path.display()),
    ] {
        if let Ok(metadata) = fs::metadata(sidecar) {
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        }
    }
}

#[test]
fn route_update_atomically_validates_structural_overlap() {
    let directory = tempdir().unwrap();
    let task_graph = graph(directory.path());
    for (id, target) in [("a", "src/initial-a.ts"), ("b", "src/initial-b.ts")] {
        task_graph
            .route(
                TaskInput {
                    id: Some(id.into()),
                    read_set: Some(vec![]),
                    write_set: Some(vec![target.into()]),
                    ..Default::default()
                },
                ConflictMode::Block,
            )
            .unwrap();
    }

    let first = task_graph
        .route_update(
            "a",
            json!({"write_set": ["src/shared.ts"]}),
            ConflictMode::Block,
            Some(0),
        )
        .unwrap();
    assert_eq!(first.decision.action, "allow");
    assert_eq!(first.task.unwrap().write_set, vec!["src/shared.ts"]);

    let second = task_graph
        .route_update(
            "b",
            json!({"write_set": ["src/shared.ts"]}),
            ConflictMode::Block,
            Some(0),
        )
        .unwrap();
    assert_eq!(second.decision.action, "blocked");
    let task = second.task.unwrap();
    assert_eq!(task.status, mindcode_state::TaskStatus::Pending);
    assert_eq!(task.blocked_by, vec!["a"]);
    assert_eq!(task.write_set, vec!["src/shared.ts"]);
}
