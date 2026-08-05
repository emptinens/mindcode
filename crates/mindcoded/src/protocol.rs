//! Async transport adapter for the shared MindCode protocol.

use std::io;

pub use mindcode_protocol::{
    ClientMessage, RemoteErrorPayload, ServerMessage, MAX_FRAME_SIZE, PROTOCOL_VERSION,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub async fn read_message<R, T>(reader: &mut R) -> io::Result<Option<T>>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut header = [0_u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }

    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid protocol frame length: {length}"),
        ));
    }
    let mut frame = Vec::with_capacity(length + 4);
    frame.extend_from_slice(&header);
    frame.resize(length + 4, 0);
    reader.read_exact(&mut frame[4..]).await?;
    mindcode_protocol::decode_frame(&frame)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub async fn write_message<W, T>(writer: &mut W, message: &T) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let frame = mindcode_protocol::encode_frame(message)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    writer.write_all(&frame).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn async_round_trip_uses_shared_codec() {
        let (mut left, mut right) = duplex(1024);
        let expected = ServerMessage::Response {
            id: "request-7".into(),
            ok: true,
            result: Some(serde_json::json!({"pong": true})),
            error: None,
        };
        let to_write = expected.clone();
        let writer = tokio::spawn(async move { write_message(&mut left, &to_write).await });
        let actual: ServerMessage = read_message(&mut right).await.unwrap().unwrap();
        writer.await.unwrap().unwrap();
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn rejects_oversized_frame() {
        let (mut left, mut right) = duplex(16);
        let writer = tokio::spawn(async move {
            left.write_all(&((MAX_FRAME_SIZE + 1) as u32).to_be_bytes())
                .await
        });
        let error = read_message::<_, ClientMessage>(&mut right)
            .await
            .unwrap_err();
        writer.await.unwrap().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
