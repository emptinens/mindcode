use mindcoded::{
    daemon_token_path,
    protocol::{read_message, write_message, ClientMessage, ServerMessage, PROTOCOL_VERSION},
    read_daemon_token, Daemon, DaemonConfig, MAX_TASK_GRAPH_WATCHERS,
};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tempfile::tempdir;
use tokio::{
    net::UnixStream,
    time::{sleep, timeout},
};

async fn wait_for_socket(path: &Path) {
    for _ in 0..200 {
        if path.exists() {
            return;
        }
        sleep(Duration::from_millis(5)).await;
    }
    panic!("socket was not created: {}", path.display());
}

async fn connect(path: &Path) -> UnixStream {
    let token = read_daemon_token(&daemon_token_path(path)).unwrap();
    let mut stream = UnixStream::connect(path).await.unwrap();
    write_message(
        &mut stream,
        &ClientMessage::Handshake {
            id: "handshake-rpc".into(),
            version: PROTOCOL_VERSION,
            client: "task-graph-rpc-test".into(),
            token,
            capabilities: vec!["task_graph".into()],
        },
    )
    .await
    .unwrap();
    let response: ServerMessage = read_message(&mut stream).await.unwrap().unwrap();
    match response {
        ServerMessage::HandshakeAck {
            accepted,
            capabilities,
            ..
        } => {
            assert!(accepted);
            assert!(capabilities
                .iter()
                .any(|capability| capability == "task_graph.list_dependents"));
            assert!(capabilities
                .iter()
                .any(|capability| capability == "task_graph.watch"));
        }
        other => panic!("unexpected handshake response: {other:?}"),
    }
    stream
}

async fn rpc(stream: &mut UnixStream, id: &str, method: &str, params: Value) -> ServerMessage {
    write_message(
        stream,
        &ClientMessage::Request {
            id: id.into(),
            method: method.into(),
            params: Some(params),
            stream: false,
        },
    )
    .await
    .unwrap();
    read_message(stream).await.unwrap().unwrap()
}

async fn start_watch(stream: &mut UnixStream, id: &str, params: Value) {
    write_message(
        stream,
        &ClientMessage::Request {
            id: id.into(),
            method: "task_graph.watch".into(),
            params: Some(params),
            stream: true,
        },
    )
    .await
    .unwrap();
}

async fn shutdown(stream: &mut UnixStream) {
    let _ = ok_result(rpc(stream, "shutdown", "shutdown", json!({})).await);
}

fn ok_result(response: ServerMessage) -> Value {
    match response {
        ServerMessage::Response {
            ok: true,
            result: Some(value),
            ..
        } => value,
        other => panic!("expected successful response, got {other:?}"),
    }
}

fn assert_invalid_code(response: ServerMessage, expected: &str) {
    match response {
        ServerMessage::Response {
            ok: false,
            error: Some(error),
            ..
        } => assert_eq!(error.code, expected),
        other => panic!("expected {expected} error, got {other:?}"),
    }
}

