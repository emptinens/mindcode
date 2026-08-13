//! Ratatui renderer for the TypeScript-authoritative MindCode UI protocol.
//!
//! The renderer owns no durable session state.  It keeps one validated latest
//! snapshot and a small frame decoder while the dedicated control socket is
//! open.

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use mindcode_protocol::ui::{
    encode_ui_frame, UiActionInput, UiInputEventKind, UiKeyInput, UiMessage, UiRenderSnapshot,
    UI_MAX_FRAME_SIZE, UI_MAX_INPUT_BYTES, UI_PROTOCOL_VERSION,
};
use mindcode_protocol::ProtocolError;
use ratatui::layout::Rect;
use ratatui::{Frame, Terminal};

pub mod clipboard;
pub mod interaction;
pub mod preferences;
mod render;
pub mod ui;

use interaction::{LocalIntent, OverlayKind};
use preferences::Preferences;
use render::{NavigationView, OverlayView, PanelFocus, RenderState};
use ui::{
    calculate_layout_with_composer, AnimationActivity, AnimationScheduler, ColorMode, MotionMode,
    PaneRatios, Theme, ThemeKind,
};

const CLIENT_NAME: &str = "mindcode-tui";
const CONTROL_CAPABILITIES: [&str; 6] = [
    "render_snapshot",
    "input",
    "resize",
    "shutdown",
    "mouse",
    "action",
];
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
    let required_capabilities = CONTROL_CAPABILITIES
        .iter()
        .all(|expected| capabilities.iter().any(|actual| actual == expected));
    if !required_capabilities {
        return Err(TuiError::Handshake(
            "control response is missing required capabilities".into(),
        ));
    }
    Ok(())
}

/// Which field of the add-provider form currently has focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderFormField {
    Id,
    Name,
    Protocol,
    BaseUrl,
    CredentialEnv,
    Allowlist,
}

impl ProviderFormField {
    pub const ALL: [Self; 6] = [
        Self::Id,
        Self::Name,
        Self::Protocol,
        Self::BaseUrl,
        Self::CredentialEnv,
        Self::Allowlist,
    ];

    pub fn next(self) -> Self {
        let index = Self::ALL
            .iter()
            .position(|field| *field == self)
            .unwrap_or(0);
        Self::ALL[(index + 1) % Self::ALL.len()]
    }
}

/// Renderer-local state for the add-provider form.  The credential is only
/// ever an environment-variable *name*; a value never passes through here.
#[derive(Debug, Clone)]
pub struct ProviderForm {
    pub field: ProviderFormField,
    pub id: String,
    pub name: String,
    pub protocol: usize,
    pub base_url: String,
    pub credential_env: String,
    pub allowlist: String,
}

impl Default for ProviderForm {
    fn default() -> Self {
        Self {
            field: ProviderFormField::Id,
            id: String::new(),
            name: String::new(),
            protocol: 0,
            base_url: String::new(),
            credential_env: String::new(),
            allowlist: String::new(),
        }
    }
}

impl ProviderForm {
    pub const PROTOCOLS: [&'static str; 2] = ["openai-compatible", "anthropic-compatible"];

    pub fn protocol_name(&self) -> &'static str {
        Self::PROTOCOLS[self.protocol % Self::PROTOCOLS.len()]
    }

    pub fn cycle_protocol(&mut self) {
        self.protocol = (self.protocol + 1) % Self::PROTOCOLS.len();
    }

    fn field_value_mut(&mut self, field: ProviderFormField) -> &mut String {
        match field {
            ProviderFormField::Id => &mut self.id,
            ProviderFormField::Name => &mut self.name,
            ProviderFormField::BaseUrl => &mut self.base_url,
            ProviderFormField::CredentialEnv => &mut self.credential_env,
            ProviderFormField::Allowlist => &mut self.allowlist,
            // The protocol field is a fixed cycle, not free text.
            ProviderFormField::Protocol => &mut self.name,
        }
    }

    /// The JSON payload consumed by the native `provider_add` action handler.
    fn to_payload(&self) -> String {
        let allowlist = self
            .allowlist
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<_>>();
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "protocol": self.protocol_name(),
            "base_url": self.base_url,
            "credential_env": self.credential_env,
            "allowlist": allowlist,
        })
        .to_string()
    }
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

#[derive(Debug)]
pub struct App {
    latest_snapshot: Option<UiRenderSnapshot>,
    input_buffer: String,
    input_cursor: usize,
    preferred_column: Option<usize>,
    show_welcome: bool,
    active_view: NavigationView,
    focus: PanelFocus,
    overlay: OverlayView,
    focus_before_overlay: Option<PanelFocus>,
    theme: Theme,
    ratios: PaneRatios,
    motion: MotionMode,
    preferences: Preferences,
    preferences_path: Option<PathBuf>,
    workspace_id: String,
    terminal_size: (u16, u16),
    drag_target: Option<DragTarget>,
    pointer_press: Option<(u16, u16)>,
    last_mouse_scroll_at: Option<Instant>,
    suppress_input: bool,
    started_at: Instant,
    sidebar_visible: bool,
    transcript_scroll: usize,
    tasks_scroll: usize,
    changes_scroll: usize,
    selected_task: Option<usize>,
    selected_change: Option<usize>,
    provider_selection: usize,
    provider_form: Option<ProviderForm>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DragTarget {
    SidebarChat,
    ChatInspector,
}

impl Default for App {
    fn default() -> Self {
        Self::with_preferences(Preferences::default(), None)
    }
}

fn layout_without_sidebar(mut layout: ui::LayoutRects) -> ui::LayoutRects {
    if layout.sidebar.width == 0 {
        return layout;
    }
    let sidebar_width = layout.sidebar.width;
    layout.sidebar = Rect::new(layout.sidebar.x, layout.sidebar.y, 0, layout.sidebar.height);
    layout.chat = Rect::new(
        layout.sidebar.x,
        layout.chat.y,
        layout.chat.width.saturating_add(sidebar_width),
        layout.chat.height,
    );
    layout
}

impl App {
    /// Build a renderer with explicit presentation preferences.
    ///
    /// The path is kept separate from the preferences value so tests and
    /// embedders can supply an in-memory configuration without touching the
    /// user's filesystem.
    pub fn with_preferences(preferences: Preferences, preferences_path: Option<PathBuf>) -> Self {
        let color_mode = terminal_color_mode();
        let motion = preferences
            .motion_override
            .unwrap_or_else(default_motion_from_environment);
        let ratios = preferences.ratios_for("default");
        Self {
            latest_snapshot: None,
            input_buffer: String::new(),
            input_cursor: 0,
            preferred_column: None,
            // The TUI opens directly on the dashboard: the composer is the
            // main interface and there is no session/workspace backend behind
            // the legacy welcome screen.
            show_welcome: false,
            active_view: NavigationView::Chat,
            focus: PanelFocus::Composer,
            overlay: OverlayView::None,
            focus_before_overlay: None,
            theme: Theme::new(preferences.theme, color_mode),
            ratios,
            motion,
            preferences,
            preferences_path,
            workspace_id: "default".into(),
            terminal_size: (140, 45),
            drag_target: None,
            pointer_press: None,
            last_mouse_scroll_at: None,
            suppress_input: false,
            started_at: Instant::now(),
            // The native in-process shell has no session/workspace backend, so
            // the sidebar is pure dead weight: open chat-only by default and
            // keep Ctrl+B as an explicit opt-in.
            sidebar_visible: false,
            transcript_scroll: 0,
            tasks_scroll: 0,
            changes_scroll: 0,
            selected_task: None,
            selected_change: None,
            provider_selection: 0,
            provider_form: None,
        }
    }

    /// Load persisted presentation preferences for the native runtime.
    pub fn load_persisted() -> Self {
        let path = preferences_path();
        let preferences = path
            .as_ref()
            .and_then(|path| Preferences::load_or_default(path).ok())
            .unwrap_or_default();
        Self::with_preferences(preferences, path)
    }

    pub fn preferences(&self) -> &Preferences {
        &self.preferences
    }

    pub fn input_cursor(&self) -> usize {
        self.input_cursor
    }

    pub fn set_theme(&mut self, theme: ThemeKind) {
        self.preferences.theme = theme;
        self.theme = Theme::new(theme, terminal_color_mode());
        self.persist_preferences();
    }

    pub fn set_motion_override(&mut self, motion: Option<MotionMode>) {
        self.preferences.motion_override = motion;
        self.motion = motion.unwrap_or_else(default_motion_from_environment);
        self.persist_preferences();
    }

    fn persist_preferences(&mut self) {
        if self
            .preferences
            .set_pane_ratios(self.workspace_id.clone(), self.ratios)
            .is_err()
        {
            return;
        }
        let Some(path) = self.preferences_path.as_ref() else {
            return;
        };
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            if fs::create_dir_all(parent).is_err() {
                return;
            }
        }
        let _ = self.preferences.save(path);
    }

    fn set_overlay(&mut self, requested: OverlayView) {
        if requested == OverlayView::None {
            self.overlay = OverlayView::None;
            if let Some(focus) = self.focus_before_overlay.take() {
                self.focus = focus;
            }
            return;
        }
        if self.overlay == OverlayView::None {
            self.focus_before_overlay = Some(self.focus);
        }
        self.overlay = requested;
    }

    fn toggle_overlay(&mut self, requested: OverlayView) {
        if self.overlay == requested {
            self.set_overlay(OverlayView::None);
        } else {
            self.set_overlay(requested);
        }
    }

    fn return_to_dashboard(&mut self) {
        self.set_overlay(OverlayView::None);
        self.show_welcome = false;
        self.focus = PanelFocus::Content;
        self.drag_target = None;
        self.pointer_press = None;
    }

    fn open_providers(&mut self) {
        if self.overlay == OverlayView::None {
            self.set_overlay(OverlayView::Providers);
        }
        self.provider_form = None;
        self.clamp_provider_selection();
    }

    fn clamp_provider_selection(&mut self) {
        let len = self
            .latest_snapshot
            .as_ref()
            .map_or(0, |snapshot| snapshot.providers.len());
        self.provider_selection = if len == 0 {
            0
        } else {
            self.provider_selection.min(len - 1)
        };
    }

    fn select_workspace(&mut self, workspace: String) {
        if workspace == self.workspace_id {
            return;
        }
        self.workspace_id = workspace;
        self.ratios = self.preferences.ratios_for(&self.workspace_id);
    }

    fn update_workspace_from_snapshot(&mut self, snapshot: &UiRenderSnapshot) {
        if let Some(workspace) = active_workspace_key(snapshot) {
            self.select_workspace(workspace);
        }
    }

    pub fn latest_snapshot(&self) -> Option<&UiRenderSnapshot> {
        self.latest_snapshot.as_ref()
    }

    /// Replace the only retained render state when the TS sequence advances.
    pub fn apply_message(&mut self, message: UiMessage) -> bool {
        if !matches!(&message, UiMessage::RenderSnapshot { .. })
            || encode_ui_frame(&message).is_err()
        {
            return false;
        }
        if let UiMessage::RenderSnapshot {
            version,
            id,
            sequence,
            sessions,
            workspaces,
            active_session_id,
            status,
            telemetry,
            tasks,
            agents,
            transcript,
            transcript_window,
            changes,
            activity,
            permissions,
            providers,
            writer,
        } = message
        {
            let is_newer = self
                .latest_snapshot
                .as_ref()
                .is_none_or(|snapshot| sequence > snapshot.sequence);
            if is_newer {
                let snapshot = UiRenderSnapshot {
                    version,
                    id,
                    sequence,
                    sessions,
                    workspaces,
                    active_session_id,
                    status,
                    telemetry,
                    tasks,
                    agents,
                    transcript,
                    transcript_window,
                    changes,
                    activity,
                    permissions,
                    providers,
                    writer,
                };
                self.update_workspace_from_snapshot(&snapshot);
                if snapshot.telemetry.connection.state == "disconnected" {
                    self.set_overlay(OverlayView::Reconnect);
                } else {
                    if self.overlay == OverlayView::Reconnect {
                        self.set_overlay(OverlayView::None);
                    }
                    if snapshot
                        .permissions
                        .iter()
                        .any(|request| request.status == "pending")
                    {
                        if self.overlay == OverlayView::None {
                            self.set_overlay(OverlayView::Permission);
                        }
                    } else if self.overlay == OverlayView::Permission {
                        self.set_overlay(OverlayView::None);
                    }
                }
                self.selected_task = self
                    .selected_task
                    .filter(|index| *index < snapshot.tasks.len());
                self.selected_change = self
                    .selected_change
                    .filter(|index| *index < snapshot.changes.len());
                self.latest_snapshot = Some(snapshot);
                self.clamp_provider_selection();
                return true;
            }
        }
        false
    }

