use mindcoded::{
    protocol::{read_message, write_message, ClientMessage, ServerMessage, PROTOCOL_VERSION},
    Daemon, DaemonConfig,
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
    let mut stream = UnixStream::connect(path).await.unwrap();
    write_message(
        &mut stream,
        &ClientMessage::Handshake {
            id: "session-index-handshake".into(),
            version: PROTOCOL_VERSION,
            client: "session-index-rpc-test".into(),
            capabilities: vec!["session_index".into()],
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
                "session_index",
                "session_index.upsert",
                "session_index.get",
                "session_index.list",
                "session_index.search",
                "session_index.remove",
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

#[tokio::test]
async fn session_index_rpc_lifecycle_filters_and_enrichment_merge() {
    let directory = tempdir().unwrap();
    let socket = directory.path().join("run/mindcoded.sock");
    let state_dir = directory.path().join("state");
    let daemon = tokio::spawn(
        Daemon::new(DaemonConfig {
            socket: socket.clone(),
            state_dir: Some(state_dir.clone()),
            idle_seconds: Some(60),
            handshake_timeout: Duration::from_secs(2),
            build_id: "session-index-rpc".into(),
        })
        .run(),
    );
    wait_for_socket(&socket).await;
    let mut stream = connect(&socket).await;

    let stat = json!({
        "session_id": "s1",
        "project_path": "/projects/one",
        "transcript_path": "/transcripts/s1.jsonl",
        "modified_at_ms": 100,
        "size_bytes": 10
    });
    let first = ok_result(rpc(&mut stream, "upsert-1", "session_index.upsert", stat).await);
    assert_eq!(first["session"]["session_id"], "s1");
    assert!(first["session"].get("title").is_none());

    let enriched = ok_result(
        rpc(
            &mut stream,
            "upsert-2",
            "session_index.upsert",
            json!({
                "session_id": "s1",
                "project_path": "/projects/one",
                "transcript_path": "/transcripts/s1.jsonl",
                "modified_at_ms": 200,
                "size_bytes": 20,
                "title": "Build Release",
                "first_prompt": "Compile the application"
            }),
        )
        .await,
    );
    assert_eq!(enriched["session"]["title"], "Build Release");

    let stat_flush = ok_result(
        rpc(
            &mut stream,
            "upsert-3",
            "session_index.upsert",
            json!({
                "session_id": "s1",
                "project_path": "/projects/one",
                "transcript_path": "/transcripts/s1.jsonl",
                "modified_at_ms": 300,
                "size_bytes": 30
            }),
        )
        .await,
    );
    assert_eq!(stat_flush["session"]["modified_at_ms"], 300);
    assert_eq!(stat_flush["session"]["title"], "Build Release");
    assert_eq!(
        stat_flush["session"]["first_prompt"],
        "Compile the application"
    );

    let clear = ok_result(
        rpc(
            &mut stream,
            "upsert-4",
            "session_index.upsert",
            json!({
                "session_id": "s1",
                "project_path": "/projects/one",
                "transcript_path": "/transcripts/s1.jsonl",
                "modified_at_ms": 400,
                "size_bytes": 40,
                "title": "",
                "first_prompt": ""
            }),
        )
        .await,
    );
    assert!(clear["session"].get("title").is_none());
    assert!(clear["session"].get("first_prompt").is_none());

    for (id, project, modified) in [("s2", "/projects/two", 300), ("s3", "/projects/one", 300)] {
        ok_result(
            rpc(
                &mut stream,
                &format!("upsert-{id}"),
                "session_index.upsert",
                json!({
                    "session_id": id,
                    "project_path": project,
                    "transcript_path": format!("/transcripts/{id}.jsonl"),
                    "modified_at_ms": modified,
                    "size_bytes": 1,
                    "title": format!("Title {id}"),
                    "first_prompt": "Searchable prompt"
                }),
            )
            .await,
        );
    }

    let listed = ok_result(
        rpc(
            &mut stream,
            "list-1",
            "session_index.list",
            json!({"limit": 10}),
        )
        .await,
    );
    let ids = listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|session| session["session_id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["s1", "s2", "s3"]);

    let filtered = ok_result(
        rpc(
            &mut stream,
            "list-2",
            "session_index.list",
            json!({
                "project_path": "/projects/one",
                "before_modified_at_ms": 401,
                "limit": 10
            }),
        )
        .await,
    );
    assert_eq!(filtered["sessions"].as_array().unwrap().len(), 2);
    assert!(filtered["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|session| session["project_path"] == "/projects/one"));

    let searched = ok_result(
        rpc(
            &mut stream,
            "search-1",
            "session_index.search",
            json!({"query": "SEARCHABLE", "limit": 10}),
        )
        .await,
    );
    assert_eq!(searched["sessions"].as_array().unwrap().len(), 2);

    assert_eq!(
        error_code(
            rpc(
                &mut stream,
                "invalid-1",
                "session_index.list",
                json!({"limit": 1001}),
            )
            .await,
        ),
        "INVALID_SESSION"
    );

    let removed = ok_result(
        rpc(
            &mut stream,
            "remove-1",
            "session_index.remove",
            json!({"session_id": "s2"}),
        )
        .await,
    );
    assert_eq!(removed["removed"], true);
    let missing = ok_result(
        rpc(
            &mut stream,
            "get-1",
            "session_index.get",
            json!({"session_id": "s2"}),
        )
        .await,
    );
    assert!(missing["session"].is_null());

    let _ = ok_result(rpc(&mut stream, "shutdown", "shutdown", json!({})).await);
    drop(stream);
    daemon.await.unwrap().unwrap();
    assert!(state_dir.join("sessions.db").exists());
}