#[tokio::test]
async fn task_graph_rpc_lifecycle_and_semantic_errors() {
    let directory = tempdir().unwrap();
    let socket = directory.path().join("run/mindcoded.sock");
    let state_dir = directory.path().join("state");
    let daemon = tokio::spawn(
        Daemon::new(DaemonConfig {
            socket: socket.clone(),
            state_dir: Some(state_dir.clone()),
            idle_seconds: Some(60),
            handshake_timeout: Duration::from_secs(2),
            build_id: "task-graph-rpc".into(),
        })
        .run(),
    );
    wait_for_socket(&socket).await;
    let mut stream = connect(&socket).await;

    let first = ok_result(
        rpc(
            &mut stream,
            "route-a",
            "task_graph.route",
            json!({"task":{"id":"a","files_touched":["src/a.rs"]},"mode":"block"}),
        )
        .await,
    );
    assert_eq!(first["created"], true);
    assert_eq!(first["task"]["status"], "pending");

    // Completed mutation responses are replayed from the daemon-global
    // ledger after reconnecting instead of executing the mutation again.
    drop(stream);
    let mut stream = connect(&socket).await;
    let replay = ok_result(
        rpc(
            &mut stream,
            "route-a",
            "task_graph.route",
            json!({"task":{"id":"a","files_touched":["src/a.rs"]},"mode":"block"}),
        )
        .await,
    );
    assert_eq!(replay, first);
    assert_invalid_code(
        rpc(
            &mut stream,
            "route-a",
            "task_graph.route",
            json!({"task":{"id":"different","files_touched":["src/different.rs"]},"mode":"block"}),
        )
        .await,
        "request_id_reuse",
    );

    let second = ok_result(
        rpc(
            &mut stream,
            "route-b",
            "task_graph.route",
            json!({"task":{"id":"b","files_touched":["src/a.rs"]}}),
        )
        .await,
    );
    assert_eq!(second["decision"]["action"], "blocked");
    assert_eq!(second["task"]["blocked_by"], json!(["a"]));

    let routed_update = ok_result(
        rpc(
            &mut stream,
            "route-update-b",
            "task_graph.route_update",
            json!({
                "task_id":"b",
                "patch":{"files_touched":["src/a.rs"]},
                "mode":"block",
                "expected_version":0
            }),
        )
        .await,
    );
    assert_eq!(routed_update["decision"]["action"], "blocked");
    assert_eq!(routed_update["task"]["status"], "pending");
    assert_eq!(routed_update["task"]["blocked_by"], json!(["a"]));

    let dependents = ok_result(
        rpc(
            &mut stream,
            "dependents-a",
            "task_graph.list_dependents",
            json!({"task_id":"a"}),
        )
        .await,
    );
    assert_eq!(dependents["tasks"][0]["id"], "b");

    let read = ok_result(
        rpc(
            &mut stream,
            "read-a",
            "task_graph.read",
            json!({"task_id":"a"}),
        )
        .await,
    );
    assert_eq!(read["task"]["id"], "a");
    let listed = ok_result(
        rpc(
            &mut stream,
            "list-pending",
            "task_graph.list",
            json!({"status":"pending","limit":10,"offset":0}),
        )
        .await,
    );
    assert_eq!(listed["tasks"].as_array().unwrap().len(), 2);

    let claim = ok_result(
        rpc(
            &mut stream,
            "claim-a",
            "task_graph.claim",
            json!({"task_id":"a","owner":"worker","lease_id":"lease-a","now":"2026-08-06T00:00:00Z"}),
        )
        .await,
    );
    assert_eq!(claim["ok"], true);
    let version = claim["task"]["version"].as_u64().unwrap();

    assert_invalid_code(
        rpc(
            &mut stream,
            "mismatched-owner",
            "task_graph.update",
            json!({"task_id":"a","patch":{"owner":"other"}}),
        )
        .await,
        "LEASE_OWNER_MISMATCH",
    );
    assert_invalid_code(
        rpc(
            &mut stream,
            "unsafe-claim-version",
            "task_graph.claim",
            json!({"task_id":"a","owner":"worker","expected_version":9_007_199_254_740_992u64}),
        )
        .await,
        "INVALID_TASK",
    );

    let conflict = rpc(
        &mut stream,
        "stale-update",
        "task_graph.update",
        json!({"task_id":"a","expected_version":0,"patch":{"status":"completed"}}),
    )
    .await;
    match conflict {
        ServerMessage::Response {
            ok: false,
            error: Some(error),
            ..
        } => {
            assert_eq!(error.code, "VERSION_CONFLICT");
            assert_eq!(error.details.unwrap()["actual_version"], version);
        }
        other => panic!("expected version conflict, got {other:?}"),
    }

    let renewed = ok_result(
        rpc(
            &mut stream,
            "renew-a",
            "task_graph.renew_lease",
            json!({"lease_id":"lease-a","owner":"worker","ttl_ms":1000,"now":"2026-08-06T00:00:00Z"}),
        )
        .await,
    );
    assert_eq!(renewed["lease"]["lease_id"], "lease-a");

    let released = ok_result(
        rpc(
            &mut stream,
            "release-a",
            "task_graph.release_lease",
            json!({"lease_id":"lease-a","owner":"worker","now":"2026-08-06T00:00:01Z"}),
        )
        .await,
    );
    assert_eq!(released["lease"]["released_at"], "2026-08-06T00:00:01.000Z");
    let pending_after_release = ok_result(
        rpc(
            &mut stream,
            "read-a-after-release",
            "task_graph.read",
            json!({"task_id":"a"}),
        )
        .await,
    );
    assert_eq!(pending_after_release["task"]["status"], "pending");
    let released_version = pending_after_release["task"]["version"].as_u64().unwrap();

    let updated = ok_result(
        rpc(
            &mut stream,
            "complete-a",
            "task_graph.update",
            json!({"task_id":"a","expected_version":released_version,"patch":{"status":"completed"}}),
        )
        .await,
    );
    assert_eq!(updated["task"]["status"], "completed");

    let recovered = ok_result(
        rpc(
            &mut stream,
            "recover",
            "task_graph.recover",
            json!({"now":"2026-08-06T00:00:02Z"}),
        )
        .await,
    );
    assert!(recovered["tasks"].is_array());

    let snapshot = ok_result(rpc(&mut stream, "snapshot", "task_graph.snapshot", json!({})).await);
    assert_eq!(snapshot["version"], snapshot["graph_version"]);
    assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 2);

    assert_invalid_code(
        rpc(
            &mut stream,
            "invalid-recover-now",
            "task_graph.recover",
            json!({"now":123}),
        )
        .await,
        "INVALID_PARAMS",
    );
    assert_invalid_code(
        rpc(
            &mut stream,
            "invalid-recover-null",
            "task_graph.recover",
            json!({"now":null}),
        )
        .await,
        "INVALID_PARAMS",
    );
    assert_invalid_code(
        rpc(
            &mut stream,
            "invalid-recover-field",
            "task_graph.recover",
            json!({"unexpected":true}),
        )
        .await,
        "INVALID_PARAMS",
    );
    assert_invalid_code(
        rpc(
            &mut stream,
            "invalid-snapshot-field",
            "task_graph.snapshot",
            json!({"unexpected":true}),
        )
        .await,
        "INVALID_PARAMS",
    );
    assert_invalid_code(
        rpc(
            &mut stream,
            "invalid-list-field",
            "task_graph.list",
            json!({"unexpected":true}),
        )
        .await,
        "INVALID_PARAMS",
    );
    assert_invalid_code(
        rpc(
            &mut stream,
            "invalid-nested-task-field",
            "task_graph.route",
            json!({"task":{"id":"bad","unexpected":true}}),
        )
        .await,
        "INVALID_PARAMS",
    );
    assert_invalid_code(
        rpc(
            &mut stream,
            "invalid-nested-patch-field",
            "task_graph.update",
            json!({"task_id":"a","patch":{"unexpected":true}}),
        )
        .await,
        "INVALID_PARAMS",
    );
    assert_invalid_code(
        rpc(
            &mut stream,
            "invalid-route-status",
            "task_graph.route",
            json!({"task":{"id":"active","status":"running"}}),
        )
        .await,
        "INVALID_TASK",
    );
    assert_invalid_code(
        rpc(
            &mut stream,
            "invalid-route-lease",
            "task_graph.route",
            json!({"task":{"id":"orphan","lease_id":"orphan-lease"}}),
        )
        .await,
        "INVALID_TASK",
    );

    let _ = ok_result(rpc(&mut stream, "shutdown", "shutdown", json!({})).await);
    drop(stream);
    daemon.await.unwrap().unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&state_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(state_dir.join("tasks.db"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn cancelled_task_graph_mutation_returns_a_committed_result_and_replays() {
    let directory = tempdir().unwrap();
    let socket = directory.path().join("run/mindcoded.sock");
    let daemon = tokio::spawn(
        Daemon::new(DaemonConfig {
            socket: socket.clone(),
            state_dir: Some(directory.path().join("state")),
            idle_seconds: Some(60),
            handshake_timeout: Duration::from_secs(2),
            build_id: "cancel-replay".into(),
        })
        .run(),
    );
    wait_for_socket(&socket).await;
    let mut stream = connect(&socket).await;
    let files_touched = (0..5_000)
        .map(|index| format!("src/cancel-{index}.rs"))
        .collect::<Vec<_>>();
    let params = json!({
        "task": {"id":"cancelled-mutation","files_touched":files_touched},
        "mode":"block"
    });

    write_message(
        &mut stream,
        &ClientMessage::Request {
            id: "cancelled-mutation-request".into(),
            method: "task_graph.route".into(),
            params: Some(params.clone()),
            stream: false,
        },
    )
    .await
    .unwrap();
    sleep(Duration::from_millis(1)).await;
    write_message(
        &mut stream,
        &ClientMessage::Cancel {
            id: "cancelled-mutation-request".into(),
        },
    )
    .await
    .unwrap();

    let mut route_response = None;
    let mut cancel_ack = false;
    for _ in 0..2 {
        let response = timeout(
            Duration::from_secs(10),
            read_message::<_, ServerMessage>(&mut stream),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        if let ServerMessage::Response {
            ok: true,
            result: Some(result),
            ..
        } = &response
        {
            if result.get("cancelled").is_some() {
                cancel_ack = result["cancelled"].as_bool().unwrap_or(false);
            }
        }
        if matches!(
            &response,
            ServerMessage::Response {
                ok: true,
                result: Some(result),
                ..
            } if result.get("created").is_some()
        ) || matches!(
            &response,
            ServerMessage::Response {
                ok: false,
                error: Some(error),
                ..
            } if error.code == "cancelled"
        ) {
            route_response = Some(response);
        }
    }
    assert!(
        cancel_ack,
        "task graph mutation was not cancelled while active"
    );
    let route_response = route_response.expect("route response was not returned");
    match &route_response {
        ServerMessage::Response {
            ok: true,
            result: Some(result),
            ..
        } => assert_eq!(result["created"], true),
        ServerMessage::Response {
            ok: false,
            error: Some(error),
            ..
        } => panic!("active mutation returned an ambiguous cancellation: {error:?}"),
        other => panic!("unexpected route response: {other:?}"),
    }

    // When the transaction won the race with cancellation, reconnecting with
    // the same identity must replay the exact committed response.
    if matches!(&route_response, ServerMessage::Response { ok: true, .. }) {
        drop(stream);
        let mut reconnected = connect(&socket).await;
        let replay = rpc(
            &mut reconnected,
            "cancelled-mutation-request",
            "task_graph.route",
            params,
        )
        .await;
        assert_eq!(replay, route_response);
        shutdown(&mut reconnected).await;
    } else {
        shutdown(&mut stream).await;
    }
    daemon.await.unwrap().unwrap();
}

#[tokio::test]
async fn concurrent_claim_rpc_has_exactly_one_winner() {
    let directory = tempdir().unwrap();
    let socket = directory.path().join("run/mindcoded.sock");
    let daemon = tokio::spawn(
        Daemon::new(DaemonConfig {
            socket: socket.clone(),
            state_dir: Some(directory.path().join("state")),
            idle_seconds: Some(60),
            handshake_timeout: Duration::from_secs(2),
            build_id: "claim-race".into(),
        })
        .run(),
    );
    wait_for_socket(&socket).await;

    let mut setup = connect(&socket).await;
    let _ = ok_result(
        rpc(
            &mut setup,
            "route-race",
            "task_graph.route",
            json!({"task":{"id":"race","files_touched":["src/race.rs"]}}),
        )
        .await,
    );
    drop(setup);

    let mut claimers = Vec::new();
    for index in 0..32_u32 {
        let socket = socket.clone();
        claimers.push(tokio::spawn(async move {
            let mut stream = connect(&socket).await;
            let response = rpc(
                &mut stream,
                &format!("claim-{index}"),
                "task_graph.claim",
                json!({
                    "task_id":"race",
                    "owner":format!("worker-{index}"),
                    "now":"2026-08-06T00:00:00Z"
                }),
            )
            .await;
            drop(stream);
            response
        }));
    }
    let mut winners = 0;
    let mut failures = 0;
    for claimer in claimers {
        if let ServerMessage::Response {
            ok: true,
            result: Some(result),
            ..
        } = claimer.await.unwrap()
        {
            if result["ok"] == true {
                winners += 1;
            } else {
                assert!(matches!(
                    result["reason"].as_str(),
                    Some("status_not_pending") | Some("version_conflict") | Some("lease_active")
                ));
                failures += 1;
            }
        } else {
            panic!("claim RPC transport must succeed");
        }
    }
    assert_eq!(winners, 1);
    assert_eq!(failures, 31);

    let mut shutdown = connect(&socket).await;
    let _ = ok_result(rpc(&mut shutdown, "shutdown", "shutdown", json!({})).await);
    drop(shutdown);
    daemon.await.unwrap().unwrap();
}

#[tokio::test]
async fn task_graph_watch_streams_initial_snapshot_and_times_out_when_idle() {
    let directory = tempdir().unwrap();
    let socket = directory.path().join("run/mindcoded.sock");
    let daemon = tokio::spawn(
        Daemon::new(DaemonConfig {
            socket: socket.clone(),
            state_dir: Some(directory.path().join("state")),
            idle_seconds: Some(60),
            handshake_timeout: Duration::from_secs(2),
            build_id: "task-graph-watch-initial".into(),
        })
        .run(),
    );
    wait_for_socket(&socket).await;
    let mut stream = connect(&socket).await;

    assert_invalid_code(
        rpc(
            &mut stream,
            "watch-without-stream",
            "task_graph.watch",
            json!({"poll_interval_ms":10,"idle_timeout_ms":100}),
        )
        .await,
        "INVALID_PARAMS",
    );

    start_watch(
        &mut stream,
        "watch-initial",
        json!({"poll_interval_ms":10,"idle_timeout_ms":100}),
    )
    .await;
    let first = timeout(
        Duration::from_secs(2),
        read_message::<_, ServerMessage>(&mut stream),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    match first {
        ServerMessage::Stream { id, seq, data } => {
            assert_eq!(id, "watch-initial");
            assert_eq!(seq, 0);
            assert_eq!(data["schema_version"], 1);
            assert_eq!(data["kind"], "snapshot");
            assert_eq!(data["graph_version"], data["snapshot"]["graph_version"]);
        }
        other => panic!("expected initial watch chunk, got {other:?}"),
    }
    let completed = timeout(
        Duration::from_secs(2),
        read_message::<_, ServerMessage>(&mut stream),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    let terminal = ok_result(completed);
    assert_eq!(terminal["reason"], "idle_timeout");
    assert!(terminal["last_version"].is_u64());

    shutdown(&mut stream).await;
    daemon.await.unwrap().unwrap();
}

#[tokio::test]
async fn task_graph_watch_reports_resync_change_and_cancellation() {
    let directory = tempdir().unwrap();
    let socket = directory.path().join("run/mindcoded.sock");
    let daemon = tokio::spawn(
        Daemon::new(DaemonConfig {
            socket: socket.clone(),
            state_dir: Some(directory.path().join("state")),
            idle_seconds: Some(60),
            handshake_timeout: Duration::from_secs(2),
            build_id: "task-graph-watch-change".into(),
        })
        .run(),
    );
    wait_for_socket(&socket).await;
    let mut mutator = connect(&socket).await;
    for task_id in ["watch-a", "watch-b"] {
        let _ = ok_result(
            rpc(
                &mut mutator,
                &format!("route-{task_id}"),
                "task_graph.route",
                json!({"task":{"id":task_id,"files_touched":[format!("src/{task_id}.rs")]}}),
            )
            .await,
        );
    }

    let mut resync = connect(&socket).await;
    start_watch(
        &mut resync,
        "watch-resync",
        json!({"after_version":0,"poll_interval_ms":10,"idle_timeout_ms":100}),
    )
    .await;
    let resync_chunk = timeout(
        Duration::from_secs(2),
        read_message::<_, ServerMessage>(&mut resync),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    let resync_version = match resync_chunk {
        ServerMessage::Stream { data, .. } => {
            assert_eq!(data["kind"], "resync");
            data["graph_version"].as_u64().unwrap()
        }
        other => panic!("expected resync chunk, got {other:?}"),
    };
    let _ = ok_result(
        timeout(
            Duration::from_secs(2),
            read_message::<_, ServerMessage>(&mut resync),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap(),
    );

    let mut changed = connect(&socket).await;
    start_watch(
        &mut changed,
        "watch-changed",
        json!({
            "after_version":resync_version,
            "poll_interval_ms":10,
            "idle_timeout_ms":5_000
        }),
    )
    .await;
    let _ = ok_result(
        rpc(
            &mut mutator,
            "route-watch-c",
            "task_graph.route",
            json!({"task":{"id":"watch-c","files_touched":["src/watch-c.rs"]}}),
        )
        .await,
    );
    let changed_chunk = timeout(
        Duration::from_secs(2),
        read_message::<_, ServerMessage>(&mut changed),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    match changed_chunk {
        ServerMessage::Stream { seq, data, .. } => {
            assert_eq!(seq, 0);
            assert_eq!(data["kind"], "changed");
            assert_eq!(data["graph_version"], resync_version + 1);
        }
        other => panic!("expected changed chunk, got {other:?}"),
    }

    write_message(
        &mut changed,
        &ClientMessage::Cancel {
            id: "watch-changed".into(),
        },
    )
    .await
    .unwrap();
    let mut saw_cancel_ack = false;
    let mut saw_cancelled_terminal = false;
    for _ in 0..2 {
        let message = timeout(
            Duration::from_secs(2),
            read_message::<_, ServerMessage>(&mut changed),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        match message {
            ServerMessage::Response {
                ok: true,
                result: Some(result),
                ..
            } if result["cancelled"] == true => saw_cancel_ack = true,
            ServerMessage::Response {
                ok: false,
                error: Some(error),
                ..
            } if error.code == "cancelled" => saw_cancelled_terminal = true,
            other => panic!("unexpected cancellation response: {other:?}"),
        }
    }
    assert!(saw_cancel_ack);
    assert!(saw_cancelled_terminal);

    shutdown(&mut mutator).await;
    daemon.await.unwrap().unwrap();
}

#[tokio::test]
async fn task_graph_watch_rejects_connections_over_the_bounded_limit() {
    let directory = tempdir().unwrap();
    let socket = directory.path().join("run/mindcoded.sock");
    let daemon = tokio::spawn(
        Daemon::new(DaemonConfig {
            socket: socket.clone(),
            state_dir: Some(directory.path().join("state")),
            idle_seconds: Some(60),
            handshake_timeout: Duration::from_secs(2),
            build_id: "task-graph-watch-limit".into(),
        })
        .run(),
    );
    wait_for_socket(&socket).await;

    let mut watchers = Vec::new();
    for index in 0..MAX_TASK_GRAPH_WATCHERS {
        let mut stream = connect(&socket).await;
        start_watch(
            &mut stream,
            &format!("watch-{index}"),
            json!({"poll_interval_ms":50,"idle_timeout_ms":5_000}),
        )
        .await;
        let first = timeout(
            Duration::from_secs(2),
            read_message::<_, ServerMessage>(&mut stream),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert!(matches!(first, ServerMessage::Stream { .. }));
        watchers.push(stream);
    }

    let mut overflow = connect(&socket).await;
    start_watch(
        &mut overflow,
        "watch-overflow",
        json!({"poll_interval_ms":50,"idle_timeout_ms":5_000}),
    )
    .await;
    let response = timeout(
        Duration::from_secs(2),
        read_message::<_, ServerMessage>(&mut overflow),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert_invalid_code(response, "watch_limit");

    drop(watchers);
    drop(overflow);
    let mut control = connect(&socket).await;
    shutdown(&mut control).await;
    daemon.await.unwrap().unwrap();
}
