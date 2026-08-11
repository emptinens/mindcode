//! Pure Ratatui rendering for the MindCode desktop shell.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use mindcode_protocol::ui::{
    UiActivitySnapshot, UiChangeSnapshot, UiRenderSnapshot, UiTaskSnapshot, UiTranscriptBlock,
    UiTranscriptWindow,
};
use ratatui::layout::{Alignment, Constraint, Layout, Margin, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{
    Block, BorderType, Borders, Clear, List, ListItem, Padding, Paragraph, Wrap,
};
use ratatui::Frame;

use crate::ui::{
    calculate_layout_with_composer, Breakpoint, ColorToken, LayoutRects, MotionMode, PaneRatios,
    SakuraPetalField, Theme,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NavigationView {
    #[default]
    Chat,
    Agents,
    Tasks,
    Changes,
    Logs,
}

impl NavigationView {
    pub const ALL: [Self; 5] = [
        Self::Chat,
        Self::Agents,
        Self::Tasks,
        Self::Changes,
        Self::Logs,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Chat => "Chat",
            Self::Agents => "Agents",
            Self::Tasks => "Tasks",
            Self::Changes => "Changes",
            Self::Logs => "Logs",
        }
    }

    pub const fn icon(self) -> &'static str {
        match self {
            Self::Chat => "◫",
            Self::Agents => "◉",
            Self::Tasks => "☷",
            Self::Changes => "±",
            Self::Logs => "≡",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PanelFocus {
    Sidebar,
    #[default]
    Content,
    Inspector,
    Composer,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OverlayView {
    #[default]
    None,
    Inspector,
    Activity,
    Palette,
    Help,
    Permission,
    Reconnect,
}

pub struct RenderState<'a> {
    pub snapshot: Option<&'a UiRenderSnapshot>,
    pub input: &'a str,
    pub show_welcome: bool,
    pub show_sidebar: bool,
    pub active_view: NavigationView,
    pub focus: PanelFocus,
    pub overlay: OverlayView,
    pub theme: Theme,
    pub ratios: PaneRatios,
    pub motion: MotionMode,
    pub elapsed: Duration,
    pub transcript_scroll: usize,
    pub tasks_scroll: usize,
    pub changes_scroll: usize,
    pub selected_task: Option<usize>,
    pub selected_change: Option<usize>,
}

struct TranscriptView<'a> {
    blocks: &'a [UiTranscriptBlock],
    has_older: bool,
    has_newer: bool,
}

fn transcript_view(snapshot: &UiRenderSnapshot) -> TranscriptView<'_> {
    transcript_view_parts(&snapshot.transcript, snapshot.transcript_window.as_ref())
}

fn transcript_view_parts<'a>(
    transcript: &'a [UiTranscriptBlock],
    window: Option<&'a UiTranscriptWindow>,
) -> TranscriptView<'a> {
    let Some(window) = window else {
        return TranscriptView {
            blocks: transcript,
            has_older: false,
            has_newer: false,
        };
    };

    // Some producers send window metadata before filling its blocks. In that
    // state the legacy transcript is still the only visible content, while
    // the paging markers remain authoritative.
    let blocks = if window.blocks.is_empty() && !transcript.is_empty() {
        transcript
    } else {
        &window.blocks
    };
    TranscriptView {
        blocks,
        has_older: window.has_older,
        has_newer: window.has_newer,
    }
}

fn transcript_range(len: usize, scroll: usize, max_blocks: usize) -> std::ops::Range<usize> {
    let max_scroll = len.saturating_sub(max_blocks);
    let end = len.saturating_sub(scroll.min(max_scroll));
    let start = end.saturating_sub(max_blocks);
    start..end
}

