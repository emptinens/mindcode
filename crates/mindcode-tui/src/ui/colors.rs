//! Palette generation and harmony scoring for `/colors` (§11.6).
//!
//! All functions here are pure and deterministic: one seed produces one
//! palette, and one palette produces one harmony report. The metric is Oklab-
//! based (perceptually uniform enough for cheap, dependency-free scoring) and
//! calibrated so that established terminal palettes score above deliberately
//! hostile ones. The default palette is frozen by test so the generator can
//! never silently rewrite what the TUI ships.

use std::collections::BTreeMap;
use std::fmt;

/// An 8-bit-per-channel sRGB color.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }

    pub fn from_hex(hex: &str) -> Result<Self, ColorError> {
        let value = hex.trim().trim_start_matches('#');
        if value.len() != 6 {
            return Err(ColorError::InvalidHex);
        }
        let parse = |range: &str| -> Result<u8, ColorError> {
            u8::from_str_radix(range, 16).map_err(|_| ColorError::InvalidHex)
        };
        Ok(Self {
            r: parse(&value[0..2])?,
            g: parse(&value[2..4])?,
            b: parse(&value[4..6])?,
        })
    }

    pub fn to_hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }

    fn as_f64(self) -> [f64; 3] {
        [
            self.r as f64 / 255.0,
            self.g as f64 / 255.0,
            self.b as f64 / 255.0,
        ]
    }

    fn from_f64(channels: [f64; 3]) -> Self {
        let to_u8 = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round().clamp(0.0, 255.0) as u8;
        Self {
            r: to_u8(channels[0]),
            g: to_u8(channels[1]),
            b: to_u8(channels[2]),
        }
    }
}

/// A perceptual Oklab color (L in 0..1, a/b roughly -0.4..0.4).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Oklab {
    pub l: f64,
    pub a: f64,
    pub b: f64,
}

impl Oklab {
    pub fn chroma(self) -> f64 {
        (self.a * self.a + self.b * self.b).sqrt()
    }

    pub fn hue(self) -> f64 {
        self.b.atan2(self.a)
    }

    /// Squared Euclidean distance in Oklab space.  Roughly 0.01 is one JND.
    pub fn distance_sq(self, other: Oklab) -> f64 {
        let da = self.a - other.a;
        let db = self.b - other.b;
        let dl = self.l - other.l;
        dl * dl + da * da + db * db
    }
}

impl Rgb {
    pub fn to_oklab(self) -> Oklab {
        let [r, g, b] = self.as_f64();
        // sRGB → linear.
        let linear = |channel: f64| {
            if channel <= 0.04045 {
                channel / 12.92
            } else {
                ((channel + 0.055) / 1.055).powf(2.4)
            }
        };
        let (r, g, b) = (linear(r), linear(g), linear(b));
        // Linear sRGB → LMS.
        let l = 0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b;
        let m = 0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b;
        let s = 0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b;
        let (l, m, s) = (l.cbrt(), m.cbrt(), s.cbrt());
        // LMS → Oklab.
        Oklab {
            l: 0.210_454_255_3 * l + 0.793_617_785_0 * m - 0.004_072_046_8 * s,
            a: 1.977_998_495_1 * l - 2.428_592_205_0 * m + 0.450_593_709_9 * s,
            b: 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766_0 * s,
        }
    }

    pub fn from_oklab(oklab: Oklab) -> Self {
        // Oklab → LMS.
        let l = oklab.l + 0.396_337_777_4 * oklab.a + 0.215_803_757_3 * oklab.b;
        let m = oklab.l - 0.105_561_345_8 * oklab.a - 0.063_854_172_8 * oklab.b;
        let s = oklab.l - 0.089_484_177_5 * oklab.a - 1.291_485_548_0 * oklab.b;
        let (l, m, s) = (l * l * l, m * m * m, s * s * s);
        // LMS → linear sRGB.
        let r = 4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s;
        let g = -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s;
        let b = -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701_0 * s;
        // Linear sRGB → sRGB.
        let encode = |channel: f64| {
            if channel <= 0.003_130_8 {
                12.92 * channel
            } else {
                1.055 * channel.powf(1.0 / 2.4) - 0.055
            }
        };
        Rgb::from_f64([encode(r), encode(g), encode(b)])
    }
}

/// The 15 semantic color roles the palette covers, mirroring `ColorToken`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Role {
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

