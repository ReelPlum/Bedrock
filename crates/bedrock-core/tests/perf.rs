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
}

/// Bug: on notes with 1500+ strokes, scribbling out stuttered as soon as
/// the scribble was recognised over ink. While the pen is down the strokes
/// it would erase are worked out again every few samples, and each time
/// every segment of the scribble was compared with every nearby stroke
/// (about 3 ms native for a 5 second scribble over a dense page, several
/// times that on an iPad in the browser), and the faded veil over them was
/// tessellated again from scratch whenever one more stroke joined (about
/// 11 ms). Now the scribble's segments sit in an R-tree and each veiled
/// stroke is tessellated once.
#[test]
#[ignore]
fn scribbling_out_on_a_big_note_stays_smooth() {
    use bedrock_core::engine::{Engine, PointerKind, ScreenSample};
    use bedrock_core::scene::Veil;
    use std::time::Duration;

    let mut e = Engine::new(1);
    e.resize(1366.0, 1024.0);
    // A page densely filled with 1600 handwriting strokes of 120 samples.
    let mut strokes = Vec::new();
    for i in 0..1600 {
        let (col, row) = ((i % 40) as f64, (i / 40) as f64);
        let (x0, y0) = (col * 12.0, row * 18.0);
        let pts = (0..120)
            .map(|k| {
                let u = k as f64 / 119.0;
                InputPoint::new(x0 + u * 30.0, y0 + (u * 30.0).sin() * 12.0, 0.5).at(k as f64 * 4.0)
            })
            .collect();
        strokes.push(Stroke::new(
            e.doc.next_id(),
            Brush::new(BrushKind::Pen, Rgba::BLACK, 2.0),
            i as f64,
            InputDevice::Pen,
            pts,
        ));
    }
    e.doc.set_strokes(strokes);

    // A five second scribble at 240 Hz over a few lines of it, with the
    // veil kept up to date the way the web app does on each frame.
    let sample = |i: usize| {
        let t = i as f64 / 240.0;
        ScreenSample::new(200.0 + 90.0 * (t * 25.0).sin(), 200.0 + t * 15.0, 0.5, 1000.0 + t * 1000.0)
    };
    let mut veil = Veil::default();
    let (mut worst_move, mut worst_veil, mut veil_total) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);
    e.pointer_down(1, PointerKind::Pen, sample(0));
    for i in 1..1200 {
        let t = Instant::now();
        e.pointer_move(1, PointerKind::Pen, sample(i));
        worst_move = worst_move.max(t.elapsed());
        let t = Instant::now();
        veil.update(&e.doc, e.scribble_preview(), Rgba::BLACK, 0.7);
        let d = t.elapsed();
        worst_veil = worst_veil.max(d);
        veil_total += d;
    }
    let fading = e.scribble_preview().len();
    println!(
        "scribble: worst move {worst_move:?}, veil worst {worst_veil:?} total {veil_total:?}, {fading} strokes fading, {} tessellated",
        veil.tessellated
    );
    assert!(fading > 20, "the scribble must be over ink");
    assert_eq!(veil.tessellated, fading, "each fading stroke tessellated once");
    assert!(worst_move.as_micros() < 1_500, "a pen sample must fit easily in a 120 Hz frame while scribbling out");
    assert!(worst_veil.as_micros() < 2_000, "updating the fading ink must not stall a frame");
    let t = Instant::now();
    e.pointer_up(1, PointerKind::Pen, None);
    let up = t.elapsed();
    println!("lifting the pen (erasing {fading}): {up:?}");
    assert_eq!(e.doc.len(), 1600 - fading);
    assert!(up.as_millis() < 5);
}

/// Time one call, print it, and return its result and duration.
fn timed<R>(what: &str, f: impl FnOnce() -> R) -> (R, std::time::Duration) {
    let t = Instant::now();
    let r = f();
    let d = t.elapsed();
    println!("{what}: {d:?}");
    (r, d)
}

/// A 1366 x 1024 engine on a note of `n` handwriting strokes.
fn big_engine(n: usize) -> bedrock_core::engine::Engine {
    let mut e = bedrock_core::engine::Engine::new(1);
    e.resize(1366.0, 1024.0);
    e.doc = big_note(n);
    e
}

/// Every eraser mode, one swipe across a few lines of a 100 000 stroke
/// note: each move fits in a frame, and undoing the swipe is quick.
#[test]
#[ignore]
fn erasing_on_a_big_note() {
    use bedrock_core::engine::{PointerKind, ScreenSample, Tool};
    let mut e = big_engine(100_000);
    let mut scene = Scene::new();
    scene.sync(&e.doc);
    let sample = |i: usize| {
        ScreenSample::new(100.0 + i as f64 * 3.0, 100.0 + (i as f64 * 0.3).sin() * 20.0, 0.5, 1000.0 + i as f64 * 4.0)
    };
    for (tool, name, move_ms, undo_ms) in [
        (Tool::EraseStroke, "stroke", 16, 60),
        (Tool::ErasePartial, "partial", 16, 400),
        (Tool::EraseTrim, "trim", 16, 60),
    ] {
        e.tool = tool;
        let before = e.doc.len();
        e.pointer_down(1, PointerKind::Pen, sample(0));
        let mut worst = std::time::Duration::ZERO;
        for i in 1..120 {
            let t = Instant::now();
            e.pointer_move(1, PointerKind::Pen, sample(i));
            worst = worst.max(t.elapsed());
        }
        e.pointer_up(1, PointerKind::Pen, None);
        println!("{name} eraser: worst move {worst:?} ({} -> {} strokes)", before, e.doc.len());
        assert_ne!(e.doc.len(), before, "the {name} eraser must hit something");
        assert!(worst.as_millis() < move_ms, "a {name} eraser move must fit in a 60 Hz frame on 100 000 strokes");
        let (_, sync) = timed("  redraw after", || scene.sync(&e.doc));
        assert!(sync.as_millis() < 100);
        let (_, undo) = timed("  undo", || e.undo());
        assert_eq!(e.doc.len(), before);
        assert!(undo.as_millis() < undo_ms, "undoing a {name} eraser swipe");
        scene.sync(&e.doc);
    }
}

