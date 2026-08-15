use mindcoded::{
    daemon_token_path,
    protocol::{read_message, write_message, ClientMessage, ServerMessage, PROTOCOL_VERSION},
    read_daemon_token, Daemon, DaemonConfig,
};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tempfile::tempdir;
use tokio::{net::UnixStream, time::sleep};

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
            id: "session-manager-handshake".into(),
            version: PROTOCOL_VERSION,
            client: "session-manager-test".into(),
            token,
            capabilities: vec!["session".into()],
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
            for method in [
                "session",
                "session.open",
                "session.touch",
                "session.close",
                "session.status",
            ] {
                assert!(capabilities.iter().any(|capability| capability == method));
            }
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

fn error_code(response: ServerMessage) -> String {
    match response {
        ServerMessage::Response {
            ok: false,
            error: Some(error),
            ..
        } => error.code,
        other => panic!("expected error response, got {other:?}"),
    }
}

async fn shutdown(stream: &mut UnixStream) {
    let response = rpc(stream, "shutdown", "shutdown", json!({})).await;
    assert!(matches!(response, ServerMessage::Response { ok: true, .. }));
}

#[tokio::test]
async fn session_manager_reconnects_and_keeps_sqlite_metadata_authoritative() {
    let directory = tempdir().unwrap();
    let socket = directory.path().join("run/mindcoded.sock");
    let daemon = tokio::spawn(
        Daemon::new(DaemonConfig {
            socket: socket.clone(),
            state_dir: Some(directory.path().join("state")),
            idle_seconds: Some(60),
            handshake_timeout: Duration::from_secs(2),
            build_id: "session-manager-rpc".into(),
        })
        .run(),
    );
    wait_for_socket(&socket).await;
    let mut stream = connect(&socket).await;

    let first = ok_result(
        rpc(
            &mut stream,
            "open-1",
            "session.open",
            json!({
                "session_id": "build-1",
                "connection_id": "tui-1",
                "project_path": "/projects/mindcode",
                "transcript_path": "/sessions/build-1.json",
                "title": "Build",
                "first_prompt": "Run tests",
                "now_ms": 100
            }),
        )
        .await,
    );
    let lease = first["session"]["lease_id"].as_str().unwrap().to_owned();
    assert!(!first["session"]["resumed"].as_bool().unwrap());
    assert_eq!(first["session"]["session"]["active_leases"], 1);

    let repeated = ok_result(
        rpc(
            &mut stream,
            "open-2",
            "session.open",
            json!({
                "session_id": "build-1",
                "connection_id": "tui-1",
                "project_path": "/projects/mindcode",
                "transcript_path": "/sessions/build-1.json",
                "now_ms": 200
            }),
        )
        .await,
    );
    assert!(repeated["session"]["resumed"].as_bool().unwrap());
    assert_eq!(repeated["session"]["lease_id"], lease);
    assert_eq!(repeated["session"]["session"]["active_leases"], 1);

    let reconnect = ok_result(
        rpc(
            &mut stream,
            "open-3",
            "session.open",
            json!({
                "session_id": "build-1",
                "connection_id": "tui-2",
                "project_path": "/projects/mindcode",
                "transcript_path": "/sessions/build-1.json",
                "now_ms": 300
            }),
        )
        .await,
    );
    let reconnect_lease = reconnect["session"]["lease_id"].as_str().unwrap();
    assert_ne!(reconnect_lease, lease);
    assert_eq!(reconnect["session"]["session"]["active_leases"], 2);

    let status = ok_result(
        rpc(
            &mut stream,
            "status-1",
            "session.status",
            json!({"now_ms": 400}),
        )
        .await,
    );
    assert_eq!(status["active_sessions"], 1);
    assert_eq!(status["sessions"][0]["active_leases"], 2);

    let touched = ok_result(
        rpc(
            &mut stream,
            "touch-1",
            "session.touch",
            json!({
                "session_id": "build-1",
                "lease_id": reconnect_lease,
                "now_ms": 400
            }),
        )
        .await,
    );
    assert_eq!(touched["session"]["last_seen_at_ms"], 400);

    let closed = ok_result(
        rpc(
            &mut stream,
            "close-1",
            "session.close",
            json!({"session_id": "build-1", "lease_id": lease}),
        )
        .await,
    );
    assert!(closed["closed"].as_bool().unwrap());
    assert_eq!(closed["session"]["active_leases"], 1);

    let closed_last = ok_result(
        rpc(
            &mut stream,
            "close-2",
            "session.close",
            json!({"session_id": "build-1", "lease_id": reconnect_lease}),
        )
        .await,
    );
    assert!(closed_last["closed"].as_bool().unwrap());
    assert!(closed_last["session"].is_null());
    let empty = ok_result(
        rpc(
            &mut stream,
            "status-2",
            "session.status",
            json!({"now_ms": 500}),
        )
        .await,
    );
    assert_eq!(empty["active_sessions"], 0);

    let reopened = ok_result(
        rpc(
            &mut stream,
            "open-4",
            "session.open",
            json!({
                "session_id": "build-1",
                "connection_id": "tui-3",
                "project_path": "/projects/mindcode",
                "transcript_path": "/sessions/build-1.json",
                "now_ms": 500
            }),
        )
        .await,
    );
    assert_eq!(
        reopened["session"]["session"]["project_path"],
        "/projects/mindcode"
    );

    assert_eq!(
        error_code(
            rpc(
                &mut stream,
                "open-conflict",
                "session.open",
                json!({
                    "session_id": "build-1",
                    "connection_id": "tui-4",
                    "project_path": "/projects/other",
                    "transcript_path": "/sessions/build-1.json",
                    "now_ms": 600
                }),
            )
            .await,
        ),
        "INVALID_SESSION"
    );

    shutdown(&mut stream).await;
    drop(stream);
    daemon.await.unwrap().unwrap();
}
