use mindcoded::{
    daemon_token_path,
    protocol::{read_message, write_message, ClientMessage, ServerMessage, PROTOCOL_VERSION},
    read_daemon_token,
};
use serde_json::Value;
use std::{path::Path, process::Stdio, time::Duration};
use tempfile::tempdir;
use tokio::{net::UnixStream, process::Command, time::sleep};

async fn wait_for_socket(path: &Path) {
    for _ in 0..400 {
        if path.exists() {
            return;
        }
        sleep(Duration::from_millis(5)).await;
    }
    panic!("socket was not created: {}", path.display());
}

async fn connect(path: &Path, handshake_id: &str) -> UnixStream {
    let token = read_daemon_token(&daemon_token_path(path)).unwrap();
    let mut stream = UnixStream::connect(path).await.unwrap();
    write_message(
        &mut stream,
        &ClientMessage::Handshake {
            id: handshake_id.into(),
            version: PROTOCOL_VERSION,
            client: "daemon-reload-test".into(),
            token,
            capabilities: vec!["status".into(), "reload".into(), "shutdown".into()],
        },
    )
    .await
    .unwrap();
    let response: ServerMessage = read_message(&mut stream).await.unwrap().unwrap();
    assert!(matches!(
        response,
        ServerMessage::HandshakeAck { accepted: true, .. }
    ));
    stream
}

async fn request(stream: &mut UnixStream, id: &str, method: &str) -> ServerMessage {
    write_message(
        stream,
        &ClientMessage::Request {
            id: id.into(),
            method: method.into(),
            params: Some(serde_json::json!({})),
            stream: false,
        },
    )
    .await
    .unwrap();
    read_message(stream).await.unwrap().unwrap()
}

fn status_pid(response: ServerMessage) -> u32 {
    let ServerMessage::Response {
        ok: true,
        result: Some(Value::Object(result)),
        ..
    } = response
    else {
        panic!("expected status response")
    };
    result["pid"].as_u64().unwrap() as u32
}

#[tokio::test]
async fn reload_reexecs_in_place_and_keeps_the_socket_usable() {
    let directory = tempdir().unwrap();
    let socket = directory.path().join("run/mindcoded.sock");
    let state_dir = directory.path().join("state");
    let mut child = Command::new(env!("CARGO_BIN_EXE_mindcoded"))
        .arg("--socket")
        .arg(&socket)
        .arg("--state-dir")
        .arg(&state_dir)
        .arg("--idle-seconds")
        .arg("60")
        .arg("--handshake-timeout-seconds")
        .arg("2")
        .arg("--build-id")
        .arg("reload-test")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait_for_socket(&socket).await;
    let token_before = read_daemon_token(&daemon_token_path(&socket)).unwrap();

    let mut first = connect(&socket, "handshake-1").await;
    let pid_before = status_pid(request(&mut first, "status-1", "status").await);
    let reload = request(&mut first, "reload-1", "reload").await;
    assert!(matches!(reload, ServerMessage::Response { ok: true, .. }));
    drop(first);

    let mut second = None;
    for attempt in 0..200 {
        if let Ok(stream) = UnixStream::connect(&socket).await {
            let mut stream = stream;
            let handshake = ClientMessage::Handshake {
                id: format!("handshake-reconnect-{attempt}"),
                version: PROTOCOL_VERSION,
                client: "daemon-reload-test".into(),
                token: read_daemon_token(&daemon_token_path(&socket)).unwrap(),
                capabilities: vec!["status".into(), "shutdown".into()],
            };
            if write_message(&mut stream, &handshake).await.is_ok()
                && matches!(
                    read_message::<_, ServerMessage>(&mut stream).await,
                    Ok(Some(ServerMessage::HandshakeAck { accepted: true, .. }))
                )
            {
                second = Some(stream);
                break;
            }
        }
        sleep(Duration::from_millis(10)).await;
    }
    let mut second = second.expect("daemon did not accept a connection after reload");
    let token_after = read_daemon_token(&daemon_token_path(&socket)).unwrap();
    assert_eq!(token_after, token_before);
    let pid_after = status_pid(request(&mut second, "status-2", "status").await);
    assert_eq!(pid_after, pid_before);
    let shutdown = request(&mut second, "shutdown-1", "shutdown").await;
    assert!(matches!(shutdown, ServerMessage::Response { ok: true, .. }));
    drop(second);
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("reloaded daemon did not exit")
        .unwrap();
    assert!(!socket.exists());
}