impl Role {
    pub const ALL: [Self; 15] = [
        Self::Background,
        Self::Surface,
        Self::SurfaceAlt,
        Self::Text,
        Self::Muted,
        Self::Border,
        Self::BorderStrong,
        Self::Accent,
        Self::AccentSoft,
        Self::Success,
        Self::Warning,
        Self::Error,
        Self::Info,
        Self::Selection,
        Self::Progress,
    ];

    /// Signal colors that must remain mutually distinguishable and colourblind-
    /// safe: success / warning / error / info plus the accent.
    pub const SIGNALS: [Self; 5] = [
        Self::Accent,
        Self::Success,
        Self::Warning,
        Self::Error,
        Self::Info,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Background => "background",
            Self::Surface => "surface",
            Self::SurfaceAlt => "surface_alt",
            Self::Text => "text",
            Self::Muted => "muted",
            Self::Border => "border",
            Self::BorderStrong => "border_strong",
            Self::Accent => "accent",
            Self::AccentSoft => "accent_soft",
            Self::Success => "success",
            Self::Warning => "warning",
            Self::Error => "error",
            Self::Info => "info",
            Self::Selection => "selection",
            Self::Progress => "progress",
        }
    }

    pub fn from_label(label: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|role| role.label() == label)
    }
}

impl fmt::Display for Role {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

/// A concrete palette: one RGB per semantic role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaletteSpec {
    pub background: Rgb,
    pub surface: Rgb,
    pub surface_alt: Rgb,
    pub text: Rgb,
    pub muted: Rgb,
    pub border: Rgb,
    pub border_strong: Rgb,
    pub accent: Rgb,
    pub accent_soft: Rgb,
    pub success: Rgb,
    pub warning: Rgb,
    pub error: Rgb,
    pub info: Rgb,
    pub selection: Rgb,
    pub progress: Rgb,
}

impl PaletteSpec {
    pub const fn color(self, role: Role) -> Rgb {
        match role {
            Role::Background => self.background,
            Role::Surface => self.surface,
            Role::SurfaceAlt => self.surface_alt,
            Role::Text => self.text,
            Role::Muted => self.muted,
            Role::Border => self.border,
            Role::BorderStrong => self.border_strong,
            Role::Accent => self.accent,
            Role::AccentSoft => self.accent_soft,
            Role::Success => self.success,
            Role::Warning => self.warning,
            Role::Error => self.error,
            Role::Info => self.info,
            Role::Selection => self.selection,
            Role::Progress => self.progress,
        }
    }

    pub fn as_hex_map(self) -> BTreeMap<&'static str, String> {
        Role::ALL
            .into_iter()
            .map(|role| (role.label(), self.color(role).to_hex()))
            .collect()
    }

    /// Return a copy with one role overridden (used by `/colors set`).
    pub const fn with_override(self, role: Role, color: Rgb) -> Self {
        match role {
            Role::Background => Self {
                background: color,
                ..self
            },
            Role::Surface => Self {
                surface: color,
                ..self
            },
            Role::SurfaceAlt => Self {
                surface_alt: color,
                ..self
            },
            Role::Text => Self {
                text: color,
                ..self
            },
            Role::Muted => Self {
                muted: color,
                ..self
            },
            Role::Border => Self {
                border: color,
                ..self
            },
            Role::BorderStrong => Self {
                border_strong: color,
                ..self
            },
            Role::Accent => Self {
                accent: color,
                ..self
            },
            Role::AccentSoft => Self {
                accent_soft: color,
                ..self
            },
            Role::Success => Self {
                success: color,
                ..self
            },
            Role::Warning => Self {
                warning: color,
                ..self
            },
            Role::Error => Self {
                error: color,
                ..self
            },
            Role::Info => Self {
                info: color,
                ..self
            },
            Role::Selection => Self {
                selection: color,
                ..self
            },
            Role::Progress => Self {
                progress: color,
                ..self
            },
        }
    }

    pub fn with_overrides<I: IntoIterator<Item = (Role, Rgb)>>(mut self, overrides: I) -> Self {
        for (role, color) in overrides {
            self = self.with_override(role, color);
        }
        self
    }

    /// Export as a TOML table keyed by role name.
    pub fn to_toml(self) -> String {
        Role::ALL
            .into_iter()
            .map(|role| format!("{} = \"{}\"", role.label(), self.color(role).to_hex()))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// The frozen Graphite Sakura default.  This is a hand-maintained copy of the
/// values in `ui/theme.rs`; the frozen-default test asserts they never drift.
pub fn default_graphite_sakura() -> PaletteSpec {
    PaletteSpec {
        background: Rgb::new(11, 11, 13),
        surface: Rgb::new(18, 18, 22),
        surface_alt: Rgb::new(25, 25, 31),
        text: Rgb::new(242, 242, 243),
        muted: Rgb::new(138, 138, 148),
        border: Rgb::new(52, 52, 60),
        border_strong: Rgb::new(82, 82, 94),
        accent: Rgb::new(255, 79, 163),
        accent_soft: Rgb::new(243, 166, 200),
        success: Rgb::new(111, 207, 151),
        warning: Rgb::new(243, 194, 93),
        error: Rgb::new(245, 108, 114),
        info: Rgb::new(117, 185, 255),
        selection: Rgb::new(64, 31, 54),
        progress: Rgb::new(255, 79, 163),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColorError {
    InvalidHex,
    UnknownRole(String),
}

impl fmt::Display for ColorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidHex => formatter.write_str("expected #rrggbb"),
            Self::UnknownRole(role) => write!(formatter, "unknown color role: {role}"),
        }
    }
}

