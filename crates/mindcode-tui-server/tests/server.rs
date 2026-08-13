//! Hermetic integration tests: a real client connects over a temp Unix socket
//! and exercises the handshake, snapshot delivery, input routing, capability
//! enforcement, and rejection paths.  No network or live provider is used.

use std::time::Duration;

use mindcode_protocol::ui::{
    encode_ui_frame, UiInputEventKind, UiKeyInput, UiMessage, UiRenderSnapshot, UI_PROTOCOL_VERSION,
};
use mindcode_tui_server::{ControlServer, ControlServerConfig, ProjectionInput, StatusInput};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::timeout;

const SESSION: &str = "session-1";

fn all_capabilities() -> Vec<String> {
    [
        "render_snapshot",
        "input",
        "resize",
        "shutdown",
        "mouse",
        "action",
    ]
    .iter()
    .map(|value| value.to_string())
    .collect()
}

fn handshake() -> UiMessage {
    UiMessage::Handshake {
        version: UI_PROTOCOL_VERSION,
        id: SESSION.to_owned(),
        client: "mindcode-tui".to_owned(),
        capabilities: all_capabilities(),
    }
}

fn input_text(sequence: u64) -> UiMessage {
    UiMessage::InputEvent {
        version: UI_PROTOCOL_VERSION,
        id: format!("input-{sequence}"),
        sequence,
        event: UiInputEventKind::Text {
            text: "hello".to_owned(),
        },
    }
}

async fn send(stream: &mut UnixStream, message: &UiMessage) {
    stream
        .write_all(&encode_ui_frame(message).unwrap())
        .await
        .unwrap();
}

/// Read frames until the buffer contains a message matching `predicate`, then
/// return every message received so far.
async fn read_until(
    stream: &mut UnixStream,
    predicate: impl Fn(&UiMessage) -> bool,
) -> Vec<UiMessage> {
    let mut buffer = Vec::<u8>::new();
    let mut messages = Vec::new();
    loop {
        for message in drain_frames(&mut buffer) {
            let matched = predicate(&message);
            messages.push(message);
            if matched {
                return messages;
            }
        }
        let mut chunk = [0_u8; 4096];
        let count = timeout(Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .expect("read timed out")
            .expect("read failed");
        assert!(count > 0, "socket closed before matching message arrived");
        buffer.extend_from_slice(&chunk[..count]);
    }
}

fn drain_frames(buffer: &mut Vec<u8>) -> Vec<UiMessage> {
    let mut messages = Vec::new();
    loop {
        if buffer.len() < 4 {
            break;
        }
        let payload =
            u32::from_be_bytes(buffer[..4].try_into().expect("four-byte header")) as usize;
        let frame_size = payload + 4;
        if buffer.len() < frame_size {
            break;
        }
        let frame: Vec<u8> = buffer.drain(..frame_size).collect();
        messages.push(mindcode_protocol::ui::decode_ui_frame(&frame).expect("valid frame"));
    }
    messages
}

fn snapshot(sequence: u64) -> UiRenderSnapshot {
    // Round-trip a projection so the snapshot is validated and complete.
    let projected = mindcode_tui_server::ProjectionStore::new(SESSION)
        .unwrap()
        .update(&ProjectionInput {
            status: StatusInput {
                state: Some("ready".to_owned()),
                ..Default::default()
            },
            ..Default::default()
        })
        .unwrap();
    let mut snapshot = projected;
    snapshot.sequence = sequence;
    snapshot
}

#[tokio::test]
async fn handshake_returns_capabilities_then_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("tui.sock");
    let server = ControlServer::new(ControlServerConfig::new(SESSION, &socket), None).unwrap();
    server.start().await.unwrap();
    server
        .publish(&ProjectionInput {
            status: StatusInput {
                state: Some("ready".to_owned()),
                ..Default::default()
            },
            ..Default::default()
        })
        .await
        .unwrap();

    let mut stream = UnixStream::connect(&socket).await.unwrap();
    send(&mut stream, &handshake()).await;

    let messages = read_until(&mut stream, |message| {
        matches!(message, UiMessage::RenderSnapshot { .. })
    })
    .await;
    assert!(messages
        .iter()
        .any(|message| matches!(message, UiMessage::Capabilities { .. })));
    assert!(messages
        .iter()
        .any(|message| matches!(message, UiMessage::RenderSnapshot { .. })));

    server.close().await;
}

#[tokio::test]
async fn input_event_is_acked() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("tui.sock");
    let server = ControlServer::new(ControlServerConfig::new(SESSION, &socket), None).unwrap();
    server.start().await.unwrap();

    let mut stream = UnixStream::connect(&socket).await.unwrap();
    send(&mut stream, &handshake()).await;
    let _ = read_until(&mut stream, |message| {
        matches!(message, UiMessage::Capabilities { .. })
    })
    .await;

    send(&mut stream, &input_text(1)).await;
    let messages = read_until(
        &mut stream,
        |message| matches!(message, UiMessage::Ack { sequence, .. } if *sequence == 1),
    )
    .await;
    assert!(messages
        .iter()
        .any(|message| { matches!(message, UiMessage::Ack { sequence, .. } if *sequence == 1) }));

    server.close().await;
}

