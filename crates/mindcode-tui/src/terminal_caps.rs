//! Terminal capability probing and the kitty keyboard protocol (§11.9).
//!
//! `Shift+Enter` is only distinguishable from `Enter` when the terminal speaks
//! the kitty keyboard protocol (`CSI-u`). This module (a) requests the protocol
//! on startup and (b) classifies the three known broken setups from a small,
//! secret-free probe so `/terminal-setup` can point at the right fix. The
//! diagnosis is a pure function of the probe and is therefore table-testable.

use crossterm::event::{KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags};

/// Enable the kitty keyboard protocol (progressive enhancement, first level):
/// escape and modified keys are sent as unambiguous `CSI-u` sequences. The
/// request is a no-op on terminals that do not implement the protocol.
pub fn enable_keyboard_enhancement() -> std::io::Result<()> {
    let mut stdout = std::io::stdout();
    // `DISAMBIGUATE_ESCAPE_CODES` is the first enhancement level: it is the
    // minimum needed to tell `Shift+Enter` apart from `Enter`.
    crossterm::execute!(
        stdout,
        PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::from_bits_truncate(0b0000_0001))
    )
    .map(|_| ())
}

/// Disable the protocol (pops the level pushed by [`enable_keyboard_enhancement`]).
pub fn disable_keyboard_enhancement() -> std::io::Result<()> {
    let mut stdout = std::io::stdout();
    crossterm::execute!(stdout, PopKeyboardEnhancementFlags).map(|_| ())
}

/// A secret-free snapshot of the terminal environment, enough to diagnose why
/// `Shift+Enter` might not produce a newline.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerminalProbe {
    pub term: String,
    pub term_program: String,
    pub inside_tmux: bool,
    /// Whether the terminal answered the kitty keyboard query (`CSI ? u`).
    pub kitty_query_replied: bool,
    /// Raw `CSI c` device-attribute reply, if any.
    pub device_attributes: Option<String>,
}

impl TerminalProbe {
    /// Build a probe from the real process environment (no I/O).
    pub fn from_env() -> Self {
        Self {
            term: std::env::var("TERM").unwrap_or_default(),
            term_program: std::env::var("TERM_PROGRAM").unwrap_or_default(),
            inside_tmux: std::env::var("TMUX").map(|value| !value.is_empty()).unwrap_or(false),
            kitty_query_replied: false,
            device_attributes: None,
        }
    }
}

/// The outcome of `/terminal-setup` for `Shift+Enter`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShiftEnterStatus {
    /// The protocol was accepted; `Shift+Enter` inserts a newline.
    Supported,
    /// Terminal.app ignores the kitty query; use `Option+Enter` or backslash.
    TerminalAppIgnoresRequest,
    /// tmux intercepts the protocol; the user must enable `extended-keys`.
    TmuxNeedsExtendedKeys,
    /// WezTerm must opt in via `enable_kitty_keyboard = true`.
    WezTermNeedsKittyConfig,
    /// No known-good terminal matched and the query did not answer.
    Unknown,
}

impl ShiftEnterStatus {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::TerminalAppIgnoresRequest => "terminal-app-ignores-request",
            Self::TmuxNeedsExtendedKeys => "tmux-needs-extended-keys",
            Self::WezTermNeedsKittyConfig => "wezterm-needs-kitty-config",
            Self::Unknown => "unknown",
        }
    }

    pub const fn advice(self) -> &'static str {
        match self {
            Self::Supported => "Shift+Enter inserts a newline.",
            Self::TerminalAppIgnoresRequest => {
                "Terminal.app ignores the kitty keyboard request; use Option+Enter or end the line with a backslash."
            }
            Self::TmuxNeedsExtendedKeys => {
                "Inside tmux enable extended keys: set -ga terminal-features ',*:extended-keys' (or set -g extended-keys on for older tmux)."
            }
            Self::WezTermNeedsKittyConfig => {
                "WezTerm needs enable_kitty_keyboard = true in ~/.config/wezterm/wezterm.lua."
            }
            Self::Unknown => {
                "Terminal did not confirm the kitty keyboard protocol; use Option+Enter or a trailing backslash for a newline."
            }
        }
    }
}