fn layout_without_sidebar(mut layout: LayoutRects) -> LayoutRects {
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

pub fn render(frame: &mut Frame<'_>, state: &RenderState<'_>) {
    frame.render_widget(
        Block::new().style(
            Style::new()
                .fg(state.theme.color(ColorToken::Text))
                .bg(state.theme.color(ColorToken::Background)),
        ),
        frame.area(),
    );

    if state.show_welcome {
        render_welcome(frame, state);
        render_overlay(frame, state);
        return;
    }

    let composer_rows = state
        .input
        .lines()
        .count()
        .max(1)
        .saturating_add(2)
        .clamp(2, 8) as u16;
    let shell = calculate_layout_with_composer(frame.area(), state.ratios, composer_rows);
    let shell = if state.show_sidebar {
        shell
    } else {
        layout_without_sidebar(shell)
    };
    render_header(frame, shell.header, state);
    render_sidebar(frame, shell.sidebar, shell.breakpoint, state);
    render_content(frame, shell.chat, state);
    if shell.inspector_is_pane() {
        render_inspector(frame, shell.inspector, state, false);
    }
    render_composer(frame, shell.composer, state);
    render_footer(frame, shell.footer, state);
    render_overlay(frame, state);
}

fn render_welcome(frame: &mut Frame<'_>, state: &RenderState<'_>) {
    let area = frame.area();
    let theme = state.theme;
    let card = centered_rect(
        72.min(area.width.saturating_sub(2)),
        25.min(area.height),
        area,
    );
    let panel = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(theme.style(ColorToken::AccentSoft))
        .style(theme.style(ColorToken::Text))
        .title(Span::styled(
            " ❀ MindCode · Welcome ",
            theme.style(ColorToken::Accent).add_modifier(Modifier::BOLD),
        ))
        .padding(Padding::horizontal(2));
    let inner = panel.inner(card);
    frame.render_widget(Clear, card);
    frame.render_widget(panel, card);

    let art = [
        "              ❀   ✿   ❀",
        "           ╭─────❀─────╮",
        "        ✿──┤  ❀  ✿  ❀  ├──✿",
        "           ╰─────┬─────╯",
        "                 │",
        "                ╱ ╲",
    ];
    let recent = state
        .snapshot
        .and_then(|snapshot| snapshot.sessions.iter().find(|session| session.active))
        .or_else(|| {
            state
                .snapshot
                .and_then(|snapshot| snapshot.sessions.first())
        });
    let latest = recent
        .map(|session| format!("{}  ·  {}", session.name, session.workspace))
        .unwrap_or_else(|| "No recent sessions".to_owned());
    let connection = state
        .snapshot
        .map(|snapshot| snapshot.telemetry.connection.state.as_str())
        .unwrap_or("connecting");
    let model = state
        .snapshot
        .map(|snapshot| snapshot.telemetry.model.as_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("gpt-5.6-luna");

    let mut lines = Vec::new();
    lines.extend(art.into_iter().map(|line| {
        Line::from(Span::styled(line, theme.style(ColorToken::AccentSoft)))
            .alignment(Alignment::Center)
    }));
    lines.push(Line::from(""));
    lines.push(
        Line::from(vec![
            Span::styled(
                "  Enter ",
                theme
                    .style(ColorToken::Background)
                    .bg(theme.color(ColorToken::Accent))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                " Continue latest  ",
                theme.style(ColorToken::Text).add_modifier(Modifier::BOLD),
            ),
            Span::styled("N", theme.style(ColorToken::Accent)),
            Span::raw(" New  "),
            Span::styled("A", theme.style(ColorToken::Accent)),
            Span::raw(" Attach  "),
            Span::styled("O", theme.style(ColorToken::Accent)),
            Span::raw(" Open workspace"),
        ])
        .alignment(Alignment::Center),
    );
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled("Recent  ", theme.style(ColorToken::Muted)),
        Span::styled(latest, theme.style(ColorToken::Text)),
    ]));
    lines.push(Line::from(vec![
        Span::styled("Runtime ", theme.style(ColorToken::Muted)),
        Span::styled(connection, status_style(connection, theme)),
        Span::styled("   Model ", theme.style(ColorToken::Muted)),
        Span::styled(model, theme.style(ColorToken::Text)),
    ]));
    lines.push(
        Line::from("Ctrl+K command palette  ·  F1 help")
            .alignment(Alignment::Center)
            .style(theme.style(ColorToken::Muted)),
    );
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);

    if matches!(state.motion, MotionMode::Full) && area.width > 40 && area.height > 12 {
        static WELCOME_PETALS: OnceLock<SakuraPetalField> = OnceLock::new();
        let field = WELCOME_PETALS.get_or_init(|| SakuraPetalField::new(0x4d49_4e44_434f_4445, 8));
        for (petal, cell) in field.sample_in(state.elapsed, state.motion, area) {
            if let Some((x, y)) = cell {
                if !card.contains((x, y).into()) {
                    frame.buffer_mut()[(x, y)]
                        .set_char(petal.glyph)
                        .set_style(theme.style(ColorToken::AccentSoft));
                }
            }
        }
    }
}

fn render_header(frame: &mut Frame<'_>, area: Rect, state: &RenderState<'_>) {
    if area.is_empty() {
        return;
    }
    let theme = state.theme;
    let snapshot = state.snapshot;
    let mut tabs = vec![Span::styled(
        " ❀ MindCode ",
        theme.style(ColorToken::Accent).add_modifier(Modifier::BOLD),
    )];
    if let Some(snapshot) = snapshot {
        for session in snapshot
            .sessions
            .iter()
            .filter(|session| session.pinned || session.active)
            .take(4)
        {
            let style = if session.active {
                theme
                    .style(ColorToken::Text)
                    .bg(theme.color(ColorToken::Selection))
                    .add_modifier(Modifier::BOLD)
            } else {
                theme.style(ColorToken::Muted)
            };
            tabs.push(Span::styled(
                format!(" {} ", truncate(&session.name, 18)),
                style,
            ));
        }
    }
    let telemetry = snapshot.map(|snapshot| &snapshot.telemetry);
    let right = telemetry
        .map(|value| {
            format!(
                "{} · {} · {} ",
                value.model, value.effort, value.connection.state
            )
        })
        .unwrap_or_else(|| "connecting · waiting for runtime ".to_owned());
    let [tabs_area, status_area] = Layout::horizontal([
        Constraint::Fill(1),
        Constraint::Length(right.chars().count().min(area.width as usize) as u16),
    ])
    .areas(area);
    frame.render_widget(
        Paragraph::new(Line::from(tabs)).style(theme.style(ColorToken::Text)),
        tabs_area,
    );
    frame.render_widget(
        Paragraph::new(right)
            .alignment(Alignment::Right)
            .style(theme.style(ColorToken::Muted)),
        status_area,
    );
    if area.height > 1 {
        frame.render_widget(
            Block::new()
                .borders(Borders::BOTTOM)
                .border_style(theme.style(ColorToken::Border)),
            area,
        );
    }
}

