//! Deterministic sakura animation and adaptive redraw scheduling.

use std::time::Duration;

use ratatui::layout::Rect;

pub const ACTIVE_FRAME_INTERVAL: Duration = Duration::from_nanos(1_000_000_000 / 30);
pub const IDLE_FRAME_INTERVAL: Duration = Duration::from_nanos(1_000_000_000 / 5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MotionMode {
    #[default]
    Full,
    Reduced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnimationActivity {
    /// Content or petals are changing and should receive the high-rate tick.
    Active,
    /// A decorative animation remains visible but can update at low rate.
    Idle,
    /// No animation is visible; redraw only after an event or invalidation.
    Static,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameSchedule {
    Every(Duration),
    EventDriven,
}

impl FrameSchedule {
    pub const fn interval(self) -> Option<Duration> {
        match self {
            Self::Every(interval) => Some(interval),
            Self::EventDriven => None,
        }
    }

    pub fn frames_per_second(self) -> Option<u32> {
        match self {
            Self::Every(interval) if interval == ACTIVE_FRAME_INTERVAL => Some(30),
            Self::Every(interval) if interval == IDLE_FRAME_INTERVAL => Some(5),
            Self::Every(_) | Self::EventDriven => None,
        }
    }
}

/// Select the redraw policy without consulting wall-clock state.
pub const fn frame_schedule(motion: MotionMode, activity: AnimationActivity) -> FrameSchedule {
    match activity {
        AnimationActivity::Static => FrameSchedule::EventDriven,
        AnimationActivity::Active if matches!(motion, MotionMode::Full) => {
            FrameSchedule::Every(ACTIVE_FRAME_INTERVAL)
        }
        AnimationActivity::Active | AnimationActivity::Idle => {
            FrameSchedule::Every(IDLE_FRAME_INTERVAL)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnimationScheduler {
    pub motion: MotionMode,
    pub activity: AnimationActivity,
}

impl AnimationScheduler {
    pub const fn new(motion: MotionMode) -> Self {
        Self {
            motion,
            activity: AnimationActivity::Static,
        }
    }

    pub const fn with_activity(motion: MotionMode, activity: AnimationActivity) -> Self {
        Self { motion, activity }
    }

    pub const fn schedule(self) -> FrameSchedule {
        frame_schedule(self.motion, self.activity)
    }

    pub const fn set_activity(self, activity: AnimationActivity) -> Self {
        Self { activity, ..self }
    }

    pub const fn set_motion(self, motion: MotionMode) -> Self {
        Self { motion, ..self }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PetalFrame {
    /// Normalized horizontal position in the range 0..=1.
    pub x: f32,
    /// Normalized vertical position in the range 0..=1.
    pub y: f32,
    /// Rotation in degrees. Reduced motion keeps this at zero.
    pub rotation: f32,
    /// Opacity hint in the range 0..=1.
    pub opacity: f32,
    pub glyph: char,
}

impl PetalFrame {
    /// Convert a normalized frame into a terminal cell, if the target is non-empty.
    pub fn cell(self, area: Rect) -> Option<(u16, u16)> {
        if area.width == 0 || area.height == 0 {
            return None;
        }
        let x = (self.x.clamp(0.0, 1.0) * f32::from(area.width.saturating_sub(1))).round();
        let y = (self.y.clamp(0.0, 1.0) * f32::from(area.height.saturating_sub(1))).round();
        Some((
            area.x.saturating_add(x as u16),
            area.y.saturating_add(y as u16),
        ))
    }
}

#[derive(Debug, Clone, Copy)]
struct PetalSeed {
    x: f32,
    y: f32,
    drift: f32,
    speed: f32,
    phase: f32,
    spin: f32,
    opacity: f32,
    glyph: char,
}

/// A deterministic field of sakura petals.
///
/// Petals are generated from a small local PRNG and sampled from an explicit
/// elapsed duration. No global clock or random source is consulted, making
/// screenshots and golden tests reproducible.
#[derive(Debug, Clone)]
pub struct SakuraPetalField {
    petals: Vec<PetalSeed>,
}

impl Default for SakuraPetalField {
    fn default() -> Self {
        Self::new(0x5341_4B55_5241, 18)
    }
}

impl SakuraPetalField {
    pub fn new(seed: u64, count: usize) -> Self {
        let mut state = seed;
        let mut petals = Vec::with_capacity(count);
        const GLYPHS: [char; 3] = ['❀', '✿', '·'];
        for index in 0..count {
            let glyph = GLYPHS[(next_u64(&mut state) as usize) % GLYPHS.len()];
            let x = unit(&mut state);
            let y = unit(&mut state);
            let drift = 0.008 + unit(&mut state) * 0.035;
            let speed = 0.035 + unit(&mut state) * 0.095;
            let phase = unit(&mut state) * std::f32::consts::TAU;
            let spin = 18.0 + unit(&mut state) * 80.0;
            let opacity = 0.35 + unit(&mut state) * 0.65;
            petals.push(PetalSeed {
                x: (x + index as f32 * 0.013).fract(),
                y,
                drift,
                speed,
                phase,
                spin,
                opacity,
                glyph,
            });
        }
        Self { petals }
    }

    pub fn len(&self) -> usize {
        self.petals.len()
    }

    pub fn is_empty(&self) -> bool {
        self.petals.is_empty()
    }

    /// Sample the field at an explicit point in time.
    pub fn sample(&self, elapsed: Duration, motion: MotionMode) -> Vec<PetalFrame> {
        let seconds = elapsed.as_secs_f32();
        let seconds = if matches!(motion, MotionMode::Reduced) {
            (seconds * 5.0).round() / 5.0
        } else {
            seconds
        };

        self.petals
            .iter()
            .map(|petal| {
                let y = (petal.y + seconds * petal.speed).fract();
                let wave = (petal.phase + seconds * 1.15).sin();
                let x = (petal.x + wave * petal.drift).rem_euclid(1.0);
                let rotation = if matches!(motion, MotionMode::Full) {
                    (petal.phase.to_degrees() + seconds * petal.spin).rem_euclid(360.0)
                } else {
                    0.0
                };
                let fade = 0.82 + 0.18 * (petal.phase + seconds * 0.7).sin();
                PetalFrame {
                    x,
                    y,
                    rotation,
                    opacity: (petal.opacity * fade).clamp(0.0, 1.0),
                    glyph: petal.glyph,
                }
            })
            .collect()
    }

    pub fn sample_in(
        &self,
        elapsed: Duration,
        motion: MotionMode,
        area: Rect,
    ) -> Vec<(PetalFrame, Option<(u16, u16)>)> {
        self.sample(elapsed, motion)
            .into_iter()
            .map(|petal| {
                let cell = petal.cell(area);
                (petal, cell)
            })
            .collect()
    }
}

fn next_u64(state: &mut u64) -> u64 {
    *state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    *state
}

fn unit(state: &mut u64) -> f32 {
    let bits = next_u64(state) >> 11;
    (bits as f64 / 9_007_199_254_740_992.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduler_adapts_between_thirty_five_and_event_driven() {
        assert_eq!(
            frame_schedule(MotionMode::Full, AnimationActivity::Active),
            FrameSchedule::Every(ACTIVE_FRAME_INTERVAL)
        );
        assert_eq!(
            frame_schedule(MotionMode::Full, AnimationActivity::Idle),
            FrameSchedule::Every(IDLE_FRAME_INTERVAL)
        );
        assert_eq!(
            frame_schedule(MotionMode::Reduced, AnimationActivity::Active),
            FrameSchedule::Every(IDLE_FRAME_INTERVAL)
        );
        assert_eq!(
            frame_schedule(MotionMode::Reduced, AnimationActivity::Static),
            FrameSchedule::EventDriven
        );
        assert_eq!(
            FrameSchedule::Every(ACTIVE_FRAME_INTERVAL).frames_per_second(),
            Some(30)
        );
        assert_eq!(
            FrameSchedule::Every(IDLE_FRAME_INTERVAL).frames_per_second(),
            Some(5)
        );
    }

    #[test]
    fn scheduler_can_be_updated_without_mutable_global_state() {
        let scheduler =
            AnimationScheduler::new(MotionMode::Full).set_activity(AnimationActivity::Active);
        assert_eq!(scheduler.schedule().frames_per_second(), Some(30));
        assert_eq!(
            scheduler
                .set_motion(MotionMode::Reduced)
                .schedule()
                .frames_per_second(),
            Some(5)
        );
    }

    #[test]
    fn same_seed_and_time_produce_identical_petals() {
        let left =
            SakuraPetalField::new(42, 12).sample(Duration::from_millis(800), MotionMode::Full);
        let right =
            SakuraPetalField::new(42, 12).sample(Duration::from_millis(800), MotionMode::Full);
        assert_eq!(left, right);
        assert_ne!(
            left,
            SakuraPetalField::new(43, 12).sample(Duration::from_millis(800), MotionMode::Full)
        );
    }

    #[test]
    fn petals_stay_in_normalized_bounds_and_reduced_motion_has_no_rotation() {
        let full = SakuraPetalField::new(7, 24).sample(Duration::from_secs(9), MotionMode::Full);
        let reduced =
            SakuraPetalField::new(7, 24).sample(Duration::from_secs(9), MotionMode::Reduced);
        assert_eq!(full.len(), reduced.len());
        for (petal, reduced_petal) in full.iter().zip(reduced.iter()) {
            assert!((0.0..=1.0).contains(&petal.x));
            assert!((0.0..=1.0).contains(&petal.y));
            assert!((0.0..=1.0).contains(&petal.opacity));
            assert!((0.0..360.0).contains(&petal.rotation));
            assert_eq!(reduced_petal.rotation, 0.0);
        }
    }

    #[test]
    fn cell_projection_respects_the_target_rect() {
        let field = SakuraPetalField::new(1, 4);
        let area = Rect::new(10, 4, 30, 8);
        for (_, cell) in field.sample_in(Duration::from_secs(1), MotionMode::Full, area) {
            let (x, y) = cell.expect("non-empty target has a cell");
            assert!(x >= area.x && x < area.right());
            assert!(y >= area.y && y < area.bottom());
        }
        assert_eq!(
            PetalFrame {
                x: 0.5,
                y: 0.5,
                rotation: 0.0,
                opacity: 1.0,
                glyph: '❀',
            }
            .cell(Rect::new(0, 0, 0, 2)),
            None
        );
    }
}
