//! Renderer-local interaction state and terminal-event intents.
//!
//! This module deliberately does not depend on the MindCode protocol.  The
//! native renderer can map [`LocalIntent`] values to protocol messages later,
//! while keeping focus, overlays, scrolling, and responsive state local to
//! the terminal client.

use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};

pub const WIDE_MIN_WIDTH: u16 = 140;
pub const MEDIUM_MIN_WIDTH: u16 = 100;
pub const COMPACT_MIN_WIDTH: u16 = 72;

/// The renderer's responsive class.  Width thresholds are inclusive at the
/// lower bound of each class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponsiveClass {
    Wide,
    Medium,
    Compact,
    Narrow,
}

/// Compatibility alias for callers that use the common layout vocabulary.
pub type Breakpoint = ResponsiveClass;

impl ResponsiveClass {
    pub const fn for_width(width: u16) -> Self {
        match width {
            WIDE_MIN_WIDTH..=u16::MAX => Self::Wide,
            MEDIUM_MIN_WIDTH..WIDE_MIN_WIDTH => Self::Medium,
            COMPACT_MIN_WIDTH..MEDIUM_MIN_WIDTH => Self::Compact,
            _ => Self::Narrow,
        }
    }

    pub const fn sidebar_is_pane(self) -> bool {
        matches!(self, Self::Wide | Self::Medium)
    }

