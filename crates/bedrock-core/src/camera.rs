//! The infinite canvas viewport. `offset` is the world position shown at the
//! top-left of the view; `zoom` is screen pixels (CSS px) per world unit.

use crate::geom::{Rect, Vec2};

/// Zoom limits: 10% to 1600%. Further out, every brush is a hairline and
/// one screen pixel spans so much of the page that writing loses its
/// precision; further in, a pixel is finer than the pen can place a point.
pub const MIN_ZOOM: f64 = 0.1;
pub const MAX_ZOOM: f64 = 16.0;

/// The page reaches this far from the origin in every direction (world
/// units, about CSS px at 100%): ten million, hundreds of screens even
/// zoomed all the way out, so it still feels infinite, while every
/// coordinate keeps better than 1e-8 unit precision in f64 and the GPU's
/// f32 values (always relative to a nearby origin) stay exact.
pub const WORLD_LIMIT: f64 = 1.0e7;

/// Keep a world point on the page.
pub fn clamp_to_world(p: Vec2) -> Vec2 {
    let c = |v: f64| if v.is_finite() { v.clamp(-WORLD_LIMIT, WORLD_LIMIT) } else { 0.0 };
    Vec2::new(c(p.x), c(p.y))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Camera {
    pub offset: Vec2,
    pub zoom: f64,
    /// Viewport size in CSS pixels.
    pub viewport: Vec2,
}

impl Default for Camera {
    fn default() -> Self {
        Camera { offset: Vec2::ZERO, zoom: 1.0, viewport: Vec2::new(800.0, 600.0) }
    }
}

impl Camera {
    pub fn screen_to_world(&self, s: Vec2) -> Vec2 {
        self.offset + s * (1.0 / self.zoom)
    }

    pub fn world_to_screen(&self, w: Vec2) -> Vec2 {
        (w - self.offset) * self.zoom
    }

    /// Pan by a screen-space delta (content follows the fingers).
    pub fn pan(&mut self, screen_delta: Vec2) {
        self.offset = self.offset - screen_delta * (1.0 / self.zoom);
        self.clamp();
    }

    /// Enforce the zoom limits and keep the centre of the view on the page.
    pub fn clamp(&mut self) {
        let center = self.offset + self.viewport * (0.5 / self.zoom);
        if !self.zoom.is_finite() || self.zoom <= 0.0 {
            self.zoom = 1.0;
        }
        self.zoom = self.zoom.clamp(MIN_ZOOM, MAX_ZOOM);
        let c = clamp_to_world(center);
        self.offset = c - self.viewport * (0.5 / self.zoom);
    }

    /// Show world point `c` in the middle of the view at `zoom`.
    pub fn center_on(&mut self, c: Vec2, zoom: f64) {
        self.zoom = if zoom.is_finite() && zoom > 0.0 { zoom.clamp(MIN_ZOOM, MAX_ZOOM) } else { self.zoom };
        self.offset = c - self.viewport * (0.5 / self.zoom);
        self.clamp();
    }

    /// Multiply zoom by `factor`, keeping the world point under `screen_anchor` fixed.
    pub fn zoom_at(&mut self, screen_anchor: Vec2, factor: f64) {
        if !factor.is_finite() || factor <= 0.0 {
            return;
        }
        let before = self.screen_to_world(screen_anchor);
        self.zoom = (self.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        self.offset = before - screen_anchor * (1.0 / self.zoom);
        self.clamp();
    }

    pub fn visible_world(&self) -> Rect {
        Rect::new(self.offset, self.screen_to_world(self.viewport))
    }

    /// Fit `r` into the viewport with a margin (in screen px).
    pub fn fit(&mut self, r: &Rect, margin: f64) {
        if r.is_empty() {
            self.offset = Vec2::ZERO;
            self.zoom = 1.0;
            return;
        }
        let avail = Vec2::new((self.viewport.x - 2.0 * margin).max(1.0), (self.viewport.y - 2.0 * margin).max(1.0));
        let z = (avail.x / r.width().max(1.0)).min(avail.y / r.height().max(1.0));
        let center = Vec2::new((r.min.x + r.max.x) / 2.0, (r.min.y + r.max.y) / 2.0);
        self.center_on(center, z.min(4.0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let c = Camera { offset: Vec2::new(-120.5, 33.0), zoom: 2.5, viewport: Vec2::new(1024.0, 768.0) };
        let p = Vec2::new(17.0, 400.0);
        let back = c.world_to_screen(c.screen_to_world(p));
        assert!(back.distance(p) < 1e-9);
    }

    #[test]
    fn zoom_keeps_anchor_fixed() {
        let mut c = Camera::default();
        let anchor = Vec2::new(300.0, 200.0);
        let w = c.screen_to_world(anchor);
        c.zoom_at(anchor, 3.0);
        assert!((c.zoom - 3.0).abs() < 1e-12);
        assert!(c.world_to_screen(w).distance(anchor) < 1e-9);
        c.zoom_at(anchor, 1e9);
        assert_eq!(c.zoom, MAX_ZOOM);
        c.zoom_at(anchor, 0.0); // ignored
        assert_eq!(c.zoom, MAX_ZOOM);
    }

    #[test]
    fn pan_moves_content_with_finger() {
        let mut c = Camera { zoom: 2.0, ..Default::default() };
        let w = Vec2::new(10.0, 10.0);
        let before = c.world_to_screen(w);
        c.pan(Vec2::new(50.0, -20.0));
        let after = c.world_to_screen(w);
        assert!((after - before).distance(Vec2::new(50.0, -20.0)) < 1e-9);
    }

    #[test]
    fn zoom_and_position_are_bounded() {
        let mut c = Camera::default();
        c.zoom_at(Vec2::ZERO, 1e-9);
        assert_eq!(c.zoom, MIN_ZOOM);
        c.zoom_at(Vec2::ZERO, 1e12);
        assert_eq!(c.zoom, MAX_ZOOM);
        // Panning forever stops at the edge of the page.
        for _ in 0..10_000 {
            c.pan(Vec2::new(-1.0e6, 1.0e6));
        }
        let mid = c.screen_to_world(c.viewport * 0.5);
        assert!((mid.x - WORLD_LIMIT).abs() < 1e-6 && (mid.y + WORLD_LIMIT).abs() < 1e-6, "{mid:?}");
        // Screen to world stays exact out there.
        let p = Vec2::new(123.25, 456.5);
        assert!(c.world_to_screen(c.screen_to_world(p)).distance(p) < 1e-6);
        // Bad input can't break the camera.
        c.center_on(Vec2::new(f64::NAN, 0.0), f64::NAN);
        assert!(c.offset.x.is_finite() && c.zoom.is_finite());
    }

    #[test]
    fn fit_shows_rect() {
        let mut c = Camera::default();
        let r = Rect::new(Vec2::new(1000.0, 1000.0), Vec2::new(3000.0, 2000.0));
        c.fit(&r, 20.0);
        let v = c.visible_world();
        assert!(v.contains(r.min) && v.contains(r.max));
    }
}