    pub fn render(&self, frame: &mut Frame<'_>) {
        let display_input = self.display_input();
        render::render(
            frame,
            &RenderState {
                snapshot: self.latest_snapshot.as_ref(),
                input: &display_input,
                show_welcome: self.show_welcome,
                active_view: self.active_view,
                focus: self.focus,
                overlay: self.overlay,
                theme: self.theme,
                ratios: self.ratios,
                motion: self.motion,
                elapsed: self.started_at.elapsed(),
                show_sidebar: self.sidebar_visible,
                transcript_scroll: self.transcript_scroll,
                tasks_scroll: self.tasks_scroll,
                changes_scroll: self.changes_scroll,
                selected_task: self.selected_task,
                selected_change: self.selected_change,
                provider_selection: self.provider_selection,
                provider_form: self.provider_form.as_ref(),
            },
        );
    }

    fn display_input(&self) -> String {
        if self.overlay != OverlayView::None
            || self.focus != PanelFocus::Composer
            || self.input_buffer.is_empty()
        {
            return self.input_buffer.clone();
        }
        let cursor = self.input_cursor.min(self.input_buffer.len());
        let cursor = (0..=cursor)
            .rev()
            .find(|offset| self.input_buffer.is_char_boundary(*offset))
            .unwrap_or(0);
        let mut display = String::with_capacity(self.input_buffer.len() + "▏".len());
        display.push_str(&self.input_buffer[..cursor]);
        display.push('▏');
        display.push_str(&self.input_buffer[cursor..]);
        display
    }

