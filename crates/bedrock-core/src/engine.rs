//! Input engine: turns pointer events (in screen CSS pixels) into strokes,
//! erasing and navigation. Platform shells (web, native) only forward events
//! and draw what the engine exposes, so behaviour is identical everywhere and
//! fully unit tested here.
//!
//! Rules:
//! * Pen and mouse draw (or erase, depending on the tool).
//! * Fingers navigate: one finger pans, two fingers pan + pinch-zoom.
//!   With "finger drawing" on, one finger draws instead.
//! * Palm rejection: while a pen is down, touches are ignored, and a pen
//!   touching down cancels any finger gesture.
//! * Two-finger double tap = undo, three-finger double tap = redo.

use crate::brush::Brush;
use crate::camera::Camera;
use crate::document::Document;
use crate::eraser;
use crate::geom::Vec2;
use crate::input::InputPoint;
use crate::stroke::{InputDevice, Stroke};
use crate::tessellate::{self, Mesh};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerKind {
    Pen,
    /// The eraser end / button of a stylus.
    PenEraser,
    Mouse,
    Touch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Draw,
    /// Erase whole strokes.
    EraseStroke,
    /// Cut away only what the eraser touches.
    ErasePartial,
}

/// One sample as delivered by the platform, in screen space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenSample {
    pub x: f64,
    pub y: f64,
    pub pressure: f32,
    pub altitude: f32,
    pub azimuth: f32,
    /// Unix epoch milliseconds.
    pub time: f64,
}

impl ScreenSample {
    pub fn new(x: f64, y: f64, pressure: f32, time: f64) -> Self {
        ScreenSample { x, y, pressure, altitude: std::f32::consts::FRAC_PI_2, azimuth: 0.0, time }
    }
    fn pos(&self) -> Vec2 {
        Vec2::new(self.x, self.y)
    }
}

#[derive(Debug)]
enum Active {
    Drawing { pointer: i32, stroke: Stroke, last_screen: Vec2 },
    Erasing { pointer: i32, last_world: Vec2, partial: bool },
}

#[derive(Debug, Default)]
struct TouchGesture {
    touches: BTreeMap<i32, Vec2>,
    /// Was this gesture ever two-finger? (for tap-to-undo)
    max_touches: usize,
    start_time: f64,
    moved: f64,
    cancelled: bool,
}

pub const TAP_MAX_MS: f64 = 300.0;
pub const TAP_MAX_MOVE: f64 = 12.0;
/// Longest pause between the two taps of a double tap.
pub const DOUBLE_TAP_GAP_MS: f64 = 350.0;

pub struct Engine {
    pub doc: Document,
    pub camera: Camera,
    pub brush: Brush,
    pub tool: Tool,
    /// Eraser radius in screen pixels.
    pub eraser_size: f64,
    pub finger_drawing: bool,
    active: Option<Active>,
    predicted: Vec<InputPoint>,
    touch: TouchGesture,
    /// Previous multi-finger tap: (finger count, time it ended).
    last_tap: Option<(usize, f64)>,
    pen_down: bool,
    /// The committed scene (strokes, camera) must be redrawn.
    dirty: bool,
    /// Only the live stroke layer must be redrawn.
    live_dirty: bool,
}

impl Engine {
    pub fn new(seed: u64) -> Self {
        Engine {
            doc: Document::new(seed),
            camera: Camera::default(),
            brush: Brush::default(),
            tool: Tool::Draw,
            eraser_size: 12.0,
            finger_drawing: false,
            active: None,
            predicted: Vec::new(),
            touch: TouchGesture::default(),
            last_tap: None,
            pen_down: false,
            dirty: true,
            live_dirty: true,
        }
    }

    pub fn resize(&mut self, width: f64, height: f64) {
        self.camera.viewport = Vec2::new(width.max(1.0), height.max(1.0));
        self.dirty = true;
    }

    /// True if something changed since the last [`Engine::mark_rendered`].
    pub fn needs_render(&self) -> bool {
        self.dirty || self.live_dirty
    }
    /// The committed strokes / camera changed (redraw the base layer).
    pub fn needs_scene_render(&self) -> bool {
        self.dirty
    }
    /// The live stroke changed (redraw the fast overlay layer).
    pub fn needs_live_render(&self) -> bool {
        self.dirty || self.live_dirty
    }
    pub fn mark_rendered(&mut self) {
        self.dirty = false;
        self.live_dirty = false;
    }
    pub fn invalidate(&mut self) {
        self.dirty = true;
    }