fn render_sidebar(
    frame: &mut Frame<'_>,
    area: Rect,
    breakpoint: Breakpoint,
    state: &RenderState<'_>,
) {
    if area.is_empty() {
        return;
    }
    let theme = state.theme;
    let focused = state.focus == PanelFocus::Sidebar;
    let block = panel_block("Sessions", focused, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if matches!(breakpoint, Breakpoint::Compact) {
        let items = NavigationView::ALL.into_iter().map(|view| {
            let style = if view == state.active_view {
                theme.style(ColorToken::Accent).add_modifier(Modifier::BOLD)
            } else {
                theme.style(ColorToken::Muted)
            };
            ListItem::new(
                Line::from(view.icon())
                    .alignment(Alignment::Center)
                    .style(style),
            )
        });
        frame.render_widget(List::new(items), inner);
        return;
    }

    let mut lines = Vec::new();
    if let Some(snapshot) = state.snapshot {
        let mut last_workspace = "";
        for session in snapshot.sessions.iter().take(9) {
            if session.workspace != last_workspace {
                lines.push(Line::from(Span::styled(
                    truncate(&session.workspace, 24).to_uppercase(),
                    theme.style(ColorToken::Muted).add_modifier(Modifier::BOLD),
                )));
                last_workspace = &session.workspace;
            }
            let marker = if session.active {
                "●"
            } else if session.status == "error" {
                "!"
            } else {
                "○"
            };
            lines.push(Line::from(vec![
                Span::styled(format!(" {marker} "), status_style(&session.status, theme)),
                Span::styled(
                    truncate(&session.name, 20),
                    if session.active {
                        theme.style(ColorToken::Text).add_modifier(Modifier::BOLD)
                    } else {
                        theme.style(ColorToken::Muted)
                    },
                ),
            ]));
        }
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            " No sessions",
            theme.style(ColorToken::Muted),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "NAVIGATION",
        theme.style(ColorToken::Muted).add_modifier(Modifier::BOLD),
    )));
    for view in NavigationView::ALL {
        let active = view == state.active_view;
        lines.push(Line::from(vec![
            Span::styled(
                format!(" {} ", view.icon()),
                if active {
                    theme.style(ColorToken::Accent)
                } else {
                    theme.style(ColorToken::Muted)
                },
            ),
            Span::styled(
                view.label(),
                if active {
                    theme.style(ColorToken::Text).add_modifier(Modifier::BOLD)
                } else {
                    theme.style(ColorToken::Muted)
                },
            ),
        ]));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: true }), inner);
}

fn render_content(frame: &mut Frame<'_>, area: Rect, state: &RenderState<'_>) {
    match state.active_view {
        NavigationView::Chat => render_chat(frame, area, state),
        NavigationView::Agents | NavigationView::Tasks => render_task_tree(frame, area, state),
        NavigationView::Changes => render_changes(frame, area, state),
        NavigationView::Logs => render_logs(frame, area, state),
    }
}

fn render_chat(frame: &mut Frame<'_>, area: Rect, state: &RenderState<'_>) {
    let theme = state.theme;
    let block = panel_block("Chat", state.focus == PanelFocus::Content, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let Some(snapshot) = state.snapshot else {
        frame.render_widget(
            Paragraph::new("Waiting for runtime snapshot…")
                .alignment(Alignment::Center)
                .style(theme.style(ColorToken::Muted)),
            inner,
        );
        return;
    };
    let window = transcript_view(snapshot);
    let older_height = u16::from(window.has_older);
    let newer_height = u16::from(window.has_newer);
    let [older_area, transcript_area, newer_area] = Layout::vertical([
        Constraint::Length(older_height),
        Constraint::Fill(1),
        Constraint::Length(newer_height),
    ])
    .areas(inner);

    if window.has_older {
        render_transcript_marker(frame, older_area, true, theme);
    }
    if window.has_newer {
        render_transcript_marker(frame, newer_area, false, theme);
    }

    // Keep the visible block budget proportional to the viewport. The old
    // fixed 40-block pass built and wrapped content that could never be drawn
    // on compact terminals.
    let max_blocks = ((transcript_area.height as usize).saturating_div(4) + 1).min(40);
    let range = transcript_range(window.blocks.len(), state.transcript_scroll, max_blocks);
    let mut lines = Vec::new();
    for entry in &window.blocks[range] {
        transcript_card(entry, theme, &mut lines);
        lines.push(Line::from(""));
    }
    if lines.is_empty() {
        lines.push(
            Line::from("Start a conversation or run a command.")
                .alignment(Alignment::Center)
                .style(theme.style(ColorToken::Muted)),
        );
    }
    frame.render_widget(
        Paragraph::new(Text::from(lines)).wrap(Wrap { trim: false }),
        transcript_area,
    );
}

fn render_transcript_marker(frame: &mut Frame<'_>, area: Rect, older: bool, theme: Theme) {
    if area.is_empty() {
        return;
    }
    let (icon, label) = if older {
        ("↑", "older messages available")
    } else {
        ("↓", "newer messages available")
    };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(format!(" {icon} "), theme.style(ColorToken::Accent)),
            Span::styled(label, theme.style(ColorToken::Muted)),
        ])),
        area,
    );
}