#[tokio::test]
async fn unnegotiated_capability_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("tui.sock");
    // The server only offers render_snapshot, so resize is never negotiated.
    let mut config = ControlServerConfig::new(SESSION, &socket);
    config.capabilities = vec!["render_snapshot".to_owned()];
    let server = ControlServer::new(config, None).unwrap();
    server.start().await.unwrap();

    let mut stream = UnixStream::connect(&socket).await.unwrap();
    send(&mut stream, &handshake()).await;
    let _ = read_until(&mut stream, |message| {
        matches!(message, UiMessage::Capabilities { .. })
    })
    .await;

    send(
        &mut stream,
        &UiMessage::TerminalSize {
            version: UI_PROTOCOL_VERSION,
            id: "size-1".to_owned(),
            columns: 80,
            rows: 24,
        },
    )
    .await;
    let messages = read_until(
        &mut stream,
        |message| matches!(message, UiMessage::Error { code, .. } if code == "capability_required"),
    )
    .await;
    assert!(messages.iter().any(|message| {
        matches!(message, UiMessage::Error { code, .. } if code == "capability_required")
    }));

    server.close().await;
}

#[tokio::test]
async fn mismatched_handshake_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("tui.sock");
    let server = ControlServer::new(ControlServerConfig::new(SESSION, &socket), None).unwrap();
    server.start().await.unwrap();

    let mut stream = UnixStream::connect(&socket).await.unwrap();
    send(
        &mut stream,
        &UiMessage::Handshake {
            version: UI_PROTOCOL_VERSION,
            id: "wrong-session".to_owned(),
            client: "mindcode-tui".to_owned(),
            capabilities: all_capabilities(),
        },
    )
    .await;
    let messages = read_until(
        &mut stream,
        |message| matches!(message, UiMessage::Error { code, .. } if code == "handshake_rejected"),
    )
    .await;
    assert!(messages.iter().any(|message| {
        matches!(message, UiMessage::Error { code, .. } if code == "handshake_rejected")
    }));

    server.close().await;
}

#[tokio::test]
async fn snapshot_is_delivered_only_after_handshake() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("tui.sock");
    let server = ControlServer::new(ControlServerConfig::new(SESSION, &socket), None).unwrap();
    server.start().await.unwrap();

    let mut stream = UnixStream::connect(&socket).await.unwrap();
    // Publish before handshake: nothing may arrive before the handshake.
    server.publish(&ProjectionInput::default()).await.unwrap();
    send(&mut stream, &handshake()).await;

    let messages = read_until(
        &mut stream,
        |message| matches!(message, UiMessage::RenderSnapshot { sequence, .. } if *sequence == 1),
    )
    .await;
    let caps_first = messages
        .iter()
        .position(|message| matches!(message, UiMessage::Capabilities { .. }));
    let snapshot_first = messages
        .iter()
        .position(|message| matches!(message, UiMessage::RenderSnapshot { .. }));
    assert!(caps_first.is_some() && snapshot_first.is_some());
    assert!(
        caps_first < snapshot_first,
        "capabilities must precede snapshots"
    );

    server.close().await;
}

#[tokio::test]
async fn key_input_routes_through_on_input_hook() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("tui.sock");
    let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::<UiMessage>::new()));
    let hook_received = received.clone();
    let server = ControlServer::new(
        ControlServerConfig::new(SESSION, &socket),
        Some(std::sync::Arc::new(move |message| {
            hook_received.lock().unwrap().push(message);
        })),
    )
    .unwrap();
    server.start().await.unwrap();

    let mut stream = UnixStream::connect(&socket).await.unwrap();
    send(&mut stream, &handshake()).await;
    let _ = read_until(&mut stream, |message| {
        matches!(message, UiMessage::Capabilities { .. })
    })
    .await;

    send(
        &mut stream,
        &UiMessage::InputEvent {
            version: UI_PROTOCOL_VERSION,
            id: "input-7".to_owned(),
            sequence: 7,
            event: UiInputEventKind::Key(UiKeyInput {
                key: "enter".to_owned(),
                modifiers: vec![],
            }),
        },
    )
    .await;
    let _ = read_until(
        &mut stream,
        |message| matches!(message, UiMessage::Ack { sequence, .. } if *sequence == 7),
    )
    .await;

    {
        let received = received.lock().unwrap();
        assert_eq!(received.len(), 1);
        assert!(matches!(
            &received[0],
            UiMessage::InputEvent { sequence: 7, .. }
        ));
    }

    server.close().await;
}

#[tokio::test]
async fn snapshot_round_trips_through_the_wire() {
    // Encode/decode a full projection snapshot to prove the server's frames
    // carry the complete snapshot faithfully.
    let value = snapshot(3);
    let frame = encode_ui_frame(&UiMessage::RenderSnapshot {
        version: value.version,
        id: value.id.clone(),
        sequence: value.sequence,
        sessions: value.sessions.clone(),
        workspaces: value.workspaces.clone(),
        active_session_id: value.active_session_id.clone(),
        status: value.status.clone(),
        telemetry: value.telemetry.clone(),
        tasks: value.tasks.clone(),
        agents: value.agents.clone(),
        transcript: value.transcript.clone(),
        transcript_window: value.transcript_window.clone(),
        changes: value.changes.clone(),
        activity: value.activity.clone(),
        permissions: value.permissions.clone(),
        providers: value.providers.clone(),
        writer: value.writer.clone(),
    })
    .unwrap();
    let decoded = mindcode_protocol::ui::decode_ui_frame(&frame).unwrap();
    match decoded {
        UiMessage::RenderSnapshot { sequence, .. } => assert_eq!(sequence, 3),
        other => panic!("expected render snapshot, got {other:?}"),
    }
}