    pub fn is_drawing(&self) -> bool {
        matches!(self.active, Some(Active::Drawing { .. }))
    }

    /// Replace the document (e.g. after opening a file) and frame its content.
    pub fn set_document(&mut self, doc: Document) {
        self.active = None;
        self.predicted.clear();
        self.doc = doc;
        let b = self.doc.bounds();
        if b.is_empty() {
            self.camera.offset = Vec2::ZERO;
            self.camera.zoom = 1.0;
        } else {
            self.camera.fit(&b, 40.0);
        }
        self.dirty = true;
    }

    fn to_input(&self, s: &ScreenSample, start_time: f64) -> InputPoint {
        let w = self.camera.screen_to_world(s.pos());
        InputPoint {
            x: w.x,
            y: w.y,
            pressure: s.pressure,
            altitude: s.altitude,
            azimuth: s.azimuth,
            t: s.time - start_time,
        }
        .sanitized()
    }

    fn draws(&self, kind: PointerKind) -> bool {
        match kind {
            PointerKind::Pen | PointerKind::Mouse | PointerKind::PenEraser => true,
            PointerKind::Touch => self.finger_drawing,
        }
    }

    fn device(kind: PointerKind) -> InputDevice {
        match kind {
            PointerKind::Pen | PointerKind::PenEraser => InputDevice::Pen,
            PointerKind::Mouse => InputDevice::Mouse,
            PointerKind::Touch => InputDevice::Touch,
        }
    }

    pub fn pointer_down(&mut self, id: i32, kind: PointerKind, s: ScreenSample) {
        if matches!(kind, PointerKind::Pen | PointerKind::PenEraser) {
            self.pen_down = true;
            // Palm rejection: a pen always wins over fingers.
            self.touch = TouchGesture::default();
            self.last_tap = None;
            if matches!(self.active, Some(Active::Drawing { stroke: Stroke { device: InputDevice::Touch, .. }, .. })) {
                self.active = None;
            }
        }
        if kind == PointerKind::Touch {
            if self.pen_down {
                return;
            }
            self.touch_down(id, s);
            if self.touch.touches.len() > 1 || !self.finger_drawing {
                return;
            }
        }
        if !self.draws(kind) || self.active.is_some() {
            return;
        }
        let tool =
            if kind == PointerKind::PenEraser && self.tool == Tool::Draw { Tool::EraseStroke } else { self.tool };
        match tool {
            Tool::Draw => {
                let id_ = self.doc.next_id();
                let mut stroke = Stroke::new(id_, self.brush, s.time, Self::device(kind), Vec::new());
                stroke.push(self.to_input(&s, s.time));
                self.active = Some(Active::Drawing { pointer: id, stroke, last_screen: s.pos() });
            }
            Tool::EraseStroke | Tool::ErasePartial => {
                self.doc.begin_group();
                let w = self.camera.screen_to_world(s.pos());
                let partial = tool == Tool::ErasePartial;
                self.active = Some(Active::Erasing { pointer: id, last_world: w, partial });
                self.erase_segment(w, w, partial);
            }
        }
        self.predicted.clear();
        self.live_dirty = true;
        self.dirty |= !self.is_drawing();
    }

    /// Feed one (coalesced) sample. Call once per sample, in order.
    pub fn pointer_move(&mut self, id: i32, kind: PointerKind, s: ScreenSample) {
        if kind == PointerKind::Touch && self.touch.touches.contains_key(&id) && !self.is_pointer_active(id) {
            self.touch_move(id, s);
            return;
        }
        match &mut self.active {
            Some(Active::Drawing { pointer, stroke, last_screen }) if *pointer == id => {
                let last = stroke.points.last().copied();
                // Skip sub-pixel jitter unless pressure meaningfully changed.
                if s.pos().distance(*last_screen) < 0.5 && last.is_some_and(|l| (l.pressure - s.pressure).abs() < 0.02)
                {
                    return;
                }
                *last_screen = s.pos();
                let start = stroke.start_time;
                let w = self.camera.screen_to_world(s.pos());
                let p = InputPoint {
                    x: w.x,
                    y: w.y,
                    pressure: s.pressure,
                    altitude: s.altitude,
                    azimuth: s.azimuth,
                    t: s.time - start,
                }
                .sanitized();
                stroke.push(p);
                self.live_dirty = true;
            }
            Some(Active::Erasing { pointer, last_world, partial }) if *pointer == id => {
                let w = self.camera.screen_to_world(s.pos());
                let (from, partial) = (*last_world, *partial);
                *last_world = w;
                self.erase_segment(from, w, partial);
                self.dirty = true;
            }
            _ => {}
        }
    }

