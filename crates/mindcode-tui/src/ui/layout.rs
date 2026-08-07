//! Responsive workspace geometry and persistent pane-ratio models.

use std::collections::BTreeMap;

use ratatui::layout::Rect;

/// The first breakpoint is inclusive: a 140-column terminal is wide.
pub const WIDE_MIN_WIDTH: u16 = 140;
/// The medium range is 100..=139 columns.
pub const MEDIUM_MIN_WIDTH: u16 = 100;
/// The compact range is 72..=99 columns.
pub const COMPACT_MIN_WIDTH: u16 = 72;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Breakpoint {
    Wide,
    Medium,
    Compact,
    Narrow,
}

impl Breakpoint {
    pub const fn for_width(width: u16) -> Self {
        match width {
            WIDE_MIN_WIDTH..=u16::MAX => Self::Wide,
            MEDIUM_MIN_WIDTH..WIDE_MIN_WIDTH => Self::Medium,
            COMPACT_MIN_WIDTH..MEDIUM_MIN_WIDTH => Self::Compact,
            _ => Self::Narrow,
        }
    }

    pub const fn sidebar_visible(self) -> bool {
        !matches!(self, Self::Narrow)
    }

    pub const fn inspector_placement(self) -> InspectorPlacement {
        match self {
            Self::Wide => InspectorPlacement::Pane,
            Self::Medium | Self::Compact | Self::Narrow => InspectorPlacement::Overlay,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InspectorPlacement {
    Pane,
    Overlay,
}

/// Relative horizontal weights for the three desktop panes.
///
/// Ratios are retained per workspace. They are weights rather than
/// percentages, so callers can resize one pane without losing precision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneRatios {
    pub sidebar: u16,
    pub chat: u16,
    pub inspector: u16,
}

impl PaneRatios {
    pub const DEFAULT: Self = Self {
        sidebar: 24,
        chat: 52,
        inspector: 24,
    };

    pub const fn new(sidebar: u16, chat: u16, inspector: u16) -> Self {
        Self {
            sidebar: if sidebar == 0 { 1 } else { sidebar },
            chat: if chat == 0 { 1 } else { chat },
            inspector: if inspector == 0 { 1 } else { inspector },
        }
    }

    pub const fn total(self) -> u32 {
        self.sidebar as u32 + self.chat as u32 + self.inspector as u32
    }

    pub const fn normalized(self) -> Self {
        Self::new(self.sidebar, self.chat, self.inspector)
    }

    pub const fn with_sidebar(self, sidebar: u16) -> Self {
        Self::new(sidebar, self.chat, self.inspector)
    }

    pub const fn with_chat(self, chat: u16) -> Self {
        Self::new(self.sidebar, chat, self.inspector)
    }

    pub const fn with_inspector(self, inspector: u16) -> Self {
        Self::new(self.sidebar, self.chat, inspector)
    }
}

impl Default for PaneRatios {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// In-memory persistence model for workspace-specific pane ratios.
#[derive(Debug, Clone)]
pub struct WorkspaceLayoutModel {
    default_ratios: PaneRatios,
    workspaces: BTreeMap<String, PaneRatios>,
}

impl Default for WorkspaceLayoutModel {
    fn default() -> Self {
        Self::new(PaneRatios::DEFAULT)
    }
}

impl WorkspaceLayoutModel {
    pub fn new(default_ratios: PaneRatios) -> Self {
        Self {
            default_ratios: default_ratios.normalized(),
            workspaces: BTreeMap::new(),
        }
    }

    pub fn ratios_for(&self, workspace: &str) -> PaneRatios {
        self.workspaces
            .get(workspace)
            .copied()
            .unwrap_or(self.default_ratios)
    }

    pub fn set_ratios(&mut self, workspace: impl Into<String>, ratios: PaneRatios) {
        self.workspaces
            .insert(workspace.into(), ratios.normalized());
    }

    pub fn reset(&mut self, workspace: &str) -> bool {
        self.workspaces.remove(workspace).is_some()
    }

    pub const fn default_ratios(&self) -> PaneRatios {
        self.default_ratios
    }

    pub fn workspace_count(&self) -> usize {
        self.workspaces.len()
    }
}

/// Rectangles produced for one frame of the TUI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayoutRects {
    pub breakpoint: Breakpoint,
    pub inspector_placement: InspectorPlacement,
    pub header: Rect,
    pub sidebar: Rect,
    pub chat: Rect,
    pub inspector: Rect,
    pub composer: Rect,
    pub footer: Rect,
}

impl LayoutRects {
    pub fn all_rects(self) -> [Rect; 6] {
        [
            self.header,
            self.sidebar,
            self.chat,
            self.inspector,
            self.composer,
            self.footer,
        ]
    }

    pub const fn inspector_is_pane(self) -> bool {
        matches!(self.inspector_placement, InspectorPlacement::Pane)
    }
}

/// Calculate the full shell geometry for a workspace.
pub fn calculate_layout(area: Rect, ratios: PaneRatios) -> LayoutRects {
    calculate_layout_with_composer(area, ratios, 3)
}

/// Calculate shell geometry with a dynamic composer height clamped to 2..=8 rows.
pub fn calculate_layout_with_composer(
    area: Rect,
    ratios: PaneRatios,
    composer_rows: u16,
) -> LayoutRects {
    let breakpoint = Breakpoint::for_width(area.width);
    let (header, content, composer, footer) = split_vertical(area, composer_rows);
    let (sidebar, chat, inspector) = split_content(content, breakpoint, ratios.normalized());

    LayoutRects {
        breakpoint,
        inspector_placement: breakpoint.inspector_placement(),
        header,
        sidebar,
        chat,
        inspector,
        composer,
        footer,
    }
}

/// Calculate geometry using the ratio assigned to one workspace.
pub fn calculate_workspace_layout(
    area: Rect,
    workspace: &WorkspaceLayoutModel,
    workspace_id: &str,
) -> LayoutRects {
    calculate_layout(area, workspace.ratios_for(workspace_id))
}

fn split_vertical(area: Rect, composer_rows: u16) -> (Rect, Rect, Rect, Rect) {
    let mut y = area.y;
    let mut remaining = area.height;

    let header_height = remaining.min(3);
    let header = Rect::new(area.x, y, area.width, header_height);
    y = y.saturating_add(header_height);
    remaining = remaining.saturating_sub(header_height);

    let footer_height = remaining.min(1);
    remaining = remaining.saturating_sub(footer_height);

    let composer_height = if remaining >= 4 {
        composer_rows.clamp(2, 8).min(remaining.saturating_sub(1))
    } else if remaining >= 2 {
        2
    } else {
        0
    };
    let content_height = remaining.saturating_sub(composer_height);

    let content = Rect::new(area.x, y, area.width, content_height);
    y = y.saturating_add(content_height);
    let composer = Rect::new(area.x, y, area.width, composer_height);
    y = y.saturating_add(composer_height);
    let footer = Rect::new(area.x, y, area.width, footer_height);

    (header, content, composer, footer)
}

fn split_content(area: Rect, breakpoint: Breakpoint, ratios: PaneRatios) -> (Rect, Rect, Rect) {
    if area.width == 0 || area.height == 0 {
        return (
            Rect::new(area.x, area.y, 0, area.height),
            Rect::new(area.x, area.y, area.width, area.height),
            Rect::new(area.x, area.y, 0, area.height),
        );
    }

    match breakpoint {
        Breakpoint::Wide => {
            let widths =
                weighted_widths(area.width, [ratios.sidebar, ratios.chat, ratios.inspector]);
            let sidebar = Rect::new(area.x, area.y, widths[0], area.height);
            let chat_x = area.x.saturating_add(widths[0]);
            let chat = Rect::new(chat_x, area.y, widths[1], area.height);
            let inspector_x = chat_x.saturating_add(widths[1]);
            let inspector = Rect::new(inspector_x, area.y, widths[2], area.height);
            (sidebar, chat, inspector)
        }
        Breakpoint::Medium => {
            let widths = weighted_widths(area.width, [ratios.sidebar, ratios.chat, 0]);
            let sidebar = Rect::new(area.x, area.y, widths[0], area.height);
            let chat = Rect::new(
                area.x.saturating_add(widths[0]),
                area.y,
                widths[1],
                area.height,
            );
            (sidebar, chat, empty_rect(area))
        }
        Breakpoint::Compact => {
            let rail_width = area.width.min(5);
            let sidebar = Rect::new(area.x, area.y, rail_width, area.height);
            let chat = Rect::new(
                area.x.saturating_add(rail_width),
                area.y,
                area.width.saturating_sub(rail_width),
                area.height,
            );
            (sidebar, chat, empty_rect(area))
        }
        Breakpoint::Narrow => (empty_rect(area), area, empty_rect(area)),
    }
}

fn empty_rect(area: Rect) -> Rect {
    Rect::new(area.x, area.y, 0, 0)
}

fn weighted_widths(width: u16, weights: [u16; 3]) -> [u16; 3] {
    let total: u32 = weights.iter().map(|weight| u32::from(*weight)).sum();
    if total == 0 {
        return [0, width, 0];
    }

    let width = u32::from(width);
    let mut result = [0_u16; 3];
    let mut remainders = [(0_u32, 0_usize); 3];
    let mut assigned = 0_u32;
    for (index, weight) in weights.into_iter().enumerate() {
        let numerator = width * u32::from(weight);
        let base = numerator / total;
        result[index] = base as u16;
        assigned += base;
        remainders[index] = (numerator % total, index);
    }

    let mut left = width.saturating_sub(assigned);
    while left > 0 {
        let mut best = remainders[0];
        for candidate in remainders.into_iter().skip(1) {
            if candidate.0 > best.0 || (candidate.0 == best.0 && candidate.1 < best.1) {
                best = candidate;
            }
        }
        result[best.1] = result[best.1].saturating_add(1);
        remainders[best.1].0 = 0;
        left -= 1;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(width: u16, height: u16) -> Rect {
        Rect::new(2, 3, width, height)
    }

    #[test]
    fn breakpoint_edges_match_the_visual_spec() {
        assert_eq!(Breakpoint::for_width(140), Breakpoint::Wide);
        assert_eq!(Breakpoint::for_width(139), Breakpoint::Medium);
        assert_eq!(Breakpoint::for_width(100), Breakpoint::Medium);
        assert_eq!(Breakpoint::for_width(99), Breakpoint::Compact);
        assert_eq!(Breakpoint::for_width(72), Breakpoint::Compact);
        assert_eq!(Breakpoint::for_width(71), Breakpoint::Narrow);
    }

    #[test]
    fn wide_layout_contains_three_horizontal_panes() {
        let layout = calculate_layout(area(140, 30), PaneRatios::DEFAULT);
        assert_eq!(layout.breakpoint, Breakpoint::Wide);
        assert!(layout.inspector_is_pane());
        assert_eq!(
            layout.sidebar.width + layout.chat.width + layout.inspector.width,
            140
        );
        assert_eq!(layout.sidebar.x, 2);
        assert_eq!(layout.chat.x, layout.sidebar.right());
        assert_eq!(layout.inspector.x, layout.chat.right());
    }

    #[test]
    fn medium_and_compact_layouts_preserve_the_chat_surface() {
        let medium = calculate_layout(area(100, 30), PaneRatios::DEFAULT);
        assert_eq!(medium.breakpoint, Breakpoint::Medium);
        assert!(medium.sidebar.width > 0);
        assert_eq!(medium.inspector.width, 0);
        assert_eq!(medium.inspector_placement, InspectorPlacement::Overlay);

        let compact = calculate_layout(area(72, 30), PaneRatios::DEFAULT);
        assert_eq!(compact.breakpoint, Breakpoint::Compact);
        assert_eq!(compact.sidebar.width, 5);
        assert_eq!(compact.chat.width, 67);
        assert_eq!(compact.inspector.width, 0);
    }

    #[test]
    fn narrow_layout_makes_chat_full_width() {
        let layout = calculate_layout(area(71, 10), PaneRatios::DEFAULT);
        assert_eq!(layout.breakpoint, Breakpoint::Narrow);
        assert_eq!(layout.sidebar.width, 0);
        assert_eq!(layout.chat.width, 71);
        assert_eq!(layout.inspector.width, 0);
    }

    #[test]
    fn vertical_regions_are_in_order_and_fit_the_terminal() {
        let layout = calculate_layout(area(140, 30), PaneRatios::DEFAULT);
        assert_eq!(layout.header.y + layout.header.height, layout.chat.y);
        assert_eq!(layout.chat.y + layout.chat.height, layout.composer.y);
        assert_eq!(layout.composer.y + layout.composer.height, layout.footer.y);
        assert_eq!(layout.footer.y + layout.footer.height, 33);
    }

    #[test]
    fn workspace_ratios_are_independent_and_resettable() {
        let mut model = WorkspaceLayoutModel::default();
        model.set_ratios("alpha", PaneRatios::new(30, 50, 20));
        model.set_ratios("beta", PaneRatios::new(10, 70, 20));
        assert_eq!(model.ratios_for("alpha"), PaneRatios::new(30, 50, 20));
        assert_eq!(model.ratios_for("beta"), PaneRatios::new(10, 70, 20));
        assert_ne!(model.ratios_for("alpha"), model.ratios_for("beta"));
        assert!(model.reset("alpha"));
        assert_eq!(model.ratios_for("alpha"), PaneRatios::DEFAULT);
        assert_eq!(model.workspace_count(), 1);
    }

    #[test]
    fn zero_sized_areas_do_not_overflow() {
        let layout = calculate_layout(Rect::new(u16::MAX, u16::MAX, 0, 0), PaneRatios::DEFAULT);
        assert_eq!(layout.header.width, 0);
        assert_eq!(layout.chat.height, 0);
        assert_eq!(layout.footer.height, 0);
    }
}