impl std::error::Error for ColorError {}

/// A component-wise harmony report.  Every component is in `0.0..=1.0`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HarmonyReport {
    /// Aggregated score (`0.4 * mean + 0.6 * worst`).
    pub score: f64,
    pub readability: f64,
    pub distinctness: f64,
    pub hue_harmony: f64,
    pub chroma_coherence: f64,
    pub colourblind: f64,
}

/// Score a palette against the §11.6 harmony criteria.
pub fn score_palette(spec: &PaletteSpec) -> HarmonyReport {
    let text = spec.text.to_oklab();
    let background = spec.background.to_oklab();
    let signals: Vec<Oklab> = Role::SIGNALS
        .into_iter()
        .map(|role| spec.color(role).to_oklab())
        .collect();

    let readability = readability(text, background);
    let distinctness = distinctness(&signals);
    let hue_harmony = hue_harmony(&signals);
    let chroma_coherence = chroma_coherence(&signals);
    let colourblind = colourblind_safety(spec);

    let components = [
        readability,
        distinctness,
        hue_harmony,
        chroma_coherence,
        colourblind,
    ];
    let mean = components.iter().sum::<f64>() / components.len() as f64;
    let worst = components.iter().copied().fold(f64::INFINITY, f64::min);
    let score = 0.4 * mean + 0.6 * worst;

    HarmonyReport {
        score,
        readability,
        distinctness,
        hue_harmony,
        chroma_coherence,
        colourblind,
    }
}

/// WCAG-relative-luminance-based contrast ratio between two colors, mapped to
/// `0..=1` with 7:1 (AAA) scoring 1.0.
fn readability(fg: Oklab, bg: Oklab) -> f64 {
    // Relative luminance is cheaply approximated from the Oklab lightness;
    // using the channel-independent path keeps this dependency-free and stable.
    let l1 = fg.l + 0.05;
    let l2 = bg.l + 0.05;
    let (lighter, darker) = if l1 >= l2 { (l1, l2) } else { (l2, l1) };
    let ratio = lighter / darker;
    ((ratio - 1.0) / 6.0).clamp(0.0, 1.0)
}

/// Minimum pairwise Oklab distance among the signal colors, mapped so roughly
/// `0.25` (≈ 25 JND) scores 1.0.
fn distinctness(signals: &[Oklab]) -> f64 {
    let mut min = f64::INFINITY;
    for (index, first) in signals.iter().enumerate() {
        for second in &signals[index + 1..] {
            min = min.min(first.distance_sq(*second));
        }
    }
    (min.sqrt() / 0.25).clamp(0.0, 1.0)
}

/// Mean resultant length of the signal hues: a coherent palette (related hues)
/// scores higher than scattered clashing hues.
fn hue_harmony(signals: &[Oklab]) -> f64 {
    let (mut x, mut y) = (0.0, 0.0);
    for signal in signals {
        let hue = signal.hue();
        x += hue.cos();
        y += hue.sin();
    }
    let resultant = (x * x + y * y).sqrt() / signals.len() as f64;
    resultant.clamp(0.0, 1.0)
}