    /// Predicted future samples (e.g. `getPredictedEvents()`); drawn with the
    /// live stroke to hide latency but never saved. Replaces earlier ones.
    pub fn set_predicted(&mut self, id: i32, samples: &[ScreenSample]) {
        if let Some(Active::Drawing { pointer, stroke, .. }) = &self.active {
            if *pointer == id {
                let start = stroke.start_time;
                self.predicted = samples.iter().map(|s| self.to_input(s, start)).collect();
                self.live_dirty = true;
            }
        }
    }

    pub fn pointer_up(&mut self, id: i32, kind: PointerKind, s: Option<ScreenSample>) {
        if matches!(kind, PointerKind::Pen | PointerKind::PenEraser) {
            self.pen_down = false;
        }
        if kind == PointerKind::Touch && self.touch.touches.contains_key(&id) {
            if let Some(s) = s {
                self.touch_up(id, s.time);
            } else {
                self.touch.touches.remove(&id);
            }
        }
        // The up position is only ink if it still has contact pressure. Pens
        // report 0 here (and often a position after lift-off), so adding it
        // would draw a tail past where the tip left the glass.
        if let Some(s) = s {
            if self.is_pointer_active(id) && s.pressure > 0.0 {
                self.pointer_move(id, kind, s);
            }
        }
        match self.active.take() {
            Some(Active::Drawing { pointer, stroke, .. }) if pointer == id => {
                self.doc.add_stroke(stroke);
            }
            Some(Active::Erasing { pointer, .. }) if pointer == id => {
                self.doc.end_group();
            }
            other => self.active = other,
        }
        self.predicted.clear();
        self.dirty = true;
    }

    /// The platform cancelled the pointer (e.g. iOS took over the gesture).
    /// A stroke in progress is discarded.
    pub fn pointer_cancel(&mut self, id: i32, kind: PointerKind) {
        if matches!(kind, PointerKind::Pen | PointerKind::PenEraser) {
            self.pen_down = false;
        }
        self.touch.touches.remove(&id);
        if self.is_pointer_active(id) {
            if let Some(Active::Erasing { .. }) = self.active {
                self.doc.end_group();
            }
            self.active = None;
            self.predicted.clear();
            self.dirty = true;
        }
    }

    fn is_pointer_active(&self, id: i32) -> bool {
        match &self.active {
            Some(Active::Drawing { pointer, .. }) | Some(Active::Erasing { pointer, .. }) => *pointer == id,
            None => false,
        }
    }

    fn erase_segment(&mut self, a: Vec2, b: Vec2, partial: bool) {
        let radius = self.eraser_size / self.camera.zoom / 2.0;
        if partial {
            let mut removed = Vec::new();
            let mut pieces = Vec::new();
            let candidates: Vec<Stroke> =
                self.doc.strokes().iter().filter(|s| eraser::touches(s, a, b, radius)).cloned().collect();
            for s in &candidates {
                let doc = &mut self.doc;
                if let Some(parts) = eraser::split(s, a, b, radius, || doc.next_id()) {
                    removed.push(s.id);
                    pieces.extend(parts.into_iter().map(|p| (s.id, p)));
                }
            }
            if !removed.is_empty() {
                self.doc.replace(&removed, pieces);
            }
        } else {
            let hit = eraser::strokes_hit(self.doc.strokes(), a, b, radius);
            if !hit.is_empty() {
                self.doc.replace(&hit, vec![]);
            }
        }
    }

    // ----- touch navigation -------------------------------------------------