    pub const fn inspector_is_pane(self) -> bool {
        matches!(self, Self::Wide)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Viewport {
    pub width: u16,
    pub height: u16,
    pub class: ResponsiveClass,
}

impl Viewport {
    pub const fn new(width: u16, height: u16) -> Self {
        Self {
            width,
            height,
            class: ResponsiveClass::for_width(width),
        }
    }
}

impl Default for Viewport {
    fn default() -> Self {
        Self::new(140, 45)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusTarget {
    Sidebar,
    Chat,
    Inspector,
    Composer,
    Footer,
    CommandPalette,
    Help,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayKind {
    CommandPalette,
    Help,
    Inspector,
    Activity,
    Sidebar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollTarget {
    Transcript,
    Tasks,
    Changes,
    Sidebar,
    Inspector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollAxis {
    Vertical,
    Horizontal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowMode {
    Following,
    Paused,
}

impl FollowMode {
    pub const fn is_following(self) -> bool {
        matches!(self, Self::Following)
    }
}

/// Scroll state for a stream-like view such as the transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollState {
    pub offset: u32,
    pub content_lines: u32,
    pub viewport_lines: u32,
    pub follow: FollowMode,
    pub unseen_lines: u32,
}

impl Default for ScrollState {
    fn default() -> Self {
        Self::new()
    }
}

impl ScrollState {
    pub const fn new() -> Self {
        Self {
            offset: 0,
            content_lines: 0,
            viewport_lines: 0,
            follow: FollowMode::Following,
            unseen_lines: 0,
        }
    }

    pub const fn max_offset(self) -> u32 {
        self.content_lines.saturating_sub(self.viewport_lines)
    }

    pub fn set_metrics(&mut self, content_lines: u32, viewport_lines: u32) {
        self.content_lines = content_lines;
        self.viewport_lines = viewport_lines;
        self.offset = self.offset.min(self.max_offset());
        if self.offset == 0 {
            self.follow = FollowMode::Following;
            self.unseen_lines = 0;
        }
    }

    /// Add content without breaking the tail-following viewport.
    pub fn append_lines(&mut self, lines: u32) {
        self.content_lines = self.content_lines.saturating_add(lines);
        if self.follow.is_following() {
            self.offset = 0;
            self.unseen_lines = 0;
        } else {
            self.unseen_lines = self.unseen_lines.saturating_add(lines);
        }
    }

    /// Scroll by lines. Negative values move toward older content; positive
    /// values move toward the newest content.
    pub fn scroll_by(&mut self, delta: i32) {
        let max_offset = self.max_offset();
        if delta < 0 {
            self.offset = self
                .offset
                .saturating_add(delta.unsigned_abs())
                .min(max_offset);
            if self.offset > 0 {
                self.follow = FollowMode::Paused;
            }
        } else if delta > 0 {
            self.offset = self.offset.saturating_sub(delta as u32);
            if self.offset == 0 {
                self.follow = FollowMode::Following;
                self.unseen_lines = 0;
            }
        }
    }

    pub fn jump_to_latest(&mut self) {
        self.offset = 0;
        self.follow = FollowMode::Following;
        self.unseen_lines = 0;
    }

    pub fn set_following(&mut self, following: bool) {
        if following {
            self.jump_to_latest();
        } else {
            self.follow = FollowMode::Paused;
        }
    }
}

/// Renderer-only actions.  These are intentionally not protocol messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalIntent {
    DismissWelcome,
    OpenCommandPalette,
    OpenHelp,
    ToggleOverlay(OverlayKind),
    ToggleSidebar,
    ToggleInspector,
    CycleFocus {
        reverse: bool,
    },
    Focus(FocusTarget),
    FocusAt {
        column: u16,
        row: u16,
    },
    Submit,
    InsertNewline,
    Cancel,
    Interrupt,
    Scroll {
        target: ScrollTarget,
        axis: ScrollAxis,
        delta: i32,
    },
    JumpToLatest {
        target: ScrollTarget,
    },
    BeginDrag {
        column: u16,
        row: u16,
    },
    Drag {
        column: u16,
        row: u16,
    },
    EndDrag {
        column: u16,
        row: u16,
    },
    Resize {
        width: u16,
        height: u16,
    },
    Paste(String),
}

impl LocalIntent {
    /// Compatibility spelling for consumers that distinguish closing an
    /// overlay from generic cancellation. It is represented by the same
    /// value so existing exhaustive matches remain protocol-independent.
    #[allow(non_upper_case_globals)]
    pub const CloseOverlay: &'static Self = &Self::Cancel;
}

/// Local state retained by the renderer between protocol snapshots.
#[derive(Debug, Clone)]
pub struct ViewState {
    pub welcome_visible: bool,
    pub focused: FocusTarget,
    pub overlay: Option<OverlayKind>,
    pub viewport: Viewport,
    pub sidebar_open: bool,
    pub inspector_open: bool,
    pub transcript_scroll: ScrollState,
    pub tasks_scroll: ScrollState,
    pub changes_scroll: ScrollState,
    pub dragging: bool,
    pub drag_origin: Option<(u16, u16)>,
    pub pointer: Option<(u16, u16)>,
}

impl Default for ViewState {
    fn default() -> Self {
        Self::new(true)
    }
}

impl ViewState {
    pub fn new(welcome_visible: bool) -> Self {
        Self {
            welcome_visible,
            focused: FocusTarget::Chat,
            overlay: None,
            viewport: Viewport::default(),
            sidebar_open: true,
            inspector_open: true,
            transcript_scroll: ScrollState::new(),
            tasks_scroll: ScrollState::new(),
            changes_scroll: ScrollState::new(),
            dragging: false,
            drag_origin: None,
            pointer: None,
        }
    }

    pub fn dismiss_welcome(&mut self) {
        self.welcome_visible = false;
        if self.focused == FocusTarget::Chat {
            self.focused = FocusTarget::Composer;
        }
    }

    pub fn set_viewport(&mut self, width: u16, height: u16) {
        self.viewport = Viewport::new(width, height);
        if self.viewport.class == ResponsiveClass::Narrow {
            self.sidebar_open = false;
            self.inspector_open = false;
        } else if self.viewport.class == ResponsiveClass::Compact {
            self.inspector_open = false;
        }
        self.ensure_focus_visible();
    }

    pub fn focus_order(&self) -> Vec<FocusTarget> {
        if let Some(overlay) = self.overlay {
            return match overlay {
                OverlayKind::CommandPalette => vec![FocusTarget::CommandPalette],
                OverlayKind::Help => vec![FocusTarget::Help],
                OverlayKind::Inspector => vec![FocusTarget::Inspector],
                OverlayKind::Activity => vec![FocusTarget::Inspector],
                OverlayKind::Sidebar => vec![FocusTarget::Sidebar],
            };
        }

        let mut order = Vec::with_capacity(5);
        if self.sidebar_open && self.viewport.class != ResponsiveClass::Narrow {
            order.push(FocusTarget::Sidebar);
        }
        order.push(FocusTarget::Chat);
        if self.inspector_open && self.viewport.class == ResponsiveClass::Wide {
            order.push(FocusTarget::Inspector);
        }
        order.push(FocusTarget::Composer);
        order.push(FocusTarget::Footer);
        order
    }

    pub fn cycle_focus(&mut self, reverse: bool) {
        let order = self.focus_order();
        if order.is_empty() {
            return;
        }
        let index = order.iter().position(|target| *target == self.focused);
        let next = match index {
            Some(index) if reverse => (index + order.len() - 1) % order.len(),
            Some(index) => (index + 1) % order.len(),
            None => 0,
        };
        self.focused = order[next];
    }

    pub fn ensure_focus_visible(&mut self) {
        if !self.focus_order().contains(&self.focused) {
            self.focused = self
                .focus_order()
                .into_iter()
                .next()
                .unwrap_or(FocusTarget::Chat);
        }
    }

    pub fn handle_event(&mut self, event: Event) -> Vec<LocalIntent> {
        let mut intents = map_event(event.clone());
        if self.welcome_visible {
            let dismiss = match event {
                Event::Key(key)
                    if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat)
                        && matches!(key.code, KeyCode::Enter | KeyCode::Esc)
                        && key.modifiers.intersection(
                            KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER,
                        ) == KeyModifiers::NONE =>
                {
                    true
                }
                Event::Key(key)
                    if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat)
                        && key.code == KeyCode::Char(' ')
                        && key.modifiers == KeyModifiers::NONE =>
                {
                    true
                }
                Event::Mouse(mouse) => {
                    matches!(mouse.kind, MouseEventKind::Down(_) | MouseEventKind::Moved)
                }
                _ => false,
            };
            if dismiss {
                intents.clear();
                intents.push(LocalIntent::DismissWelcome);
            }
        }
        for intent in &intents {
            self.apply_intent(intent);
        }
        intents
    }

    pub fn apply_intent(&mut self, intent: &LocalIntent) {
        match intent {
            LocalIntent::DismissWelcome => self.dismiss_welcome(),
            LocalIntent::OpenCommandPalette => {
                self.overlay = Some(OverlayKind::CommandPalette);
                self.focused = FocusTarget::CommandPalette;
            }
            LocalIntent::OpenHelp => {
                self.overlay = Some(OverlayKind::Help);
                self.focused = FocusTarget::Help;
            }
            LocalIntent::ToggleOverlay(kind) => {
                if self.overlay == Some(*kind) {
                    self.overlay = None;
                    self.ensure_focus_visible();
                } else {
                    self.overlay = Some(*kind);
                    self.focused = match kind {
                        OverlayKind::CommandPalette => FocusTarget::CommandPalette,
                        OverlayKind::Help => FocusTarget::Help,
                        OverlayKind::Inspector => FocusTarget::Inspector,
                        OverlayKind::Activity => FocusTarget::Inspector,
                        OverlayKind::Sidebar => FocusTarget::Sidebar,
                    };
                }
            }
            LocalIntent::ToggleSidebar => {
                self.sidebar_open = !self.sidebar_open;
                self.ensure_focus_visible();
            }
            LocalIntent::ToggleInspector => {
                self.inspector_open = !self.inspector_open;
                self.ensure_focus_visible();
            }
            LocalIntent::CycleFocus { reverse } => self.cycle_focus(*reverse),
            LocalIntent::Focus(target) => {
                if self.focus_order().contains(target) {
                    self.focused = *target;
                }
            }
            LocalIntent::FocusAt { column, row } => self.pointer = Some((*column, *row)),
            LocalIntent::Scroll {
                target,
                axis,
                delta,
            } => {
                if *axis == ScrollAxis::Vertical {
                    match target {
                        ScrollTarget::Transcript => self.transcript_scroll.scroll_by(*delta),
                        ScrollTarget::Tasks => self.tasks_scroll.scroll_by(*delta),
                        ScrollTarget::Changes => self.changes_scroll.scroll_by(*delta),
                        ScrollTarget::Sidebar => self.tasks_scroll.scroll_by(*delta),
                        ScrollTarget::Inspector => self.changes_scroll.scroll_by(*delta),
                    }
                }
            }
            LocalIntent::JumpToLatest { target } => match target {
                ScrollTarget::Transcript => self.transcript_scroll.jump_to_latest(),
                ScrollTarget::Tasks => self.tasks_scroll.jump_to_latest(),
                ScrollTarget::Changes => self.changes_scroll.jump_to_latest(),
                ScrollTarget::Sidebar => self.tasks_scroll.jump_to_latest(),
                ScrollTarget::Inspector => self.changes_scroll.jump_to_latest(),
            },
            LocalIntent::BeginDrag { column, row } => {
                self.dragging = true;
                self.drag_origin = Some((*column, *row));
                self.pointer = Some((*column, *row));
            }
            LocalIntent::Drag { column, row } | LocalIntent::EndDrag { column, row } => {
                self.pointer = Some((*column, *row));
                if matches!(intent, LocalIntent::EndDrag { .. }) {
                    self.dragging = false;
                    self.drag_origin = None;
                }
            }
            LocalIntent::Resize { width, height } => self.set_viewport(*width, *height),
            LocalIntent::Cancel => {
                if self.overlay.is_some() {
                    self.overlay = None;
                    self.ensure_focus_visible();
                }
            }
            LocalIntent::Submit
            | LocalIntent::InsertNewline
            | LocalIntent::Interrupt
            | LocalIntent::Paste(_) => {}
        }
    }
}

/// Map one terminal event to zero or more renderer-local intents.
pub fn map_event(event: Event) -> Vec<LocalIntent> {
    match event {
        Event::Key(key) => map_key_event(key).into_iter().collect(),
        Event::Mouse(mouse) => map_mouse_event(mouse),
        Event::Resize(width, height) => vec![LocalIntent::Resize { width, height }],
        Event::Paste(text) => vec![LocalIntent::Paste(text)],
        Event::FocusGained | Event::FocusLost => Vec::new(),
    }
}

pub fn map_key_event(event: KeyEvent) -> Option<LocalIntent> {
    if matches!(event.kind, KeyEventKind::Release) {
        return None;
    }

    let modifiers = event.modifiers;
    let control = modifiers.contains(KeyModifiers::CONTROL);
    let shift = modifiers.contains(KeyModifiers::SHIFT);
    let alt_or_system = modifiers.intersects(KeyModifiers::ALT | KeyModifiers::SUPER);

    if event.code == KeyCode::Char('k') && control && !alt_or_system {
        return Some(LocalIntent::OpenCommandPalette);
    }
    if event.code == KeyCode::Char('a') && control && shift && !alt_or_system {
        return Some(LocalIntent::ToggleOverlay(OverlayKind::Activity));
    }
    if event.code == KeyCode::F(1) && !control && !alt_or_system {
        return Some(LocalIntent::OpenHelp);
    }
    if event.code == KeyCode::Char('b') && control && !alt_or_system {
        return Some(LocalIntent::ToggleSidebar);
    }
    if event.code == KeyCode::Char('i') && control && !alt_or_system {
        return Some(LocalIntent::ToggleInspector);
    }
    if event.code == KeyCode::Char('j') && control && !alt_or_system {
        return Some(LocalIntent::InsertNewline);
    }

    if matches!(event.code, KeyCode::Tab | KeyCode::BackTab) {
        return Some(LocalIntent::CycleFocus {
            reverse: event.code == KeyCode::BackTab || shift,
        });
    }

    if event.code == KeyCode::Esc {
        return Some(LocalIntent::Cancel);
    }

    if event.code == KeyCode::Enter {
        return Some(if shift {
            LocalIntent::InsertNewline
        } else {
            LocalIntent::Submit
        });
    }

    if event.code == KeyCode::Char(' ') && !control && !alt_or_system {
        return Some(LocalIntent::DismissWelcome);
    }

    let scroll = |delta| LocalIntent::Scroll {
        target: ScrollTarget::Transcript,
        axis: ScrollAxis::Vertical,
        delta,
    };
    match event.code {
        KeyCode::PageUp => Some(scroll(-10)),
        KeyCode::PageDown => Some(scroll(10)),
        KeyCode::Up => Some(scroll(-1)),
        KeyCode::Down => Some(scroll(1)),
        KeyCode::End => Some(LocalIntent::JumpToLatest {
            target: ScrollTarget::Transcript,
        }),
        KeyCode::Char('c') if control && !alt_or_system => Some(LocalIntent::Interrupt),
        KeyCode::Char('q') if control && !alt_or_system => Some(LocalIntent::Cancel),
        _ => None,
    }
}

pub fn map_mouse_event(event: MouseEvent) -> Vec<LocalIntent> {
    let column = event.column;
    let row = event.row;
    match event.kind {
        MouseEventKind::Down(MouseButton::Left) => vec![
            LocalIntent::FocusAt { column, row },
            LocalIntent::BeginDrag { column, row },
        ],
        MouseEventKind::Down(_) => vec![LocalIntent::FocusAt { column, row }],
        MouseEventKind::Up(_) => vec![LocalIntent::EndDrag { column, row }],
        MouseEventKind::Drag(_) => vec![LocalIntent::Drag { column, row }],
        MouseEventKind::Moved => vec![LocalIntent::FocusAt { column, row }],
        MouseEventKind::ScrollUp => vec![LocalIntent::Scroll {
            target: ScrollTarget::Transcript,
            axis: ScrollAxis::Vertical,
            delta: -3,
        }],
        MouseEventKind::ScrollDown => vec![LocalIntent::Scroll {
            target: ScrollTarget::Transcript,
            axis: ScrollAxis::Vertical,
            delta: 3,
        }],
        MouseEventKind::ScrollLeft => vec![LocalIntent::Scroll {
            target: ScrollTarget::Changes,
            axis: ScrollAxis::Horizontal,
            delta: -3,
        }],
        MouseEventKind::ScrollRight => vec![LocalIntent::Scroll {
            target: ScrollTarget::Changes,
            axis: ScrollAxis::Horizontal,
            delta: 3,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    #[test]
    fn keyboard_shortcuts_map_to_local_intents() {
        assert_eq!(
            map_key_event(key(KeyCode::Char('k'), KeyModifiers::CONTROL)),
            Some(LocalIntent::OpenCommandPalette)
        );
        assert_eq!(
            map_key_event(key(KeyCode::F(1), KeyModifiers::NONE)),
            Some(LocalIntent::OpenHelp)
        );
        assert_eq!(
            map_key_event(key(KeyCode::Tab, KeyModifiers::NONE)),
            Some(LocalIntent::CycleFocus { reverse: false })
        );
        assert_eq!(
            map_key_event(key(KeyCode::BackTab, KeyModifiers::SHIFT)),
            Some(LocalIntent::CycleFocus { reverse: true })
        );
    }

    #[test]
    fn welcome_enter_is_dismissal_before_composer_submit() {
        let mut state = ViewState::new(true);
        assert_eq!(
            state.handle_event(Event::Key(key(KeyCode::Enter, KeyModifiers::NONE))),
            vec![LocalIntent::DismissWelcome]
        );
        assert!(!state.welcome_visible);
    }

    #[test]
    fn submit_and_newline_shortcuts_are_distinct() {
        assert_eq!(
            map_key_event(key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(LocalIntent::Submit)
        );
        assert_eq!(
            map_key_event(key(KeyCode::Enter, KeyModifiers::SHIFT)),
            Some(LocalIntent::InsertNewline)
        );
        assert_eq!(
            map_key_event(key(KeyCode::Char('j'), KeyModifiers::CONTROL)),
            Some(LocalIntent::InsertNewline)
        );
    }

    #[test]
    fn welcome_can_be_dismissed_and_overlay_focus_is_trapped() {
        let mut state = ViewState::new(true);
        state.apply_intent(&LocalIntent::DismissWelcome);
        assert!(!state.welcome_visible);
        assert_eq!(state.focused, FocusTarget::Composer);

        state.apply_intent(&LocalIntent::OpenCommandPalette);
        assert_eq!(state.focused, FocusTarget::CommandPalette);
        state.cycle_focus(false);
        assert_eq!(state.focused, FocusTarget::CommandPalette);
        state.apply_intent(LocalIntent::CloseOverlay);
        assert_ne!(state.focused, FocusTarget::CommandPalette);
    }

    #[test]
    fn tab_cycles_only_visible_panes_after_responsive_collapse() {
        let mut state = ViewState::new(false);
        state.set_viewport(60, 24);
        assert_eq!(
            state.focus_order(),
            vec![
                FocusTarget::Chat,
                FocusTarget::Composer,
                FocusTarget::Footer
            ]
        );
        state.focused = FocusTarget::Chat;
        state.cycle_focus(false);
        assert_eq!(state.focused, FocusTarget::Composer);
    }

    #[test]
    fn smart_follow_pauses_and_resumes_at_tail() {
        let mut scroll = ScrollState::new();
        scroll.set_metrics(100, 20);
        scroll.append_lines(100);
        assert!(scroll.follow.is_following());
        scroll.scroll_by(-4);
        assert_eq!(scroll.offset, 4);
        assert_eq!(scroll.follow, FollowMode::Paused);
        scroll.append_lines(2);
        assert_eq!(scroll.unseen_lines, 2);
        scroll.jump_to_latest();
        assert_eq!(scroll.unseen_lines, 0);
        assert!(scroll.follow.is_following());
    }

    #[test]
    fn mouse_events_emit_focus_scroll_and_drag_intents() {
        let down = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 4,
            row: 7,
            modifiers: KeyModifiers::NONE,
        };
        assert_eq!(
            map_mouse_event(down),
            vec![
                LocalIntent::FocusAt { column: 4, row: 7 },
                LocalIntent::BeginDrag { column: 4, row: 7 }
            ]
        );
        let scroll = MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 4,
            row: 7,
            modifiers: KeyModifiers::NONE,
        };
        assert_eq!(map_mouse_event(scroll).len(), 1);
        assert!(matches!(
            map_mouse_event(scroll).first(),
            Some(LocalIntent::Scroll { delta: -3, .. })
        ));
    }

    #[test]
    fn arrow_keys_emit_navigation_intents() {
        assert_eq!(
            map_key_event(key(KeyCode::Up, KeyModifiers::NONE)),
            Some(LocalIntent::Scroll {
                target: ScrollTarget::Transcript,
                axis: ScrollAxis::Vertical,
                delta: -1,
            })
        );
        assert_eq!(
            map_key_event(key(KeyCode::Down, KeyModifiers::NONE)),
            Some(LocalIntent::Scroll {
                target: ScrollTarget::Transcript,
                axis: ScrollAxis::Vertical,
                delta: 1,
            })
        );
    }

    #[test]
    fn key_release_is_ignored() {
        let mut event = key(KeyCode::Enter, KeyModifiers::NONE);
        event.kind = KeyEventKind::Release;
        assert_eq!(map_key_event(event), None);
    }
}
