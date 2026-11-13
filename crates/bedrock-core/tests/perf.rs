//! Performance budget for big notes (research target: a note with 100 000
//! strokes stays smooth). Run with:
//!   cargo test --release -p bedrock-core --test perf -- --ignored --nocapture

use bedrock_core::brush::{Brush, BrushKind};
use bedrock_core::camera::Camera;
use bedrock_core::color::Rgba;
use bedrock_core::document::Document;
use bedrock_core::geom::Vec2;
use bedrock_core::input::InputPoint;
use bedrock_core::scene::Scene;
use bedrock_core::stroke::{InputDevice, Stroke};
use std::time::Instant;

fn big_note(n: usize) -> Document {
    let mut d = Document::new(1);
    let mut strokes = Vec::with_capacity(n);
    for i in 0..n {
        // Handwriting-sized strokes laid out in lines across a large area.
        let (col, row) = ((i % 400) as f64, (i / 400) as f64);
        let (x0, y0) = (col * 20.0, row * 30.0);
        let pts = (0..24)
            .map(|k| {
                let u = k as f64 / 23.0;
                InputPoint::new(x0 + u * 14.0, y0 + (u * 9.0).sin() * 8.0, 0.5).at(k as f64 * 4.0)
            })
            .collect();
        let kind = if i % 50 == 0 { BrushKind::Highlighter } else { BrushKind::Pen };
        strokes.push(Stroke::new(d.next_id(), Brush::new(kind, Rgba::BLACK, 2.0), i as f64, InputDevice::Pen, pts));
    }
    d.set_strokes(strokes);
    d
}

#[test]
#[ignore]
fn hundred_thousand_strokes() {
    let n = 100_000;
    let mut d = big_note(n);
    let mut scene = Scene::new();

    let t = Instant::now();
    let diff = scene.sync(&d);
    let build = t.elapsed();
    let segs: usize = diff.added.iter().map(|(_, m)| m.segment_count()).sum();
    println!("initial build: {build:?} for {n} strokes, {} chunks, {segs} capsules", scene.chunk_count());
    assert!(segs / n < 120, "GPU memory: {} capsules per stroke is too many", segs / n);

    // Per frame work while panning: cull chunks against the view.
    let cam = Camera { offset: Vec2::new(3000.0, 3000.0), zoom: 1.0, viewport: Vec2::new(1366.0, 1024.0) };
    let view = cam.visible_world();
    let t = Instant::now();
    let mut visible = 0;
    for _ in 0..100 {
        visible = scene.visible(&view).count();
    }
    let cull = t.elapsed() / 100;
    println!("cull per frame: {cull:?} ({visible} visible chunks)");
    assert!(cull.as_micros() < 2_000, "culling must fit easily in a 120 Hz frame");
    assert!(visible < scene.chunk_count() / 4);

    // Adding one stroke (the common case while writing) must be incremental.
    let id = d.next_id();
    d.add_stroke(Stroke::new(id, Brush::default(), 0.0, InputDevice::Pen, vec![InputPoint::new(1.0, 1.0, 0.5)]));
    let t = Instant::now();
    let diff = scene.sync(&d);
    let incr = t.elapsed();
    println!("incremental sync after one stroke: {incr:?}, rebuilt {} chunk(s)", diff.added.len());
    assert!(diff.added.len() <= 2);
    assert!(incr.as_millis() < 50, "adding a stroke must not stall the next frame");

    // The eraser and the lasso look at every stroke's bounds. That is kept
    // instead of a spatial index (rstar was considered): it fits easily in
    // a frame, and an index would have to give strokes back in stacking
    // order, which costs as much as the scan.
    let (a, b) = (Vec2::new(3000.0, 3000.0), Vec2::new(3004.0, 3002.0));
    let t = Instant::now();
    let mut hits = 0;
    for _ in 0..100 {
        hits = bedrock_core::eraser::strokes_hit(d.strokes(), a, b, 6.0).len();
    }
    let erase = t.elapsed() / 100;
    println!("eraser per move: {erase:?} ({hits} strokes hit)");
    assert!(hits > 0);
    assert!(erase.as_micros() < 2_000, "an eraser move must fit easily in a 120 Hz frame");
    let lasso: Vec<Vec2> = (0..64)
        .map(|k| {
            let u = k as f64 / 64.0 * std::f64::consts::TAU;
            Vec2::new(3000.0 + 80.0 * u.cos(), 3000.0 + 40.0 * u.sin())
        })
        .collect();
    let t = Instant::now();
    let mut taken = 0;
    for _ in 0..20 {
        taken = bedrock_core::selection::strokes_in_lasso(&d, &lasso).len();
    }
    let select = t.elapsed() / 20;
    println!("lasso: {select:?} ({taken} strokes taken)");
    assert!(taken > 0);
    assert!(select.as_millis() < 5, "a lasso must select without a visible pause");
}