/// Inverse chroma variance among the signal colors: similar saturation scores
/// higher than a mix of neon and near-gray.
fn chroma_coherence(signals: &[Oklab]) -> f64 {
    let chromas: Vec<f64> = signals.iter().map(|signal| signal.chroma()).collect();
    let mean = chromas.iter().sum::<f64>() / chromas.len() as f64;
    let variance = chromas
        .iter()
        .map(|chroma| (chroma - mean).powi(2))
        .sum::<f64>()
        / chromas.len() as f64;
    let spread = variance.sqrt() / 0.15;
    (1.0 - spread).clamp(0.0, 1.0)
}

/// Lightness separation of success/warning/error: red-green colourblindness
/// collapses hue into a blue-yellow axis, so the status colors must also differ
/// in lightness to stay distinguishable.
fn colourblind_safety(spec: &PaletteSpec) -> f64 {
    let statuses = [spec.success, spec.warning, spec.error].map(|color| color.to_oklab().l);
    let mut min = f64::INFINITY;
    for (index, first) in statuses.iter().enumerate() {
        for second in &statuses[index + 1..] {
            min = min.min((first - second).abs());
        }
    }
    (min / 0.2).clamp(0.0, 1.0)
}

/// Generate a deterministic, harmonious palette from a seed color (§11.6).
///
/// The seed contributes its hue (and its light/dark polarity); the remaining
/// roles are placed with the golden angle around the seed hue and fixed
/// lightness tiers, so the same seed always produces the same palette.
pub fn generate_palette(seed: Rgb) -> PaletteSpec {
    let seed_lab = seed.to_oklab();
    let seed_hue = seed_lab.hue();
    let dark = seed_lab.l < 0.6;

    let (bg_l, surface_l, surface_alt_l, text_l, muted_l, border_l, border_strong_l) = if dark {
        (0.05, 0.09, 0.13, 0.95, 0.55, 0.22, 0.34)
    } else {
        (0.96, 1.00, 0.93, 0.10, 0.45, 0.80, 0.65)
    };

    let neutral = |l: f64| Rgb::from_oklab(Oklab { l, a: 0.0, b: 0.0 });
    let at = |l: f64, chroma: f64, hue: f64| {
        Rgb::from_oklab(Oklab {
            l,
            a: chroma * hue.cos(),
            b: chroma * hue.sin(),
        })
    };

    // Signal hues rotate from the seed by the golden angle; status colors use
    // lightness tiers far enough apart to survive colourblindness.
    let accent_hue = seed_hue;
    let success_hue = seed_hue + 2.399_963;
    let warning_hue = seed_hue + 1.6;
    let error_hue = seed_hue + 0.4;
    let info_hue = seed_hue + 4.4;

    let signal_l = if dark { 0.72 } else { 0.38 };
    let success_l = if dark { 0.74 } else { 0.42 };
    let warning_l = if dark { 0.86 } else { 0.60 };
    let error_l = if dark { 0.50 } else { 0.26 };

    PaletteSpec {
        background: neutral(bg_l),
        surface: neutral(surface_l),
        surface_alt: neutral(surface_alt_l),
        text: neutral(text_l),
        muted: neutral(muted_l),
        border: neutral(border_l),
        border_strong: neutral(border_strong_l),
        accent: at(signal_l, 0.17, accent_hue),
        accent_soft: at(if dark { 0.80 } else { 0.28 }, 0.08, accent_hue),
        success: at(success_l, 0.13, success_hue),
        warning: at(warning_l, 0.13, warning_hue),
        error: at(error_l, 0.17, error_hue),
        info: at(signal_l, 0.15, info_hue),
        selection: at(if dark { 0.25 } else { 0.85 }, 0.05, accent_hue),
        progress: at(signal_l, 0.17, accent_hue),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips() {
        let color = Rgb::new(255, 79, 163);
        assert_eq!(Rgb::from_hex("#ff4fa3").unwrap(), color);
        assert_eq!(color.to_hex(), "#ff4fa3");
        assert!(Rgb::from_hex("ff4fa3").is_ok());
        assert!(matches!(Rgb::from_hex("#fff"), Err(ColorError::InvalidHex)));
        assert!(matches!(
            Rgb::from_hex("#gggggg"),
            Err(ColorError::InvalidHex)
        ));
    }

    #[test]
    fn oklab_round_trip_is_stable() {
        for color in [
            Rgb::new(255, 79, 163),
            Rgb::new(11, 11, 13),
            Rgb::new(111, 207, 151),
            Rgb::new(0, 0, 0),
            Rgb::new(255, 255, 255),
        ] {
            let round = Rgb::from_oklab(color.to_oklab());
            assert!(
                (round.r as i32 - color.r as i32).abs() <= 2,
                "{color:?} → {round:?}"
            );
            assert!(
                (round.g as i32 - color.g as i32).abs() <= 2,
                "{color:?} → {round:?}"
            );
            assert!(
                (round.b as i32 - color.b as i32).abs() <= 2,
                "{color:?} → {round:?}"
            );
        }
    }

    #[test]
    fn default_palette_is_frozen() {
        // Hand-maintained copy of ui/theme.rs truecolor GraphiteSakura.  If the
        // shipped default changes, this test must change with it — deliberately.
        let frozen = PaletteSpec {
            background: Rgb::new(11, 11, 13),
            surface: Rgb::new(18, 18, 22),
            surface_alt: Rgb::new(25, 25, 31),
            text: Rgb::new(242, 242, 243),
            muted: Rgb::new(138, 138, 148),
            border: Rgb::new(52, 52, 60),
            border_strong: Rgb::new(82, 82, 94),
            accent: Rgb::new(255, 79, 163),
            accent_soft: Rgb::new(243, 166, 200),
            success: Rgb::new(111, 207, 151),
            warning: Rgb::new(243, 194, 93),
            error: Rgb::new(245, 108, 114),
            info: Rgb::new(117, 185, 255),
            selection: Rgb::new(64, 31, 54),
            progress: Rgb::new(255, 79, 163),
        };
        assert_eq!(default_graphite_sakura(), frozen);
    }

    #[test]
    fn generator_is_deterministic() {
        let seed = Rgb::new(255, 79, 163);
        assert_eq!(generate_palette(seed), generate_palette(seed));
    }

    #[test]
    fn generated_palette_is_exportable_and_parses() {
        let seed = Rgb::new(120, 80, 200);
        let palette = generate_palette(seed);
        let hex_map = palette.as_hex_map();
        assert_eq!(hex_map.len(), Role::ALL.len());
        for role in Role::ALL {
            let hex = hex_map[role.label()].clone();
            assert_eq!(Rgb::from_hex(&hex).unwrap(), palette.color(role));
        }
        let toml = palette.to_toml();
        assert!(toml.contains("accent = \"#"));
    }

    #[test]
    fn calibration_palettes_beat_hostile_palettes() {
        // A "hostile" palette: identical signal colors, low text/background
        // contrast, no lightness separation between the status colors.
        let hostile = PaletteSpec {
            background: Rgb::new(100, 100, 100),
            surface: Rgb::new(100, 100, 100),
            surface_alt: Rgb::new(100, 100, 100),
            text: Rgb::new(110, 110, 110),
            muted: Rgb::new(105, 105, 105),
            border: Rgb::new(100, 100, 100),
            border_strong: Rgb::new(100, 100, 100),
            accent: Rgb::new(200, 60, 60),
            accent_soft: Rgb::new(200, 60, 60),
            success: Rgb::new(200, 60, 60),
            warning: Rgb::new(200, 60, 60),
            error: Rgb::new(200, 60, 60),
            info: Rgb::new(200, 60, 60),
            selection: Rgb::new(200, 60, 60),
            progress: Rgb::new(200, 60, 60),
        };
        let generated = generate_palette(Rgb::new(255, 79, 163));
        let hostile_score = score_palette(&hostile).score;
        let generated_score = score_palette(&generated).score;
        let default_score = score_palette(&default_graphite_sakura()).score;

        assert!(
            generated_score > hostile_score,
            "generated {generated_score:.3} should beat hostile {hostile_score:.3}"
        );
        assert!(
            default_score > hostile_score,
            "default {default_score:.3} should beat hostile {hostile_score:.3}"
        );
    }

    #[test]
    fn status_colors_survive_colourblindness() {
        let palette = generate_palette(Rgb::new(255, 79, 163));
        let report = score_palette(&palette);
        assert!(
            report.colourblind > 0.5,
            "status colors should be lightness-separated: {report:?}"
        );
    }
}
