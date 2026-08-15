use mindcoded::{
    daemon_token_path,
    protocol::{read_message, write_message, ClientMessage, ServerMessage, PROTOCOL_VERSION},
    read_daemon_token, Daemon, DaemonConfig,
};
use serde_json::Value;
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

async fn handshake(path: &Path, token: &str, id: &str) -> ServerMessage {
    let mut stream = UnixStream::connect(path).await.unwrap();
    write_message(
        &mut stream,
        &ClientMessage::Handshake {
            id: id.into(),
            version: PROTOCOL_VERSION,
            client: "daemon-auth-test".into(),
            token: token.into(),
            capabilities: vec!["status".into()],
        },
    )
    .await
    .unwrap();
    read_message(&mut stream).await.unwrap().unwrap()
}

fn rejected(response: ServerMessage) {
    match response {
        ServerMessage::HandshakeAck {
            accepted: false,
            error: Some(error),
            capabilities,
            ..
        } => {
            assert_eq!(error.code, "authentication_failed");
            assert!(capabilities.is_empty());
            assert!(!error.message.contains("00"));
        }
        other => panic!("expected authentication rejection, got {other:?}"),
    }
}

#[tokio::test]
async fn daemon_requires_runtime_token_and_keeps_it_secret_free() {
    let directory = tempdir().unwrap();
    let socket = directory.path().join("run/mindcoded.sock");
    let daemon = tokio::spawn(
        Daemon::new(DaemonConfig {
            socket: socket.clone(),
            state_dir: Some(directory.path().join("state")),
            idle_seconds: Some(60),
            handshake_timeout: Duration::from_secs(2),
            build_id: "daemon-auth".into(),
        })
        .run(),
    );
    wait_for_socket(&socket).await;

    let token_path = daemon_token_path(&socket);
    let token = read_daemon_token(&token_path).unwrap();
    assert_eq!(token.len(), 64);
    assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let raw_token_file = std::fs::read_to_string(&token_path).unwrap();
    assert_eq!(raw_token_file.trim(), token);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&token_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    rejected(handshake(&socket, "", "missing-token").await);
    rejected(handshake(&socket, &"00".repeat(32), "wrong-token").await);

    let accepted = handshake(&socket, &token, "correct-token").await;
    match accepted {
        ServerMessage::HandshakeAck {
            accepted: true,
            capabilities,
            ..
        } => assert!(capabilities.iter().any(|value| value == "auth.token")),
        other => panic!("expected authenticated handshake, got {other:?}"),
    }

    let mut control = UnixStream::connect(&socket).await.unwrap();
    write_message(
        &mut control,
        &ClientMessage::Handshake {
            id: "shutdown-handshake".into(),
            version: PROTOCOL_VERSION,
            client: "daemon-auth-test".into(),
            token,
            capabilities: vec!["shutdown".into()],
        },
    )
    .await
    .unwrap();
    let _: ServerMessage = read_message(&mut control).await.unwrap().unwrap();
    write_message(
        &mut control,
        &ClientMessage::Request {
            id: "shutdown".into(),
            method: "shutdown".into(),
            params: Some(Value::Object(Default::default())),
            stream: false,
        },
    )
    .await
    .unwrap();
    let _: ServerMessage = read_message(&mut control).await.unwrap().unwrap();
    drop(control);
    daemon.await.unwrap().unwrap();
}
