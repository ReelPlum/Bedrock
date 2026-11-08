//! The infinite canvas viewport. `offset` is the world position shown at the
//! top-left of the view; `zoom` is screen pixels (CSS px) per world unit.

use crate::geom::{Rect, Vec2};

pub const MIN_ZOOM: f64 = 0.02;
pub const MAX_ZOOM: f64 = 64.0;

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
    }

    /// Multiply zoom by `factor`, keeping the world point under `screen_anchor` fixed.
    pub fn zoom_at(&mut self, screen_anchor: Vec2, factor: f64) {
        if !factor.is_finite() || factor <= 0.0 {
            return;
        }
        let before = self.screen_to_world(screen_anchor);
        self.zoom = (self.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        self.offset = before - screen_anchor * (1.0 / self.zoom);
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
        self.zoom = z.clamp(MIN_ZOOM, 4.0);
        let center = Vec2::new((r.min.x + r.max.x) / 2.0, (r.min.y + r.max.y) / 2.0);
        self.offset = center - self.viewport * (0.5 / self.zoom);
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
    fn fit_shows_rect() {
        let mut c = Camera::default();
        let r = Rect::new(Vec2::new(1000.0, 1000.0), Vec2::new(3000.0, 2000.0));
        c.fit(&r, 20.0);
        let v = c.visible_world();
        assert!(v.contains(r.min) && v.contains(r.max));
    }
}
