//! Ratatui renderer for the TypeScript-authoritative MindCode UI protocol.
//!
//! The renderer owns no durable session state.  It keeps one validated latest
//! snapshot and a small frame decoder while the dedicated control socket is
//! open.

use std::ffi::OsString;
use std::fmt;
use std::io;
use std::time::Duration;

use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use mindcode_protocol::ui::{
    encode_ui_frame, UiInputEventKind, UiKeyInput, UiMessage, UiRenderSnapshot, UI_MAX_FRAME_SIZE,
    UI_MAX_INPUT_BYTES, UI_PROTOCOL_VERSION,
};
use mindcode_protocol::ProtocolError;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap};
use ratatui::{Frame, Terminal};

const CLIENT_NAME: &str = "mindcode-tui";
const CONTROL_CAPABILITIES: [&str; 4] = ["render_snapshot", "input", "resize", "shutdown"];
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const SOCKET_READ_TIMEOUT: Duration = Duration::from_millis(20);
const SOCKET_WRITE_TIMEOUT: Duration = Duration::from_millis(250);
const FRAME_BUFFER_LIMIT: usize = UI_MAX_FRAME_SIZE + 4;

fn validate_handshake_response(message: &UiMessage, session_id: &str) -> Result<(), TuiError> {
    let UiMessage::Capabilities {
        version,
        id,
        capabilities,
    } = message
    else {
        return Err(TuiError::Handshake(
            "expected capabilities response from control server".into(),
        ));
    };
    if *version != UI_PROTOCOL_VERSION {
        return Err(TuiError::Handshake(format!(
            "unsupported control protocol version: {version}"
        )));
    }
    if id != session_id {
        return Err(TuiError::Handshake(
            "control response session ID does not match".into(),
        ));
    }
    let exact_capabilities = capabilities.len() == CONTROL_CAPABILITIES.len()
        && CONTROL_CAPABILITIES
            .iter()
            .all(|expected| capabilities.iter().any(|actual| actual == expected));
    if !exact_capabilities {
        return Err(TuiError::Handshake(
            "control response capabilities do not match".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiConfig {
    pub control_socket: std::path::PathBuf,
    pub session_id: String,
}

#[derive(Debug)]
pub enum TuiError {
    InvalidArguments(String),
    Io(io::Error),
    Protocol(ProtocolError),
    HandshakeTimeout,
    Handshake(String),
    UnsupportedPlatform,
}

impl fmt::Display for TuiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArguments(message) => f.write_str(message),
            Self::Io(error) => write!(f, "I/O error: {error}"),
            Self::Protocol(error) => write!(f, "protocol error: {error}"),
            Self::HandshakeTimeout => f.write_str("UI handshake timed out"),
            Self::Handshake(message) => write!(f, "UI handshake failed: {message}"),
            Self::UnsupportedPlatform => {
                f.write_str("unsupported platform: Unix sockets are required")
            }
        }
    }
}

impl std::error::Error for TuiError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Protocol(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for TuiError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<ProtocolError> for TuiError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

/// Parse the binary's deliberately small CLI surface.
pub fn parse_args<I>(args: I) -> Result<TuiConfig, TuiError>
where
    I: IntoIterator<Item = OsString>,
{
    let mut control_socket = None;
    let mut session_id = None;
    let mut args = args.into_iter();

    while let Some(argument) = args.next() {
        let argument = argument.to_string_lossy();
        match argument.as_ref() {
            "--control-socket" => {
                let value = args.next().ok_or_else(|| {
                    TuiError::InvalidArguments("--control-socket requires a value".into())
                })?;
                control_socket = Some(std::path::PathBuf::from(value));
            }
            "--session-id" => {
                let value = args.next().ok_or_else(|| {
                    TuiError::InvalidArguments("--session-id requires a value".into())
                })?;
                session_id = Some(value.to_string_lossy().into_owned());
            }
            "-h" | "--help" => {
                return Err(TuiError::InvalidArguments(
                    "usage: mindcode-tui --control-socket PATH --session-id ID".into(),
                ));
            }
            other => {
                return Err(TuiError::InvalidArguments(format!(
                    "unknown argument: {other}"
                )))
            }
        }
    }

    let control_socket = control_socket
        .ok_or_else(|| TuiError::InvalidArguments("missing required --control-socket".into()))?;
    let session_id = session_id
        .filter(|value| !value.is_empty())
        .ok_or_else(|| TuiError::InvalidArguments("missing required --session-id".into()))?;

    Ok(TuiConfig {
        control_socket,
        session_id,
    })
}

#[derive(Debug, Default)]
pub struct App {
    latest_snapshot: Option<UiRenderSnapshot>,
    input_buffer: String,
}

impl App {
    pub fn latest_snapshot(&self) -> Option<&UiRenderSnapshot> {
        self.latest_snapshot.as_ref()
    }

    /// Replace the only retained render state when the TS sequence advances.
    pub fn apply_message(&mut self, message: UiMessage) {
        if !matches!(&message, UiMessage::RenderSnapshot { .. })
            || encode_ui_frame(&message).is_err()
        {
            return;
        }
        if let UiMessage::RenderSnapshot {
            version,
            id,
            sequence,
            status,
            tasks,
            transcript,
        } = message
        {
            let is_newer = self
                .latest_snapshot
                .as_ref()
                .is_none_or(|snapshot| sequence > snapshot.sequence);
            if is_newer {
                self.latest_snapshot = Some(UiRenderSnapshot {
                    version,
                    id,
                    sequence,
                    status,
                    tasks,
                    transcript,
                });
            }
        }
    }

    pub fn render(&self, frame: &mut Frame<'_>) {
        render_snapshot_with_input(frame, self.latest_snapshot.as_ref(), &self.input_buffer);
    }

    fn apply_input(&mut self, message: &UiMessage) {
        let UiMessage::InputEvent { event, .. } = message else {
            return;
        };
        match event {
            UiInputEventKind::Key(input)
                if input.key == "backspace" && input.modifiers.is_empty() =>
            {
                self.input_buffer.pop();
            }
            UiInputEventKind::Key(input)
                if input.modifiers.iter().all(|modifier| modifier == "shift")
                    && input.key.chars().count() == 1
                    && !input.key.chars().next().is_some_and(char::is_control) =>
            {
                self.push_input(&input.key);
            }
            UiInputEventKind::Paste { text } | UiInputEventKind::Text { text } => {
                self.push_input(text);
            }
            UiInputEventKind::Submit | UiInputEventKind::Cancel => {
                self.input_buffer.clear();
            }
            UiInputEventKind::Key(_) | UiInputEventKind::Interrupt => {}
        }
    }

    fn push_input(&mut self, value: &str) {
        let remaining = UI_MAX_INPUT_BYTES.saturating_sub(self.input_buffer.len());
        if remaining == 0 {
            return;
        }
        let end = value
            .char_indices()
            .map(|(index, character)| index + character.len_utf8())
            .take_while(|end| *end <= remaining)
            .last()
            .unwrap_or(0);
        self.input_buffer.push_str(&value[..end]);
    }
}

pub fn render_snapshot(frame: &mut Frame<'_>, snapshot: Option<&UiRenderSnapshot>) {
    render_snapshot_with_input(frame, snapshot, "");
}

fn render_snapshot_with_input(
    frame: &mut Frame<'_>,
    snapshot: Option<&UiRenderSnapshot>,
    input_buffer: &str,
) {
    let [header_area, body_area, input_area, footer_area] = Layout::vertical([
        Constraint::Length(3),
        Constraint::Fill(1),
        Constraint::Length(3),
        Constraint::Length(1),
    ])
    .areas(frame.area());

    let (header, footer) = match snapshot {
        Some(snapshot) => {
            let message = snapshot.status.message.as_deref().unwrap_or("");
            let detail = snapshot.status.detail.as_deref().unwrap_or("");
            let title = if message.is_empty() {
                snapshot.status.state.clone()
            } else {
                format!("{} — {message}", snapshot.status.state)
            };
            let footer = if detail.is_empty() {
                format!(
                    "snapshot #{}  |  ctrl-q: quit  ctrl-c: interrupt",
                    snapshot.sequence
                )
            } else {
                format!("{detail}  |  snapshot #{}", snapshot.sequence)
            };
            (title, footer)
        }
        None => (
            "waiting for TypeScript snapshot".to_owned(),
            "connecting  |  ctrl-q: quit  ctrl-c: interrupt".to_owned(),
        ),
    };

    frame.render_widget(
        Paragraph::new(header)
            .block(Block::bordered().title("MindCode"))
            .style(
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
        header_area,
    );

    let [tasks_area, transcript_area] =
        Layout::horizontal([Constraint::Percentage(36), Constraint::Fill(1)]).areas(body_area);
    render_tasks(frame, tasks_area, snapshot);
    render_transcript(frame, transcript_area, snapshot);

    frame.render_widget(
        Paragraph::new(format!("> {input_buffer}")).block(Block::bordered().title("Input")),
        input_area,
    );

    frame.render_widget(
        Paragraph::new(footer).style(Style::default().fg(Color::DarkGray)),
        footer_area,
    );
}

fn render_tasks(
    frame: &mut Frame<'_>,
    area: ratatui::layout::Rect,
    snapshot: Option<&UiRenderSnapshot>,
) {
    let items = snapshot
        .map(|snapshot| {
            snapshot
                .tasks
                .iter()
                .map(|task| {
                    let progress = task
                        .progress
                        .map(|value| format!(" {value}%"))
                        .unwrap_or_default();
                    let detail = task
                        .detail
                        .as_deref()
                        .map(|value| format!(" — {value}"))
                        .unwrap_or_default();
                    ListItem::new(Line::from(vec![
                        Span::styled(
                            format!("{} ", task.status),
                            Style::default().fg(task_status_color(&task.status)),
                        ),
                        Span::raw(format!("{}{progress}{detail}", task.title)),
                    ]))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    frame.render_widget(
        List::new(items).block(Block::default().borders(Borders::ALL).title("Tasks")),
        area,
    );
}

fn task_status_color(status: &str) -> Color {
    match status {
        "running" | "active" => Color::Yellow,
        "done" | "completed" | "success" => Color::Green,
        "failed" | "error" => Color::Red,
        _ => Color::Gray,
    }
}

fn render_transcript(
    frame: &mut Frame<'_>,
    area: ratatui::layout::Rect,
    snapshot: Option<&UiRenderSnapshot>,
) {
    let lines = match snapshot {
        Some(snapshot) => {
            let max_lines = usize::from(area.height.saturating_sub(2)).max(1);
            let start = snapshot.transcript.len().saturating_sub(max_lines);
            snapshot.transcript[start..]
                .iter()
                .map(|entry| {
                    Line::from(vec![
                        Span::styled(
                            format!("{}: ", entry.role),
                            Style::default().fg(Color::LightBlue),
                        ),
                        Span::raw(entry.text.clone()),
                    ])
                })
                .collect::<Vec<_>>()
        }
        None => vec![Line::from("no transcript")],
    };
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .block(Block::default().borders(Borders::ALL).title("Transcript"))
            .wrap(Wrap { trim: false }),
        area,
    );
}

pub fn key_event_to_input(event: KeyEvent) -> Option<UiInputEventKind> {
    if event.kind == KeyEventKind::Release {
        return None;
    }
    if event.code == KeyCode::Char('c') && event.modifiers.contains(KeyModifiers::CONTROL) {
        return Some(UiInputEventKind::Interrupt);
    }
    match event.code {
        KeyCode::Enter => Some(UiInputEventKind::Submit),
        KeyCode::Esc => Some(UiInputEventKind::Cancel),
        code => Some(UiInputEventKind::Key(UiKeyInput {
            key: key_code_name(code),
            modifiers: key_modifiers(event.modifiers),
        })),
    }
}

fn key_code_name(code: KeyCode) -> String {
    match code {
        KeyCode::Backspace => "backspace".into(),
        KeyCode::Enter => "enter".into(),
        KeyCode::Left => "left".into(),
        KeyCode::Right => "right".into(),
        KeyCode::Up => "up".into(),
        KeyCode::Down => "down".into(),
        KeyCode::Home => "home".into(),
        KeyCode::End => "end".into(),
        KeyCode::PageUp => "page_up".into(),
        KeyCode::PageDown => "page_down".into(),
        KeyCode::Tab => "tab".into(),
        KeyCode::BackTab => "back_tab".into(),
        KeyCode::Delete => "delete".into(),
        KeyCode::Insert => "insert".into(),
        KeyCode::F(number) => format!("f{number}"),
        KeyCode::Char(value) => value.to_string(),
        KeyCode::Null => "null".into(),
        KeyCode::CapsLock => "caps_lock".into(),
        KeyCode::ScrollLock => "scroll_lock".into(),
        KeyCode::NumLock => "num_lock".into(),
        KeyCode::PrintScreen => "print_screen".into(),
        KeyCode::Pause => "pause".into(),
        KeyCode::Menu => "menu".into(),
        KeyCode::KeypadBegin => "keypad_begin".into(),
        KeyCode::Media(media) => format!("media_{media:?}").to_lowercase(),
        KeyCode::Modifier(modifier) => format!("modifier_{modifier:?}").to_lowercase(),
        KeyCode::Esc => "escape".into(),
    }
}

fn key_modifiers(modifiers: KeyModifiers) -> Vec<String> {
    [
        (KeyModifiers::SHIFT, "shift"),
        (KeyModifiers::CONTROL, "ctrl"),
        (KeyModifiers::ALT, "alt"),
        (KeyModifiers::SUPER, "super"),
        (KeyModifiers::HYPER, "hyper"),
        (KeyModifiers::META, "meta"),
    ]
    .into_iter()
    .filter(|(modifier, _)| modifiers.contains(*modifier))
    .map(|(_, name)| name.to_owned())
    .collect()
}

#[cfg(unix)]
mod unix_runtime {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::path::Path;
    use std::time::Instant;

    struct FrameReader {
        bytes: Vec<u8>,
    }

    impl FrameReader {
        fn new() -> Self {
            Self { bytes: Vec::new() }
        }

        fn push(&mut self, bytes: &[u8]) -> Result<Vec<UiMessage>, TuiError> {
            if self.bytes.len().saturating_add(bytes.len()) > FRAME_BUFFER_LIMIT {
                return Err(TuiError::Handshake(
                    "UI frame buffer exceeded its bound".into(),
                ));
            }
            self.bytes.extend_from_slice(bytes);
            let mut messages = Vec::new();
            loop {
                if self.bytes.len() < 4 {
                    break;
                }
                let payload_size =
                    u32::from_be_bytes(self.bytes[..4].try_into().expect("four-byte header"))
                        as usize;
                if payload_size > UI_MAX_FRAME_SIZE {
                    return Err(TuiError::Protocol(ProtocolError::FrameTooLarge {
                        size: payload_size,
                        max: UI_MAX_FRAME_SIZE,
                    }));
                }
                let frame_size = payload_size + 4;
                if self.bytes.len() < frame_size {
                    break;
                }
                let frame: Vec<_> = self.bytes.drain(..frame_size).collect();
                messages.push(mindcode_protocol::ui::decode_ui_frame(&frame)?);
            }
            Ok(messages)
        }
    }

    struct UiConnection {
        stream: UnixStream,
        frames: FrameReader,
    }

    impl UiConnection {
        fn connect(path: &Path) -> Result<Self, TuiError> {
            let stream = UnixStream::connect(path)?;
            stream.set_write_timeout(Some(SOCKET_WRITE_TIMEOUT))?;
            Ok(Self {
                stream,
                frames: FrameReader::new(),
            })
        }

        fn send(&mut self, message: &UiMessage) -> Result<(), TuiError> {
            let frame = encode_ui_frame(message)?;
            self.stream.write_all(&frame)?;
            Ok(())
        }

        fn receive(&mut self) -> Result<Vec<UiMessage>, TuiError> {
            let mut bytes = [0_u8; 8192];
            match self.stream.read(&mut bytes) {
                Ok(0) => Err(TuiError::Handshake("control socket closed".into())),
                Ok(count) => self.frames.push(&bytes[..count]),
                Err(error) if error.kind() == io::ErrorKind::TimedOut => Ok(Vec::new()),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(Vec::new()),
                Err(error) => Err(error.into()),
            }
        }

        fn handshake(&mut self, session_id: &str) -> Result<Option<UiMessage>, TuiError> {
            self.send(&UiMessage::Handshake {
                version: UI_PROTOCOL_VERSION,
                id: session_id.to_owned(),
                client: CLIENT_NAME.into(),
                capabilities: CONTROL_CAPABILITIES.map(str::to_owned).to_vec(),
            })?;
            let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
            let mut latest_snapshot = None;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(TuiError::HandshakeTimeout);
                }
                self.stream.set_read_timeout(Some(remaining))?;
                let messages = self.receive()?;
                let mut handshake_complete = false;
                for message in messages {
                    if handshake_complete {
                        remember_latest_snapshot(&mut latest_snapshot, message);
                        continue;
                    }
                    match message {
                        message @ UiMessage::Capabilities { .. } => {
                            validate_handshake_response(&message, session_id)?;
                            handshake_complete = true;
                        }
                        message @ UiMessage::RenderSnapshot { .. } => {
                            remember_latest_snapshot(&mut latest_snapshot, message)
                        }
                        UiMessage::Error { message, .. } => {
                            return Err(TuiError::Handshake(message));
                        }
                        other => {
                            return Err(TuiError::Handshake(format!(
                                "unexpected message during handshake: {other:?}"
                            )));
                        }
                    }
                }
                if handshake_complete {
                    self.stream.set_read_timeout(Some(SOCKET_READ_TIMEOUT))?;
                    return Ok(latest_snapshot);
                }
            }
        }
    }

    struct TerminalGuard {
        active: bool,
    }

    fn remember_latest_snapshot(slot: &mut Option<UiMessage>, message: UiMessage) {
        let UiMessage::RenderSnapshot { sequence, .. } = &message else {
            return;
        };
        let replace = slot.as_ref().is_none_or(|current| {
            matches!(current, UiMessage::RenderSnapshot { sequence: current_sequence, .. } if sequence > current_sequence)
        });
        if replace {
            *slot = Some(message);
        }
    }

    impl TerminalGuard {
        fn enter() -> Result<Self, TuiError> {
            let mut guard = Self { active: false };
            crossterm::terminal::enable_raw_mode()?;
            guard.active = true;
            let mut stdout = io::stdout();
            if let Err(error) = crossterm::execute!(
                stdout,
                crossterm::terminal::EnterAlternateScreen,
                crossterm::cursor::Hide
            ) {
                return Err(error.into());
            }
            Ok(guard)
        }
    }

    impl Drop for TerminalGuard {
        fn drop(&mut self) {
            if !self.active {
                return;
            }
            let mut stdout = io::stdout();
            let _ = crossterm::execute!(
                stdout,
                crossterm::terminal::LeaveAlternateScreen,
                crossterm::cursor::Show
            );
            let _ = crossterm::terminal::disable_raw_mode();
            self.active = false;
        }
    }

    pub(super) fn run(config: TuiConfig) -> Result<(), TuiError> {
        let mut connection = UiConnection::connect(&config.control_socket)?;
        let initial_message = connection.handshake(&config.session_id)?;
        let mut app = App::default();
        if let Some(message) = initial_message {
            app.apply_message(message);
        }

        let _terminal_guard = TerminalGuard::enter()?;
        let mut terminal = Terminal::new(ratatui::backend::CrosstermBackend::new(io::stdout()))?;
        let mut input_sequence = 0_u64;
        let mut message_sequence = 0_u64;
        send_terminal_size(&mut connection, &mut message_sequence)?;

        loop {
            terminal.draw(|frame| app.render(frame))?;

            if crossterm::event::poll(Duration::from_millis(10))? {
                if let Some(event) = read_input_event()? {
                    if should_quit(&event) {
                        send_shutdown(&mut connection, &mut message_sequence)?;
                        break;
                    }
                    app.apply_input(&event);
                    send_input(
                        &mut connection,
                        &mut input_sequence,
                        &mut message_sequence,
                        event,
                    )?;
                }
            }

            for message in connection.receive()? {
                if matches!(message, UiMessage::Shutdown { .. }) {
                    return Ok(());
                }
                app.apply_message(message);
            }
        }
        Ok(())
    }

    fn read_input_event() -> Result<Option<UiMessage>, TuiError> {
        let event = crossterm::event::read()?;
        Ok(match event {
            Event::Key(key) => key_event_to_input(key).map(|event| UiMessage::InputEvent {
                version: UI_PROTOCOL_VERSION,
                id: "input".into(),
                sequence: 0,
                event,
            }),
            Event::Paste(text) => Some(UiMessage::InputEvent {
                version: UI_PROTOCOL_VERSION,
                id: "input".into(),
                sequence: 0,
                event: UiInputEventKind::Paste { text },
            }),
            Event::Resize(columns, rows) if columns > 0 && rows > 0 => {
                Some(UiMessage::TerminalSize {
                    version: UI_PROTOCOL_VERSION,
                    id: "size".into(),
                    columns,
                    rows,
                })
            }
            _ => None,
        })
    }

    fn should_quit(message: &UiMessage) -> bool {
        matches!(
            message,
            UiMessage::InputEvent {
                event: UiInputEventKind::Key(UiKeyInput { key, modifiers }),
                ..
            } if key == "q" && modifiers.as_slice() == ["ctrl"]
        )
    }

    fn send_input(
        connection: &mut UiConnection,
        input_sequence: &mut u64,
        message_id_sequence: &mut u64,
        mut message: UiMessage,
    ) -> Result<(), TuiError> {
        match &mut message {
            UiMessage::InputEvent {
                id,
                sequence: event_sequence,
                ..
            } => {
                *input_sequence = input_sequence.saturating_add(1);
                *message_id_sequence = message_id_sequence.saturating_add(1);
                *id = format!("input-{message_id_sequence}");
                *event_sequence = *input_sequence;
            }
            UiMessage::TerminalSize { id, .. } => {
                *message_id_sequence = message_id_sequence.saturating_add(1);
                *id = format!("size-{message_id_sequence}");
            }
            _ => {}
        }
        connection.send(&message)?;
        Ok(())
    }

    fn send_terminal_size(
        connection: &mut UiConnection,
        message_id_sequence: &mut u64,
    ) -> Result<(), TuiError> {
        let size = crossterm::terminal::size()?;
        *message_id_sequence = message_id_sequence.saturating_add(1);
        connection.send(&UiMessage::TerminalSize {
            version: UI_PROTOCOL_VERSION,
            id: format!("size-{message_id_sequence}"),
            columns: size.0,
            rows: size.1,
        })
    }

    fn send_shutdown(
        connection: &mut UiConnection,
        message_id_sequence: &mut u64,
    ) -> Result<(), TuiError> {
        *message_id_sequence = message_id_sequence.saturating_add(1);
        connection.send(&UiMessage::Shutdown {
            version: UI_PROTOCOL_VERSION,
            id: format!("shutdown-{message_id_sequence}"),
            reason: Some("user_quit".into()),
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn q_is_not_a_quit_key_but_ctrl_q_is() {
            let normal_q = UiMessage::InputEvent {
                version: UI_PROTOCOL_VERSION,
                id: "input-1".into(),
                sequence: 1,
                event: UiInputEventKind::Key(UiKeyInput {
                    key: "q".into(),
                    modifiers: vec![],
                }),
            };
            let ctrl_q = UiMessage::InputEvent {
                version: UI_PROTOCOL_VERSION,
                id: "input-2".into(),
                sequence: 2,
                event: UiInputEventKind::Key(UiKeyInput {
                    key: "q".into(),
                    modifiers: vec!["ctrl".into()],
                }),
            };
            assert!(!should_quit(&normal_q));
            assert!(should_quit(&ctrl_q));
        }
    }
}

#[cfg(unix)]
pub fn run(config: TuiConfig) -> Result<(), TuiError> {
    unix_runtime::run(config)
}

#[cfg(not(unix))]
pub fn run(_config: TuiConfig) -> Result<(), TuiError> {
    Err(TuiError::UnsupportedPlatform)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn snapshot(sequence: u64) -> UiRenderSnapshot {
        UiRenderSnapshot {
            version: UI_PROTOCOL_VERSION,
            id: "snapshot".into(),
            sequence,
            status: mindcode_protocol::ui::UiStatusSnapshot {
                state: "running".into(),
                message: Some("working".into()),
                detail: None,
            },
            tasks: vec![mindcode_protocol::ui::UiTaskSnapshot {
                id: "task-1".into(),
                title: "compile".into(),
                status: "running".into(),
                detail: None,
                progress: Some(42),
            }],
            transcript: vec![mindcode_protocol::ui::UiTranscriptEntry {
                sequence: 1,
                role: "assistant".into(),
                text: "hello".into(),
            }],
        }
    }

    #[test]
    fn args_require_socket_and_session() {
        let result = parse_args([OsString::from("--control-socket")]);
        assert!(matches!(result, Err(TuiError::InvalidArguments(_))));
        let result = parse_args([
            OsString::from("--control-socket"),
            OsString::from("/tmp/ui.sock"),
            OsString::from("--session-id"),
            OsString::from("session-1"),
        ])
        .unwrap();
        assert_eq!(result.session_id, "session-1");
    }

    #[test]
    fn handshake_response_requires_exact_session_and_capabilities() {
        let response = UiMessage::Capabilities {
            version: UI_PROTOCOL_VERSION,
            id: "session-1".into(),
            capabilities: CONTROL_CAPABILITIES.map(str::to_owned).to_vec(),
        };
        assert!(validate_handshake_response(&response, "session-1").is_ok());

        let wrong_session = UiMessage::Capabilities {
            version: UI_PROTOCOL_VERSION,
            id: "session-2".into(),
            capabilities: CONTROL_CAPABILITIES.map(str::to_owned).to_vec(),
        };
        assert!(validate_handshake_response(&wrong_session, "session-1").is_err());

        let missing_capability = UiMessage::Capabilities {
            version: UI_PROTOCOL_VERSION,
            id: "session-1".into(),
            capabilities: vec!["render_snapshot".into(), "input".into()],
        };
        assert!(validate_handshake_response(&missing_capability, "session-1").is_err());
        assert!(validate_handshake_response(
            &UiMessage::Ack {
                version: UI_PROTOCOL_VERSION,
                id: "session-1".into(),
                sequence: 1,
            },
            "session-1",
        )
        .is_err());
    }

    #[test]
    fn app_replaces_only_with_latest_sequence() {
        let mut app = App::default();
        app.apply_message(UiMessage::RenderSnapshot {
            version: UI_PROTOCOL_VERSION,
            id: "one".into(),
            sequence: 2,
            status: snapshot(2).status,
            tasks: snapshot(2).tasks,
            transcript: snapshot(2).transcript,
        });
        app.apply_message(UiMessage::RenderSnapshot {
            version: UI_PROTOCOL_VERSION,
            id: "old".into(),
            sequence: 1,
            status: snapshot(1).status,
            tasks: snapshot(1).tasks,
            transcript: snapshot(1).transcript,
        });
        app.apply_message(UiMessage::RenderSnapshot {
            version: UI_PROTOCOL_VERSION,
            id: "duplicate".into(),
            sequence: 2,
            status: snapshot(2).status,
            tasks: snapshot(2).tasks,
            transcript: snapshot(2).transcript,
        });
        assert_eq!(app.latest_snapshot().unwrap().sequence, 2);
        assert_eq!(app.latest_snapshot().unwrap().id, "one");
    }

    #[test]
    fn app_does_not_retain_invalid_snapshot() {
        let mut app = App::default();
        app.apply_message(UiMessage::RenderSnapshot {
            version: UI_PROTOCOL_VERSION,
            id: "invalid".into(),
            sequence: 1,
            status: mindcode_protocol::ui::UiStatusSnapshot {
                state: String::new(),
                message: None,
                detail: None,
            },
            tasks: Vec::new(),
            transcript: Vec::new(),
        });
        assert!(app.latest_snapshot().is_none());
    }

    #[test]
    fn test_backend_renders_authoritative_snapshot() {
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let app = App {
            latest_snapshot: Some(snapshot(9)),
            input_buffer: String::new(),
        };
        terminal.draw(|frame| app.render(frame)).unwrap();
        let buffer = terminal.backend().buffer();
        let content: String = buffer
            .content()
            .iter()
            .map(|cell| cell.symbol().to_owned())
            .collect();
        assert!(content.contains("running — working"));
        assert!(content.contains("compile"));
        assert!(content.contains("assistant: hello"));
    }

    #[test]
    fn input_projection_is_visible_and_editable() {
        let mut app = App::default();
        app.apply_input(&UiMessage::InputEvent {
            version: UI_PROTOCOL_VERSION,
            id: "input-1".into(),
            sequence: 1,
            event: UiInputEventKind::Key(UiKeyInput {
                key: "q".into(),
                modifiers: vec![],
            }),
        });
        app.apply_input(&UiMessage::InputEvent {
            version: UI_PROTOCOL_VERSION,
            id: "input-2".into(),
            sequence: 2,
            event: UiInputEventKind::Key(UiKeyInput {
                key: "backspace".into(),
                modifiers: vec![],
            }),
        });
        app.apply_input(&UiMessage::InputEvent {
            version: UI_PROTOCOL_VERSION,
            id: "input-3".into(),
            sequence: 3,
            event: UiInputEventKind::Paste {
                text: "editable".into(),
            },
        });
        assert_eq!(app.input_buffer, "editable");

        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| app.render(frame)).unwrap();
        let content: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol().to_owned())
            .collect();
        assert!(content.contains("> editable"));
    }

    #[test]
    fn input_projection_is_utf8_safe_and_bounded() {
        let mut app = App::default();
        app.push_input(&"x".repeat(UI_MAX_INPUT_BYTES - 1));
        app.push_input("é");
        assert_eq!(app.input_buffer.len(), UI_MAX_INPUT_BYTES - 1);
        app.apply_input(&UiMessage::InputEvent {
            version: UI_PROTOCOL_VERSION,
            id: "submit".into(),
            sequence: 1,
            event: UiInputEventKind::Submit,
        });
        assert!(app.input_buffer.is_empty());
    }

    #[test]
    fn key_mapping_emits_control_messages() {
        assert_eq!(
            key_event_to_input(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(UiInputEventKind::Submit)
        );
        assert_eq!(
            key_event_to_input(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Some(UiInputEventKind::Interrupt)
        );
        assert_eq!(
            key_event_to_input(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE)),
            Some(UiInputEventKind::Key(UiKeyInput {
                key: "q".into(),
                modifiers: vec![],
            }))
        );
        assert!(key_event_to_input(KeyEvent {
            code: KeyCode::Char('a'),
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Release,
            state: crossterm::event::KeyEventState::NONE,
        })
        .is_none());
    }
}