fn transcript_card(entry: &UiTranscriptBlock, theme: Theme, lines: &mut Vec<Line<'static>>) {
    let (title, role, status, body): (String, String, Option<String>, Vec<String>) = match entry {
        UiTranscriptBlock::Markdown(block) => (
            capitalize(&block.role),
            block.role.clone(),
            None,
            preview_lines(&block.text, 8, 180),
        ),
        UiTranscriptBlock::Code(block) => (
            format!("Code · {}", block.language),
            block.role.clone(),
            block.file_path.clone(),
            preview_lines(&block.code, 7, 180),
        ),
        UiTranscriptBlock::Tool(block) => {
            let mut body = Vec::new();
            if let Some(input) = &block.input {
                body.push(format!("args  {}", single_line(input, 160)));
            }
            if let Some(output) = &block.output {
                body.push(format!("out   {}", single_line(output, 160)));
            }
            (
                format!("Tool · {}", block.name),
                "tool".to_owned(),
                Some(block.status.clone()),
                body,
            )
        }
        UiTranscriptBlock::Thinking(block) => (
            "Thinking".to_owned(),
            "thinking".to_owned(),
            Some(format!(
                "{} · {}ms · {} tokens",
                block.effort, block.elapsed_ms, block.tokens_used
            )),
            preview_lines(&block.summary, 4, 180),
        ),
        UiTranscriptBlock::Report(block) => {
            let mut body = preview_lines(&block.summary, 4, 180);
            if !block.changed_files.is_empty() {
                body.push(format!("changed  {}", block.changed_files.join(", ")));
            }
            if !block.evidence.is_empty() {
                body.push(format!("evidence {}", block.evidence.join(" · ")));
            }
            (
                format!("Worker report · {}", block.task_id),
                "report".to_owned(),
                Some(block.status.clone()),
                body,
            )
        }
        UiTranscriptBlock::Error(block) => (
            format!("Error · {}", block.code),
            "error".to_owned(),
            Some(
                if block.recoverable {
                    "recoverable"
                } else {
                    "fatal"
                }
                .to_owned(),
            ),
            preview_lines(&block.message, 5, 180),
        ),
    };
    let border = if role == "error" {
        ColorToken::Error
    } else if role == "user" {
        ColorToken::Accent
    } else {
        ColorToken::BorderStrong
    };
    let mut header = vec![
        Span::styled("╭─ ", theme.style(border)),
        Span::styled(
            title,
            theme.style(ColorToken::Text).add_modifier(Modifier::BOLD),
        ),
    ];
    if let Some(status) = status {
        header.push(Span::styled(
            format!(" · {status}"),
            theme.style(ColorToken::Muted),
        ));
    }
    header.push(Span::styled(" ─", theme.style(border)));
    lines.push(Line::from(header));
    for body_line in body {
        lines.push(Line::from(vec![
            Span::styled("│ ", theme.style(border)),
            Span::styled(body_line, theme.style(ColorToken::Text)),
        ]));
    }
    lines.push(Line::from(Span::styled("╰─", theme.style(border))));
}