    fn animation_scheduler(&self) -> AnimationScheduler {
        let activity = if self.show_welcome
            || self
                .latest_snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.status.state == "working")
        {
            AnimationActivity::Active
        } else {
            AnimationActivity::Static
        };
        AnimationScheduler::with_activity(self.motion, activity)
    }

    fn apply_local_intents(&mut self, intents: &[LocalIntent]) -> bool {
        self.apply_local_intents_at(intents, Instant::now())
    }

    fn apply_local_intents_at(&mut self, intents: &[LocalIntent], _now: Instant) -> bool {
        let mut consumed = false;
        for intent in intents {
            match intent {
                LocalIntent::DismissWelcome | LocalIntent::Submit if self.show_welcome => {
                    self.show_welcome = false;
                    self.focus = PanelFocus::Composer;
                    self.input_cursor = self.input_buffer.len();
                    consumed = true;
                }
                LocalIntent::OpenCommandPalette => {
                    if self.overlay == OverlayView::None {
                        self.toggle_overlay(OverlayView::Palette);
                    }
                    consumed = true;
                }
                LocalIntent::OpenHelp => {
                    if self.overlay == OverlayView::None {
                        self.toggle_overlay(OverlayView::Help);
                    }
                    consumed = true;
                }
                LocalIntent::Cancel => {
                    if self.overlay != OverlayView::None {
                        self.set_overlay(OverlayView::None);
                        consumed = true;
                    }
                }
                LocalIntent::ToggleOverlay(kind) => {
                    let requested = match kind {
                        OverlayKind::CommandPalette => OverlayView::Palette,
                        OverlayKind::Help => OverlayView::Help,
                        OverlayKind::Inspector => OverlayView::Inspector,
                        OverlayKind::Activity => OverlayView::Activity,
                        OverlayKind::Sidebar => OverlayView::None,
                    };
                    if requested == OverlayView::None {
                        self.set_overlay(OverlayView::None);
                    } else if self.overlay == OverlayView::None || self.overlay == requested {
                        self.toggle_overlay(requested);
                    }
                    consumed = true;
                }
                LocalIntent::ToggleInspector => {
                    if self.overlay == OverlayView::None {
                        self.toggle_overlay(OverlayView::Inspector);
                    }
                    consumed = true;
                }
                LocalIntent::CycleFocus { reverse } => {
                    if self.overlay == OverlayView::None {
                        self.cycle_focus(*reverse);
                    }
                    consumed = true;
                }
                LocalIntent::InsertNewline => {
                    if self.overlay == OverlayView::None {
                        self.insert_input("\n");
                    }
                    consumed = true;
                }
                // Up/down in the composer are cursor movement rather than
                // transcript scrolling. Let the original key event reach
                // `apply_input`; page scrolling remains local.
                LocalIntent::Scroll {
                    target,
                    axis,
                    delta,
                } => {
                    let composer_cursor_move = self.focus == PanelFocus::Composer
                        && *target == interaction::ScrollTarget::Transcript
                        && delta.unsigned_abs() <= 1
                        && self.overlay == OverlayView::None;
                    if !composer_cursor_move
                        && self.overlay == OverlayView::None
                        && *axis == interaction::ScrollAxis::Vertical
                    {
                        self.scroll_by(*target, *delta);
                    }
                    if !composer_cursor_move {
                        consumed = true;
                    }
                }
                LocalIntent::MouseScroll {
                    target,
                    axis,
                    delta,
                } => {
                    if self.overlay == OverlayView::None
                        && *axis == interaction::ScrollAxis::Vertical
                    {
                        self.scroll_by(*target, *delta);
                    }
                    consumed = true;
                }
                LocalIntent::JumpToLatest { target } => {
                    if self.overlay == OverlayView::None {
                        self.jump_to_latest(*target);
                    }
                    consumed = true;
                }
                LocalIntent::ToggleSidebar => {
                    if self.overlay == OverlayView::None {
                        self.sidebar_visible = !self.sidebar_visible;
                        if !self.sidebar_visible && self.focus == PanelFocus::Sidebar {
                            self.focus = PanelFocus::Content;
                        }
                    }
                    consumed = true;
                }
                LocalIntent::Focus(target) => {
                    if self.overlay == OverlayView::None {
                        self.set_focus(panel_focus(*target));
                    }
                    consumed = true;
                }
                LocalIntent::FocusAt { column, row } => {
                    if self.overlay == OverlayView::None {
                        self.focus_at(*column, *row);
                    } else {
                        consumed = true;
                    }
                }
                LocalIntent::BeginDrag { column, row } => {
                    if self.overlay == OverlayView::None {
                        self.begin_drag(*column, *row);
                    } else {
                        consumed = true;
                    }
                }
                LocalIntent::Drag { column, row } => {
                    if self.overlay == OverlayView::None {
                        self.drag_to(*column, *row);
                    } else {
                        consumed = true;
                    }
                }
                LocalIntent::EndDrag { column, row } => {
                    if self.overlay == OverlayView::None {
                        if self.show_welcome && self.pointer_press == Some((*column, *row)) {
                            self.show_welcome = false;
                            self.focus = PanelFocus::Composer;
                            self.input_cursor = self.input_buffer.len();
                            self.pointer_press = None;
                            self.drag_target = None;
                        } else {
                            self.end_drag(*column, *row);
                        }
                    } else {
                        consumed = true;
                    }
                }
                LocalIntent::Resize { width, height } => {
                    self.terminal_size = (*width, *height);
                    self.drag_target = None;
                    self.pointer_press = None;
                }
                LocalIntent::Paste(_) => {
                    // apply_input performs the single local insertion and
                    // forwards the same event to the authoritative runtime.
                    if self.overlay != OverlayView::None {
                        consumed = true;
                    }
                }
                LocalIntent::Submit | LocalIntent::Interrupt | LocalIntent::DismissWelcome => {}
            }
        }
        consumed
    }

    /// Gate physical wheel events before they reach either local rendering or
    /// the TypeScript transcript boundary. Keyboard scrolling is never throttled.
    fn admit_mouse_scroll(&mut self, intents: &mut Vec<LocalIntent>, now: Instant) -> bool {
        if !intents
            .iter()
            .any(|intent| matches!(intent, LocalIntent::MouseScroll { .. }))
        {
            return true;
        }
        const MOUSE_SCROLL_THROTTLE: Duration = Duration::from_millis(80);
        if self
            .last_mouse_scroll_at
            .is_some_and(|previous| now.saturating_duration_since(previous) < MOUSE_SCROLL_THROTTLE)
        {
            intents.retain(|intent| !matches!(intent, LocalIntent::MouseScroll { .. }));
            return false;
        }
        self.last_mouse_scroll_at = Some(now);
        true
    }

    fn effective_scroll_target(
        &self,
        target: interaction::ScrollTarget,
    ) -> interaction::ScrollTarget {
        if target != interaction::ScrollTarget::Transcript {
            return target;
        }
        match self.active_view {
            NavigationView::Agents | NavigationView::Tasks => interaction::ScrollTarget::Tasks,
            NavigationView::Changes => interaction::ScrollTarget::Changes,
            NavigationView::Chat | NavigationView::Logs => target,
        }
    }

    fn scroll_by(&mut self, target: interaction::ScrollTarget, delta: i32) {
        let target = self.effective_scroll_target(target);
        let amount = delta.unsigned_abs() as usize;
        let scroll = match target {
            interaction::ScrollTarget::Transcript => &mut self.transcript_scroll,
            interaction::ScrollTarget::Tasks | interaction::ScrollTarget::Sidebar => {
                &mut self.tasks_scroll
            }
            interaction::ScrollTarget::Changes | interaction::ScrollTarget::Inspector => {
                &mut self.changes_scroll
            }
        };
        if delta < 0 {
            *scroll = scroll.saturating_add(amount);
        } else if delta > 0 {
            *scroll = scroll.saturating_sub(amount);
        }
    }

    fn jump_to_latest(&mut self, target: interaction::ScrollTarget) {
        match self.effective_scroll_target(target) {
            interaction::ScrollTarget::Transcript => self.transcript_scroll = 0,
            interaction::ScrollTarget::Tasks | interaction::ScrollTarget::Sidebar => {
                self.tasks_scroll = 0
            }
            interaction::ScrollTarget::Changes | interaction::ScrollTarget::Inspector => {
                self.changes_scroll = 0
            }
        }
    }

    fn transcript_page_action(&self, older: bool) -> bool {
        self.overlay == OverlayView::None
            && self.focus == PanelFocus::Content
            && matches!(
                self.active_view,
                NavigationView::Chat | NavigationView::Logs
            )
            && self.latest_snapshot.as_ref().is_some_and(|snapshot| {
                snapshot.transcript_window.as_ref().is_some_and(|window| {
                    if older {
                        window.has_older
                    } else {
                        window.has_newer
                    }
                })
            })
    }

    fn request_transcript_page(&mut self, older: bool, event: &mut UiInputEventKind) -> bool {
        if !self.transcript_page_action(older) {
            return false;
        }
        *event = UiInputEventKind::Action(mindcode_protocol::ui::UiActionInput {
            action: "transcript_page".into(),
            target: self
                .latest_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.active_session_id.clone()),
            value: Some(if older { "older" } else { "newer" }.into()),
        });
        self.suppress_input = true;
        true
    }

    fn contextualize_input(&mut self, message: &mut UiMessage) -> bool {
        self.suppress_input = false;
        let UiMessage::InputEvent { event, .. } = message else {
            return false;
        };
        let page_direction = match event {
            UiInputEventKind::Key(input)
                if input.modifiers.is_empty() && matches!(input.key.as_str(), "up" | "down") =>
            {
                Some(input.key == "up")
            }
            UiInputEventKind::Mouse(mouse) => match mouse.kind {
                mindcode_protocol::ui::UiMouseEventKind::ScrollUp => Some(true),
                mindcode_protocol::ui::UiMouseEventKind::ScrollDown => Some(false),
                _ => None,
            },
            _ => None,
        };
        if let Some(older) = page_direction {
            if self.transcript_page_action(older) {
                return self.request_transcript_page(older, event);
            }
        }
        match event {
            UiInputEventKind::Key(UiKeyInput { key, modifiers }) => {
                if exact_modifiers(modifiers, &["alt"])
                    && navigation_view_for_key(key).is_some()
                    && self.overlay == OverlayView::None
                {
                    self.active_view = navigation_view_for_key(key).expect("checked above");
                    self.focus = PanelFocus::Content;
                    self.suppress_input = true;
                    return true;
                }

                if exact_modifiers(modifiers, &["alt", "shift"])
                    && matches!(key.as_str(), "left" | "right")
                    && self.overlay == OverlayView::None
                {
                    let delta = if key == "left" { -2 } else { 2 };
                    self.resize_by_keyboard(delta);
                    self.suppress_input = true;
                    return true;
                }

                if self.overlay == OverlayView::Permission && modifiers.is_empty() {
                    let decision = match key.as_str() {
                        "o" => Some("once"),
                        "p" => Some("project"),
                        "d" => Some("deny"),
                        _ => None,
                    };
                    if let Some(decision) = decision {
                        let target = self.latest_snapshot.as_ref().and_then(|snapshot| {
                            snapshot
                                .permissions
                                .iter()
                                .find(|request| request.status == "pending")
                                .map(|request| request.id.clone())
                        });
                        *event = UiInputEventKind::Action(mindcode_protocol::ui::UiActionInput {
                            action: "permission_decision".into(),
                            target,
                            value: Some(decision.into()),
                        });
                        self.set_overlay(OverlayView::None);
                        return true;
                    }
                }

                if exact_modifiers(modifiers, &["ctrl"]) && key == "p" {
                    self.open_providers();
                    self.suppress_input = true;
                    return true;
                }

                if self.overlay == OverlayView::Providers {
                    self.suppress_input = true;
                    let key = key.clone();
                    let modifiers = modifiers.clone();
                    return if self.provider_form.is_some() {
                        self.handle_provider_form_key(&key, &modifiers, event)
                    } else {
                        self.handle_providers_list_key(&key, &modifiers, event)
                    };
                }

                if self.overlay != OverlayView::None {
                    // Every key not explicitly handled above belongs to the
                    // modal focus scope and must not leak into the session.
                    self.suppress_input = true;
                    return true;
                }

                if !modifiers.is_empty() {
                    return false;
                }

                if self.show_welcome && matches!(key.as_str(), "n" | "a" | "o") {
                    let action = match key.as_str() {
                        "n" => "new_session",
                        "a" => "attach_session",
                        _ => "open_workspace",
                    };
                    self.show_welcome = false;
                    self.focus = PanelFocus::Composer;
                    self.input_cursor = self.input_buffer.len();
                    *event = UiInputEventKind::Action(mindcode_protocol::ui::UiActionInput {
                        action: action.into(),
                        target: None,
                        value: None,
                    });
                    return true;
                }

                let observer = self
                    .latest_snapshot
                    .as_ref()
                    .is_some_and(|snapshot| snapshot.writer.mode == "observer");
                if observer && key == "r" {
                    *event = UiInputEventKind::Action(mindcode_protocol::ui::UiActionInput {
                        action: "request_control".into(),
                        target: self
                            .latest_snapshot
                            .as_ref()
                            .and_then(|snapshot| snapshot.active_session_id.clone()),
                        value: None,
                    });
                    return true;
                }
                false
            }
            UiInputEventKind::Mouse(_) => false,
            UiInputEventKind::Submit if self.overlay == OverlayView::Providers => {
                self.handle_provider_submit(event);
                self.suppress_input = true;
                true
            }
            UiInputEventKind::Submit if self.overlay == OverlayView::None && !self.show_welcome => {
                // The composer is the main interface: hand the typed buffer to
                // the control server as a `composer_submit` action so it can be
                // routed to a slash command or a live chat turn.
                let text = std::mem::take(&mut self.input_buffer);
                self.input_cursor = 0;
                self.preferred_column = None;
                if !text.trim().is_empty() {
                    *event = UiInputEventKind::Action(provider_action(
                        "composer_submit",
                        None,
                        Some(text),
                    ));
                }
                true
            }
            UiInputEventKind::Cancel
                if self.overlay == OverlayView::Providers && self.provider_form.is_some() =>
            {
                self.provider_form = None;
                self.suppress_input = true;
                true
            }
            _ if self.overlay != OverlayView::None => {
                self.suppress_input = true;
                true
            }
            _ => false,
        }
    }

    fn selected_provider_id(&self) -> Option<String> {
        self.latest_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.providers.get(self.provider_selection))
            .map(|provider| provider.id.clone())
    }

    /// Provider-list overlay keys: navigate, switch, remove, or open the add
    /// form.  Every key is consumed locally; the active provider id is carried
    /// only as an action target, never as a credential.
    fn handle_providers_list_key(
        &mut self,
        key: &str,
        modifiers: &[String],
        event: &mut UiInputEventKind,
    ) -> bool {
        if !modifiers.is_empty() {
            return true;
        }
        let len = self
            .latest_snapshot
            .as_ref()
            .map_or(0, |snapshot| snapshot.providers.len());
        match key {
            "up" => {
                self.provider_selection = self.provider_selection.saturating_sub(1);
            }
            "down" if len > 0 => {
                self.provider_selection = (self.provider_selection + 1).min(len - 1);
            }
            "a" => {
                self.provider_form = Some(ProviderForm::default());
            }
            "d" => {
                if let Some(id) = self.selected_provider_id() {
                    *event = UiInputEventKind::Action(provider_action(
                        "provider_remove",
                        Some(id),
                        None,
                    ));
                }
            }
            _ => {}
        }
        true
    }

    /// Add-provider form keys: text entry, backspace, and protocol cycling.
    fn handle_provider_form_key(
        &mut self,
        key: &str,
        modifiers: &[String],
        _event: &mut UiInputEventKind,
    ) -> bool {
        if !modifiers.is_empty() {
            return true;
        }
        match key {
            "backspace" => {
                if let Some(form) = &mut self.provider_form {
                    if form.field != ProviderFormField::Protocol {
                        form.field_value_mut(form.field).pop();
                    }
                }
            }
            "tab" | "back_tab" | "left" | "right" | "up" | "down" | " " => {
                if let Some(form) = &mut self.provider_form {
                    if form.field == ProviderFormField::Protocol {
                        form.cycle_protocol();
                    } else if matches!(key, "tab" | "back_tab") {
                        form.field = form.field.next();
                    }
                }
            }
            key if key.chars().count() == 1 => {
                if let Some(form) = &mut self.provider_form {
                    if form.field != ProviderFormField::Protocol {
                        let character = key.chars().next().expect("single-char key");
                        let value = form.field_value_mut(form.field);
                        if value.len().saturating_add(character.len_utf8()) <= UI_MAX_INPUT_BYTES {
                            value.push_str(key);
                        }
                    }
                }
            }
            _ => {}
        }
        true
    }

    /// Submit in the providers overlay: advance the add form, emit the final
    /// `provider_add`, or switch to the selected provider.
    fn handle_provider_submit(&mut self, event: &mut UiInputEventKind) {
        if let Some(form) = &mut self.provider_form {
            if form.field == ProviderFormField::Allowlist {
                let payload = form.to_payload();
                self.provider_form = None;
                *event =
                    UiInputEventKind::Action(provider_action("provider_add", None, Some(payload)));
            } else {
                form.field = form.field.next();
            }
        } else if let Some(id) = self.selected_provider_id() {
            *event = UiInputEventKind::Action(provider_action("provider_switch", Some(id), None));
        }
    }

    fn apply_input(&mut self, message: &UiMessage) {
        let UiMessage::InputEvent { event, .. } = message else {
            return;
        };
        match event {
            UiInputEventKind::Key(input)
                if input.key == "backspace" && input.modifiers.is_empty() =>
            {
                self.remove_previous_char();
            }
            UiInputEventKind::Key(input) if input.key == "delete" && input.modifiers.is_empty() => {
                self.delete_char();
            }
            UiInputEventKind::Key(input) if input.key == "left" && input.modifiers.is_empty() => {
                self.move_horizontal(-1);
            }
            UiInputEventKind::Key(input) if input.key == "right" && input.modifiers.is_empty() => {
                self.move_horizontal(1);
            }
            UiInputEventKind::Key(input) if input.key == "home" && input.modifiers.is_empty() => {
                self.move_home();
            }
            UiInputEventKind::Key(input) if input.key == "end" && input.modifiers.is_empty() => {
                self.move_end();
            }
            UiInputEventKind::Key(input) if input.key == "up" && input.modifiers.is_empty() => {
                self.move_vertical(-1);
            }
            UiInputEventKind::Key(input) if input.key == "down" && input.modifiers.is_empty() => {
                self.move_vertical(1);
            }
            UiInputEventKind::Key(input)
                if input.modifiers.iter().all(|modifier| modifier == "shift")
                    && input.key.chars().count() == 1
                    && !input.key.chars().next().is_some_and(char::is_control) =>
            {
                self.insert_input(&input.key);
            }
            UiInputEventKind::Paste { text } | UiInputEventKind::Text { text } => {
                self.insert_input(text);
            }
            UiInputEventKind::Submit | UiInputEventKind::Cancel => {
                self.input_buffer.clear();
                self.input_cursor = 0;
                self.preferred_column = None;
            }
            UiInputEventKind::Key(_)
            | UiInputEventKind::Mouse(_)
            | UiInputEventKind::Action(_)
            | UiInputEventKind::Interrupt => {}
        }
    }

    pub fn push_input(&mut self, value: &str) {
        self.input_cursor = self.input_buffer.len();
        self.insert_input(value);
    }

    fn insert_input(&mut self, value: &str) {
        self.clamp_cursor();
        for character in value.chars() {
            let length = character.len_utf8();
            if self.input_buffer.len().saturating_add(length) > UI_MAX_INPUT_BYTES {
                break;
            }
            self.input_buffer.insert(self.input_cursor, character);
            self.input_cursor += length;
        }
        self.preferred_column = None;
    }

    fn clamp_cursor(&mut self) {
        self.input_cursor = self.input_cursor.min(self.input_buffer.len());
        while self.input_cursor > 0 && !self.input_buffer.is_char_boundary(self.input_cursor) {
            self.input_cursor -= 1;
        }
    }

    fn remove_previous_char(&mut self) {
        self.clamp_cursor();
        if self.input_cursor == 0 {
            return;
        }
        let previous = self.input_buffer[..self.input_cursor]
            .char_indices()
            .next_back()
            .map_or(0, |(index, _)| index);
        self.input_buffer.drain(previous..self.input_cursor);
        self.input_cursor = previous;
        self.preferred_column = None;
    }

    fn delete_char(&mut self) {
        self.clamp_cursor();
        let Some(character) = self.input_buffer[self.input_cursor..].chars().next() else {
            return;
        };
        let end = self.input_cursor + character.len_utf8();
        self.input_buffer.drain(self.input_cursor..end);
        self.preferred_column = None;
    }

    fn move_horizontal(&mut self, direction: i8) {
        self.clamp_cursor();
        if direction < 0 {
            self.input_cursor = self.input_buffer[..self.input_cursor]
                .char_indices()
                .next_back()
                .map_or(0, |(index, _)| index);
        } else if let Some(character) = self.input_buffer[self.input_cursor..].chars().next() {
            self.input_cursor += character.len_utf8();
        }
        self.preferred_column = None;
    }

    fn move_home(&mut self) {
        self.clamp_cursor();
        self.input_cursor = self.line_bounds().0;
        self.preferred_column = None;
    }

    fn move_end(&mut self) {
        self.clamp_cursor();
        self.input_cursor = self.line_bounds().1;
        self.preferred_column = None;
    }

    fn move_vertical(&mut self, direction: i8) {
        self.clamp_cursor();
        let (line_start, line_end) = self.line_bounds();
        let column = self.input_buffer[line_start..self.input_cursor]
            .chars()
            .count();
        let desired_column = self.preferred_column.unwrap_or(column);
        let (target_start, target_end) = if direction < 0 {
            if line_start == 0 {
                return;
            }
            let previous_end = line_start - 1;
            let previous_start = self.input_buffer[..previous_end]
                .rfind('\n')
                .map_or(0, |index| index + 1);
            (previous_start, previous_end)
        } else {
            if line_end >= self.input_buffer.len() {
                return;
            }
            let target_start = line_end + 1;
            let target_end = self.input_buffer[target_start..]
                .find('\n')
                .map_or(self.input_buffer.len(), |index| target_start + index);
            (target_start, target_end)
        };
        let target_column =
            desired_column.min(self.input_buffer[target_start..target_end].chars().count());
        self.input_cursor = self.input_buffer[target_start..target_end]
            .char_indices()
            .nth(target_column)
            .map_or(target_end, |(index, _)| target_start + index);
        self.preferred_column = Some(desired_column);
    }

    fn line_bounds(&self) -> (usize, usize) {
        let cursor = self.input_cursor.min(self.input_buffer.len());
        let start = self.input_buffer[..cursor]
            .rfind('\n')
            .map_or(0, |index| index + 1);
        let end = self.input_buffer[cursor..]
            .find('\n')
            .map_or(self.input_buffer.len(), |index| cursor + index);
        (start, end)
    }
}

