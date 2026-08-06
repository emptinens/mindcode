use mindcode_state::{ConflictMode, TaskGraph, TaskGraphConfig, TaskInput};
use rusqlite::Connection;
use serde_json::{json, Value};
use tempfile::tempdir;

const DIGEST: &str = "a23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0";

fn graph(state_dir: &std::path::Path) -> TaskGraph {
    TaskGraph::open(TaskGraphConfig {
        state_dir: state_dir.to_path_buf(),
        lease_ttl_ms: 1_000,
    })
    .unwrap()
}

#[test]
fn policy_digest_round_trips_through_create_route_update_and_snapshot() {
    let directory = tempdir().unwrap();
    let task_graph = graph(directory.path());

    let legacy = task_graph
        .create(TaskInput {
            id: Some("legacy".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(legacy.policy_digest, None);

    let routed = task_graph
        .route(
            TaskInput {
                id: Some("routed".into()),
                policy_epoch: Some(7),
                policy_digest: Some(Some(DIGEST.into())),
                ..Default::default()
            },
            ConflictMode::Block,
        )
        .unwrap();
    assert_eq!(
        routed.task.as_ref().unwrap().policy_digest.as_deref(),
        Some(DIGEST)
    );

    let updated = task_graph
        .update(
            "legacy",
            json!({"policy_epoch": 8, "policy_digest": DIGEST}),
            Some(legacy.version),
        )
        .unwrap();
    assert_eq!(updated.policy_epoch, 8);
    assert_eq!(updated.policy_digest.as_deref(), Some(DIGEST));

    let snapshot = task_graph.snapshot().unwrap();
    assert_eq!(snapshot.tasks.len(), 2);
    assert!(snapshot
        .tasks
        .iter()
        .all(|task| task.policy_digest.as_deref() == Some(DIGEST)));
}

#[test]
fn policy_digest_validation_is_strict_and_legacy_rows_materialize_null() {
    let omitted: TaskInput = serde_json::from_value(json!({"id": "omitted"})).unwrap();
    assert_eq!(omitted.policy_digest, None);
    let explicit_null: TaskInput =
        serde_json::from_value(json!({"id": "explicit-null", "policy_digest": null})).unwrap();
    assert_eq!(explicit_null.policy_digest, Some(None));

    let omitted_json = serde_json::to_value(TaskInput {
        id: Some("omitted".into()),
        ..Default::default()
    })
    .unwrap();
    assert!(!omitted_json
        .as_object()
        .unwrap()
        .contains_key("policy_digest"));
    let explicit_null_json = serde_json::to_value(TaskInput {
        id: Some("explicit-null".into()),
        policy_digest: Some(None),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(explicit_null_json["policy_digest"], Value::Null);

    let directory = tempdir().unwrap();
    let database_path = directory.path().join("tasks.db");
    let database = Connection::open(&database_path).unwrap();
    database
        .execute_batch(
            r#"
            CREATE TABLE task_graph_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
            INSERT INTO task_graph_meta(key,value) VALUES ('schema_version','2');
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
            INSERT INTO tasks(id,status) VALUES ('legacy','pending');
            "#,
        )
        .unwrap();
    drop(database);

    let task_graph = graph(directory.path());
    assert_eq!(
        task_graph.read("legacy").unwrap().unwrap().policy_digest,
        None
    );
    assert!(task_graph
        .create(TaskInput {
            id: Some("unpaired".into()),
            policy_digest: Some(Some(DIGEST.into())),
            ..Default::default()
        })
        .unwrap_err()
        .to_string()
        .contains("policy_epoch and policy_digest must be provided together"));
    let explicit_null_task = task_graph
        .create(TaskInput {
            id: Some("explicit-null".into()),
            policy_epoch: Some(1),
            policy_digest: Some(None),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(explicit_null_task.policy_epoch, 1);
    assert_eq!(explicit_null_task.policy_digest, None);
    assert!(task_graph
        .create(TaskInput {
            id: Some("unpaired-epoch".into()),
            policy_epoch: Some(1),
            ..Default::default()
        })
        .unwrap_err()
        .to_string()
        .contains("policy_epoch and policy_digest must be provided together"));
    assert!(task_graph
        .create(TaskInput {
            id: Some("uppercase".into()),
            policy_epoch: Some(1),
            policy_digest: Some(Some("A".repeat(64))),
            ..Default::default()
        })
        .unwrap_err()
        .to_string()
        .contains("lowercase SHA-256"));

    let task = task_graph
        .create(TaskInput {
            id: Some("patches".into()),
            policy_epoch: Some(1),
            policy_digest: Some(Some(DIGEST.into())),
            ..Default::default()
        })
        .unwrap();
    for patch in [json!({"policy_epoch": 2}), json!({"policy_digest": DIGEST})] {
        let error = task_graph
            .update("patches", patch, Some(task.version))
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("policy_epoch and policy_digest must be provided together in a patch"));
    }
    let error = task_graph
        .route_update(
            "patches",
            json!({"policy_epoch": 2}),
            ConflictMode::Block,
            Some(task.version),
        )
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("policy_epoch and policy_digest must be provided together in a patch"));
}
