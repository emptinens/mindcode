//! Theme tokens and terminal color-depth fallbacks for MindCode.

use ratatui::style::{Color, Modifier, Style};

/// The semantic colors used by the visual foundation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorToken {
    Background,
    Surface,
    SurfaceAlt,
    Text,
    Muted,
    Border,
    BorderStrong,
    Accent,
    AccentSoft,
    Success,
    Warning,
    Error,
    Info,
    Selection,
    Progress,
}

/// The color capabilities available from the terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ColorMode {
    /// 24-bit RGB colors.
    #[default]
    TrueColor,
    /// The 256-color indexed palette.
    Ansi256,
    /// The original 16-color ANSI palette.
    Ansi16,
}

impl ColorMode {
    /// Select the richest mode known to be supported by a terminal.
    pub const fn from_capabilities(truecolor: bool, ansi256: bool) -> Self {
        if truecolor {
            Self::TrueColor
        } else if ansi256 {
            Self::Ansi256
        } else {
            Self::Ansi16
        }
    }
}

/// The three built-in MindCode themes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ThemeKind {
    /// Dark graphite surfaces with pink sakura accents.
    #[default]
    GraphiteSakura,
    /// High-contrast light surfaces for bright terminals.
    Light,
    /// A grayscale theme for monochrome terminals and screenshots.
    Monochrome,
}

impl ThemeKind {
    pub const ALL: [Self; 3] = [Self::GraphiteSakura, Self::Light, Self::Monochrome];

    pub const fn label(self) -> &'static str {
        match self {
            Self::GraphiteSakura => "Graphite Sakura",
            Self::Light => "Light",
            Self::Monochrome => "Monochrome",
        }
    }
}

/// Concrete colors for one theme and one terminal color mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Palette {
    pub background: Color,
    pub surface: Color,
    pub surface_alt: Color,
    pub text: Color,
    pub muted: Color,
    pub border: Color,
    pub border_strong: Color,
    pub accent: Color,
    pub accent_soft: Color,
    pub success: Color,
    pub warning: Color,
    pub error: Color,
    pub info: Color,
    pub selection: Color,
    pub progress: Color,
}

impl Palette {
    pub const fn color(self, token: ColorToken) -> Color {
        match token {
            ColorToken::Background => self.background,
            ColorToken::Surface => self.surface,
            ColorToken::SurfaceAlt => self.surface_alt,
            ColorToken::Text => self.text,
            ColorToken::Muted => self.muted,
            ColorToken::Border => self.border,
            ColorToken::BorderStrong => self.border_strong,
            ColorToken::Accent => self.accent,
            ColorToken::AccentSoft => self.accent_soft,
            ColorToken::Success => self.success,
            ColorToken::Warning => self.warning,
            ColorToken::Error => self.error,
            ColorToken::Info => self.info,
            ColorToken::Selection => self.selection,
            ColorToken::Progress => self.progress,
        }
    }

    pub const fn style(self, token: ColorToken) -> Style {
        Style::new().fg(self.color(token))
    }

    pub const fn focused_style(self) -> Style {
        Style::new()
            .fg(self.text)
            .bg(self.surface)
            .add_modifier(Modifier::BOLD)
    }

    pub const fn panel_style(self) -> Style {
        Style::new().fg(self.text).bg(self.surface)
    }
}

/// A selected theme ready to be used by Ratatui widgets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Theme {
    pub kind: ThemeKind,
    pub mode: ColorMode,
    palette: Palette,
}

impl Theme {
    pub const fn new(kind: ThemeKind, mode: ColorMode) -> Self {
        Self {
            kind,
            mode,
            palette: palette_for(kind, mode),
        }
    }

    pub const fn graphite_sakura(mode: ColorMode) -> Self {
        Self::new(ThemeKind::GraphiteSakura, mode)
    }

    pub const fn light(mode: ColorMode) -> Self {
        Self::new(ThemeKind::Light, mode)
    }

    pub const fn monochrome(mode: ColorMode) -> Self {
        Self::new(ThemeKind::Monochrome, mode)
    }

    pub const fn palette(self) -> Palette {
        self.palette
    }

    pub const fn color(self, token: ColorToken) -> Color {
        self.palette.color(token)
    }

    pub const fn style(self, token: ColorToken) -> Style {
        self.palette.style(token)
    }
}

impl Default for Theme {
    fn default() -> Self {
        Self::new(ThemeKind::GraphiteSakura, ColorMode::TrueColor)
    }
}

const fn palette_for(kind: ThemeKind, mode: ColorMode) -> Palette {
    match mode {
        ColorMode::TrueColor => truecolor_palette(kind),
        ColorMode::Ansi256 => ansi256_palette(kind),
        ColorMode::Ansi16 => ansi16_palette(kind),
    }
}