impl App {
    fn interaction_layout(&self) -> ui::LayoutRects {
        let composer_rows = self
            .input_buffer
            .lines()
            .count()
            .max(1)
            .saturating_add(2)
            .clamp(2, 8) as u16;
        let layout = calculate_layout_with_composer(
            Rect::new(0, 0, self.terminal_size.0, self.terminal_size.1),
            self.ratios,
            composer_rows,
        );
        if self.sidebar_visible {
            layout
        } else {
            layout_without_sidebar(layout)
        }
    }

    fn focus_order(&self) -> Vec<PanelFocus> {
        let layout = self.interaction_layout();
        let mut order = Vec::with_capacity(4);
        if layout.sidebar.width > 0 {
            order.push(PanelFocus::Sidebar);
        }
        if layout.chat.width > 0 {
            order.push(PanelFocus::Content);
        }
        if layout.inspector_is_pane() && layout.inspector.width > 0 {
            order.push(PanelFocus::Inspector);
        }
        if layout.composer.height > 0 {
            order.push(PanelFocus::Composer);
        }
        if order.is_empty() {
            order.push(PanelFocus::Content);
        }
        order
    }

    fn set_focus(&mut self, requested: PanelFocus) {
        if self.overlay == OverlayView::None && self.focus_order().contains(&requested) {
            self.focus = requested;
        }
    }

    fn cycle_focus(&mut self, reverse: bool) {
        let order = self.focus_order();
        let index = order.iter().position(|focus| *focus == self.focus);
        let index = index.unwrap_or(0);
        let next = if reverse {
            (index + order.len() - 1) % order.len()
        } else {
            (index + 1) % order.len()
        };
        self.focus = order[next];
    }

    fn focus_at(&mut self, column: u16, row: u16) {
        let layout = self.interaction_layout();
        if rect_contains(layout.sidebar, column, row) {
            self.set_focus(PanelFocus::Sidebar);
            self.select_view_from_sidebar(row, layout.sidebar);
        } else if rect_contains(layout.inspector, column, row) {
            self.set_focus(PanelFocus::Inspector);
        } else if rect_contains(layout.composer, column, row) {
            self.set_focus(PanelFocus::Composer);
            self.input_cursor = self.input_buffer.len();
        } else if rect_contains(layout.chat, column, row) {
            self.set_focus(PanelFocus::Content);
            self.select_content_item(row, column, layout.chat);
        }
    }

    fn select_content_item(&mut self, row: u16, column: u16, content: Rect) {
        let Some(snapshot) = self.latest_snapshot.as_ref() else {
            return;
        };
        let inner = Rect::new(
            content.x.saturating_add(1),
            content.y.saturating_add(1),
            content.width.saturating_sub(2),
            content.height.saturating_sub(2),
        );
        if !rect_contains(inner, column, row) {
            return;
        }
        let row_index = row.saturating_sub(inner.y) as usize;
        match self.active_view {
            NavigationView::Agents | NavigationView::Tasks => {
                let target_row = row_index.saturating_add(self.tasks_scroll);
                let mut rendered_row = 1_usize; // Leader occupies row zero.
                for (task_index, task) in snapshot.tasks.iter().enumerate() {
                    if target_row == rendered_row {
                        self.selected_task = Some(task_index);
                        return;
                    }
                    rendered_row = rendered_row.saturating_add(1);
                    let agent_count = snapshot
                        .agents
                        .iter()
                        .filter(|agent| agent.task_id.as_deref() == Some(task.id.as_str()))
                        .count();
                    if target_row < rendered_row.saturating_add(agent_count) {
                        self.selected_task = Some(task_index);
                        return;
                    }
                    rendered_row = rendered_row.saturating_add(agent_count);
                }
            }
            NavigationView::Changes => {
                let files_width = inner.width.saturating_mul(34) / 100;
                if column < inner.x.saturating_add(files_width) {
                    let change_index = row_index.saturating_add(self.changes_scroll);
                    if change_index < snapshot.changes.len() {
                        self.selected_change = Some(change_index);
                    }
                }
            }
            NavigationView::Chat | NavigationView::Logs => {}
        }
    }

    fn select_view_from_sidebar(&mut self, row: u16, sidebar: Rect) {
        if sidebar.width == 0 {
            return;
        }
        let index = row.saturating_sub(sidebar.y.saturating_add(1)) as usize;
        let breakpoint = ui::Breakpoint::for_width(self.terminal_size.0);
        let navigation_index = match breakpoint {
            ui::Breakpoint::Compact => Some(index),
            ui::Breakpoint::Medium | ui::Breakpoint::Wide => {
                let session_lines = self
                    .latest_snapshot
                    .as_ref()
                    .map(|snapshot| {
                        let mut lines = 0_usize;
                        let mut last_workspace = None::<&str>;
                        for session in snapshot.sessions.iter().take(9) {
                            if last_workspace != Some(session.workspace.as_str()) {
                                lines += 1;
                                last_workspace = Some(session.workspace.as_str());
                            }
                            lines += 1;
                        }
                        if lines == 0 {
                            1 // "No sessions"
                        } else {
                            lines
                        }
                    })
                    .unwrap_or(1);
                index.checked_sub(session_lines.saturating_add(1)) // NAVIGATION heading
            }
            ui::Breakpoint::Narrow => None,
        };
        if let Some(index) = navigation_index.filter(|index| *index < NavigationView::ALL.len()) {
            self.active_view = NavigationView::ALL[index];
        }
    }

    fn begin_drag(&mut self, column: u16, row: u16) {
        let layout = self.interaction_layout();
        self.drag_target =
            if layout.sidebar.width > 0 && near_boundary(column, layout.sidebar.right()) {
                Some(DragTarget::SidebarChat)
            } else if layout.inspector_is_pane() && near_boundary(column, layout.chat.right()) {
                Some(DragTarget::ChatInspector)
            } else {
                None
            };
        // A press in a panel is deliberately inert. It becomes a click only if
        // the left-button release returns to this exact terminal cell. A press
        // on a divider has no click target and may resize only that divider.
        self.pointer_press = self.drag_target.is_none().then_some((column, row));
    }

    fn drag_to(&mut self, column: u16, _row: u16) {
        if let Some(target) = self.drag_target {
            self.resize_at(target, column);
        }
    }

    fn end_drag(&mut self, column: u16, row: u16) {
        if self.drag_target.is_some() {
            self.drag_to(column, row);
            self.persist_preferences();
        } else if self.pointer_press.take() == Some((column, row)) {
            self.focus_at(column, row);
        }
        self.drag_target = None;
        self.pointer_press = None;
    }

    fn resize_by_keyboard(&mut self, delta: i16) {
        let layout = self.interaction_layout();
        let target = match self.focus {
            PanelFocus::Sidebar => DragTarget::SidebarChat,
            PanelFocus::Inspector => DragTarget::ChatInspector,
            PanelFocus::Content | PanelFocus::Composer => {
                if layout.inspector_is_pane() {
                    DragTarget::ChatInspector
                } else {
                    DragTarget::SidebarChat
                }
            }
        };
        let boundary = match target {
            DragTarget::SidebarChat if layout.sidebar.width > 0 => layout.sidebar.right(),
            DragTarget::ChatInspector if layout.inspector_is_pane() => layout.chat.right(),
            _ => return,
        };
        let next = if delta < 0 {
            boundary.saturating_sub(delta.unsigned_abs())
        } else {
            boundary.saturating_add(delta as u16)
        };
        if self.resize_at(target, next) {
            self.persist_preferences();
        }
    }

    fn resize_at(&mut self, target: DragTarget, column: u16) -> bool {
        let layout = self.interaction_layout();
        let visible_widths = [
            layout.sidebar.width,
            layout.chat.width,
            layout.inspector.width,
        ];
        let content_left = visible_widths
            .iter()
            .enumerate()
            .find(|(_, width)| **width > 0)
            .map_or(0, |(index, _)| match index {
                0 => layout.sidebar.x,
                1 => layout.chat.x,
                _ => layout.inspector.x,
            });
        let content_width: u16 = visible_widths.into_iter().sum();
        if content_width == 0 {
            return false;
        }
        let minimum = (content_width / 3).clamp(1, 12);
        let current = [self.ratios.sidebar, self.ratios.chat, self.ratios.inspector];
        let mut widths = visible_widths;
        let local_column = column.saturating_sub(content_left).min(content_width);

        match target {
            DragTarget::SidebarChat if widths[0] > 0 => {
                let max_sidebar = content_width.saturating_sub(minimum.saturating_mul(2));
                widths[0] = local_column.clamp(minimum.min(max_sidebar), max_sidebar.max(minimum));
                let remaining = content_width.saturating_sub(widths[0]);
                if widths[2] > 0 {
                    let others = u32::from(current[1].max(1) + current[2].max(1));
                    let chat =
                        (u32::from(remaining) * u32::from(current[1].max(1)) / others) as u16;
                    widths[1] =
                        chat.clamp(minimum.min(remaining), remaining.saturating_sub(minimum));
                    widths[2] = remaining.saturating_sub(widths[1]);
                } else {
                    widths[1] = remaining;
                }
            }
            DragTarget::ChatInspector if widths[2] > 0 => {
                let sidebar = widths[0];
                let remaining = content_width.saturating_sub(sidebar);
                let chat_column = local_column.saturating_sub(sidebar);
                let max_chat = remaining.saturating_sub(minimum);
                widths[1] = chat_column.clamp(minimum.min(max_chat), max_chat.max(minimum));
                widths[2] = remaining.saturating_sub(widths[1]);
            }
            _ => return false,
        }

        // Medium/compact layouts hide the inspector. Keep its persisted
        // weight intact while resizing visible panes so returning to a wide
        // terminal does not collapse the inspector to a one-unit sliver.
        if visible_widths[2] == 0 {
            widths[2] = current[2].max(1);
        }

        let next = PaneRatios::new(widths[0].max(1), widths[1].max(1), widths[2].max(1));
        if next == self.ratios {
            return false;
        }
        self.ratios = next;
        true
    }
}

pub fn render_snapshot(frame: &mut Frame<'_>, snapshot: Option<&UiRenderSnapshot>) {
    render::render(
        frame,
        &RenderState {
            snapshot,
            input: "",
            show_welcome: false,
            active_view: NavigationView::Chat,
            focus: PanelFocus::Content,
            overlay: OverlayView::None,
            theme: Theme::default(),
            ratios: PaneRatios::DEFAULT,
            motion: MotionMode::Reduced,
            elapsed: Duration::ZERO,
            show_sidebar: true,
            transcript_scroll: 0,
            tasks_scroll: 0,
            changes_scroll: 0,
            selected_task: None,
            selected_change: None,
            provider_selection: 0,
            provider_form: None,
        },
    );
}

fn terminal_color_mode() -> ColorMode {
    let colorterm = std::env::var("COLORTERM")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let term = std::env::var("TERM")
        .unwrap_or_default()
        .to_ascii_lowercase();
    ColorMode::from_capabilities(
        colorterm.contains("truecolor") || colorterm.contains("24bit"),
        term.contains("256color"),
    )
}

fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

fn default_motion_from_environment() -> MotionMode {
    if env_flag("MINDCODE_REDUCED_MOTION") || env_flag("REDUCE_MOTION") {
        MotionMode::Reduced
    } else {
        MotionMode::Full
    }
}

fn preferences_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("MINDCODE_PREFERENCES_PATH") {
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    let base = std::env::var_os("MINDCODE_CONFIG_HOME")
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME"))
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").into())
        })?;
    Some(PathBuf::from(base).join("mindcode").join("preferences.bin"))
}

fn active_workspace_key(snapshot: &UiRenderSnapshot) -> Option<String> {
    let value = snapshot
        .active_session_id
        .as_ref()
        .and_then(|id| snapshot.sessions.iter().find(|session| &session.id == id))
        .or_else(|| snapshot.sessions.iter().find(|session| session.active))
        .map(|session| session.workspace.as_str())
        .or_else(|| {
            snapshot
                .workspaces
                .iter()
                .find(|workspace| workspace.active)
                .map(|workspace| workspace.path.as_str())
        })?;
    let valid = !value.is_empty()
        && value.len() <= preferences::MAX_WORKSPACE_ID_BYTES
        && !value.chars().any(char::is_control);
    valid.then(|| value.to_owned())
}

fn exact_modifiers(actual: &[String], expected: &[&str]) -> bool {
    actual.len() == expected.len()
        && expected.iter().all(|modifier| {
            actual
                .iter()
                .any(|actual_modifier| actual_modifier == modifier)
        })
}

fn navigation_view_for_key(key: &str) -> Option<NavigationView> {
    match key {
        "1" => Some(NavigationView::Chat),
        "2" => Some(NavigationView::Agents),
        "3" => Some(NavigationView::Tasks),
        "4" => Some(NavigationView::Changes),
        "5" => Some(NavigationView::Logs),
        _ => None,
    }
}

fn panel_focus(target: interaction::FocusTarget) -> PanelFocus {
    match target {
        interaction::FocusTarget::Sidebar => PanelFocus::Sidebar,
        interaction::FocusTarget::Inspector => PanelFocus::Inspector,
        interaction::FocusTarget::Composer => PanelFocus::Composer,
        interaction::FocusTarget::Chat
        | interaction::FocusTarget::Footer
        | interaction::FocusTarget::CommandPalette
        | interaction::FocusTarget::Help => PanelFocus::Content,
    }
}

fn transport_passthrough(app: &App, message: &UiMessage) -> bool {
    matches!(message, UiMessage::TerminalSize { .. })
        || (app.overlay == OverlayView::None
            && matches!(
                message,
                UiMessage::InputEvent {
                    event: UiInputEventKind::Mouse(_),
                    ..
                }
            ))
        || matches!(
            message,
            UiMessage::InputEvent {
                event: UiInputEventKind::Action(action),
                ..
            } if action.action == "transcript_page"
        )
        || matches!(
            message,
            UiMessage::InputEvent {
                event: UiInputEventKind::Action(action),
                ..
            } if app.overlay == OverlayView::Providers
                && matches!(
                    action.action.as_str(),
                    "provider_switch" | "provider_remove" | "provider_add"
                )
        )
}

fn provider_action(action: &str, target: Option<String>, value: Option<String>) -> UiActionInput {
    UiActionInput {
        action: action.to_owned(),
        target,
        value,
    }
}

fn rect_contains(rect: Rect, column: u16, row: u16) -> bool {
    rect.width > 0
        && rect.height > 0
        && column >= rect.x
        && column < rect.right()
        && row >= rect.y
        && row < rect.bottom()
}

fn near_boundary(value: u16, boundary: u16) -> bool {
    value.abs_diff(boundary) <= 1
}