fn render_task_tree(frame: &mut Frame<'_>, area: Rect, state: &RenderState<'_>) {
    let theme = state.theme;
    let title = if state.active_view == NavigationView::Agents {
        "Agents · Leader → workers"
    } else {
        "Tasks · dependency tree"
    };
    let block = panel_block(title, state.focus == PanelFocus::Content, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let Some(snapshot) = state.snapshot else {
        return;
    };
    let mut agents_by_task = HashMap::with_capacity(snapshot.tasks.len());
    for agent in &snapshot.agents {
        if let Some(task_id) = agent.task_id.as_deref() {
            agents_by_task
                .entry(task_id)
                .or_insert_with(Vec::new)
                .push(agent);
        }
    }
    let mut items = vec![ListItem::new(Line::from(vec![
        Span::styled("❀ ", theme.style(ColorToken::Accent)),
        Span::styled(
            "Leader",
            theme.style(ColorToken::Text).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(
                "  {} · {}",
                snapshot.telemetry.model, snapshot.telemetry.effort
            ),
            theme.style(ColorToken::Muted),
        ),
    ]))];
    let selected_task = state
        .selected_task
        .unwrap_or(0)
        .min(snapshot.tasks.len().saturating_sub(1));
    for (task_index, task) in snapshot.tasks.iter().enumerate() {
        items.push(task_item(task, theme, task_index == selected_task));
        if let Some(agents) = agents_by_task.get(task.id.as_str()) {
            for agent in agents {
                items.push(ListItem::new(Line::from(vec![
                    Span::styled("    ╰─ ", theme.style(ColorToken::Border)),
                    Span::styled(
                        status_icon(&agent.status),
                        status_style(&agent.status, theme),
                    ),
                    Span::styled(format!(" {}", agent.name), theme.style(ColorToken::Text)),
                    Span::styled(
                        format!(" · {} · {}", agent.model, agent.effort),
                        theme.style(ColorToken::Muted),
                    ),
                ])));
            }
        }
    }
    if snapshot.tasks.is_empty() {
        items.push(ListItem::new(Line::from(Span::styled(
            "  No active tasks",
            theme.style(ColorToken::Muted),
        ))));
    }
    let scroll = state
        .tasks_scroll
        .min(items.len().saturating_sub(inner.height as usize));
    frame.render_widget(
        List::new(items.into_iter().skip(scroll).take(inner.height as usize)),
        inner,
    );
}

fn task_item(task: &UiTaskSnapshot, theme: Theme, selected: bool) -> ListItem<'static> {
    let dependency = if task.metadata.blocked_by.is_empty() {
        String::new()
    } else {
        format!(" · blocked by {}", task.metadata.blocked_by.join(","))
    };
    let progress = task
        .progress
        .map(|value| format!(" · {value}%"))
        .unwrap_or_default();
    let item = ListItem::new(Line::from(vec![
        Span::styled("  ├─ ", theme.style(ColorToken::Border)),
        Span::styled(status_icon(&task.status), status_style(&task.status, theme)),
        Span::styled(format!(" {}", task.title), theme.style(ColorToken::Text)),
        Span::styled(
            format!("{progress}{dependency}"),
            theme.style(ColorToken::Muted),
        ),
    ]));
    if selected {
        item.style(theme.style(ColorToken::Selection))
    } else {
        item
    }
}

fn render_changes(frame: &mut Frame<'_>, area: Rect, state: &RenderState<'_>) {
    let theme = state.theme;
    let block = panel_block("Changes", state.focus == PanelFocus::Content, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let Some(snapshot) = state.snapshot else {
        return;
    };
    let [files_area, diff_area] =
        Layout::horizontal([Constraint::Percentage(34), Constraint::Fill(1)]).areas(inner);
    let selected_change_index = state
        .selected_change
        .unwrap_or(0)
        .min(snapshot.changes.len().saturating_sub(1));
    let files = snapshot.changes.iter().enumerate().map(|(index, change)| {
        let item = ListItem::new(Line::from(vec![
            Span::styled(
                format!("{} ", change.kind),
                status_style(&change.kind, theme),
            ),
            Span::styled(truncate(&change.path, 28), theme.style(ColorToken::Text)),
            Span::styled(
                format!(" +{} -{}", change.additions, change.deletions),
                theme.style(ColorToken::Muted),
            ),
        ]));
        if index == selected_change_index {
            item.style(theme.style(ColorToken::Selection))
        } else {
            item
        }
    });
    frame.render_widget(
        List::new(
            files
                .skip(
                    state.changes_scroll.min(
                        snapshot
                            .changes
                            .len()
                            .saturating_sub(files_area.height as usize),
                    ),
                )
                .take(files_area.height as usize),
        )
        .block(
            Block::new()
                .borders(Borders::RIGHT)
                .border_style(theme.style(ColorToken::Border)),
        ),
        files_area,
    );
    let diff = selected_change(snapshot, state)
        .and_then(|change| change.diff.as_deref())
        .unwrap_or("Select a changed file to inspect its diff.");
    let diff_lines = preview_lines(diff, diff_area.height.saturating_sub(1) as usize, 240)
        .into_iter()
        .map(|line| {
            let token = if line.starts_with('+') {
                ColorToken::Success
            } else if line.starts_with('-') {
                ColorToken::Error
            } else {
                ColorToken::Text
            };
            Line::from(Span::styled(line, theme.style(token)))
        })
        .collect::<Vec<_>>();
    frame.render_widget(
        Paragraph::new(diff_lines).wrap(Wrap { trim: false }),
        diff_area.inner(Margin::new(1, 0)),
    );
}

fn render_logs(frame: &mut Frame<'_>, area: Rect, state: &RenderState<'_>) {
    let theme = state.theme;
    let block = panel_block(
        "Logs · Events | Raw",
        state.focus == PanelFocus::Content,
        theme,
    );
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let events = state
        .snapshot
        .map(|snapshot| snapshot.activity.as_slice())
        .unwrap_or_default();
    let items = events
        .iter()
        .rev()
        .take(inner.height as usize)
        .map(|event| activity_item(event, theme));
    frame.render_widget(List::new(items), inner);
}

fn activity_item<'a>(event: &'a UiActivitySnapshot, theme: Theme) -> ListItem<'a> {
    ListItem::new(Line::from(vec![
        Span::styled(
            format!("{:>8} ", event.timestamp_ms % 100_000_000),
            theme.style(ColorToken::Muted),
        ),
        Span::styled(
            format!("{:<8} ", event.kind),
            status_style(&event.severity, theme),
        ),
        Span::styled(event.message.as_str(), theme.style(ColorToken::Text)),
    ]))
}