const fn truecolor_palette(kind: ThemeKind) -> Palette {
    match kind {
        ThemeKind::GraphiteSakura => Palette {
            background: Color::Rgb(11, 11, 13),
            surface: Color::Rgb(18, 18, 22),
            surface_alt: Color::Rgb(25, 25, 31),
            text: Color::Rgb(242, 242, 243),
            muted: Color::Rgb(138, 138, 148),
            border: Color::Rgb(52, 52, 60),
            border_strong: Color::Rgb(82, 82, 94),
            accent: Color::Rgb(255, 79, 163),
            accent_soft: Color::Rgb(243, 166, 200),
            success: Color::Rgb(111, 207, 151),
            warning: Color::Rgb(243, 194, 93),
            error: Color::Rgb(245, 108, 114),
            info: Color::Rgb(117, 185, 255),
            selection: Color::Rgb(64, 31, 54),
            progress: Color::Rgb(255, 79, 163),
        },
        ThemeKind::Light => Palette {
            background: Color::Rgb(250, 250, 251),
            surface: Color::Rgb(255, 255, 255),
            surface_alt: Color::Rgb(241, 241, 245),
            text: Color::Rgb(27, 27, 32),
            muted: Color::Rgb(100, 100, 112),
            border: Color::Rgb(210, 210, 219),
            border_strong: Color::Rgb(160, 160, 174),
            accent: Color::Rgb(190, 47, 116),
            accent_soft: Color::Rgb(146, 36, 90),
            success: Color::Rgb(28, 120, 75),
            warning: Color::Rgb(153, 95, 0),
            error: Color::Rgb(176, 31, 37),
            info: Color::Rgb(30, 90, 150),
            selection: Color::Rgb(252, 220, 235),
            progress: Color::Rgb(190, 47, 116),
        },
        ThemeKind::Monochrome => Palette {
            background: Color::Rgb(0, 0, 0),
            surface: Color::Rgb(20, 20, 20),
            surface_alt: Color::Rgb(38, 38, 38),
            text: Color::Rgb(245, 245, 245),
            muted: Color::Rgb(155, 155, 155),
            border: Color::Rgb(88, 88, 88),
            border_strong: Color::Rgb(180, 180, 180),
            accent: Color::Rgb(245, 245, 245),
            accent_soft: Color::Rgb(190, 190, 190),
            success: Color::Rgb(215, 215, 215),
            warning: Color::Rgb(185, 185, 185),
            error: Color::Rgb(230, 230, 230),
            info: Color::Rgb(165, 165, 165),
            selection: Color::Rgb(70, 70, 70),
            progress: Color::Rgb(245, 245, 245),
        },
    }
}

const fn ansi256_palette(kind: ThemeKind) -> Palette {
    match kind {
        ThemeKind::GraphiteSakura => Palette {
            background: Color::Indexed(232),
            surface: Color::Indexed(235),
            surface_alt: Color::Indexed(238),
            text: Color::Indexed(255),
            muted: Color::Indexed(245),
            border: Color::Indexed(240),
            border_strong: Color::Indexed(250),
            accent: Color::Indexed(205),
            accent_soft: Color::Indexed(218),
            success: Color::Indexed(114),
            warning: Color::Indexed(221),
            error: Color::Indexed(210),
            info: Color::Indexed(117),
            selection: Color::Indexed(53),
            progress: Color::Indexed(205),
        },
        ThemeKind::Light => Palette {
            background: Color::Indexed(255),
            surface: Color::Indexed(255),
            surface_alt: Color::Indexed(251),
            text: Color::Indexed(232),
            muted: Color::Indexed(242),
            border: Color::Indexed(252),
            border_strong: Color::Indexed(245),
            accent: Color::Indexed(163),
            accent_soft: Color::Indexed(89),
            success: Color::Indexed(28),
            warning: Color::Indexed(130),
            error: Color::Indexed(124),
            info: Color::Indexed(25),
            selection: Color::Indexed(225),
            progress: Color::Indexed(163),
        },
        ThemeKind::Monochrome => Palette {
            background: Color::Indexed(232),
            surface: Color::Indexed(235),
            surface_alt: Color::Indexed(241),
            text: Color::Indexed(255),
            muted: Color::Indexed(247),
            border: Color::Indexed(244),
            border_strong: Color::Indexed(250),
            accent: Color::Indexed(255),
            accent_soft: Color::Indexed(250),
            success: Color::Indexed(252),
            warning: Color::Indexed(249),
            error: Color::Indexed(255),
            info: Color::Indexed(248),
            selection: Color::Indexed(242),
            progress: Color::Indexed(255),
        },
    }
}