pub fn key_event_to_input(event: KeyEvent) -> Option<UiInputEventKind> {
    if event.kind == KeyEventKind::Release {
        return None;
    }
    if event.code == KeyCode::Char('c') && event.modifiers.contains(KeyModifiers::CONTROL) {
        return Some(UiInputEventKind::Interrupt);
    }
    if (event.code == KeyCode::Enter && event.modifiers.contains(KeyModifiers::SHIFT))
        || (event.code == KeyCode::Char('j') && event.modifiers.contains(KeyModifiers::CONTROL))
    {
        return Some(UiInputEventKind::Text { text: "\n".into() });
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
                crossterm::cursor::Hide,
                crossterm::event::EnableMouseCapture,
                crossterm::event::EnableBracketedPaste,
                crossterm::event::EnableFocusChange
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
                crossterm::event::DisableFocusChange,
                crossterm::event::DisableBracketedPaste,
                crossterm::event::DisableMouseCapture,
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
        let mut app = App::load_persisted();
        if let Some(message) = initial_message {
            app.apply_message(message);
        }

        let _terminal_guard = TerminalGuard::enter()?;
        let mut terminal = Terminal::new(ratatui::backend::CrosstermBackend::new(io::stdout()))?;
        if let Ok(size) = crossterm::terminal::size() {
            app.terminal_size = size;
        }
        let mut input_sequence = 0_u64;
        let mut message_sequence = 0_u64;
        if send_terminal_size(&mut connection, &mut message_sequence).is_err() {
            let Some(reconnected) =
                reconnect_connection(&config, &mut app, &mut terminal, &mut message_sequence)?
            else {
                return Ok(());
            };
            connection = reconnected;
        }
        let mut needs_redraw = true;
        let mut last_draw = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);

        loop {
            let schedule = app.animation_scheduler().schedule();
            let animation_due = schedule
                .interval()
                .is_some_and(|interval| last_draw.elapsed() >= interval);
            if needs_redraw || animation_due {
                terminal.autoresize()?;
                terminal.draw(|frame| app.render(frame))?;
                last_draw = Instant::now();
                needs_redraw = false;
            }

            let poll_interval = schedule
                .interval()
                .map(|interval| interval.saturating_sub(last_draw.elapsed()))
                .unwrap_or(SOCKET_READ_TIMEOUT)
                .min(SOCKET_READ_TIMEOUT);
            if crossterm::event::poll(poll_interval)? {
                let mut captured = read_input_event()?;
                let accepted_mouse_scroll =
                    app.admit_mouse_scroll(&mut captured.intents, Instant::now());
                if !accepted_mouse_scroll && is_mouse_wheel_message(captured.message.as_ref()) {
                    captured.message = None;
                }
                if let Some(message) = captured.message.as_mut() {
                    needs_redraw |= app.contextualize_input(message);
                }
                let suppressed = app.suppress_input;
                app.suppress_input = false;
                let local_consumed = app.apply_local_intents(&captured.intents) || suppressed;
                let passthrough = captured
                    .message
                    .as_ref()
                    .is_some_and(|message| transport_passthrough(&app, message));
                let consumed = local_consumed && !passthrough;
                if !captured.intents.is_empty() {
                    needs_redraw = true;
                }
                if let Some(event) = captured.message {
                    if should_quit(&event) {
                        send_shutdown(&mut connection, &mut message_sequence)?;
                        break;
                    }
                    if !consumed {
                        app.apply_input(&event);
                        if send_input(
                            &mut connection,
                            &mut input_sequence,
                            &mut message_sequence,
                            event,
                        )
                        .is_err()
                        {
                            needs_redraw = true;
                            let Some(reconnected) = reconnect_connection(
                                &config,
                                &mut app,
                                &mut terminal,
                                &mut message_sequence,
                            )?
                            else {
                                return Ok(());
                            };
                            connection = reconnected;
                            continue;
                        }
                    }
                }
            }

            let messages = match connection.receive() {
                Ok(messages) => messages,
                Err(_) => {
                    needs_redraw = true;
                    let Some(reconnected) = reconnect_connection(
                        &config,
                        &mut app,
                        &mut terminal,
                        &mut message_sequence,
                    )?
                    else {
                        return Ok(());
                    };
                    connection = reconnected;
                    continue;
                }
            };
            for message in messages {
                if matches!(message, UiMessage::Shutdown { .. }) {
                    return Ok(());
                }
                needs_redraw |= app.apply_message(message);
            }
        }
        Ok(())
    }

    fn reconnect_connection(
        config: &TuiConfig,
        app: &mut App,
        terminal: &mut Terminal<ratatui::backend::CrosstermBackend<io::Stdout>>,
        message_sequence: &mut u64,
    ) -> Result<Option<UiConnection>, TuiError> {
        let mut retry_delay = Duration::from_millis(250);
        let mut reconnect_overlay = true;
        loop {
            if reconnect_overlay {
                app.set_overlay(OverlayView::Reconnect);
            } else {
                app.return_to_dashboard();
            }
            terminal.draw(|frame| app.render(frame))?;

            let wait = if reconnect_overlay {
                retry_delay
            } else {
                Duration::from_millis(250)
            };
            if crossterm::event::poll(wait)? {
                let mut captured = read_input_event()?;
                let accepted_mouse_scroll =
                    app.admit_mouse_scroll(&mut captured.intents, Instant::now());
                if !accepted_mouse_scroll && is_mouse_wheel_message(captured.message.as_ref()) {
                    captured.message = None;
                }
                if captured.message.as_ref().is_some_and(should_quit) {
                    return Ok(None);
                }
                let cancelled = captured.message.as_ref().is_some_and(|message| {
                    matches!(
                        message,
                        UiMessage::InputEvent {
                            event: UiInputEventKind::Cancel,
                            ..
                        }
                    )
                });
                if reconnect_overlay && cancelled {
                    // Escape leaves the retry modal in a live dashboard
                    // state. Reconnection continues in the background and
                    // the process remains usable instead of terminating.
                    reconnect_overlay = false;
                    continue;
                }
                let retry_requested = !reconnect_overlay
                    && captured.message.as_ref().is_some_and(|message| {
                        matches!(
                            message,
                            UiMessage::InputEvent {
                                event: UiInputEventKind::Submit,
                                ..
                            }
                        )
                    });
                if retry_requested {
                    reconnect_overlay = true;
                    app.show_welcome = false;
                    retry_delay = Duration::from_millis(250);
                    continue;
                }
                let consumed = app.apply_local_intents(&captured.intents);
                if !consumed {
                    if let Some(message) = captured.message.as_ref() {
                        app.apply_input(message);
                    }
                }
            }

            if let Ok(mut candidate) = UiConnection::connect(&config.control_socket) {
                if let Ok(initial_message) = candidate.handshake(&config.session_id) {
                    if let Some(message) = initial_message {
                        app.apply_message(message);
                    }
                    if app.overlay == OverlayView::Reconnect {
                        app.set_overlay(OverlayView::None);
                    }
                    if send_terminal_size(&mut candidate, message_sequence).is_ok() {
                        return Ok(Some(candidate));
                    }
                }
            }
            retry_delay = retry_delay.saturating_mul(2).min(Duration::from_secs(5));
        }
    }

    struct CapturedEvent {
        message: Option<UiMessage>,
        intents: Vec<LocalIntent>,
    }

    fn read_input_event() -> Result<CapturedEvent, TuiError> {
        let event = crossterm::event::read()?;
        let intents = interaction::map_event(event.clone());
        let message = match event {
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
            Event::Mouse(mouse) => Some(UiMessage::InputEvent {
                version: UI_PROTOCOL_VERSION,
                id: "input".into(),
                sequence: 0,
                event: UiInputEventKind::Mouse(mouse_event_to_input(mouse)),
            }),
            Event::Resize(columns, rows) if columns > 0 && rows > 0 => {
                Some(UiMessage::TerminalSize {
                    version: UI_PROTOCOL_VERSION,
                    id: "size".into(),
                    columns,
                    rows,
                })
            }
            Event::FocusGained => Some(action_message("focus_gained")),
            Event::FocusLost => Some(action_message("focus_lost")),
            Event::Resize(_, _) => None,
        };
        Ok(CapturedEvent { message, intents })
    }

    fn action_message(action: &str) -> UiMessage {
        UiMessage::InputEvent {
            version: UI_PROTOCOL_VERSION,
            id: "input".into(),
            sequence: 0,
            event: UiInputEventKind::Action(mindcode_protocol::ui::UiActionInput {
                action: action.to_owned(),
                target: None,
                value: None,
            }),
        }
    }

    fn mouse_event_to_input(
        event: crossterm::event::MouseEvent,
    ) -> mindcode_protocol::ui::UiMouseInput {
        use crossterm::event::{MouseButton, MouseEventKind};
        use mindcode_protocol::ui::{UiMouseButton, UiMouseEventKind};

        let (kind, button) = match event.kind {
            MouseEventKind::Down(button) => (UiMouseEventKind::Down, mouse_button(button)),
            MouseEventKind::Up(button) => (UiMouseEventKind::Up, mouse_button(button)),
            MouseEventKind::Drag(button) => (UiMouseEventKind::Drag, mouse_button(button)),
            MouseEventKind::Moved => (UiMouseEventKind::Move, UiMouseButton::None),
            MouseEventKind::ScrollUp => (UiMouseEventKind::ScrollUp, UiMouseButton::None),
            MouseEventKind::ScrollDown => (UiMouseEventKind::ScrollDown, UiMouseButton::None),
            MouseEventKind::ScrollLeft | MouseEventKind::ScrollRight => {
                (UiMouseEventKind::Move, UiMouseButton::None)
            }
        };
        let _ = MouseButton::Left;
        mindcode_protocol::ui::UiMouseInput {
            x: event.column,
            y: event.row,
            button,
            kind,
            modifiers: key_modifiers(event.modifiers),
        }
    }

    fn mouse_button(button: crossterm::event::MouseButton) -> mindcode_protocol::ui::UiMouseButton {
        match button {
            crossterm::event::MouseButton::Left => mindcode_protocol::ui::UiMouseButton::Left,
            crossterm::event::MouseButton::Middle => mindcode_protocol::ui::UiMouseButton::Middle,
            crossterm::event::MouseButton::Right => mindcode_protocol::ui::UiMouseButton::Right,
        }
    }

    fn is_mouse_wheel_message(message: Option<&UiMessage>) -> bool {
        matches!(
            message,
            Some(UiMessage::InputEvent {
                event: UiInputEventKind::Mouse(mouse),
                ..
            }) if matches!(
                mouse.kind,
                mindcode_protocol::ui::UiMouseEventKind::ScrollUp
                    | mindcode_protocol::ui::UiMouseEventKind::ScrollDown
            )
        )
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

        #[test]
        fn write_failure_is_returned_to_the_reconnect_caller() {
            let (stream, peer) = UnixStream::pair().unwrap();
            drop(peer);
            let mut connection = UiConnection {
                stream,
                frames: FrameReader::new(),
            };
            let result = send_input(
                &mut connection,
                &mut 0,
                &mut 0,
                action_message("write-test"),
            );
            assert!(result.is_err());
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
    use std::fmt::Write as _;
    use std::fs;
    use std::path::PathBuf;

    fn snapshot(sequence: u64) -> UiRenderSnapshot {
        use mindcode_protocol::ui::*;
        UiRenderSnapshot {
            version: UI_PROTOCOL_VERSION,
            id: "snapshot".into(),
            sequence,
            sessions: vec![UiSessionSnapshot {
                id: "session-1".into(),
                name: "Demo session".into(),
                workspace: "mindcode".into(),
                status: "active".into(),
                model: "gpt-5.6-luna".into(),
                effort: "high".into(),
                active: true,
                pinned: true,
                unread: 0,
                created_at_ms: 1,
                updated_at_ms: 2,
            }],
            workspaces: vec![UiWorkspaceSnapshot {
                id: "workspace-1".into(),
                name: "mindcode".into(),
                path: "/workspace/mindcode".into(),
                active: true,
            }],
            active_session_id: Some("session-1".into()),
            status: UiStatusSnapshot {
                state: "running".into(),
                message: Some("working".into()),
                detail: None,
            },
            telemetry: UiTelemetrySnapshot {
                connection: UiConnectionSnapshot {
                    state: "connected".into(),
                    reconnect_attempts: 0,
                    last_error: None,
                },
                model: "gpt-5.6-luna".into(),
                effort: "high".into(),
                context_used_tokens: 20_000,
                context_limit_tokens: 1_100_000,
                input_tokens: 18_000,
                output_tokens: 2_000,
                cached_tokens: 500,
                reasoning_tokens: 900,
                credits: 4.419,
                active_agents: 1,
                queued_tasks: 2,
                api_requests: 3,
                latency_ms: 120,
            },
            tasks: vec![UiTaskSnapshot {
                id: "task-1".into(),
                title: "compile".into(),
                status: "running".into(),
                detail: None,
                progress: Some(42),
                metadata: UiTaskMetadata {
                    parent_id: None,
                    owner: Some("leader".into()),
                    agent_id: Some("agent-1".into()),
                    model: Some("gpt-5.6-luna".into()),
                    effort: Some("high".into()),
                    dependencies: Vec::new(),
                    blocked_by: Vec::new(),
                    files_touched: vec!["src/main.rs".into()],
                    isolation: Some("worktree".into()),
                },
            }],
            agents: vec![UiAgentSnapshot {
                id: "agent-1".into(),
                name: "Luna worker".into(),
                role: "implement".into(),
                status: "running".into(),
                parent_id: None,
                task_id: Some("task-1".into()),
                model: "gpt-5.6-luna".into(),
                effort: "high".into(),
                progress: Some(42),
            }],
            transcript: vec![UiTranscriptBlock::Markdown(UiMarkdownBlock {
                id: "message-1".into(),
                sequence: 1,
                role: "assistant".into(),
                text: "hello".into(),
                created_at_ms: Some(1),
            })],
            transcript_window: None,
            changes: Vec::new(),
            activity: Vec::new(),
            permissions: Vec::new(),
            providers: vec![UiProviderSnapshot {
                id: "vexzy".into(),
                name: "VEXZY".into(),
                protocol: "openai-compatible".into(),
                base_url: "https://api.echogate.one/v1".into(),
                active: true,
                credential: Some("env:VEXZY_API_KEY".into()),
            }],
            writer: UiWriterState {
                mode: "writer".into(),
                writer_id: Some("client-1".into()),
                lease_expires_at_ms: None,
                observers: Vec::new(),
            },
        }
    }

    fn render_message(mut snapshot: UiRenderSnapshot, id: &str) -> UiMessage {
        snapshot.id = id.into();
        UiMessage::RenderSnapshot {
            version: snapshot.version,
            id: snapshot.id,
            sequence: snapshot.sequence,
            sessions: snapshot.sessions,
            workspaces: snapshot.workspaces,
            active_session_id: snapshot.active_session_id,
            status: snapshot.status,
            telemetry: snapshot.telemetry,
            tasks: snapshot.tasks,
            agents: snapshot.agents,
            transcript: snapshot.transcript,
            transcript_window: snapshot.transcript_window,
            changes: snapshot.changes,
            activity: snapshot.activity,
            permissions: snapshot.permissions,
            providers: snapshot.providers,
            writer: snapshot.writer,
        }
    }

    fn key_message(key: &str, modifiers: &[&str]) -> UiMessage {
        UiMessage::InputEvent {
            version: UI_PROTOCOL_VERSION,
            id: "test-input".into(),
            sequence: 1,
            event: UiInputEventKind::Key(UiKeyInput {
                key: key.into(),
                modifiers: modifiers
                    .iter()
                    .map(|modifier| (*modifier).into())
                    .collect(),
            }),
        }
    }

    fn submit_message() -> UiMessage {
        UiMessage::InputEvent {
            version: UI_PROTOCOL_VERSION,
            id: "test-input".into(),
            sequence: 1,
            event: UiInputEventKind::Submit,
        }
    }

    fn cancel_message() -> UiMessage {
        UiMessage::InputEvent {
            version: UI_PROTOCOL_VERSION,
            id: "test-input".into(),
            sequence: 1,
            event: UiInputEventKind::Cancel,
        }
    }

    fn app_with_providers() -> App {
        use mindcode_protocol::ui::UiProviderSnapshot;
        let mut current = snapshot(1);
        current.providers = vec![
            UiProviderSnapshot {
                id: "vexzy".into(),
                name: "VEXZY".into(),
                protocol: "openai-compatible".into(),
                base_url: "https://api.echogate.one/v1".into(),
                active: true,
                credential: Some("env:VEXZY_API_KEY".into()),
            },
            UiProviderSnapshot {
                id: "custom-a".into(),
                name: "Custom A".into(),
                protocol: "openai-compatible".into(),
                base_url: "https://custom.example/v1".into(),
                active: false,
                credential: Some("env:CUSTOM_KEY".into()),
            },
        ];
        let mut app = App::default();
        app.apply_message(render_message(current, "providers"));
        app
    }

    #[test]
    fn providers_overlay_switch_emits_action_for_selected_provider() {
        let mut app = app_with_providers();
        let mut ctrl_p = key_message("p", &["ctrl"]);
        assert!(app.contextualize_input(&mut ctrl_p));
        assert_eq!(app.overlay, OverlayView::Providers);

        let mut down = key_message("down", &[]);
        assert!(app.contextualize_input(&mut down));
        assert_eq!(app.provider_selection, 1);

        let mut enter = submit_message();
        assert!(app.contextualize_input(&mut enter));
        match enter {
            UiMessage::InputEvent {
                event: UiInputEventKind::Action(action),
                ..
            } => {
                assert_eq!(action.action, "provider_switch");
                assert_eq!(action.target.as_deref(), Some("custom-a"));
            }
            other => panic!("expected provider_switch action, got {other:?}"),
        }
    }

    #[test]
    fn providers_overlay_escape_cancels_form_before_overlay() {
        let mut app = app_with_providers();
        app.open_providers();
        let mut a = key_message("a", &[]);
        assert!(app.contextualize_input(&mut a));
        assert!(app.provider_form.is_some());

        let mut esc = cancel_message();
        assert!(app.contextualize_input(&mut esc));
        assert!(app.provider_form.is_none());
        assert_eq!(app.overlay, OverlayView::Providers);
    }

    #[test]
    fn providers_overlay_add_submit_emits_provider_add_action() {
        let mut app = app_with_providers();
        app.open_providers();
        let mut a = key_message("a", &[]);
        assert!(app.contextualize_input(&mut a));

        let form = app.provider_form.as_mut().unwrap();
        form.id = "my-api".into();
        form.name = "My API".into();
        form.base_url = "https://my.example/v1".into();
        form.credential_env = "MY_KEY".into();
        form.allowlist = "model-a, model-b".into();
        form.field = ProviderFormField::Allowlist;

        let mut submit = submit_message();
        assert!(app.contextualize_input(&mut submit));
        assert!(app.provider_form.is_none());
        match submit {
            UiMessage::InputEvent {
                event: UiInputEventKind::Action(action),
                ..
            } => {
                assert_eq!(action.action, "provider_add");
                let value: serde_json::Value =
                    serde_json::from_str(action.value.as_deref().unwrap()).unwrap();
                assert_eq!(value["id"], "my-api");
                assert_eq!(value["protocol"], "openai-compatible");
                assert_eq!(value["allowlist"][1], "model-b");
            }
            other => panic!("expected provider_add action, got {other:?}"),
        }
    }

    #[test]
    fn composer_submit_emits_composer_submit_action_with_buffer_text() {
        let mut app = App {
            show_welcome: false,
            ..Default::default()
        };
        app.push_input("/model gpt-5.6-luna");

        let mut submit = submit_message();
        assert!(app.contextualize_input(&mut submit));
        match submit {
            UiMessage::InputEvent {
                event: UiInputEventKind::Action(action),
                ..
            } => {
                assert_eq!(action.action, "composer_submit");
                assert_eq!(action.value.as_deref(), Some("/model gpt-5.6-luna"));
            }
            other => panic!("expected composer_submit action, got {other:?}"),
        }
        assert!(app.input_buffer.is_empty());
    }

    #[test]
    fn composer_submit_drops_whitespace_only_buffer() {
        let mut app = App {
            show_welcome: false,
            ..Default::default()
        };
        app.push_input("   ");

        let mut submit = submit_message();
        assert!(app.contextualize_input(&mut submit));
        // Whitespace-only input is dropped: the event stays a bare Submit.
        assert!(matches!(
            submit,
            UiMessage::InputEvent {
                event: UiInputEventKind::Submit,
                ..
            }
        ));
        assert!(app.input_buffer.is_empty());
    }

    #[test]
    fn default_app_opens_on_dashboard_with_composer_focused() {
        let app = App::default();
        assert!(!app.show_welcome);
        assert_eq!(app.focus, PanelFocus::Composer);
    }

    #[test]
    fn provider_form_payload_is_valid_json_without_a_credential_value() {
        let form = ProviderForm {
            field: ProviderFormField::Id,
            id: "my-api".into(),
            name: "My API".into(),
            protocol: 0,
            base_url: "https://my.example/v1".into(),
            credential_env: "MY_KEY".into(),
            allowlist: "model-a, model-b".into(),
        };
        let payload = form.to_payload();
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value["id"], "my-api");
        assert_eq!(value["protocol"], "openai-compatible");
        assert_eq!(value["allowlist"][1], "model-b");
        assert!(!payload.contains("sk-") && !payload.contains("forge-"));
    }

    #[test]
    fn preferences_are_loaded_into_the_active_workspace() {
        let mut preferences = Preferences::default();
        preferences
            .set_pane_ratios("default", PaneRatios::new(11, 67, 22))
            .unwrap();
        let app = App::with_preferences(preferences, None);
        assert_eq!(app.ratios, PaneRatios::new(11, 67, 22));
    }

    #[test]
    fn preferences_changes_are_persisted_atomically_through_app() {
        let path = std::env::temp_dir().join(format!(
            "mindcode-tui-preferences-{}-{}.bin",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_file(&path);
        let mut app = App::with_preferences(Preferences::default(), Some(path.clone()));
        app.set_theme(ThemeKind::Light);
        app.set_motion_override(Some(MotionMode::Reduced));
        let saved = Preferences::load(&path).unwrap();
        assert_eq!(saved.theme, ThemeKind::Light);
        assert_eq!(saved.motion_override, Some(MotionMode::Reduced));
        assert_eq!(saved.ratios_for("default"), PaneRatios::DEFAULT);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn transcript_boundary_keys_become_paging_actions() {
        use mindcode_protocol::ui::UiTranscriptWindow;

        let mut app = App {
            show_welcome: false,
            focus: PanelFocus::Content,
            ..App::default()
        };
        let mut current = snapshot(1);
        current.transcript_window = Some(UiTranscriptWindow {
            start_sequence: 1,
            end_sequence: 2,
            has_older: true,
            has_newer: false,
            blocks: current.transcript.clone(),
        });
        app.apply_message(render_message(current, "paging"));
        let mut older = key_message("up", &[]);
        assert!(app.contextualize_input(&mut older));
        assert!(
            matches!(older, UiMessage::InputEvent { event: UiInputEventKind::Action(action), .. } if action.action == "transcript_page" && action.value.as_deref() == Some("older"))
        );

        let mut current = snapshot(2);
        current.transcript_window = Some(UiTranscriptWindow {
            start_sequence: 3,
            end_sequence: 4,
            has_older: false,
            has_newer: true,
            blocks: current.transcript.clone(),
        });
        app.apply_message(render_message(current, "paging"));
        let mut newer = UiMessage::InputEvent {
            version: UI_PROTOCOL_VERSION,
            id: "mouse".into(),
            sequence: 2,
            event: UiInputEventKind::Mouse(mindcode_protocol::ui::UiMouseInput {
                x: 2,
                y: 2,
                button: mindcode_protocol::ui::UiMouseButton::None,
                kind: mindcode_protocol::ui::UiMouseEventKind::ScrollDown,
                modifiers: Vec::new(),
            }),
        };
        assert!(app.contextualize_input(&mut newer));
        assert!(
            matches!(newer, UiMessage::InputEvent { event: UiInputEventKind::Action(action), .. } if action.action == "transcript_page" && action.value.as_deref() == Some("newer"))
        );
    }

    #[test]
    fn alt_navigation_and_modal_focus_are_local_only() {
        let mut app = App {
            show_welcome: false,
            ..App::default()
        };
        let mut navigation = key_message("3", &["alt"]);
        assert!(app.contextualize_input(&mut navigation));
        assert_eq!(app.active_view, NavigationView::Tasks);
        assert!(app.suppress_input);

        app.focus = PanelFocus::Composer;
        app.set_overlay(OverlayView::Help);
        app.apply_local_intents(&[LocalIntent::CycleFocus { reverse: false }]);
        assert_eq!(app.focus, PanelFocus::Composer);
        app.apply_local_intents(&[LocalIntent::Cancel]);
        assert_eq!(app.overlay, OverlayView::None);
        assert_eq!(app.focus, PanelFocus::Composer);

        let mut vertical = key_message("up", &["alt", "shift"]);
        assert!(!app.contextualize_input(&mut vertical));
    }

    #[test]
    fn ctrl_b_hides_and_restores_sidebar_geometry() {
        let mut app = App {
            show_welcome: false,
            sidebar_visible: true,
            ..App::default()
        };
        app.terminal_size = (140, 45);
        let visible = app.interaction_layout();
        assert!(visible.sidebar.width > 0);

        app.focus = PanelFocus::Sidebar;
        assert!(app.apply_local_intents(&[LocalIntent::ToggleSidebar]));
        let hidden = app.interaction_layout();
        assert!(!app.sidebar_visible);
        assert_eq!(hidden.sidebar.width, 0);
        assert_eq!(
            hidden.chat.width,
            visible.chat.width + visible.sidebar.width
        );
        assert_eq!(app.focus, PanelFocus::Content);

        app.apply_local_intents(&[LocalIntent::ToggleSidebar]);
        assert!(app.sidebar_visible);
        assert_eq!(
            app.interaction_layout().sidebar.width,
            visible.sidebar.width
        );
    }

    #[test]
    fn overlays_render_above_the_welcome_screen() {
        let mut app = App::default();
        app.set_overlay(OverlayView::Help);
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| app.render(frame)).unwrap();
        let content: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol().to_owned())
            .collect();
        assert!(content.contains("Keyboard help"));
    }

    #[test]
    fn welcome_sakura_is_compact_and_symmetric() {
        let app = App {
            show_welcome: true,
            motion: MotionMode::Reduced,
            ..App::default()
        };
        let backend = TestBackend::new(80, 25);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| app.render(frame)).unwrap();
        let content: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol().to_owned())
            .collect();
        assert!(content.contains("❀   ✿   ❀"));
        assert!(content.contains("╭─────❀─────╮"));
        assert!(!content.contains("────╲╱────"));
    }

    #[test]
    fn scroll_targets_are_independent_and_composer_vertical_keys_do_not_scroll() {
        let mut app = App {
            show_welcome: false,
            focus: PanelFocus::Content,
            ..App::default()
        };
        assert!(app.apply_local_intents(&[LocalIntent::Scroll {
            target: interaction::ScrollTarget::Transcript,
            axis: interaction::ScrollAxis::Vertical,
            delta: -3,
        }]));
        assert_eq!(app.transcript_scroll, 3);

        app.apply_local_intents(&[LocalIntent::Scroll {
            target: interaction::ScrollTarget::Tasks,
            axis: interaction::ScrollAxis::Vertical,
            delta: -4,
        }]);
        app.apply_local_intents(&[LocalIntent::Scroll {
            target: interaction::ScrollTarget::Changes,
            axis: interaction::ScrollAxis::Vertical,
            delta: -5,
        }]);
        assert_eq!(app.tasks_scroll, 4);
        assert_eq!(app.changes_scroll, 5);
        assert_eq!(app.transcript_scroll, 3);

        app.active_view = NavigationView::Tasks;
        app.apply_local_intents(&[LocalIntent::Scroll {
            target: interaction::ScrollTarget::Transcript,
            axis: interaction::ScrollAxis::Vertical,
            delta: -2,
        }]);
        assert_eq!(app.tasks_scroll, 6);
        assert_eq!(app.transcript_scroll, 3);

        app.focus = PanelFocus::Composer;
        let consumed = app.apply_local_intents(&[LocalIntent::Scroll {
            target: interaction::ScrollTarget::Transcript,
            axis: interaction::ScrollAxis::Vertical,
            delta: -1,
        }]);
        assert!(!consumed);
        assert_eq!(app.transcript_scroll, 3);
    }

    #[test]
    fn mouse_click_activates_only_when_release_matches_press_and_drag_stays_on_dividers() {
        let mut current = snapshot(1);
        let mut second_task = current.tasks[0].clone();
        second_task.id = "task-2".into();
        second_task.title = "selected-task".into();
        second_task.metadata.agent_id = None;
        current.tasks.push(second_task);

        let mut app = App {
            show_welcome: false,
            active_view: NavigationView::Tasks,
            sidebar_visible: true,
            terminal_size: (140, 45),
            ..App::default()
        };
        app.apply_message(render_message(current, "mouse-release"));
        let layout = app.interaction_layout();
        let task_row = layout.chat.y + 1 + 3;
        let task_column = layout.chat.x + 2;

        app.apply_local_intents(&[LocalIntent::BeginDrag {
            column: task_column,
            row: task_row,
        }]);
        assert_eq!(app.selected_task, None, "press must not activate content");
        app.apply_local_intents(&[LocalIntent::EndDrag {
            column: task_column.saturating_add(1),
            row: task_row,
        }]);
        assert_eq!(
            app.selected_task, None,
            "release elsewhere must not activate content"
        );

        app.apply_local_intents(&[LocalIntent::BeginDrag {
            column: task_column,
            row: task_row,
        }]);
        app.apply_local_intents(&[LocalIntent::EndDrag {
            column: task_column,
            row: task_row,
        }]);
        assert_eq!(app.selected_task, Some(1));

        let before = app.ratios;
        app.apply_local_intents(&[LocalIntent::BeginDrag {
            column: task_column,
            row: task_row,
        }]);
        app.apply_local_intents(&[LocalIntent::Drag {
            column: task_column.saturating_add(8),
            row: task_row,
        }]);
        app.apply_local_intents(&[LocalIntent::EndDrag {
            column: task_column.saturating_add(8),
            row: task_row,
        }]);
        assert_eq!(app.ratios, before, "content drag must not resize panes");

        let divider = app.interaction_layout().sidebar.right();
        app.apply_local_intents(&[LocalIntent::BeginDrag {
            column: divider,
            row: task_row,
        }]);
        app.apply_local_intents(&[LocalIntent::Drag {
            column: divider.saturating_add(6),
            row: task_row,
        }]);
        app.apply_local_intents(&[LocalIntent::EndDrag {
            column: divider.saturating_add(6),
            row: task_row,
        }]);
        assert_ne!(app.ratios, before, "divider drag must resize panes");
    }

    #[test]
    fn mouse_wheel_scrolls_one_line_and_is_throttled_for_eighty_milliseconds() {
        let mut app = App {
            show_welcome: false,
            focus: PanelFocus::Content,
            ..App::default()
        };
        let started = Instant::now();
        let tick = LocalIntent::MouseScroll {
            target: interaction::ScrollTarget::Transcript,
            axis: interaction::ScrollAxis::Vertical,
            delta: -1,
        };

        let mut first = vec![tick.clone()];
        assert!(app.admit_mouse_scroll(&mut first, started));
        assert!(app.apply_local_intents_at(&first, started));
        assert_eq!(app.transcript_scroll, 1);

        let mut too_fast = vec![tick.clone()];
        assert!(!app.admit_mouse_scroll(&mut too_fast, started + Duration::from_millis(79)));
        assert!(too_fast.is_empty());
        assert_eq!(app.transcript_scroll, 1);

        let mut next = vec![tick];
        assert!(app.admit_mouse_scroll(&mut next, started + Duration::from_millis(80)));
        app.apply_local_intents_at(&next, started + Duration::from_millis(80));
        assert_eq!(app.transcript_scroll, 2);
    }

    #[test]
    fn task_and_change_clicks_update_renderer_selection() {
        use mindcode_protocol::ui::UiChangeSnapshot;

        let mut current = snapshot(1);
        let mut second_task = current.tasks[0].clone();
        second_task.id = "task-2".into();
        second_task.title = "selected-task".into();
        second_task.metadata.agent_id = None;
        current.tasks.push(second_task);
        current.changes = vec![
            UiChangeSnapshot {
                path: "first.rs".into(),
                kind: "M".into(),
                additions: 1,
                deletions: 0,
                staged: false,
                language: Some("rust".into()),
                diff: Some("first diff".into()),
            },
            UiChangeSnapshot {
                path: "selected.rs".into(),
                kind: "M".into(),
                additions: 2,
                deletions: 1,
                staged: false,
                language: Some("rust".into()),
                diff: Some("selected diff".into()),
            },
        ];

        let mut app = App {
            show_welcome: false,
            active_view: NavigationView::Tasks,
            terminal_size: (140, 45),
            ..App::default()
        };
        app.apply_message(render_message(current, "selection"));
        let layout = app.interaction_layout();
        let task_row = layout.chat.y + 1 + 3; // leader, first task, agent, second task
        app.focus_at(layout.chat.x + 2, task_row);
        assert_eq!(app.selected_task, Some(1));

        app.active_view = NavigationView::Changes;
        let layout = app.interaction_layout();
        let files_x = layout.chat.x + 2;
        let second_change_row = layout.chat.y + 1 + 1;
        app.focus_at(files_x, second_change_row);
        assert_eq!(app.selected_change, Some(1));
    }

    #[test]
    fn permission_overlay_selects_first_pending_and_survives_reconnect_snapshot() {
        use mindcode_protocol::ui::UiPermissionRequest;

        let mut connected = snapshot(1);
        connected.permissions = vec![
            UiPermissionRequest {
                id: "stale".into(),
                tool: "shell".into(),
                action: "execute".into(),
                resource: "stale".into(),
                reason: "already handled".into(),
                status: "completed".into(),
                requested_at_ms: 1,
                expires_at_ms: None,
                task_id: None,
                agent_id: None,
            },
            UiPermissionRequest {
                id: "pending".into(),
                tool: "shell".into(),
                action: "execute".into(),
                resource: "pending-resource".into(),
                reason: "needs approval".into(),
                status: "pending".into(),
                requested_at_ms: 2,
                expires_at_ms: None,
                task_id: None,
                agent_id: None,
            },
        ];
        let mut app = App::default();
        app.apply_message(render_message(connected.clone(), "connected-1"));
        assert_eq!(app.overlay, OverlayView::Permission);

        let mut disconnected = connected.clone();
        disconnected.sequence = 2;
        disconnected.telemetry.connection.state = "disconnected".into();
        app.apply_message(render_message(disconnected, "disconnected"));
        assert_eq!(app.overlay, OverlayView::Reconnect);

        connected.sequence = 3;
        app.apply_message(render_message(connected, "connected-2"));
        assert_eq!(app.overlay, OverlayView::Permission);
    }

    #[test]
    fn reconnect_escape_returns_to_dashboard_without_losing_the_draft() {
        let mut app = App {
            show_welcome: false,
            focus: PanelFocus::Composer,
            ..App::default()
        };
        app.push_input("draft");
        app.set_overlay(OverlayView::Reconnect);
        app.return_to_dashboard();
        assert!(!app.show_welcome);
        assert_eq!(app.overlay, OverlayView::None);
        assert_eq!(app.focus, PanelFocus::Content);
        assert_eq!(app.input_buffer, "draft");
    }

    #[test]
    fn utf8_composer_editing_keeps_byte_cursor_on_boundaries() {
        let mut app = App {
            show_welcome: false,
            focus: PanelFocus::Composer,
            ..App::default()
        };
        app.push_input("aé中\nb");
        app.input_cursor = "aé中".len();
        app.move_vertical(1);
        assert_eq!(app.input_cursor, app.input_buffer.len());
        app.move_vertical(-1);
        assert_eq!(app.input_cursor, "aé中".len());
        app.move_horizontal(-1);
        assert_eq!(app.input_cursor, "aé".len());
        app.delete_char();
        assert_eq!(app.input_buffer, "aé\nb");
        assert!(app.input_buffer.is_char_boundary(app.input_cursor));
        assert_eq!(app.display_input(), "aé▏\nb");

        app.input_cursor = app.input_buffer.len();
        let consumed = app.apply_local_intents(&[LocalIntent::Scroll {
            target: interaction::ScrollTarget::Transcript,
            axis: interaction::ScrollAxis::Vertical,
            delta: -1,
        }]);
        assert!(!consumed);
        app.apply_input(&key_message("up", &[]));
        assert!(app.input_buffer.is_char_boundary(app.input_cursor));
    }

    #[test]
    fn sidebar_navigation_works_in_desktop_layouts_and_focus_skips_hidden_panes() {
        let mut app = App {
            show_welcome: false,
            sidebar_visible: true,
            ..App::default()
        };
        app.apply_message(render_message(snapshot(1), "snapshot"));
        app.terminal_size = (140, 45);
        let sidebar = app.interaction_layout().sidebar;
        let navigation_start = sidebar.y + 1 + 2 + 1;
        app.focus_at(sidebar.x + 1, navigation_start + 2);
        assert_eq!(app.active_view, NavigationView::Tasks);

        app.terminal_size = (85, 30);
        app.focus = PanelFocus::Content;
        app.cycle_focus(false);
        assert_eq!(app.focus, PanelFocus::Composer);
        app.cycle_focus(false);
        assert_eq!(app.focus, PanelFocus::Sidebar);
    }

    #[test]
    fn hidden_inspector_weight_survives_keyboard_resize() {
        let mut app = App {
            show_welcome: false,
            terminal_size: (100, 30),
            focus: PanelFocus::Sidebar,
            ..App::default()
        };
        app.resize_by_keyboard(2);
        assert_eq!(app.ratios.inspector, PaneRatios::DEFAULT.inspector);
    }

    #[test]
    fn mouse_and_resize_events_cross_the_protocol_boundary_only_outside_modals() {
        let app = App::default();
        let mouse = UiMessage::InputEvent {
            version: UI_PROTOCOL_VERSION,
            id: "mouse".into(),
            sequence: 1,
            event: UiInputEventKind::Mouse(mindcode_protocol::ui::UiMouseInput {
                x: 1,
                y: 1,
                button: mindcode_protocol::ui::UiMouseButton::Left,
                kind: mindcode_protocol::ui::UiMouseEventKind::Down,
                modifiers: Vec::new(),
            }),
        };
        assert!(transport_passthrough(&app, &mouse));
        let mut modal = app;
        modal.set_overlay(OverlayView::Help);
        assert!(!transport_passthrough(&modal, &mouse));
        let resize = UiMessage::TerminalSize {
            version: UI_PROTOCOL_VERSION,
            id: "resize".into(),
            columns: 100,
            rows: 30,
        };
        assert!(transport_passthrough(&modal, &resize));
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
    fn handshake_response_requires_session_and_required_capabilities() {
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

        let future_capability = UiMessage::Capabilities {
            version: UI_PROTOCOL_VERSION,
            id: "session-1".into(),
            capabilities: CONTROL_CAPABILITIES
                .map(str::to_owned)
                .into_iter()
                .chain(["future_feature".into()])
                .collect(),
        };
        assert!(validate_handshake_response(&future_capability, "session-1").is_ok());

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

        let without_mouse = UiMessage::Capabilities {
            version: UI_PROTOCOL_VERSION,
            id: "session-1".into(),
            capabilities: CONTROL_CAPABILITIES
                .iter()
                .copied()
                .filter(|capability| *capability != "mouse")
                .map(str::to_owned)
                .collect(),
        };
        assert!(validate_handshake_response(&without_mouse, "session-1").is_err());

        let without_action = UiMessage::Capabilities {
            version: UI_PROTOCOL_VERSION,
            id: "session-1".into(),
            capabilities: CONTROL_CAPABILITIES
                .iter()
                .copied()
                .filter(|capability| *capability != "action")
                .map(str::to_owned)
                .collect(),
        };
        assert!(validate_handshake_response(&without_action, "session-1").is_err());
    }

    #[test]
    fn app_replaces_only_with_latest_sequence() {
        let mut app = App::default();
        app.apply_message(render_message(snapshot(2), "one"));
        app.apply_message(render_message(snapshot(1), "old"));
        app.apply_message(render_message(snapshot(2), "duplicate"));
        assert_eq!(app.latest_snapshot().unwrap().sequence, 2);
        assert_eq!(app.latest_snapshot().unwrap().id, "one");
    }

    #[test]
    fn app_does_not_retain_invalid_snapshot() {
        let mut app = App::default();
        let mut invalid = snapshot(1);
        invalid.status.state.clear();
        app.apply_message(render_message(invalid, "invalid"));
        assert!(app.latest_snapshot().is_none());
    }

    #[test]
    fn test_backend_renders_authoritative_snapshot() {
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let app = App {
            latest_snapshot: Some(snapshot(9)),
            show_welcome: false,
            ..App::default()
        };
        terminal.draw(|frame| app.render(frame)).unwrap();
        let buffer = terminal.backend().buffer();
        let content: String = buffer
            .content()
            .iter()
            .map(|cell| cell.symbol().to_owned())
            .collect();
        assert!(content.contains("gpt-5.6-luna"));
        assert!(content.contains("Assistant"));
        assert!(content.contains("hello"));
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
        app.show_welcome = false;

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
            key_event_to_input(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT)),
            Some(UiInputEventKind::Text { text: "\n".into() })
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
        for (key, expected) in [
            (KeyCode::Left, "left"),
            (KeyCode::Right, "right"),
            (KeyCode::Up, "up"),
            (KeyCode::Down, "down"),
        ] {
            assert_eq!(
                key_event_to_input(KeyEvent::new(key, KeyModifiers::NONE)),
                Some(UiInputEventKind::Key(UiKeyInput {
                    key: expected.into(),
                    modifiers: vec![],
                }))
            );
        }
        assert!(key_event_to_input(KeyEvent {
            code: KeyCode::Char('a'),
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Release,
            state: crossterm::event::KeyEventState::NONE,
        })
        .is_none());
    }

    #[test]
    fn responsive_testbackend_goldens() {
        for (name, width, height) in [
            ("wide-160x45", 160, 45),
            ("medium-120x36", 120, 36),
            ("compact-85x30", 85, 30),
            ("narrow-60x24", 60, 24),
        ] {
            assert_golden(name, width, height, ThemeKind::GraphiteSakura);
        }
        assert_golden("light-160x45", 160, 45, ThemeKind::Light);
        assert_golden("monochrome-160x45", 160, 45, ThemeKind::Monochrome);
    }

    fn assert_golden(name: &str, width: u16, height: u16, theme_kind: ThemeKind) {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).unwrap();
        let app = App {
            latest_snapshot: Some(snapshot(9)),
            show_welcome: false,
            theme: Theme::new(theme_kind, ColorMode::TrueColor),
            motion: MotionMode::Reduced,
            ..App::default()
        };
        terminal.draw(|frame| app.render(frame)).unwrap();
        let actual = serialize_buffer(terminal.backend().buffer(), width, height);
        let path = golden_path(name);
        if std::env::var_os("MINDCODE_UPDATE_GOLDENS").is_some() {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, &actual).unwrap();
        }
        let expected = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("missing golden {}: {error}", path.display()));
        assert_eq!(actual, expected, "visual golden mismatch: {name}");
    }

    fn golden_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("golden")
            .join(format!("{name}.txt"))
    }

    fn serialize_buffer(buffer: &ratatui::buffer::Buffer, width: u16, height: u16) -> String {
        let mut output = format!("size {width}x{height}\n");
        let mut style_hash = 0xcbf2_9ce4_8422_2325_u64;
        for cell in buffer.content() {
            for byte in format!("{:?}{:?}{:?}", cell.fg, cell.bg, cell.modifier).bytes() {
                style_hash ^= u64::from(byte);
                style_hash = style_hash.wrapping_mul(0x100_0000_01b3);
            }
        }
        writeln!(output, "style {style_hash:016x}").unwrap();
        for row in 0..height {
            output.push('|');
            for column in 0..width {
                output.push_str(buffer[(column, row)].symbol());
            }
            output.push_str("|\n");
        }
        output
    }
}