fn render_inspector(frame: &mut Frame<'_>, area: Rect, state: &RenderState<'_>, overlay: bool) {
    if area.is_empty() {
        return;
    }
    let theme = state.theme;
    if overlay {
        frame.render_widget(Clear, area);
    }
    let block = panel_block(
        "Inspector · pinned",
        state.focus == PanelFocus::Inspector || overlay,
        theme,
    );
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let Some(snapshot) = state.snapshot else {
        return;
    };
    let mut lines = vec![
        label_value(
            "Session",
            snapshot.active_session_id.as_deref().unwrap_or("none"),
            theme,
        ),
        label_value("State", &snapshot.status.state, theme),
        label_value("Model", &snapshot.telemetry.model, theme),
        label_value("Effort", &snapshot.telemetry.effort, theme),
        label_value(
            "Credits",
            &format!("{:.4}", snapshot.telemetry.credits),
            theme,
        ),
        Line::from(""),
    ];
    if let Some(task) = selected_task(snapshot, state) {
        lines.push(Line::from(Span::styled(
            "SELECTED TASK",
            theme.style(ColorToken::Muted).add_modifier(Modifier::BOLD),
        )));
        lines.push(label_value("Title", &task.title, theme));
        lines.push(label_value("Status", &task.status, theme));
        if let Some(owner) = &task.metadata.owner {
            lines.push(label_value("Owner", owner, theme));
        }
        if let Some(effort) = &task.metadata.effort {
            lines.push(label_value("Effort", effort, theme));
        }
        if !task.metadata.files_touched.is_empty() {
            lines.push(Line::from(Span::styled(
                "Files",
                theme.style(ColorToken::Muted),
            )));
            lines.extend(
                task.metadata
                    .files_touched
                    .iter()
                    .take(8)
                    .map(|path| Line::from(format!("  {path}"))),
            );
        }
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn selected_change<'a>(
    snapshot: &'a UiRenderSnapshot,
    state: &RenderState<'_>,
) -> Option<&'a UiChangeSnapshot> {
    snapshot.changes.get(
        state
            .selected_change
            .unwrap_or(0)
            .min(snapshot.changes.len().saturating_sub(1)),
    )
}

fn selected_task<'a>(
    snapshot: &'a UiRenderSnapshot,
    state: &RenderState<'_>,
) -> Option<&'a UiTaskSnapshot> {
    snapshot.tasks.get(
        state
            .selected_task
            .unwrap_or(0)
            .min(snapshot.tasks.len().saturating_sub(1)),
    )
}