const fn ansi16_palette(kind: ThemeKind) -> Palette {
    match kind {
        ThemeKind::GraphiteSakura => Palette {
            background: Color::Black,
            surface: Color::Black,
            surface_alt: Color::DarkGray,
            text: Color::White,
            muted: Color::Gray,
            border: Color::DarkGray,
            border_strong: Color::Gray,
            accent: Color::LightMagenta,
            accent_soft: Color::Magenta,
            success: Color::LightGreen,
            warning: Color::Yellow,
            error: Color::LightRed,
            info: Color::LightBlue,
            selection: Color::Magenta,
            progress: Color::LightMagenta,
        },
        ThemeKind::Light => Palette {
            background: Color::White,
            surface: Color::White,
            surface_alt: Color::Gray,
            text: Color::Black,
            muted: Color::DarkGray,
            border: Color::Gray,
            border_strong: Color::Black,
            accent: Color::Magenta,
            accent_soft: Color::DarkGray,
            success: Color::Green,
            warning: Color::Yellow,
            error: Color::Red,
            info: Color::Blue,
            selection: Color::LightMagenta,
            progress: Color::Magenta,
        },
        ThemeKind::Monochrome => Palette {
            background: Color::Black,
            surface: Color::Black,
            surface_alt: Color::DarkGray,
            text: Color::White,
            muted: Color::Gray,
            border: Color::DarkGray,
            border_strong: Color::White,
            accent: Color::White,
            accent_soft: Color::Gray,
            success: Color::White,
            warning: Color::Gray,
            error: Color::White,
            info: Color::Gray,
            selection: Color::DarkGray,
            progress: Color::White,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_theme_has_all_color_modes() {
        for kind in ThemeKind::ALL {
            for mode in [ColorMode::TrueColor, ColorMode::Ansi256, ColorMode::Ansi16] {
                let theme = Theme::new(kind, mode);
                assert_eq!(theme.kind, kind);
                assert_eq!(theme.mode, mode);
                assert_ne!(
                    theme.color(ColorToken::Text),
                    theme.color(ColorToken::Background)
                );
            }
        }
    }

    #[test]
    fn fallback_modes_use_terminal_palette_variants() {
        let indexed = Theme::graphite_sakura(ColorMode::Ansi256).palette();
        let ansi = Theme::graphite_sakura(ColorMode::Ansi16).palette();
        assert!(matches!(indexed.accent, Color::Indexed(_)));
        assert!(matches!(ansi.accent, Color::Magenta | Color::LightMagenta));
        assert!(!matches!(indexed.accent, Color::Rgb(_, _, _)));
    }

    #[test]
    fn capabilities_choose_the_richest_available_mode() {
        assert_eq!(
            ColorMode::from_capabilities(true, true),
            ColorMode::TrueColor
        );
        assert_eq!(
            ColorMode::from_capabilities(false, true),
            ColorMode::Ansi256
        );
        assert_eq!(
            ColorMode::from_capabilities(false, false),
            ColorMode::Ansi16
        );
    }

    #[test]
    fn semantic_style_uses_the_selected_palette() {
        let theme = Theme::light(ColorMode::TrueColor);
        assert_eq!(
            theme.style(ColorToken::Accent).fg,
            Some(theme.color(ColorToken::Accent))
        );
        assert_eq!(
            theme.palette().panel_style().bg,
            Some(theme.color(ColorToken::Surface))
        );
    }

    #[test]
    fn shipped_default_matches_frozen_palette() {
        // §11.6: the truecolor GraphiteSakura theme must equal the frozen
        // values in `colors::default_graphite_sakura`; changing either without
        // the other is caught here.
        let palette = truecolor_palette(ThemeKind::GraphiteSakura);
        let frozen = super::super::colors::default_graphite_sakura();
        let rgb = |color: Color| -> (u8, u8, u8) {
            match color {
                Color::Rgb(r, g, b) => (r, g, b),
                other => panic!("expected Rgb, got {other:?}"),
            }
        };
        assert_eq!(rgb(palette.background), (frozen.background.r, frozen.background.g, frozen.background.b));
        assert_eq!(rgb(palette.surface), (frozen.surface.r, frozen.surface.g, frozen.surface.b));
        assert_eq!(rgb(palette.surface_alt), (frozen.surface_alt.r, frozen.surface_alt.g, frozen.surface_alt.b));
        assert_eq!(rgb(palette.text), (frozen.text.r, frozen.text.g, frozen.text.b));
        assert_eq!(rgb(palette.muted), (frozen.muted.r, frozen.muted.g, frozen.muted.b));
        assert_eq!(rgb(palette.border), (frozen.border.r, frozen.border.g, frozen.border.b));
        assert_eq!(rgb(palette.border_strong), (frozen.border_strong.r, frozen.border_strong.g, frozen.border_strong.b));
        assert_eq!(rgb(palette.accent), (frozen.accent.r, frozen.accent.g, frozen.accent.b));
        assert_eq!(rgb(palette.accent_soft), (frozen.accent_soft.r, frozen.accent_soft.g, frozen.accent_soft.b));
        assert_eq!(rgb(palette.success), (frozen.success.r, frozen.success.g, frozen.success.b));
        assert_eq!(rgb(palette.warning), (frozen.warning.r, frozen.warning.g, frozen.warning.b));
        assert_eq!(rgb(palette.error), (frozen.error.r, frozen.error.g, frozen.error.b));
        assert_eq!(rgb(palette.info), (frozen.info.r, frozen.info.g, frozen.info.b));
        assert_eq!(rgb(palette.selection), (frozen.selection.r, frozen.selection.g, frozen.selection.b));
        assert_eq!(rgb(palette.progress), (frozen.progress.r, frozen.progress.g, frozen.progress.b));
    }
}