    fn touch_down(&mut self, id: i32, s: ScreenSample) {
        if self.touch.touches.is_empty() {
            self.touch = TouchGesture { start_time: s.time, ..Default::default() };
        }
        self.touch.touches.insert(id, s.pos());
        self.touch.max_touches = self.touch.max_touches.max(self.touch.touches.len());
        if self.touch.touches.len() >= 2 {
            // A second finger turns a finger stroke into navigation.
            if matches!(self.active, Some(Active::Drawing { stroke: Stroke { device: InputDevice::Touch, .. }, .. })) {
                self.active = None;
                self.predicted.clear();
                self.dirty = true;
            }
        }
    }

    fn centroid_and_spread(&self) -> (Vec2, f64) {
        let n = self.touch.touches.len().max(1) as f64;
        let c = self.touch.touches.values().fold(Vec2::ZERO, |a, p| a + *p) * (1.0 / n);
        let spread = self.touch.touches.values().map(|p| p.distance(c)).sum::<f64>() / n;
        (c, spread)
    }

    fn touch_move(&mut self, id: i32, s: ScreenSample) {
        let nav = !self.finger_drawing || self.touch.touches.len() >= 2;
        let Some(old) = self.touch.touches.get(&id).copied() else { return };
        let (c0, d0) = self.centroid_and_spread();
        self.touch.touches.insert(id, s.pos());
        self.touch.moved += old.distance(s.pos());
        if !nav {
            return;
        }
        let (c1, d1) = self.centroid_and_spread();
        self.camera.pan(c1 - c0);
        if self.touch.touches.len() >= 2 && d0 > 1.0 && d1 > 1.0 {
            self.camera.zoom_at(c1, d1 / d0);
        }
        self.dirty = true;
    }

    fn touch_up(&mut self, id: i32, time: f64) {
        self.touch.touches.remove(&id);
        if self.touch.touches.is_empty() {
            let t = std::mem::take(&mut self.touch);
            let tap = !t.cancelled && time - t.start_time <= TAP_MAX_MS && t.moved <= TAP_MAX_MOVE;
            if !tap || !(2..=3).contains(&t.max_touches) {
                self.last_tap = None;
                return;
            }
            // Undo / redo need a *double* tap, so a stray touch never undoes.
            let double = matches!(self.last_tap, Some((n, end))
                if n == t.max_touches && t.start_time - end <= DOUBLE_TAP_GAP_MS);
            if double {
                self.last_tap = None;
                if t.max_touches == 2 {
                    self.undo();
                } else {
                    self.redo();
                }
            } else {
                self.last_tap = Some((t.max_touches, time));
            }
        }
    }

    // ----- commands --------------------------------------------------------

    pub fn undo(&mut self) -> bool {
        let r = self.doc.undo();
        self.dirty |= r;
        r
    }

    pub fn redo(&mut self) -> bool {
        let r = self.doc.redo();
        self.dirty |= r;
        r
    }

    pub fn pan(&mut self, dx: f64, dy: f64) {
        self.camera.pan(Vec2::new(dx, dy));
        self.dirty = true;
    }

    pub fn zoom_at(&mut self, x: f64, y: f64, factor: f64) {
        self.camera.zoom_at(Vec2::new(x, y), factor);
        self.dirty = true;
    }

    // ----- rendering helpers -----------------------------------------------

    /// The stroke being drawn right now, if any.
    pub fn live_stroke(&self) -> Option<&Stroke> {
        match &self.active {
            Some(Active::Drawing { stroke, .. }) => Some(stroke),
            _ => None,
        }
    }