/// Bug: moving a big selection took seconds on a big note (2000 strokes
/// on 100 000: 3.6 s to move, 2.9 s to undo). Every new id was checked by
/// looking through the whole note, and the moved strokes were taken out
/// and put back one by one, shifting the rest of the note each time.
#[test]
#[ignore]
fn moving_a_big_selection_on_a_big_note() {
    let mut d = big_note(100_000);
    let mut scene = Scene::new();
    scene.sync(&d);
    let ids: Vec<_> = d.strokes()[30_000..32_000].iter().map(|s| s.id).collect();
    let order: Vec<_> = d.strokes().iter().map(|s| s.id).collect();
    let (moved, t_move) = timed("move 2000 strokes", || d.translate(&ids, Vec2::new(5.0, 5.0)));
    assert_eq!(moved.len(), 2000);
    assert_eq!(d.strokes()[30_000].id, moved[0], "moved strokes keep their place");
    let (_, t_sync) = timed("  redraw after", || scene.sync(&d));
    let (_, t_undo) = timed("  undo", || d.undo());
    assert!(d.strokes().iter().map(|s| s.id).eq(order.iter().copied()), "undo puts every stroke back in place");
    let (_, t_redo) = timed("  redo", || d.redo());
    assert_eq!(d.strokes()[31_999].id, moved[1999]);
    assert!(t_move.as_millis() < 150, "moving 2000 strokes must not pause");
    assert!(t_undo.as_millis() < 100 && t_redo.as_millis() < 100);
    assert!(t_sync.as_millis() < 300);
    let (copies, t_dup) = timed("duplicate 2000 strokes", || d.duplicate(&moved, Vec2::new(40.0, 0.0)));
    assert_eq!(copies.len(), 2000);
    assert!(t_dup.as_millis() < 150);
}

/// Bug: grouping handwriting into words was quadratic (each stroke against
/// every line sorted a copy of that line's letter heights): 140 ms for a
/// note of 10 000 strokes, 540 ms for 20 000, 23 s for 100 000. It runs
/// again after every change to find words for search and links.
#[test]
#[ignore]
fn word_layout_on_a_big_note() {
    let d = big_note(20_000);
    let (lay, t) = timed("word layout, 20 000 strokes", || bedrock_core::words::layout(&d));
    assert!(!lay.words.is_empty());
    assert!(t.as_millis() < 60, "laying out words must not stall writing");
    let d = big_note(100_000);
    let (_, t) = timed("word layout, 100 000 strokes", || bedrock_core::words::layout(&d));
    assert!(t.as_millis() < 500);
}

/// Saving, opening and exporting a note of 10 000 strokes (a thick
/// notebook) stays quick. The minimap and the sync check of a 100 000
/// stroke note too.
#[test]
#[ignore]
fn saving_opening_and_exporting_a_big_note() {
    use bedrock_core::format;
    let d = big_note(10_000);
    let (bytes, t_save) = timed("save 10 000 strokes", || format::to_bedrock(&d));
    let (loaded, t_open) = timed("open 10 000 strokes", || format::load_bytes(&bytes, 1).unwrap());
    assert_eq!(loaded.doc.len(), d.len());
    assert!(loaded.warnings.is_empty());
    let (svg, t_svg) = timed("SVG export of 10 000 strokes", || format::to_svg(&d));
    assert!(svg.len() > 1000);
    println!("  file {} KB", bytes.len() / 1000);
    assert!(t_save.as_millis() < 1_500, "saving");
    assert!(t_open.as_millis() < 1_500, "opening");
    assert!(t_svg.as_millis() < 3_000, "exporting");

    let d = big_note(100_000);
    let (lines, t_map) = timed("minimap of 100 000 strokes", || bedrock_core::overview::polylines(&d, 2.0));
    assert!(!lines.is_empty());
    assert!(t_map.as_millis() < 300);
    let (_, t_hash) = timed("sync check of 100 000 strokes", || bedrock_core::mirror::content_hash(&d));
    assert!(t_hash.as_millis() < 50);
}

/// The eraser and lasso look at every stroke's stored bounds instead of a
/// spatial index (rstar was measured and turned down for this, see the
/// ink-latency spec); that must stay well inside a frame on 100 000 strokes.
#[test]
#[ignore]
fn eraser_and_lasso_hit_tests_on_a_big_note() {
    let d = big_note(100_000);
    let (a, b) = (Vec2::new(3000.0, 3000.0), Vec2::new(3004.0, 3002.0));
    let t = Instant::now();
    let mut hits = 0;
    for _ in 0..100 {
        hits = bedrock_core::eraser::strokes_hit(d.strokes(), a, b, 6.0).len();
    }
    let erase = t.elapsed() / 100;
    println!("eraser hit test: {erase:?} ({hits} strokes hit)");
    assert!(hits > 0);
    assert!(erase.as_micros() < 2_000, "an eraser hit test must fit easily in a 120 Hz frame");
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
