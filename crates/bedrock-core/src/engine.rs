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
use crate::geom::{Rect, Vec2};
use crate::input::InputPoint;
use crate::scribble;
use crate::selection;
use crate::stroke::{InputDevice, Stroke, StrokeId};
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
    /// Cut a stroke back to where it crosses other strokes.
    EraseTrim,
    /// Draw a loop around strokes to select them; drag the selection to
    /// move it.
    Lasso,
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
    Drawing {
        pointer: i32,
        stroke: Stroke,
        last_screen: Vec2,
    },
    Erasing {
        pointer: i32,
        last_world: Vec2,
        mode: Tool,
    },
    /// Drawing a selection loop (world coordinates).
    Lassoing {
        pointer: i32,
        points: Vec<Vec2>,
        last_screen: Vec2,
    },
    /// Dragging the selection: it is drawn `delta` away from where it is
    /// and moved there on release.
    Moving {
        pointer: i32,
        start: Vec2,
        delta: Vec2,
    },
    /// Dragging a picture's corner handle: it keeps its shape and its
    /// top-left corner stays put.
    Resizing {
        pointer: i32,
        id: StrokeId,
        rect: Rect,
    },
}

/// The resize handle's reach around a selected picture's corner, in css px.
pub const HANDLE_REACH: f64 = 22.0;
/// The smallest a picture can be made, in css px on screen.
const MIN_IMAGE_PX: f64 = 16.0;

#[derive(Debug, Default)]
struct TouchGesture {
    touches: BTreeMap<i32, Vec2>,
    /// Was this gesture ever two-finger? (for tap-to-undo)
    max_touches: usize,
    start_time: f64,
    moved: f64,
    cancelled: bool,
}

/// Gestures whose meaning lives in the app (e.g. which tool is current).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gesture {
    /// One-finger double tap: switch between the eraser and the tool before.
    ToggleEraser,
}

pub const TAP_MAX_MS: f64 = 300.0;
pub const TAP_MAX_MOVE: f64 = 12.0;
/// Longest pause between the two taps of a double tap.
pub const DOUBLE_TAP_GAP_MS: f64 = 350.0;

/// The scribble preview is refreshed each time the live stroke has grown by
/// this many samples (20 times a second at 240 Hz).
pub const PREVIEW_EVERY: usize = 12;

