//! Reusable visual primitives for the native MindCode terminal UI.
//!
//! The modules in this directory intentionally keep visual state independent
//! from the protocol renderer. A caller can select a theme, calculate a
//! workspace layout, and drive the animation scheduler without owning a
//! session or a terminal connection.

pub mod animation;
pub mod layout;
pub mod theme;

pub use animation::{
    frame_schedule, AnimationActivity, AnimationScheduler, FrameSchedule, MotionMode, PetalFrame,
    SakuraPetalField,
};
pub use layout::{
    calculate_layout, calculate_layout_with_composer, calculate_workspace_layout, Breakpoint,
    LayoutRects, PaneRatios, WorkspaceLayoutModel,
};
pub use theme::{ColorMode, ColorToken, Palette, Theme, ThemeKind};