/// Classify `Shift+Enter` support from a probe.  Order matters: tmux is checked
/// first because it wraps every terminal, then the known-unsupported Terminal.app
/// case, then WezTerm's opt-in requirement, then the query result.
pub fn diagnose_shift_enter(probe: &TerminalProbe) -> ShiftEnterStatus {
    if probe.inside_tmux {
        return ShiftEnterStatus::TmuxNeedsExtendedKeys;
    }
    let program = probe.term_program.to_ascii_lowercase();
    if program == "apple_terminal" {
        return ShiftEnterStatus::TerminalAppIgnoresRequest;
    }
    if program == "wezterm" && !probe.kitty_query_replied {
        return ShiftEnterStatus::WezTermNeedsKittyConfig;
    }
    if probe.kitty_query_replied || is_kitty_family(&program) {
        return ShiftEnterStatus::Supported;
    }
    ShiftEnterStatus::Unknown
}

fn is_kitty_family(term_program: &str) -> bool {
    matches!(
        term_program,
        "kitty" | "ghostty" | "wezterm" | "alacritty" | "foot" | "iterm.app" | "iTerm.app"
    )
}

/// Render the `/terminal-setup` transcript text.
pub fn terminal_setup_report(probe: &TerminalProbe) -> String {
    let status = diagnose_shift_enter(probe);
    let term = if probe.term.is_empty() { "unset" } else { probe.term.as_str() };
    let program = if probe.term_program.is_empty() {
        "unset"
    } else {
        probe.term_program.as_str()
    };
    format!(
        "terminal: {term} (program {program})\nshift+enter: {}\nadvice: {}",
        status.label(),
        status.advice()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmux_wins_regardless_of_terminal() {
        let probe = TerminalProbe {
            inside_tmux: true,
            kitty_query_replied: true,
            term_program: "kitty".to_owned(),
            ..TerminalProbe::default()
        };
        assert_eq!(diagnose_shift_enter(&probe), ShiftEnterStatus::TmuxNeedsExtendedKeys);
    }

    #[test]
    fn terminal_app_is_detected_even_when_query_answers() {
        let probe = TerminalProbe {
            term_program: "Apple_Terminal".to_owned(),
            kitty_query_replied: true,
            ..TerminalProbe::default()
        };
        assert_eq!(
            diagnose_shift_enter(&probe),
            ShiftEnterStatus::TerminalAppIgnoresRequest
        );
    }

    #[test]
    fn wezterm_without_confirmation_needs_config() {
        let probe = TerminalProbe {
            term_program: "WezTerm".to_owned(),
            kitty_query_replied: false,
            ..TerminalProbe::default()
        };
        assert_eq!(
            diagnose_shift_enter(&probe),
            ShiftEnterStatus::WezTermNeedsKittyConfig
        );
    }

    #[test]
    fn kitty_family_and_query_reply_are_supported() {
        for program in ["kitty", "ghostty", "alacritty", "foot", "iTerm.app"] {
            let probe = TerminalProbe {
                term_program: program.to_owned(),
                kitty_query_replied: false,
                ..TerminalProbe::default()
            };
            assert_eq!(diagnose_shift_enter(&probe), ShiftEnterStatus::Supported);
        }
        let answered = TerminalProbe {
            term_program: "xterm".to_owned(),
            kitty_query_replied: true,
            ..TerminalProbe::default()
        };
        assert_eq!(diagnose_shift_enter(&answered), ShiftEnterStatus::Supported);
    }

    #[test]
    fn unknown_terminal_without_answer_is_unknown() {
        let probe = TerminalProbe {
            term_program: "xterm".to_owned(),
            ..TerminalProbe::default()
        };
        assert_eq!(diagnose_shift_enter(&probe), ShiftEnterStatus::Unknown);
    }

    #[test]
    fn report_is_secret_free_and_readable() {
        let report = terminal_setup_report(&TerminalProbe {
            term: "xterm-256color".to_owned(),
            term_program: "kitty".to_owned(),
            ..TerminalProbe::default()
        });
        assert!(report.contains("shift+enter: supported"));
        assert!(report.contains("kitty"));
    }
}