fn render_composer(frame: &mut Frame<'_>, area: Rect, state: &RenderState<'_>) {
    if area.is_empty() {
        return;
    }
    let theme = state.theme;
    let observer = state
        .snapshot
        .is_some_and(|snapshot| snapshot.writer.mode == "observer");
    let title = if observer {
        "Composer · read-only observer · Request control"
    } else {
        "Composer · Enter send · Shift+Enter newline"
    };
    let block = panel_block(title, state.focus == PanelFocus::Composer, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let value = if observer {
        "Read-only — request writer control to send messages."
    } else if state.input.is_empty() {
        "Type a prompt or / command…"
    } else {
        state.input
    };
    let token = if state.input.is_empty() || observer {
        ColorToken::Muted
    } else {
        ColorToken::Text
    };
    frame.render_widget(
        Paragraph::new(format!("> {value}"))
            .style(theme.style(token))
            .wrap(Wrap { trim: false }),
        inner,
    );
}

fn render_footer(frame: &mut Frame<'_>, area: Rect, state: &RenderState<'_>) {
    if area.is_empty() {
        return;
    }
    let theme = state.theme;
    let Some(snapshot) = state.snapshot else {
        frame.render_widget(
            Paragraph::new("connecting · MindCode runtime unavailable")
                .style(theme.style(ColorToken::Muted)),
            area,
        );
        return;
    };
    let telemetry = &snapshot.telemetry;
    let percent = if telemetry.context_limit_tokens == 0 {
        0
    } else {
        telemetry
            .context_used_tokens
            .saturating_mul(100)
            .checked_div(telemetry.context_limit_tokens)
            .unwrap_or(0)
            .min(100)
    };
    let full = format!(
        " {} │ {} · {} │ Context {}% │ Credits {:.4} │ Agents {} │ Queue {} │ Permissions {} ",
        telemetry.connection.state,
        telemetry.model,
        telemetry.effort,
        percent,
        telemetry.credits,
        telemetry.active_agents,
        telemetry.queued_tasks,
        snapshot.permissions.len(),
    );
    let compact = format!(
        " {} │ {} │ Context {}% ",
        telemetry.connection.state, telemetry.model, percent
    );
    let value = if full.chars().count() <= area.width as usize {
        full
    } else {
        compact
    };
    frame.render_widget(
        Paragraph::new(value).style(theme.style(ColorToken::Muted)),
        area,
    );
}

fn render_overlay(frame: &mut Frame<'_>, state: &RenderState<'_>) {
    let area = frame.area();
    match state.overlay {
        OverlayView::None => {}
        OverlayView::Inspector => render_inspector(
            frame,
            centered_rect(
                area.width.min(72),
                area.height.saturating_sub(4).min(32),
                area,
            ),
            state,
            true,
        ),
        OverlayView::Activity => render_activity_overlay(frame, state),
        OverlayView::Palette => render_text_modal(
            frame,
            "Command palette",
            &[
                "/model  Select leader model",
                "/submodel  Select worker model",
                "/agents  Agent team",
                "/tasks  Shared task graph",
                "/status  Session report",
                "/copy  Copy latest response",
                "/copycon  Copy handoff context",
            ],
            state,
        ),
        OverlayView::Help => render_text_modal(
            frame,
            "Keyboard help",
            &[
                "Ctrl+K  Command palette",
                "F1  Help",
                "Tab  Move focus",
                "Alt+1…5  Open view",
                "Alt+Shift+Arrow  Resize panes",
                "Ctrl+Q  Detach",
                "Shift+Enter / Ctrl+J  New line",
            ],
            state,
        ),
        OverlayView::Permission => render_permission_overlay(frame, state),
        OverlayView::Reconnect => render_text_modal(
            frame,
            "Connection lost",
            &[
                "The last snapshot and draft are preserved.",
                "Enter  Retry now",
                "Esc  Return to dashboard",
            ],
            state,
        ),
    }
}

fn render_activity_overlay(frame: &mut Frame<'_>, state: &RenderState<'_>) {
    let area = centered_rect(
        frame.area().width.min(84),
        frame.area().height.saturating_sub(4).min(34),
        frame.area(),
    );
    frame.render_widget(Clear, area);
    let theme = state.theme;
    let block = panel_block("Activity center", true, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if let Some(snapshot) = state.snapshot {
        let items = snapshot
            .activity
            .iter()
            .rev()
            .take(50)
            .map(|event| activity_item(event, theme));
        frame.render_widget(List::new(items), inner);
    }
}

fn render_permission_overlay(frame: &mut Frame<'_>, state: &RenderState<'_>) {
    let Some(permission) = state.snapshot.and_then(|snapshot| {
        snapshot
            .permissions
            .iter()
            .find(|request| request.status == "pending")
    }) else {
        render_text_modal(
            frame,
            "Permission",
            &["No pending permission requests."],
            state,
        );
        return;
    };
    let resource = format!("Resource: {}", permission.resource);
    let reason = format!("Reason: {}", permission.reason);
    render_text_modal(
        frame,
        "Permission request",
        &[
            &permission.action,
            &resource,
            &reason,
            "[O] Allow once   [P] Allow project   [D] Deny",
        ],
        state,
    );
}

fn render_text_modal(frame: &mut Frame<'_>, title: &str, body: &[&str], state: &RenderState<'_>) {
    let width = frame.area().width.min(76);
    let height = (body.len() as u16 + 4).min(frame.area().height);
    let area = centered_rect(width, height, frame.area());
    frame.render_widget(Clear, area);
    let block = panel_block(title, true, state.theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let lines = body
        .iter()
        .map(|value| Line::from((*value).to_owned()))
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn panel_block<'a>(title: &'a str, focused: bool, theme: Theme) -> Block<'a> {
    let border = if focused {
        ColorToken::Accent
    } else {
        ColorToken::Border
    };
    Block::new()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(theme.style(border))
        .style(theme.style(if focused {
            ColorToken::Text
        } else {
            ColorToken::Muted
        }))
        .title(Span::styled(
            format!(" {title} "),
            if focused {
                theme.style(ColorToken::Text).add_modifier(Modifier::BOLD)
            } else {
                theme.style(ColorToken::Muted)
            },
        ))
}

fn label_value(label: &str, value: &str, theme: Theme) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{label:<9}"), theme.style(ColorToken::Muted)),
        Span::styled(value.to_owned(), theme.style(ColorToken::Text)),
    ])
}