    /// Mesh of the live stroke including predicted samples.
    pub fn live_mesh(&self) -> Option<Mesh> {
        let s = self.live_stroke()?;
        if self.predicted.is_empty() {
            return Some(tessellate::mesh(s));
        }
        let mut pts = s.points.clone();
        pts.extend_from_slice(&self.predicted);
        Some(tessellate::mesh_for(s, &tessellate::samples_for(s, &pts)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::Change;

    fn eng() -> Engine {
        let mut e = Engine::new(1);
        e.resize(1000.0, 800.0);
        e
    }

    fn draw(e: &mut Engine, id: i32, kind: PointerKind, from: (f64, f64), to: (f64, f64), t0: f64) {
        let steps = 20;
        e.pointer_down(id, kind, ScreenSample::new(from.0, from.1, 0.4, t0));
        for i in 1..=steps {
            let f = i as f64 / steps as f64;
            let s =
                ScreenSample::new(from.0 + (to.0 - from.0) * f, from.1 + (to.1 - from.1) * f, 0.6, t0 + i as f64 * 4.0);
            e.pointer_move(id, kind, s);
        }
        e.pointer_up(id, kind, None);
    }

    #[test]
    fn pen_draws_a_stroke_with_world_coords_and_times() {
        let mut e = eng();
        e.camera.zoom = 2.0;
        e.camera.offset = Vec2::new(100.0, 50.0);
        draw(&mut e, 1, PointerKind::Pen, (10.0, 10.0), (210.0, 10.0), 1_000.0);
        assert_eq!(e.doc.len(), 1);
        let s = &e.doc.strokes()[0];
        assert_eq!(s.start_time, 1_000.0);
        assert_eq!(s.points.len(), 21);
        assert_eq!(s.points[0].pos(), Vec2::new(105.0, 55.0));
        assert_eq!(s.points[20].pos(), Vec2::new(205.0, 55.0));
        assert_eq!(s.points[20].t, 80.0);
        assert_eq!(s.device, InputDevice::Pen);
        assert!(e.live_stroke().is_none());
    }

    #[test]
    fn live_stroke_includes_predictions_but_does_not_save_them() {
        let mut e = eng();
        e.pointer_down(1, PointerKind::Pen, ScreenSample::new(0.0, 0.0, 0.5, 0.0));
        e.pointer_move(1, PointerKind::Pen, ScreenSample::new(10.0, 0.0, 0.5, 4.0));
        let without = e.live_mesh().unwrap().bounds();
        e.set_predicted(1, &[ScreenSample::new(40.0, 0.0, 0.5, 8.0)]);
        let with = e.live_mesh().unwrap().bounds();
        assert!(with.max.x > without.max.x + 20.0);
        e.pointer_up(1, PointerKind::Pen, None);
        assert!(e.doc.strokes()[0].points.iter().all(|p| p.x <= 10.0));
    }

    /// Regression: lifting the pencil drew a short line to where the tip
    /// was when the (late) pointerup arrived.
    #[test]
    fn pen_up_position_after_lift_is_not_ink() {
        let mut e = eng();
        e.pointer_down(1, PointerKind::Pen, ScreenSample::new(0.0, 0.0, 0.5, 0.0));
        e.pointer_move(1, PointerKind::Pen, ScreenSample::new(50.0, 0.0, 0.5, 4.0));
        e.pointer_up(1, PointerKind::Pen, Some(ScreenSample::new(80.0, 0.0, 0.0, 30.0)));
        let s = &e.doc.strokes()[0];
        assert_eq!(s.points.last().unwrap().x, 50.0);
    }

    #[test]
    fn jitter_is_filtered() {
        let mut e = eng();
        e.pointer_down(1, PointerKind::Pen, ScreenSample::new(0.0, 0.0, 0.5, 0.0));
        for i in 0..10 {
            e.pointer_move(1, PointerKind::Pen, ScreenSample::new(0.1, 0.1, 0.5, i as f64));
        }
        e.pointer_up(1, PointerKind::Pen, None);
        assert_eq!(e.doc.strokes()[0].points.len(), 1);
    }

    #[test]
    fn one_finger_pans_and_does_not_draw() {
        let mut e = eng();
        e.pointer_down(5, PointerKind::Touch, ScreenSample::new(100.0, 100.0, 0.0, 0.0));
        e.pointer_move(5, PointerKind::Touch, ScreenSample::new(150.0, 130.0, 0.0, 16.0));
        e.pointer_up(5, PointerKind::Touch, Some(ScreenSample::new(150.0, 130.0, 0.0, 20.0)));
        assert!(e.doc.is_empty());
        assert_eq!(e.camera.offset, Vec2::new(-50.0, -30.0));
    }

    #[test]
    fn finger_drawing_mode_draws_with_one_finger() {
        let mut e = eng();
        e.finger_drawing = true;
        draw(&mut e, 5, PointerKind::Touch, (0.0, 0.0), (100.0, 0.0), 0.0);
        assert_eq!(e.doc.len(), 1);
        assert_eq!(e.doc.strokes()[0].device, InputDevice::Touch);
    }

    #[test]
    fn pinch_zooms_around_fingers() {
        let mut e = eng();
        e.pointer_down(1, PointerKind::Touch, ScreenSample::new(400.0, 400.0, 0.0, 0.0));
        e.pointer_down(2, PointerKind::Touch, ScreenSample::new(600.0, 400.0, 0.0, 0.0));
        let anchor_world = e.camera.screen_to_world(Vec2::new(500.0, 400.0));
        e.pointer_move(1, PointerKind::Touch, ScreenSample::new(300.0, 400.0, 0.0, 400.0));
        e.pointer_move(2, PointerKind::Touch, ScreenSample::new(700.0, 400.0, 0.0, 400.0));
        assert!(e.camera.zoom > 1.9, "zoom {}", e.camera.zoom);
        let back = e.camera.world_to_screen(anchor_world);
        assert!(back.distance(Vec2::new(500.0, 400.0)) < 1.0);
        e.pointer_up(1, PointerKind::Touch, Some(ScreenSample::new(300.0, 400.0, 0.0, 500.0)));
        e.pointer_up(2, PointerKind::Touch, Some(ScreenSample::new(700.0, 400.0, 0.0, 500.0)));
        assert!(e.doc.is_empty());
    }

    fn tap(e: &mut Engine, fingers: i32, t0: f64) {
        for i in 0..fingers {
            e.pointer_down(
                10 + i,
                PointerKind::Touch,
                ScreenSample::new(300.0 + i as f64 * 50.0, 300.0, 0.0, t0 + i as f64),
            );
        }
        for i in 0..fingers {
            e.pointer_up(
                10 + i,
                PointerKind::Touch,
                Some(ScreenSample::new(300.0 + i as f64 * 50.0, 300.0, 0.0, t0 + 80.0)),
            );
        }
    }

    #[test]
    fn two_finger_double_tap_undoes() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 0.0), (100.0, 0.0), 0.0);
        tap(&mut e, 2, 1000.0);
        assert_eq!(e.doc.len(), 1, "a single two-finger tap does nothing");
        tap(&mut e, 2, 1200.0);
        assert!(e.doc.is_empty(), "the second tap undoes");
    }

