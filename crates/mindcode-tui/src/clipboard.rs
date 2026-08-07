//! Bounded OSC52 clipboard emission for the native renderer.
//!
//! The testable path builds the terminal command or writes it to an arbitrary
//! writer.  Tests use an in-memory buffer and never execute a terminal command
//! or access a host clipboard.

use std::fmt;
use std::io::{self, Write};

use crossterm::clipboard::CopyToClipboard;
use crossterm::Command;

/// Maximum UTF-8 payload accepted before OSC52 base64 encoding.
pub const MAX_CLIPBOARD_BYTES: usize = 64 * 1024;
/// Maximum complete OSC52 sequence emitted by this module.
pub const MAX_OSC52_BYTES: usize = 128 * 1024;

#[derive(Debug)]
pub enum ClipboardError {
    TooLarge { bytes: usize, max: usize },
    Formatting,
    Io(io::Error),
}

impl fmt::Display for ClipboardError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { bytes, max } => {
                write!(
                    formatter,
                    "clipboard payload is {bytes} bytes; maximum is {max}"
                )
            }
            Self::Formatting => formatter.write_str("failed to format OSC52 clipboard command"),
            Self::Io(error) => write!(
                formatter,
                "failed to write OSC52 clipboard command: {error}"
            ),
        }
    }
}

impl std::error::Error for ClipboardError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::TooLarge { .. } | Self::Formatting => None,
        }
    }
}

/// Build a bounded OSC52 sequence without touching the terminal or host
/// clipboard.  The destination is the normal clipboard (`c`).
pub fn osc52_sequence(content: &str) -> Result<String, ClipboardError> {
    let bytes = content.len();
    if bytes > MAX_CLIPBOARD_BYTES {
        return Err(ClipboardError::TooLarge {
            bytes,
            max: MAX_CLIPBOARD_BYTES,
        });
    }

    // The input bound makes this allocation bounded before crossterm encodes
    // the payload.  Keep a second check so the output contract remains true
    // if the upstream command format changes.
    let mut sequence = String::with_capacity((bytes.saturating_mul(4) / 3).saturating_add(16));
    CopyToClipboard::to_clipboard_from(content)
        .write_ansi(&mut sequence)
        .map_err(|_| ClipboardError::Formatting)?;
    if sequence.len() > MAX_OSC52_BYTES {
        return Err(ClipboardError::TooLarge {
            bytes: sequence.len(),
            max: MAX_OSC52_BYTES,
        });
    }
    Ok(sequence)
}

/// Write one bounded OSC52 command to a caller-owned terminal writer.
///
/// The caller decides when terminal output is appropriate; this function does
/// not query or read the system clipboard.
pub fn write_osc52<W: Write>(writer: &mut W, content: &str) -> Result<usize, ClipboardError> {
    let sequence = osc52_sequence(content)?;
    writer
        .write_all(sequence.as_bytes())
        .map_err(ClipboardError::Io)?;
    Ok(sequence.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequence_uses_crossterm_osc52_clipboard_command() {
        let sequence = osc52_sequence("foo").expect("small payload is accepted");
        assert_eq!(sequence, "\x1b]52;c;Zm9v\x1b\\");
    }

    #[test]
    fn writer_path_is_in_memory_and_reports_bytes_written() {
        let mut output = Vec::new();
        let written = write_osc52(&mut output, "hello").expect("buffer write succeeds");
        assert_eq!(written, output.len());
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "\x1b]52;c;aGVsbG8=\x1b\\"
        );
    }

    #[test]
    fn oversized_payload_is_rejected_before_encoding() {
        let content = "x".repeat(MAX_CLIPBOARD_BYTES + 1);
        assert!(matches!(
            osc52_sequence(&content),
            Err(ClipboardError::TooLarge { bytes, max })
                if bytes == MAX_CLIPBOARD_BYTES + 1 && max == MAX_CLIPBOARD_BYTES
        ));
    }

    #[test]
    fn unicode_is_bounded_by_utf8_bytes() {
        let content = "я".repeat(MAX_CLIPBOARD_BYTES / "я".len());
        assert!(osc52_sequence(&content).is_ok());
        let oversized = format!("{content}я");
        assert!(matches!(
            osc52_sequence(&oversized),
            Err(ClipboardError::TooLarge { .. })
        ));
    }
}
