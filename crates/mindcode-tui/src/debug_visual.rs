//! Visual-debug frame dumps (`/debug-visual`, §11.8).
//!
//! A bounded ring of rendered frames, written as JSONL so an agent or a
//! developer can read it without a live terminal. Dumps are secret-free by
//! construction: ANSI escapes are stripped and credential-shaped values are
//! redacted at write time, before anything touches disk.

use mindcode_core_tools::redact_secrets;
use std::collections::VecDeque;
use std::fmt;
use std::fs;
use std::io::Write as _;
use std::path::Path;

/// Frames kept in memory per capture session (§11.8: ~100).
pub const DEFAULT_FRAME_CAPACITY: usize = 100;

#[derive(Debug, Clone, PartialEq)]
pub struct FrameDump {
    pub frame_id: u64,
    pub timestamp_ms: u64,
    pub terminal_size: Option<(u16, u16)>,
    /// Visible render text with ANSI removed and secrets redacted.
    pub render_text: String,
    /// Opaque, already-redacted state snapshot (JSON-serializable).
    pub state: serde_json::Value,
    pub timing_ms: u64,
    pub anomalies: Vec<String>,
}

impl FrameDump {
    /// Serialize one frame as a JSONL line (no trailing newline).
    pub fn to_jsonl_line(&self) -> Result<String, serde_json::Error> {
        let value = serde_json::json!({
            "frame_id": self.frame_id,
            "timestamp_ms": self.timestamp_ms,
            "terminal_size": self.terminal_size.map(|(w, h)| [w, h]),
            "render_text": self.render_text,
            "state": self.state,
            "timing_ms": self.timing_ms,
            "anomalies": self.anomalies,
        });
        serde_json::to_string(&value)
    }
}

#[derive(Debug, Clone, Default)]
pub struct FrameRecorder {
    frames: VecDeque<FrameDump>,
    capacity: usize,
    next_id: u64,
}

impl FrameRecorder {
    pub fn new(capacity: usize) -> Self {
        Self {
            frames: VecDeque::new(),
            capacity: capacity.max(1),
            next_id: 0,
        }
    }

    /// Record one frame, evicting the oldest when at capacity.  The caller is
    /// responsible for redacting text and state before calling this.
    pub fn record(&mut self, mut frame: FrameDump) {
        frame.frame_id = self.next_id;
        self.next_id += 1;
        if self.frames.len() == self.capacity {
            self.frames.pop_front();
        }
        self.frames.push_back(frame);
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    pub fn frames(&self) -> impl Iterator<Item = &FrameDump> {
        self.frames.iter()
    }

    /// Append every buffered frame as one JSONL document.  Creates parent
    /// directories with owner-only permissions on Unix.
    pub fn write_jsonl(&self, path: &Path) -> Result<(), FrameDumpError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(FrameDumpError::Io)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
            }
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(FrameDumpError::Io)?;
        for frame in &self.frames {
            let line = frame.to_jsonl_line().map_err(FrameDumpError::Json)?;
            writeln!(file, "{line}").map_err(FrameDumpError::Io)?;
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum FrameDumpError {
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for FrameDumpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "frame dump I/O error: {error}"),
            Self::Json(error) => write!(formatter, "frame dump JSON error: {error}"),
        }
    }
}

impl std::error::Error for FrameDumpError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
        }
    }
}

/// Remove ANSI escape sequences: CSI (`ESC [ … final byte`), OSC
/// (`ESC ] … BEL` or `ESC ] … ST`), and lone ESC characters.
pub fn strip_ansi(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != 0x1b {
            // Copy a run of plain bytes up to the next escape.
            let start = index;
            while index < bytes.len() && bytes[index] != 0x1b {
                index += 1;
            }
            // SAFETY: the slice boundaries were derived from UTF-8 byte indices.
            output.push_str(&text[start..index]);
            continue;
        }
        // At an ESC. Skip the escape and its parameter/terminator sequence.
        index += 1;
        if index >= bytes.len() {
            break;
        }
        match bytes[index] {
            b'[' => {
                // CSI: parameter + intermediate bytes, then a final byte in
                // 0x40..=0x7e.
                index += 1;
                while index < bytes.len() {
                    let byte = bytes[index];
                    index += 1;
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
            }
            b']' => {
                // OSC: terminated by BEL or ST (ESC \).
                index += 1;
                while index < bytes.len() {
                    let byte = bytes[index];
                    if byte == 0x07 {
                        index += 1;
                        break;
                    }
                    if byte == 0x1b && index + 1 < bytes.len() && bytes[index + 1] == b'\\' {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
            }
            b'P' | b'^' | b'_' => {
                // DCS / PM / APC are also string-terminated by ST; skip until
                // ESC \ to avoid leaking their payload.
                index += 1;
                while index + 1 < bytes.len() {
                    if bytes[index] == 0x1b && bytes[index + 1] == b'\\' {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
            }
            _ => {
                // Unknown/unsupported escape: drop the ESC and continue.
            }
        }
    }
    output
}

/// Strip ANSI then redact secrets, in that order, for a single frame's text.
pub fn sanitize_frame_text(text: &str) -> String {
    redact_secrets(&strip_ansi(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_csi_and_osc() {
        let text = "\u{1b}[31mred\u{1b}[0m plain \u{1b}]0;title\u{7}done";
        assert_eq!(strip_ansi(text), "red plain done");
    }

    #[test]
    fn ring_buffer_evicts_oldest_frame() {
        let mut recorder = FrameRecorder::new(3);
        for index in 0..5 {
            recorder.record(FrameDump {
                frame_id: 0,
                timestamp_ms: index,
                terminal_size: Some((80, 24)),
                render_text: format!("frame {index}"),
                state: serde_json::json!({}),
                timing_ms: 0,
                anomalies: Vec::new(),
            });
        }
        assert_eq!(recorder.len(), 3);
        let ids: Vec<u64> = recorder.frames().map(|frame| frame.frame_id).collect();
        assert_eq!(ids, vec![2, 3, 4]);
    }

    #[test]
    fn jsonl_write_is_valid_and_secret_free() {
        let path = std::env::temp_dir().join(format!(
            "mindcode-debug-visual-test-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let mut recorder = FrameRecorder::new(10);
        recorder.record(FrameDump {
            frame_id: 0,
            timestamp_ms: 42,
            terminal_size: Some((120, 40)),
            render_text: sanitize_frame_text("\u{1b}[31mBearer sk-1234567890abcdef\u{1b}[0m"),
            state: serde_json::json!({ "credential": "must-not-leak" }),
            timing_ms: 7,
            anomalies: vec!["late frame".to_owned()],
        });
        recorder.write_jsonl(&path).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let _ = fs::remove_file(&path);
        assert!(raw.contains("\"frame_id\":0"));
        assert!(raw.contains("[redacted]"));
        assert!(!raw.contains("sk-1234567890abcdef"));
        assert!(!raw.contains("\u{1b}["));
        // Every line is valid JSON.
        for line in raw.lines() {
            serde_json::from_str::<serde_json::Value>(line).unwrap();
        }
    }
}