    #[test]
    fn two_finger_taps_too_far_apart_do_not_undo() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 0.0), (100.0, 0.0), 0.0);
        tap(&mut e, 2, 1000.0);
        tap(&mut e, 2, 2000.0);
        assert_eq!(e.doc.len(), 1);
    }

    #[test]
    fn three_finger_double_tap_redoes() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 0.0), (100.0, 0.0), 0.0);
        e.undo();
        tap(&mut e, 3, 1000.0);
        assert!(e.doc.is_empty());
        tap(&mut e, 3, 1150.0);
        assert_eq!(e.doc.len(), 1);
    }

    #[test]
    fn mixed_taps_do_not_count_as_double() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 0.0), (100.0, 0.0), 0.0);
        tap(&mut e, 3, 1000.0);
        tap(&mut e, 2, 1150.0);
        assert_eq!(e.doc.len(), 1);
    }

    #[test]
    fn slow_two_finger_hold_does_not_undo() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 0.0), (100.0, 0.0), 0.0);
        for t0 in [1000.0, 2000.0] {
            e.pointer_down(7, PointerKind::Touch, ScreenSample::new(300.0, 300.0, 0.0, t0));
            e.pointer_down(8, PointerKind::Touch, ScreenSample::new(360.0, 300.0, 0.0, t0 + 10.0));
            e.pointer_up(7, PointerKind::Touch, Some(ScreenSample::new(300.0, 300.0, 0.0, t0 + 900.0)));
            e.pointer_up(8, PointerKind::Touch, Some(ScreenSample::new(360.0, 300.0, 0.0, t0 + 910.0)));
        }
        assert_eq!(e.doc.len(), 1);
    }

    /// Palm rejection: a palm resting on the screen while writing must neither
    /// draw nor move the canvas.
    #[test]
    fn palm_is_ignored_while_pen_is_down() {
        let mut e = eng();
        e.finger_drawing = true;
        let cam = e.camera;
        e.pointer_down(1, PointerKind::Pen, ScreenSample::new(0.0, 0.0, 0.5, 0.0));
        e.pointer_down(9, PointerKind::Touch, ScreenSample::new(500.0, 500.0, 0.0, 1.0));
        e.pointer_move(9, PointerKind::Touch, ScreenSample::new(560.0, 520.0, 0.0, 2.0));
        e.pointer_move(1, PointerKind::Pen, ScreenSample::new(50.0, 0.0, 0.5, 3.0));
        e.pointer_up(9, PointerKind::Touch, Some(ScreenSample::new(560.0, 520.0, 0.0, 4.0)));
        e.pointer_up(1, PointerKind::Pen, None);
        assert_eq!(e.camera, cam);
        assert_eq!(e.doc.len(), 1);
        assert_eq!(e.doc.strokes()[0].device, InputDevice::Pen);
    }

    #[test]
    fn pen_cancels_finger_stroke() {
        let mut e = eng();
        e.finger_drawing = true;
        e.pointer_down(9, PointerKind::Touch, ScreenSample::new(500.0, 500.0, 0.0, 0.0));
        e.pointer_move(9, PointerKind::Touch, ScreenSample::new(520.0, 500.0, 0.0, 1.0));
        draw(&mut e, 1, PointerKind::Pen, (0.0, 0.0), (100.0, 0.0), 2.0);
        e.pointer_up(9, PointerKind::Touch, None);
        assert_eq!(e.doc.len(), 1);
        assert_eq!(e.doc.strokes()[0].device, InputDevice::Pen);
    }

    #[test]
    fn cancel_discards_stroke() {
        let mut e = eng();
        e.pointer_down(1, PointerKind::Pen, ScreenSample::new(0.0, 0.0, 0.5, 0.0));
        e.pointer_move(1, PointerKind::Pen, ScreenSample::new(30.0, 0.0, 0.5, 1.0));
        e.pointer_cancel(1, PointerKind::Pen);
        assert!(e.doc.is_empty());
        assert!(e.live_stroke().is_none());
    }

    #[test]
    fn stroke_eraser_is_one_undo_step() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 100.0), (500.0, 100.0), 0.0);
        draw(&mut e, 1, PointerKind::Pen, (0.0, 200.0), (500.0, 200.0), 100.0);
        e.doc.take_changes();
        e.tool = Tool::EraseStroke;
        draw(&mut e, 2, PointerKind::Pen, (250.0, 50.0), (250.0, 250.0), 200.0);
        assert!(e.doc.is_empty());
        assert_eq!(e.doc.take_changes().iter().filter(|c| matches!(c, Change::Removed(_))).count(), 2);
        e.undo();
        assert_eq!(e.doc.len(), 2);
    }

    #[test]
    fn partial_eraser_splits() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 100.0), (500.0, 100.0), 0.0);
        let original = e.doc.strokes()[0].id;
        e.tool = Tool::ErasePartial;
        draw(&mut e, 2, PointerKind::Pen, (250.0, 50.0), (250.0, 150.0), 200.0);
        assert_eq!(e.doc.len(), 2);
        assert!(e.doc.strokes().iter().all(|s| s.derived_from == vec![original]));
        e.undo();
        assert_eq!(e.doc.len(), 1);
        assert_eq!(e.doc.strokes()[0].id, original);
    }

    #[test]
    fn pen_eraser_end_erases_even_in_draw_mode() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 100.0), (500.0, 100.0), 0.0);
        draw(&mut e, 1, PointerKind::PenEraser, (250.0, 50.0), (250.0, 150.0), 100.0);
        assert!(e.doc.is_empty());
    }

    /// Writing must only redraw the light overlay layer, never the whole
    /// scene, until the stroke is committed (keeps ink latency low).
    #[test]
    fn drawing_only_dirties_live_layer() {
        let mut e = eng();
        e.mark_rendered();
        e.pointer_down(1, PointerKind::Pen, ScreenSample::new(0.0, 0.0, 0.5, 0.0));
        e.pointer_move(1, PointerKind::Pen, ScreenSample::new(20.0, 0.0, 0.5, 4.0));
        e.set_predicted(1, &[ScreenSample::new(30.0, 0.0, 0.5, 8.0)]);
        assert!(e.needs_live_render());
        assert!(!e.needs_scene_render());
        e.pointer_up(1, PointerKind::Pen, None);
        assert!(e.needs_scene_render());
    }

    #[test]
    fn render_flag() {
        let mut e = eng();
        assert!(e.needs_render());
        e.mark_rendered();
        assert!(!e.needs_render());
        e.pan(5.0, 0.0);
        assert!(e.needs_render());
    }
}
