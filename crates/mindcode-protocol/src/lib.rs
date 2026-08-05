//! Versioned MessagePack protocol shared by MindCode clients and `mindcoded`.

use std::fmt;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;
const FRAME_HEADER_SIZE: usize = 4;

#[derive(Debug)]
pub enum ProtocolError {
    Encode(rmp_serde::encode::Error),
    Decode(rmp_serde::decode::Error),
    FrameTooLarge { size: usize, max: usize },
    TruncatedFrame { expected: usize, actual: usize },
    TrailingBytes { remaining: usize },
    ZeroLengthFrame,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Encode(error) => write!(f, "MessagePack encode error: {error}"),
            Self::Decode(error) => write!(f, "MessagePack decode error: {error}"),
            Self::FrameTooLarge { size, max } => {
                write!(f, "frame payload is {size} bytes, maximum is {max} bytes")
            }
            Self::TruncatedFrame { expected, actual } => {
                write!(
                    f,
                    "truncated frame: expected {expected} bytes, received {actual}"
                )
            }
            Self::TrailingBytes { remaining } => {
                write!(f, "frame contains {remaining} trailing bytes")
            }
            Self::ZeroLengthFrame => write!(f, "zero-length frames are invalid"),
        }
    }
}

impl std::error::Error for ProtocolError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Encode(error) => Some(error),
            Self::Decode(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rmp_serde::encode::Error> for ProtocolError {
    fn from(error: rmp_serde::encode::Error) -> Self {
        Self::Encode(error)
    }
}

impl From<rmp_serde::decode::Error> for ProtocolError {
    fn from(error: rmp_serde::decode::Error) -> Self {
        Self::Decode(error)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Handshake {
        id: String,
        version: u16,
        client: String,
        #[serde(default)]
        capabilities: Vec<String>,
    },
    Request {
        id: String,
        method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<Value>,
        #[serde(default, skip_serializing_if = "is_false")]
        stream: bool,
    },
    Cancel {
        id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    HandshakeAck {
        id: String,
        version: u16,
        accepted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        capabilities: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RemoteErrorPayload>,
    },
    Response {
        id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RemoteErrorPayload>,
    },
    Stream {
        id: String,
        seq: u64,
        data: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteErrorPayload {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

const fn is_false(value: &bool) -> bool {
    !*value
}

pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, ProtocolError> {
    let payload = rmp_serde::to_vec_named(value)?;
    if payload.is_empty() {
        return Err(ProtocolError::ZeroLengthFrame);
    }
    if payload.len() > MAX_FRAME_SIZE {
        return Err(ProtocolError::FrameTooLarge {
            size: payload.len(),
            max: MAX_FRAME_SIZE,
        });
    }

    let mut frame = Vec::with_capacity(FRAME_HEADER_SIZE + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_frame<T: DeserializeOwned>(frame: &[u8]) -> Result<T, ProtocolError> {
    if frame.len() < FRAME_HEADER_SIZE {
        return Err(ProtocolError::TruncatedFrame {
            expected: FRAME_HEADER_SIZE,
            actual: frame.len(),
        });
    }
    let payload_length =
        u32::from_be_bytes(frame[..4].try_into().expect("four-byte header")) as usize;
    if payload_length == 0 {
        return Err(ProtocolError::ZeroLengthFrame);
    }
    if payload_length > MAX_FRAME_SIZE {
        return Err(ProtocolError::FrameTooLarge {
            size: payload_length,
            max: MAX_FRAME_SIZE,
        });
    }
    let expected = FRAME_HEADER_SIZE + payload_length;
    if frame.len() < expected {
        return Err(ProtocolError::TruncatedFrame {
            expected,
            actual: frame.len(),
        });
    }
    if frame.len() > expected {
        return Err(ProtocolError::TrailingBytes {
            remaining: frame.len() - expected,
        });
    }
    Ok(rmp_serde::from_slice(&frame[FRAME_HEADER_SIZE..])?)
}

#[derive(Debug, Default)]
pub struct IncrementalDecoder {
    buffered: Vec<u8>,
}

impl IncrementalDecoder {
    pub fn push<T: DeserializeOwned>(&mut self, bytes: &[u8]) -> Result<Vec<T>, ProtocolError> {
        self.buffered.extend_from_slice(bytes);
        let mut decoded = Vec::new();
        loop {
            if self.buffered.len() < FRAME_HEADER_SIZE {
                break;
            }
            let payload_length =
                u32::from_be_bytes(self.buffered[..4].try_into().expect("four-byte header"))
                    as usize;
            if payload_length == 0 {
                return Err(ProtocolError::ZeroLengthFrame);
            }
            if payload_length > MAX_FRAME_SIZE {
                return Err(ProtocolError::FrameTooLarge {
                    size: payload_length,
                    max: MAX_FRAME_SIZE,
                });
            }
            let frame_length = FRAME_HEADER_SIZE + payload_length;
            if self.buffered.len() < frame_length {
                break;
            }
            let frame: Vec<u8> = self.buffered.drain(..frame_length).collect();
            decoded.push(decode_frame(&frame)?);
        }
        Ok(decoded)
    }

    pub fn clear(&mut self) {
        self.buffered.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handshake() -> ClientMessage {
        ClientMessage::Handshake {
            id: "handshake-1".into(),
            version: PROTOCOL_VERSION,
            client: "mindcode-test".into(),
            capabilities: vec!["stream".into(), "cancel".into()],
        }
    }

    #[test]
    fn client_message_round_trip() {
        let frame = encode_frame(&handshake()).unwrap();
        assert_eq!(
            u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize,
            frame.len() - 4
        );
        assert_eq!(decode_frame::<ClientMessage>(&frame).unwrap(), handshake());
    }

    #[test]
    fn response_round_trip() {
        let message = ServerMessage::Response {
            id: "request-1".into(),
            ok: true,
            result: Some(serde_json::json!({"pong": true})),
            error: None,
        };
        assert_eq!(
            decode_frame::<ServerMessage>(&encode_frame(&message).unwrap()).unwrap(),
            message
        );
    }

    #[test]
    fn incremental_decoder_handles_split_and_multiple_frames() {
        let first = encode_frame(&handshake()).unwrap();
        let second_message = ClientMessage::Cancel {
            id: "request-9".into(),
        };
        let second = encode_frame(&second_message).unwrap();
        let mut decoder = IncrementalDecoder::default();
        assert!(decoder
            .push::<ClientMessage>(&first[..3])
            .unwrap()
            .is_empty());
        let mut tail = first[3..].to_vec();
        tail.extend(second);
        assert_eq!(
            decoder.push::<ClientMessage>(&tail).unwrap(),
            vec![handshake(), second_message]
        );
    }

    #[test]
    fn rejects_zero_oversized_truncated_and_trailing_frames() {
        assert!(matches!(
            decode_frame::<ClientMessage>(&[0, 0, 0, 0]),
            Err(ProtocolError::ZeroLengthFrame)
        ));
        let oversized = ((MAX_FRAME_SIZE + 1) as u32).to_be_bytes();
        assert!(matches!(
            decode_frame::<ClientMessage>(&oversized),
            Err(ProtocolError::FrameTooLarge { .. })
        ));
        assert!(matches!(
            decode_frame::<ClientMessage>(&[0, 0, 0, 4, 1]),
            Err(ProtocolError::TruncatedFrame { .. })
        ));
        let mut trailing = encode_frame(&handshake()).unwrap();
        trailing.push(0);
        assert!(matches!(
            decode_frame::<ClientMessage>(&trailing),
            Err(ProtocolError::TrailingBytes { remaining: 1 })
        ));
    }
}
