//! The live stroke (the one under the pen) must look like a full rebuild
//! and must not get slower as it gets longer.
//!
//! Bug: `Engine::live_mesh` rebuilt the whole stroke on every frame, so the
//! cost per frame grew with the stroke: 0.15 ms for a short one, 5.7 ms
//! after eight seconds of ink, 23 ms after thirty (native; most of a 120 Hz
//! frame's 8.3 ms, or all of it). Long strokes (shading, scribbling out, a
//! long underline) stuttered.

use bedrock_core::brush::{Brush, BrushKind};
use bedrock_core::color::Rgba;
use bedrock_core::engine::{Engine, PointerKind, ScreenSample};
use bedrock_core::geom::Vec2;
use bedrock_core::tessellate::Mesh;
use std::time::Instant;

/// Handwriting-like motion at 240 Hz that never ends: loops and zigzags
/// wandering over the page, with digitiser jitter and changing pressure.
fn sample(i: usize) -> ScreenSample {
    let t = i as f64 / 240.0;
    ScreenSample {
        x: 400.0 + 180.0 * (t * 2.3).sin() + 30.0 * (t * 9.0).sin() + (i as f64 * 0.37).sin() * 0.3,
        y: 300.0 + 120.0 * (t * 1.1).cos() + 30.0 * (t * 7.0).cos() + (i as f64 * 0.91).cos() * 0.3,
        pressure: (0.5 + 0.3 * (t * 5.0).sin()) as f32,
        altitude: 1.0,
        azimuth: 0.6,
        time: 1_000.0 + t * 1000.0,
    }
}

fn engine(brush: Brush) -> Engine {
    let mut e = Engine::new(1);
    e.resize(1366.0, 1024.0);
    e.brush = brush;
    e.pointer_down(1, PointerKind::Pen, sample(0));
    e
}

/// Distance from `p` to the capsule centre line a..b, and the radius there.
fn to_segment(p: Vec2, a: Vec2, b: Vec2, ra: f64, rb: f64) -> (f64, f64) {
    let d = b - a;
    let len2 = d.dot(d);
    let t = if len2 > 0.0 { ((p - a).dot(d) / len2).clamp(0.0, 1.0) } else { 0.0 };
    (p.distance(a + d * t), ra + (rb - ra) * t)
}

/// How far `m` strays from `reference`: for every capsule end in `m`, the
/// distance to the nearest centre line in `reference` and the difference in
/// radius there. Returns the worst of each.
fn deviation(m: &Mesh, reference: &Mesh) -> (f64, f64) {
    let abs = |mesh: &Mesh, p: [f32; 2]| Vec2::new(p[0] as f64 + mesh.origin.x, p[1] as f64 + mesh.origin.y);
    let refs: Vec<(Vec2, Vec2, f64, f64)> = reference
        .segments
        .iter()
        .map(|g| (abs(reference, g.a), abs(reference, g.b), g.ra as f64, g.rb as f64))
        .collect();
    let (mut worst_pos, mut worst_r) = (0.0f64, 0.0f64);
    for g in &m.segments {
        for (p, r) in [(abs(m, g.a), g.ra as f64), (abs(m, g.b), g.rb as f64)] {
            let (mut best, mut best_r) = (f64::INFINITY, 0.0);
            for (a, b, ra, rb) in &refs {
                // Cheap reject before the exact distance.
                if (p.x - a.x).abs() > 8.0 && (p.x - b.x).abs() > 8.0 {
                    continue;
                }
                let (d, rr) = to_segment(p, *a, *b, *ra, *rb);
                // Lines cross themselves: among near-equal distances take
                // the closest radius, so a crossing isn't read as a jump.
                if d < best - 0.02 || (d < best + 0.02 && (rr - r).abs() < (best_r - r).abs()) {
                    best = best.min(d);
                    best_r = rr;
                }
            }
            worst_pos = worst_pos.max(best);
            worst_r = worst_r.max((best_r - r).abs());
        }
    }
    (worst_pos, worst_r)
}

#[test]
fn a_long_live_stroke_looks_like_a_full_rebuild() {
    let brushes = [
        Brush::new(BrushKind::Pen, Rgba::BLACK, 2.5),
        Brush::new(BrushKind::Fountain, Rgba::BLACK, 4.0),
        Brush::new(BrushKind::Pencil, Rgba::BLACK, 3.0),
        Brush { stabilizer: 0.6, ..Brush::new(BrushKind::Pen, Rgba::BLACK, 2.5) },
    ];
    for brush in brushes {
        let mut e = engine(brush.clone());
        let mut frozen_some = false;
        for i in 1..=3000 {
            e.pointer_move(1, PointerKind::Pen, sample(i));
            // A frame every other sample, as at 120 Hz.
            if i % 2 == 0 {
                let live = e.live_mesh().unwrap();
                if i % 250 == 0 {
                    let full = e.live_mesh_full().unwrap();
                    let (pos, radius) = deviation(&live, &full);
                    let (back_pos, _) = deviation(&full, &live);
                    assert!(
                        pos < 0.2 && back_pos < 0.2,
                        "{:?} at {i}: line off by {pos:.3} / {back_pos:.3} units",
                        brush.kind
                    );
                    assert!(radius < 0.15, "{:?} at {i}: radius off by {radius:.3} units", brush.kind);
                }
            }
            frozen_some |= e.live_window_start() > 0;
        }
        assert!(frozen_some, "{:?}: nothing was ever frozen", brush.kind);
    }
}

#[test]
fn a_dashed_live_stroke_is_built_whole() {
    use bedrock_core::brush::LineStyle;
    let mut e = engine(Brush { style: LineStyle::Dashed, ..Brush::new(BrushKind::Pen, Rgba::BLACK, 2.5) });
    for i in 1..=1500 {
        e.pointer_move(1, PointerKind::Pen, sample(i));
        if i % 2 == 0 {
            e.live_mesh();
        }
    }
    assert_eq!(e.live_mesh().unwrap(), e.live_mesh_full().unwrap(), "dashes keep their rhythm from the stroke's start");
    assert_eq!(e.live_window_start(), 0);
}

#[test]
fn the_cost_of_a_live_frame_does_not_grow_with_the_stroke() {
    let mut e = engine(Brush::new(BrushKind::Pen, Rgba::BLACK, 2.5));
    let time = |e: &mut Engine, from: usize, to: usize| {
        let mut worst = 0.0f64;
        let mut total = 0.0;
        for i in from..=to {
            e.pointer_move(1, PointerKind::Pen, sample(i));
            if i % 2 == 0 {
                let t = Instant::now();
                let m = e.live_mesh().unwrap();
                let dt = t.elapsed().as_secs_f64() * 1000.0;
                assert!(m.segment_count() > 0);
                worst = worst.max(dt);
                total += dt;
            }
        }
        (total / ((to - from + 1) / 2) as f64, worst)
    };
    // The second second of ink, then the thirtieth.
    let (early, _) = time(&mut e, 1, 480);
    time(&mut e, 481, 6960);
    let (late, worst) = time(&mut e, 6961, 7200);
    let t = Instant::now();
    e.live_mesh_full();
    let full = t.elapsed().as_secs_f64() * 1000.0;
    println!(
        "live frame: {early:.3} ms early, {late:.3} ms after 30 s (worst {worst:.3} ms); full rebuild {full:.3} ms"
    );
    assert!(late < early * 4.0 + 0.5, "a frame after 30 s costs {late:.3} ms, {early:.3} ms at the start");
    assert!(
        late * 4.0 < full,
        "a frame after 30 s ({late:.3} ms) should be far cheaper than a full rebuild ({full:.3} ms)"
    );
}