fn status_icon(status: &str) -> &'static str {
    if status.eq_ignore_ascii_case("running")
        || status.eq_ignore_ascii_case("active")
        || status.eq_ignore_ascii_case("working")
        || status.eq_ignore_ascii_case("claimed")
    {
        "◐"
    } else if status.eq_ignore_ascii_case("done")
        || status.eq_ignore_ascii_case("completed")
        || status.eq_ignore_ascii_case("success")
        || status.eq_ignore_ascii_case("passed")
    {
        "●"
    } else if status.eq_ignore_ascii_case("failed")
        || status.eq_ignore_ascii_case("error")
        || status.eq_ignore_ascii_case("fatal")
        || status.eq_ignore_ascii_case("denied")
    {
        "×"
    } else if status.eq_ignore_ascii_case("blocked")
        || status.eq_ignore_ascii_case("waiting")
        || status.eq_ignore_ascii_case("pending")
    {
        "○"
    } else {
        "·"
    }
}

fn status_style(status: &str, theme: Theme) -> Style {
    let token = if status.eq_ignore_ascii_case("running")
        || status.eq_ignore_ascii_case("active")
        || status.eq_ignore_ascii_case("working")
        || status.eq_ignore_ascii_case("claimed")
        || status.eq_ignore_ascii_case("connected")
        || status.eq_ignore_ascii_case("ready")
    {
        ColorToken::Accent
    } else if status.eq_ignore_ascii_case("done")
        || status.eq_ignore_ascii_case("completed")
        || status.eq_ignore_ascii_case("success")
        || status.eq_ignore_ascii_case("passed")
        || status.eq_ignore_ascii_case("allowed")
    {
        ColorToken::Success
    } else if status.eq_ignore_ascii_case("failed")
        || status.eq_ignore_ascii_case("error")
        || status.eq_ignore_ascii_case("fatal")
        || status.eq_ignore_ascii_case("denied")
        || status.eq_ignore_ascii_case("disconnected")
    {
        ColorToken::Error
    } else if status.eq_ignore_ascii_case("blocked")
        || status.eq_ignore_ascii_case("warning")
        || status.eq_ignore_ascii_case("waiting")
        || status.eq_ignore_ascii_case("pending")
    {
        ColorToken::Warning
    } else {
        ColorToken::Muted
    };
    theme.style(token)
}

fn preview_lines(value: &str, max_lines: usize, max_chars: usize) -> Vec<String> {
    value
        .lines()
        .take(max_lines)
        .map(|line| truncate(line, max_chars))
        .collect()
}

fn single_line(value: &str, max_chars: usize) -> String {
    if !value.contains(['\r', '\n']) {
        return truncate(value, max_chars);
    }
    let mut compacted = String::with_capacity(value.len());
    for character in value.chars() {
        compacted.push(if matches!(character, '\r' | '\n') {
            ' '
        } else {
            character
        });
    }
    truncate(&compacted, max_chars)
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    let mut result = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        None => "Message".to_owned(),
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

fn centered_rect(width: u16, height: u16, area: Rect) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_status_has_a_safe_fallback() {
        let theme = Theme::default();
        assert_eq!(status_icon("provider-added-state"), "·");
        assert_eq!(
            status_style("provider-added-state", theme).fg,
            theme.style(ColorToken::Muted).fg
        );
    }

    #[test]
    fn truncation_is_unicode_safe() {
        assert_eq!(truncate("abcdef", 4), "abc…");
        assert_eq!(truncate("❀❀❀❀", 3), "❀❀…");
    }

    #[test]
    fn centered_rect_never_exceeds_parent() {
        let parent = Rect::new(4, 2, 20, 10);
        let result = centered_rect(80, 40, parent);
        assert_eq!(result, parent);
    }

    #[test]
    fn transcript_range_keeps_newest_blocks_without_collecting_reversed_refs() {
        assert_eq!(transcript_range(10, 0, 4), 6..10);
        assert_eq!(transcript_range(10, 3, 4), 3..7);
        assert_eq!(transcript_range(10, 99, 4), 0..4);
    }

    #[test]
    fn populated_transcript_window_is_rendered_and_empty_window_falls_back() {
        let transcript = vec![UiTranscriptBlock::Markdown(
            mindcode_protocol::ui::UiMarkdownBlock {
                id: "legacy".into(),
                sequence: 1,
                role: "assistant".into(),
                text: "legacy".into(),
                created_at_ms: None,
            },
        )];
        let fallback_window = UiTranscriptWindow {
            start_sequence: 1,
            end_sequence: 1,
            has_older: true,
            has_newer: false,
            blocks: Vec::new(),
        };
        let fallback = transcript_view_parts(&transcript, Some(&fallback_window));
        assert_eq!(fallback.blocks.len(), 1);
        assert!(fallback.has_older);

        let window_block = UiTranscriptBlock::Markdown(mindcode_protocol::ui::UiMarkdownBlock {
            id: "window".into(),
            sequence: 2,
            role: "assistant".into(),
            text: "window".into(),
            created_at_ms: None,
        });
        let populated_window = UiTranscriptWindow {
            start_sequence: 2,
            end_sequence: 2,
            has_older: false,
            has_newer: true,
            blocks: vec![window_block],
        };
        let visible = transcript_view_parts(&transcript, Some(&populated_window));
        assert_eq!(visible.blocks.len(), 1);
        assert_eq!(visible.blocks[0], populated_window.blocks[0]);
        assert!(visible.has_newer);
    }
}
