use mindcoded::{
    protocol::{read_message, write_message, ClientMessage, ServerMessage, PROTOCOL_VERSION},
    Daemon, DaemonConfig,
};
use std::{path::Path, time::Duration};
use tempfile::tempdir;
use tokio::{net::UnixStream, time::sleep};

async fn wait_for_socket(path: &Path) {
    for _ in 0..100 {
        if path.exists() {
            return;
        }
        sleep(Duration::from_millis(10)).await;
    }
    panic!("socket was not created: {}", path.display());
}

async fn handshake(stream: &mut UnixStream) {
    write_message(
        stream,
        &ClientMessage::Handshake {
            id: "handshake-1".into(),
            version: PROTOCOL_VERSION,
            client: "integration-test".into(),
            capabilities: vec!["status".into()],
        },
    )
    .await
    .unwrap();
    let response: ServerMessage = read_message(stream).await.unwrap().unwrap();
    assert!(matches!(
        response,
        ServerMessage::HandshakeAck { accepted: true, .. }
    ));
}

#[tokio::test]
async fn status_exposes_counters_without_secrets() {
    let dir = tempdir().unwrap();
    let socket = dir.path().join("runtime/daemon.sock");
    let task = tokio::spawn(
        Daemon::new(DaemonConfig {
            socket: socket.clone(),
            idle_seconds: Some(60),
            handshake_timeout: Duration::from_secs(5),
            build_id: "integration".into(),
        })
        .run(),
    );
    wait_for_socket(&socket).await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let mut stream = UnixStream::connect(&socket).await.unwrap();
    handshake(&mut stream).await;
    write_message(
        &mut stream,
        &ClientMessage::Request {
            id: "request-10".into(),
            method: "status".into(),
            params: None,
            stream: false,
        },
    )
    .await
    .unwrap();
    let response: ServerMessage = read_message(&mut stream).await.unwrap().unwrap();
    let encoded = format!("{response:?}");
    assert!(encoded.contains("integration"));
    assert!(!encoded.contains("forge-"));
    write_message(
        &mut stream,
        &ClientMessage::Request {
            id: "request-11".into(),
            method: "shutdown".into(),
            params: None,
            stream: false,
        },
    )
    .await
    .unwrap();
    let _: ServerMessage = read_message(&mut stream).await.unwrap().unwrap();
    drop(stream);
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn second_instance_is_rejected() {
    let dir = tempdir().unwrap();
    let socket = dir.path().join("runtime/daemon.sock");
    let config = DaemonConfig {
        socket: socket.clone(),
        idle_seconds: Some(60),
        handshake_timeout: Duration::from_secs(5),
        build_id: "one".into(),
    };
    let first = tokio::spawn(Daemon::new(config.clone()).run());
    wait_for_socket(&socket).await;
    let error = Daemon::new(config).run().await.unwrap_err();
    assert!(format!("{error:#}").contains("another mindcoded instance"));
    first.abort();
    let _ = first.await;
}

#[tokio::test]
async fn idle_timeout_stops_daemon_without_active_requests() {
    let dir = tempdir().unwrap();
    let socket = dir.path().join("runtime/idle.sock");
    let task = tokio::spawn(
        Daemon::new(DaemonConfig {
            socket: socket.clone(),
            idle_seconds: Some(1),
            handshake_timeout: Duration::from_secs(5),
            build_id: "idle-test".into(),
        })
        .run(),
    );
    wait_for_socket(&socket).await;
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .expect("idle timeout did not fire")
        .unwrap()
        .unwrap();
    assert!(!socket.exists());
}