pub struct Engine {
    pub doc: Document,
    pub camera: Camera,
    pub brush: Brush,
    pub tool: Tool,
    /// Eraser radius in screen pixels.
    pub eraser_size: f64,
    pub finger_drawing: bool,
    /// Scribbling over ink erases it (see [`crate::scribble`]).
    pub scribble_erase: bool,
    /// Pieces the trimmer made during the current swipe.
    trimmed: std::collections::HashSet<StrokeId>,
    /// A gesture for the app to act on (see [`Engine::take_gesture`]).
    gesture: Option<Gesture>,
    /// Strokes the last scribble erased, until read with
    /// [`Engine::take_scribble_erased`].
    scribble_erased: usize,
    /// Selected strokes (lasso tool), in stacking order.
    selection: Vec<StrokeId>,
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
    /// Keeps the settled part of the live stroke's mesh between frames.
    live: tessellate::LiveTessellator,
    /// What the stroke being drawn would erase if the pen lifted now (see
    /// [`Engine::scribble_preview`]), and the stroke length it was worked
    /// out at.
    preview: Vec<StrokeId>,
    preview_at: usize,
    /// Strokes held up off the paper (their menu is open): drawn on the
    /// live layer, grown by `lift_scale` around their middle.
    lifted: Vec<StrokeId>,
    lift_scale: f64,
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
            scribble_erase: true,
            scribble_erased: 0,
            gesture: None,
            trimmed: Default::default(),
            selection: Vec::new(),
            active: None,
            predicted: Vec::new(),
            touch: TouchGesture::default(),
            last_tap: None,
            pen_down: false,
            dirty: true,
            live_dirty: true,
            live: tessellate::LiveTessellator::new(),
            preview: Vec::new(),
            preview_at: 0,
            lifted: Vec::new(),
            lift_scale: 1.0,
        }
    }

    /// Redraw everything on the next frame (e.g. after a rendering setting
    /// such as the pressure feel changed).
    pub fn invalidate(&mut self) {
        self.dirty = true;
        self.live_dirty = true;
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
    pub fn is_drawing(&self) -> bool {
        matches!(self.active, Some(Active::Drawing { .. }))
    }

    /// Replace the document (e.g. after opening a file) and frame its content.
    pub fn set_document(&mut self, doc: Document) {
        self.active = None;
        self.selection.clear();
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
        let w = crate::camera::clamp_to_world(self.camera.screen_to_world(s.pos()));
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
        let tool = if kind == PointerKind::PenEraser && matches!(self.tool, Tool::Draw | Tool::Lasso) {
            Tool::EraseStroke
        } else {
            self.tool
        };
        match tool {
            Tool::Draw => {
                let id_ = self.doc.next_id();
                let mut stroke = Stroke::new(id_, self.brush, s.time, Self::device(kind), Vec::new());
                stroke.input_scale = 1.0 / self.camera.zoom;
                stroke.push(self.to_input(&s, s.time));
                self.preview.clear();
                self.preview_at = 0;
                self.active = Some(Active::Drawing { pointer: id, stroke, last_screen: s.pos() });
            }
            Tool::Lasso => {
                let w = self.camera.screen_to_world(s.pos());
                // Grab the selection anywhere in its box (plus a finger's
                // width of slop), otherwise start a new loop.
                let slop = 12.0 / self.camera.zoom;
                if let Some(img) =
                    self.resizable_image().filter(|i| i.rect().max.distance(w) <= HANDLE_REACH / self.camera.zoom)
                {
                    let (image, rect) = (img.id, img.rect());
                    self.active = Some(Active::Resizing { pointer: id, id: image, rect });
                } else if !self.selection.is_empty() && self.selection_bounds().inflate(slop).contains(w) {
                    self.active = Some(Active::Moving { pointer: id, start: w, delta: Vec2::ZERO });
                } else {
                    self.selection.clear();
                    self.active = Some(Active::Lassoing { pointer: id, points: vec![w], last_screen: s.pos() });
                }
            }
            Tool::EraseStroke | Tool::ErasePartial | Tool::EraseTrim => {
                self.doc.begin_group();
                self.trimmed.clear();
                let w = self.camera.screen_to_world(s.pos());
                self.active = Some(Active::Erasing { pointer: id, last_world: w, mode: tool });
                self.erase_segment(w, w, tool);
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
                // Would lifting the pen now erase something? Checked every
                // few samples, so the ink can fade before it goes.
                if self.scribble_erase
                    && stroke.brush.kind != crate::brush::BrushKind::Highlighter
                    && stroke.points.len() >= self.preview_at + PREVIEW_EVERY
                {
                    self.preview_at = stroke.points.len();
                    self.preview =
                        if scribble::is_scribble(stroke) { scribble::targets(&self.doc, stroke) } else { Vec::new() };
                }
            }
            Some(Active::Erasing { pointer, last_world, mode }) if *pointer == id => {
                let w = self.camera.screen_to_world(s.pos());
                let (from, mode) = (*last_world, *mode);
                *last_world = w;
                self.erase_segment(from, w, mode);
                self.dirty = true;
            }
            Some(Active::Lassoing { pointer, points, last_screen }) if *pointer == id => {
                if s.pos().distance(*last_screen) >= 2.0 {
                    *last_screen = s.pos();
                    points.push(self.camera.screen_to_world(s.pos()));
                    self.live_dirty = true;
                }
            }
            Some(Active::Moving { pointer, start, delta }) if *pointer == id => {
                *delta = self.camera.screen_to_world(s.pos()) - *start;
                self.live_dirty = true;
                // Pictures are drawn on the base layer, so it redraws too.
                let doc = &self.doc;
                if self.selection.iter().any(|i| doc.image(*i).is_some()) {
                    self.dirty = true;
                }
            }
            Some(Active::Resizing { pointer, id: image, rect }) if *pointer == id => {
                let w = self.camera.screen_to_world(s.pos());
                if let Some(img) = self.doc.image(*image) {
                    let aspect = img.w / img.h.max(1e-9);
                    let min_w = MIN_IMAGE_PX / self.camera.zoom * aspect.max(1.0);
                    let width = (w.x - img.x).max((w.y - img.y) * aspect).max(min_w);
                    *rect =
                        Rect { min: Vec2::new(img.x, img.y), max: Vec2::new(img.x + width, img.y + width / aspect) };
                    self.dirty = true;
                }
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
                let erase = if self.scribble_erase
                    && stroke.brush.kind != crate::brush::BrushKind::Highlighter
                    && scribble::is_scribble(&stroke)
                {
                    scribble::targets(&self.doc, &stroke)
                } else {
                    Vec::new()
                };
                if erase.is_empty() {
                    self.doc.add_stroke(stroke);
                } else {
                    // The scribble itself is not kept: one undo brings the ink back.
                    self.scribble_erased = erase.len();
                    self.doc.replace(&erase, vec![]);
                }
            }
            Some(Active::Erasing { pointer, .. }) if pointer == id => {
                self.doc.end_group();
            }
            Some(Active::Lassoing { pointer, points, .. }) if pointer == id => {
                self.selection = selection::strokes_in_lasso(&self.doc, &points);
            }
            Some(Active::Moving { pointer, delta, .. }) if pointer == id => {
                if delta.length() > 0.0 {
                    self.selection = self.doc.translate(&self.selection, delta);
                }
            }
            Some(Active::Resizing { pointer, id: image, rect }) if pointer == id => {
                if self.doc.image(image).is_some_and(|i| i.rect() != rect) {
                    self.doc.place_image(image, rect);
                }
            }
            other => self.active = other,
        }
        self.predicted.clear();
        if !self.is_drawing() {
            self.preview.clear();
        }
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
            self.preview.clear();
            self.dirty = true;
        }
    }

    fn is_pointer_active(&self, id: i32) -> bool {
        match &self.active {
            Some(Active::Drawing { pointer, .. })
            | Some(Active::Erasing { pointer, .. })
            | Some(Active::Lassoing { pointer, .. })
            | Some(Active::Moving { pointer, .. })
            | Some(Active::Resizing { pointer, .. }) => *pointer == id,
            None => false,
        }
    }

    fn erase_segment(&mut self, a: Vec2, b: Vec2, mode: Tool) {
        let radius = self.eraser_size / self.camera.zoom / 2.0;
        if mode == Tool::EraseTrim {
            // One cut per stroke per swipe (as Fresco): pieces made during
            // this swipe are left alone, so dragging over a crossing doesn't
            // eat the neighbouring segment too.
            let candidates: Vec<Stroke> = self
                .doc
                .strokes()
                .iter()
                .filter(|s| !self.trimmed.contains(&s.id) && eraser::touches(s, a, b, radius))
                .cloned()
                .collect();
            let mut removed = Vec::new();
            let mut pieces = Vec::new();
            for s in &candidates {
                let others: Vec<Stroke> = self
                    .doc
                    .strokes()
                    .iter()
                    .filter(|o| o.id != s.id && o.bounds().intersects(&s.bounds()))
                    .cloned()
                    .collect();
                let refs: Vec<&Stroke> = others.iter().collect();
                let doc = &mut self.doc;
                if let Some(parts) = eraser::trim(s, &refs, a, b, radius, || doc.next_id()) {
                    removed.push(s.id);
                    for p in parts {
                        self.trimmed.insert(p.id);
                        pieces.push((s.id, p));
                    }
                }
            }
            if !removed.is_empty() {
                self.doc.replace(&removed, pieces);
            }
        } else if mode == Tool::ErasePartial {
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
            // One finger counts only when fingers don't draw (then a tap is a dot).
            let fingers_ok = (2..=3).contains(&t.max_touches) || (t.max_touches == 1 && !self.finger_drawing);
            if !tap || !fingers_ok {
                self.last_tap = None;
                return;
            }
            // Undo / redo need a *double* tap, so a stray touch never undoes.
            let double = matches!(self.last_tap, Some((n, end))
                if n == t.max_touches && t.start_time - end <= DOUBLE_TAP_GAP_MS);
            if double {
                self.last_tap = None;
                match t.max_touches {
                    1 => self.gesture = Some(Gesture::ToggleEraser),
                    2 => {
                        self.undo();
                    }
                    _ => {
                        self.redo();
                    }
                }
            } else {
                self.last_tap = Some((t.max_touches, time));
            }
        }
    }

    // ----- commands --------------------------------------------------------

    pub fn undo(&mut self) -> bool {
        let r = self.doc.undo();
        if r {
            self.selection.clear();
        }
        self.dirty |= r;
        r
    }

    pub fn redo(&mut self) -> bool {
        let r = self.doc.redo();
        if r {
            self.selection.clear();
        }
        self.dirty |= r;
        r
    }

    /// The last gesture the app should act on, once.
    pub fn take_gesture(&mut self) -> Option<Gesture> {
        self.gesture.take()
    }

    /// How many strokes a scribble erased since the last call (0 if none).
    pub fn take_scribble_erased(&mut self) -> usize {
        std::mem::take(&mut self.scribble_erased)
    }

    // ----- selection ---------------------------------------------------------

    /// The selected strokes that still exist, in stacking order.
    pub fn selection(&self) -> Vec<StrokeId> {
        self.selection
            .iter()
            .copied()
            .filter(|id| self.doc.find(*id).is_some() || self.doc.image(*id).is_some())
            .collect()
    }

    pub fn select(&mut self, ids: Vec<StrokeId>) {
        self.selection = ids;
        self.dirty = true;
    }

    pub fn clear_selection(&mut self) {
        if !self.selection.is_empty() {
            self.selection.clear();
            self.dirty = true;
        }
    }

    /// Ink bounds of the selection (world), empty if nothing is selected.
    pub fn selection_bounds(&self) -> Rect {
        if let Some(Active::Resizing { rect, .. }) = &self.active {
            return *rect;
        }
        selection::bounds(&self.doc, &self.selection)
    }

    /// The selection loop being drawn (world coordinates).
    pub fn lasso(&self) -> Option<&[Vec2]> {
        match &self.active {
            Some(Active::Lassoing { points, .. }) => Some(points),
            _ => None,
        }
    }

    /// How far the selection is being dragged (world), while it is.
    pub fn drag_offset(&self) -> Option<Vec2> {
        match &self.active {
            Some(Active::Moving { delta, .. }) => Some(*delta),
            _ => None,
        }
    }

    /// Strokes the base layer must leave out right now: the selection while
    /// it is dragged, or the lifted strokes (they are drawn on the live
    /// layer instead).
    pub fn floating(&self) -> &[StrokeId] {
        if self.drag_offset().is_some() {
            &self.selection
        } else {
            &self.lifted
        }
    }

    /// Hold these strokes up off the paper, grown `scale` times around
    /// their middle (1 = their own size). An empty list puts them back.
    pub fn set_lift(&mut self, ids: &[StrokeId], scale: f64) {
        let ids: Vec<StrokeId> =
            ids.iter().copied().filter(|id| self.doc.strokes().iter().any(|s| s.id == *id)).collect();
        let scale = if scale.is_finite() { scale.clamp(0.5, 2.0) } else { 1.0 };
        if ids != self.lifted {
            self.lifted = ids;
            self.dirty = true;
        } else if scale != self.lift_scale {
            self.live_dirty = true;
        }
        self.lift_scale = scale;
    }

    /// The lifted strokes' scale and the point it grows from (the middle of
    /// their bounds), while some are lifted and none is being dragged.
    pub fn lift(&self) -> Option<(f64, Vec2)> {
        if self.lifted.is_empty() || self.drag_offset().is_some() {
            return None;
        }
        let mut b: Option<Rect> = None;
        for s in self.doc.strokes().iter().filter(|s| self.lifted.contains(&s.id)) {
            let r = s.bounds();
            b = Some(match b {
                Some(a) => Rect {
                    min: Vec2::new(a.min.x.min(r.min.x), a.min.y.min(r.min.y)),
                    max: Vec2::new(a.max.x.max(r.max.x), a.max.y.max(r.max.y)),
                },
                None => r,
            });
        }
        let b = b?;
        Some((self.lift_scale, Vec2::new((b.min.x + b.max.x) / 2.0, (b.min.y + b.max.y) / 2.0)))
    }

    /// Delete the selected strokes (one undo step).
    pub fn delete_selection(&mut self) -> bool {
        let ids = self.selection();
        self.selection.clear();
        if ids.is_empty() {
            return false;
        }
        self.doc.remove(&ids);
        self.dirty = true;
        true
    }

    /// The selected picture, when the selection is exactly one picture
    /// (then its corner has a resize handle).
    pub fn resizable_image(&self) -> Option<&crate::document::Image> {
        match self.selection.as_slice() {
            [one] => self.doc.image(*one),
            _ => None,
        }
    }

    /// Where each picture is drawn right now: dragged and resized ones
    /// where the pen has them. Bottom first.
    pub fn image_placements(&self) -> Vec<(StrokeId, String, Rect)> {
        let delta = self.drag_offset().unwrap_or(Vec2::ZERO);
        self.doc
            .images()
            .iter()
            .map(|img| {
                let mut r = img.rect();
                match &self.active {
                    Some(Active::Resizing { id, rect, .. }) if *id == img.id => r = *rect,
                    Some(Active::Moving { .. }) if self.selection.contains(&img.id) => {
                        r = Rect { min: r.min + delta, max: r.max + delta };
                    }
                    _ => {}
                }
                (img.id, img.texture_key(), r)
            })
            .collect()
    }

    /// Place a text box in the middle of the view, `width`×`height` css px
    /// on screen at this zoom, and select it.
    pub fn insert_text(&mut self, text: &str, width_css: f64, height_css: f64) -> StrokeId {
        let z = self.camera.zoom.max(1e-9);
        let size = Vec2::new(width_css.max(1.0) / z, height_css.max(1.0) / z);
        let view = self.camera.visible_world();
        let c = Vec2::new((view.min.x + view.max.x) / 2.0, (view.min.y + view.max.y) / 2.0);
        let id = self.doc.add_text(text, Rect { min: c - size * 0.5, max: c + size * 0.5 });
        self.selection = vec![id];
        self.dirty = true;
        id
    }

    /// Place a picture in the middle of the view, at most 60% of it (and
    /// never larger than its own pixels at this zoom), and select it.
    pub fn insert_image(&mut self, file: &str, bytes: Option<Vec<u8>>, width_px: f64, height_px: f64) -> StrokeId {
        let (w, h) = (width_px.max(1.0), height_px.max(1.0));
        let view = self.camera.visible_world();
        let fit = (view.width() * 0.6 / w).min(view.height() * 0.6 / h).min(1.0 / self.camera.zoom.max(1e-9) * 1.0);
        let fit = if fit > 0.0 && fit.is_finite() { fit } else { 1.0 };
        let size = Vec2::new(w * fit, h * fit);
        let c = Vec2::new((view.min.x + view.max.x) / 2.0, (view.min.y + view.max.y) / 2.0);
        let rect = Rect { min: c - size * 0.5, max: c + size * 0.5 };
        let id = self.doc.add_image(file, bytes, rect);
        self.selection = vec![id];
        self.dirty = true;
        id
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

    /// The strokes the scribble being drawn would erase if the pen lifted
    /// now; empty while it is not (yet) a scribble over ink. The app fades
    /// them, so the erase never comes as a surprise.
    pub fn scribble_preview(&self) -> &[StrokeId] {
        &self.preview
    }

    /// Mesh of the live stroke including predicted samples. Only the part
    /// near the pen is rebuilt (see [`tessellate::LiveTessellator`]).
    pub fn live_mesh(&mut self) -> Option<Mesh> {
        let Some(Active::Drawing { stroke, .. }) = &self.active else { return None };
        Some(self.live.mesh(stroke, &self.predicted))
    }

    /// Raw sample the per-frame rebuild of the live stroke starts at (0
    /// until part of it has settled).
    pub fn live_window_start(&self) -> usize {
        self.live.window_start()
    }

    /// The live mesh rebuilt from the stroke's first sample: what
    /// [`Engine::live_mesh`] must look like, at a cost that grows with the
    /// stroke. For tests and measurements.
    pub fn live_mesh_full(&self) -> Option<Mesh> {
        let s = self.live_stroke()?;
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
    fn a_scribble_shows_what_it_will_erase_before_the_pen_lifts() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (100.0, 100.0), (140.0, 104.0), 0.0);
        draw(&mut e, 1, PointerKind::Pen, (400.0, 400.0), (440.0, 400.0), 500.0);
        let word = e.doc.strokes()[0].id;
        // Scribble back and forth over the first stroke.
        e.pointer_down(2, PointerKind::Pen, ScreenSample::new(95.0, 96.0, 0.5, 1000.0));
        let mut seen_at = None;
        for i in 1..=120 {
            let pass = (i - 1) / 10;
            let f = ((i - 1) % 10) as f64 / 9.0;
            let x = if pass % 2 == 0 { 95.0 + 50.0 * f } else { 145.0 - 50.0 * f };
            e.pointer_move(
                2,
                PointerKind::Pen,
                ScreenSample::new(x, 96.0 + i as f64 * 0.1, 0.5, 1000.0 + i as f64 * 4.0),
            );
            if seen_at.is_none() && !e.scribble_preview().is_empty() {
                seen_at = Some(i);
            }
            if i < 30 {
                assert!(e.scribble_preview().is_empty(), "two or three passes are not a scribble yet");
            }
        }
        assert!(seen_at.is_some(), "the preview never appeared");
        assert_eq!(e.scribble_preview(), &[word], "only the ink under the scribble");
        assert_eq!(e.doc.len(), 2, "nothing is erased while the pen is down");
        e.pointer_up(2, PointerKind::Pen, None);
        assert!(e.scribble_preview().is_empty());
        assert_eq!(e.doc.len(), 1);
        assert!(e.doc.strokes().iter().all(|s| s.id != word));

        // Turned off: no preview either.
        e.undo();
        e.scribble_erase = false;
        e.pointer_down(3, PointerKind::Pen, ScreenSample::new(95.0, 96.0, 0.5, 3000.0));
        for i in 1..=120 {
            let pass = (i - 1) / 10;
            let f = ((i - 1) % 10) as f64 / 9.0;
            let x = if pass % 2 == 0 { 95.0 + 50.0 * f } else { 145.0 - 50.0 * f };
            e.pointer_move(
                3,
                PointerKind::Pen,
                ScreenSample::new(x, 96.0 + i as f64 * 0.1, 0.5, 3000.0 + i as f64 * 4.0),
            );
        }
        assert!(e.scribble_preview().is_empty());
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
    fn one_finger_double_tap_asks_to_toggle_the_eraser() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 0.0), (100.0, 0.0), 0.0);
        tap(&mut e, 1, 1000.0);
        assert_eq!(e.take_gesture(), None, "one tap is nothing");
        tap(&mut e, 1, 1200.0);
        assert_eq!(e.take_gesture(), Some(Gesture::ToggleEraser));
        assert_eq!(e.take_gesture(), None, "only once");
        assert_eq!(e.doc.len(), 1, "no ink, no undo");
        // Taps too far apart, or a pan, don't count.
        tap(&mut e, 1, 3000.0);
        tap(&mut e, 1, 4000.0);
        assert_eq!(e.take_gesture(), None);
        // With finger drawing on, a finger tap is a dot instead.
        e.finger_drawing = true;
        tap(&mut e, 1, 5000.0);
        tap(&mut e, 1, 5200.0);
        assert_eq!(e.take_gesture(), None);
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
    fn trimmer_cuts_back_to_crossings() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 100.0), (500.0, 100.0), 0.0); // the line
        draw(&mut e, 1, PointerKind::Pen, (200.0, 0.0), (200.0, 200.0), 100.0); // crossings
        draw(&mut e, 1, PointerKind::Pen, (300.0, 0.0), (300.0, 200.0), 200.0);
        let line = e.doc.strokes()[0].id;
        e.tool = Tool::EraseTrim;
        let (v1, v2) = (e.doc.strokes()[1].clone(), e.doc.strokes()[2].clone());
        let swipe = |e: &mut Engine, pts: &[(f64, f64)], t0: f64| {
            e.pointer_down(2, PointerKind::Pen, ScreenSample::new(pts[0].0, pts[0].1, 0.5, t0));
            for (i, p) in pts.iter().enumerate().skip(1) {
                e.pointer_move(2, PointerKind::Pen, ScreenSample::new(p.0, p.1, 0.5, t0 + i as f64 * 10.0));
            }
            e.pointer_up(2, PointerKind::Pen, None);
        };
        let pieces = |e: &Engine| -> Vec<(f64, f64)> {
            e.doc
                .strokes()
                .iter()
                .filter(|s| s.derived_from == vec![line])
                .map(|s| (s.points[0].x, s.points.last().unwrap().x))
                .collect()
        };
        // Across the left end: it goes back to the first crossing.
        swipe(&mut e, &[(100.0, 80.0), (100.0, 120.0)], 300.0);
        let p = pieces(&e);
        assert_eq!(p.len(), 1);
        assert!((p[0].0 - 200.0).abs() < 1e-6 && p[0].1 == 500.0, "{p:?}");
        // A second swipe between the crossings cuts out that segment only.
        swipe(&mut e, &[(250.0, 80.0), (250.0, 120.0)], 400.0);
        let p = pieces(&e);
        assert_eq!(p.len(), 1);
        assert!((p[0].0 - 300.0).abs() < 1e-6 && p[0].1 == 500.0, "{p:?}");
        assert!(e.doc.find(v1.id).is_some() && e.doc.find(v2.id).is_some(), "the crossing lines are untouched");
        e.undo();
        e.undo();
        assert_eq!(e.doc.len(), 3);
        assert_eq!(e.doc.strokes()[0].id, line);
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

    fn lasso(e: &mut Engine, id: i32, pts: &[(f64, f64)], t0: f64) {
        e.pointer_down(id, PointerKind::Pen, ScreenSample::new(pts[0].0, pts[0].1, 0.5, t0));
        for (i, p) in pts.iter().enumerate().skip(1) {
            e.pointer_move(id, PointerKind::Pen, ScreenSample::new(p.0, p.1, 0.5, t0 + i as f64 * 4.0));
        }
        e.pointer_up(id, PointerKind::Pen, None);
    }

    const AROUND_FIRST: [(f64, f64); 5] = [(-10.0, 90.0), (120.0, 90.0), (120.0, 110.0), (-10.0, 110.0), (-10.0, 92.0)];

    #[test]
    fn lasso_selects_and_drag_moves_as_one_undo_step() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 100.0), (100.0, 100.0), 0.0);
        draw(&mut e, 1, PointerKind::Pen, (0.0, 300.0), (100.0, 300.0), 100.0);
        let (a, b) = (e.doc.strokes()[0].id, e.doc.strokes()[1].id);
        e.tool = Tool::Lasso;
        lasso(&mut e, 2, &AROUND_FIRST, 200.0);
        assert_eq!(e.selection(), vec![a]);
        assert_eq!(e.doc.len(), 2, "the loop is not ink");
        // Drag it 50 px right, 20 down.
        e.pointer_down(3, PointerKind::Pen, ScreenSample::new(50.0, 100.0, 0.5, 300.0));
        e.pointer_move(3, PointerKind::Pen, ScreenSample::new(100.0, 120.0, 0.5, 310.0));
        assert_eq!(e.drag_offset(), Some(Vec2::new(50.0, 20.0)));
        assert_eq!(e.floating(), &[a], "drawn on the live layer while dragged");
        e.pointer_up(3, PointerKind::Pen, None);
        assert!(e.floating().is_empty());
        let moved = e.selection();
        assert_eq!(moved.len(), 1);
        assert_ne!(moved[0], a, "moved strokes get new ids");
        let m = e.doc.find(moved[0]).unwrap();
        assert_eq!(m.points[0].pos(), Vec2::new(50.0, 120.0));
        assert_eq!(e.doc.strokes()[0].id, moved[0], "keeps its place in the stacking order");
        assert_eq!(e.doc.strokes()[1].id, b);
        e.undo();
        assert_eq!(e.doc.strokes()[0].id, a);
        assert_eq!(e.doc.strokes()[0].points[0].pos(), Vec2::new(0.0, 100.0));
        assert!(e.selection().is_empty());
    }

    #[test]
    fn tapping_outside_the_selection_clears_it_and_a_cancelled_drag_moves_nothing() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 100.0), (100.0, 100.0), 0.0);
        e.tool = Tool::Lasso;
        lasso(&mut e, 2, &AROUND_FIRST, 100.0);
        assert_eq!(e.selection().len(), 1);
        e.pointer_down(3, PointerKind::Pen, ScreenSample::new(50.0, 100.0, 0.5, 300.0));
        e.pointer_move(3, PointerKind::Pen, ScreenSample::new(90.0, 100.0, 0.5, 310.0));
        e.pointer_cancel(3, PointerKind::Pen); // e.g. the hold that opens the menu
        assert_eq!(e.doc.strokes()[0].points[0].pos(), Vec2::new(0.0, 100.0));
        assert!(!e.doc.can_redo() && e.doc.strokes().len() == 1);
        assert_eq!(e.selection().len(), 1);
        lasso(&mut e, 4, &[(600.0, 600.0), (601.0, 601.0)], 400.0);
        assert!(e.selection().is_empty());
    }

    #[test]
    fn pen_eraser_end_still_erases_with_the_lasso() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 100.0), (500.0, 100.0), 0.0);
        e.tool = Tool::Lasso;
        draw(&mut e, 2, PointerKind::PenEraser, (250.0, 50.0), (250.0, 150.0), 100.0);
        assert!(e.doc.is_empty());
    }

    #[test]
    fn delete_selection() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (0.0, 100.0), (100.0, 100.0), 0.0);
        e.tool = Tool::Lasso;
        lasso(&mut e, 2, &AROUND_FIRST, 100.0);
        assert!(e.delete_selection());
        assert!(e.doc.is_empty());
        e.undo();
        assert_eq!(e.doc.len(), 1);
    }

    #[test]
    fn scribbling_over_a_word_erases_it_in_one_undo_step() {
        let mut e = eng();
        // A short "word" and a line far away.
        draw(&mut e, 1, PointerKind::Pen, (100.0, 100.0), (140.0, 110.0), 0.0);
        draw(&mut e, 1, PointerKind::Pen, (100.0, 400.0), (300.0, 400.0), 100.0);
        let keep = e.doc.strokes()[1].id;
        let scribble = |e: &mut Engine, t0: f64, y0: f64| {
            e.pointer_down(2, PointerKind::Pen, ScreenSample::new(95.0, y0, 0.5, t0));
            for i in 1..=48 {
                let pass = i / 6;
                let f = (i % 6) as f64 / 6.0;
                let x = if pass % 2 == 0 { 95.0 + 50.0 * f } else { 145.0 - 50.0 * f };
                e.pointer_move(
                    2,
                    PointerKind::Pen,
                    ScreenSample::new(x, y0 + i as f64 * 0.4, 0.5, t0 + i as f64 * 8.0),
                );
            }
            e.pointer_up(2, PointerKind::Pen, None);
        };
        scribble(&mut e, 200.0, 96.0);
        assert_eq!(
            e.doc.strokes().iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![keep],
            "word gone, scribble not kept"
        );
        assert_eq!(e.take_scribble_erased(), 1);
        assert_eq!(e.take_scribble_erased(), 0);
        e.undo();
        assert_eq!(e.doc.len(), 2);
        // Over empty paper it is just ink (shading).
        scribble(&mut e, 400.0, 600.0);
        assert_eq!(e.doc.len(), 3);
        // And it can be turned off.
        e.undo();
        e.scribble_erase = false;
        scribble(&mut e, 600.0, 96.0);
        assert_eq!(e.doc.len(), 3);
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

    /// Bug guard for pictures: inserted in the middle of the view and
    /// selected; the lasso takes them with ink; dragging moves both as one
    /// undo step; the corner handle resizes keeping the shape; delete
    /// removes them, and undo brings each step back.
    #[test]
    fn pictures_insert_select_move_resize_delete_undo() {
        let mut e = eng();
        let id = e.insert_image("images/a.png", Some(vec![1, 2, 3]), 400.0, 200.0);
        let img = e.doc.image(id).unwrap().clone();
        assert_eq!((img.w, img.h), (400.0, 200.0));
        assert_eq!((img.x + img.w / 2.0, img.y + img.h / 2.0), (500.0, 400.0));
        assert_eq!(e.selection(), vec![id]);
        assert_eq!(e.doc.used_assets(), vec![("images/a.png", &[1u8, 2, 3][..])]);

        // Resize from the bottom-right corner to 600 wide: 300 high.
        e.tool = Tool::Lasso;
        e.pointer_down(1, PointerKind::Pen, ScreenSample::new(700.0, 500.0, 0.5, 0.0));
        e.pointer_move(1, PointerKind::Pen, ScreenSample::new(900.0, 520.0, 0.5, 4.0));
        assert_eq!(e.selection_bounds().max, Vec2::new(900.0, 600.0), "the box follows the handle");
        e.pointer_up(1, PointerKind::Pen, None);
        let r = e.doc.image(id).unwrap().rect();
        assert_eq!((r.min, r.max), (Vec2::new(300.0, 300.0), Vec2::new(900.0, 600.0)));

        // A loop around the picture and a stroke takes both; drag them.
        e.tool = Tool::Draw;
        draw(&mut e, 2, PointerKind::Pen, (320.0, 650.0), (400.0, 650.0), 100.0);
        let pts = [(250.0, 250.0), (950.0, 250.0), (950.0, 700.0), (250.0, 700.0), (250.0, 260.0)];
        e.tool = Tool::Lasso;
        lasso(&mut e, 3, &pts, 200.0);
        assert_eq!(e.selection().len(), 2);
        e.pointer_down(4, PointerKind::Pen, ScreenSample::new(500.0, 400.0, 0.5, 300.0));
        e.pointer_move(4, PointerKind::Pen, ScreenSample::new(550.0, 410.0, 0.5, 304.0));
        assert!(e.needs_scene_render(), "the base layer redraws a dragged picture");
        let placed = e.image_placements()[0].2;
        assert_eq!(placed.min, Vec2::new(350.0, 310.0));
        e.pointer_up(4, PointerKind::Pen, None);
        assert_eq!(e.doc.image(id).unwrap().rect().min, Vec2::new(350.0, 310.0));
        assert!((e.doc.strokes()[0].points[0].x - 370.0).abs() < 1e-9);
        assert!(e.selection().contains(&id), "the picture stays selected with its id");

        // Delete both, then undo each step.
        assert!(e.delete_selection());
        assert!(e.doc.images().is_empty() && e.doc.is_empty());
        e.undo();
        assert_eq!(e.doc.images().len(), 1);
        assert_eq!(e.doc.len(), 1);
        e.undo(); // the move
        assert_eq!(e.doc.image(id).unwrap().rect().min, Vec2::new(300.0, 300.0));
        assert!((e.doc.strokes()[0].points[0].x - 320.0).abs() < 1e-9);
        e.undo(); // the stroke
        e.undo(); // the resize
        assert_eq!(e.doc.image(id).unwrap().w, 400.0);
        e.undo(); // the insert
        assert!(e.doc.images().is_empty());
        e.redo();
        assert_eq!(e.doc.images().len(), 1);
    }

    #[test]
    fn a_picture_is_never_inserted_larger_than_its_pixels_or_the_view() {
        let mut e = eng();
        let id = e.insert_image("images/big.jpg", Some(vec![0]), 4000.0, 1000.0);
        let r = e.doc.image(id).unwrap().rect();
        assert!((r.width() - 600.0).abs() < 1e-9 && (r.height() - 150.0).abs() < 1e-9, "{r:?}");
        e.camera.zoom = 2.0;
        let id = e.insert_image("images/small.png", Some(vec![0]), 100.0, 50.0);
        let r = e.doc.image(id).unwrap().rect();
        assert!((r.width() - 50.0).abs() < 1e-9, "100 px at 200% is 50 world units: {r:?}");
    }

    #[test]
    fn lifted_strokes_float_grown_around_their_middle() {
        let mut e = eng();
        draw(&mut e, 1, PointerKind::Pen, (100.0, 100.0), (140.0, 120.0), 0.0);
        let a = e.doc.strokes()[0].id;
        e.mark_rendered();
        e.set_lift(&[a], 1.0);
        assert_eq!(e.floating(), &[a], "left out of the paper layer");
        assert!(e.needs_scene_render());
        e.mark_rendered();
        e.set_lift(&[a], 1.06);
        assert!(!e.needs_scene_render() && e.needs_live_render(), "growing only redraws the live layer");
        let (k, c) = e.lift().unwrap();
        assert_eq!(k, 1.06);
        let b = e.doc.strokes()[0].bounds();
        assert_eq!(c, Vec2::new((b.min.x + b.max.x) / 2.0, (b.min.y + b.max.y) / 2.0));
        e.set_lift(&[StrokeId(u64::MAX)], 1.0);
        assert!(e.floating().is_empty() && e.lift().is_none(), "unknown ids lift nothing; the stroke is put back");
    }
}
