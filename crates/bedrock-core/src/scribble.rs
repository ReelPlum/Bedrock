//! Scribble to erase: scribbling back and forth over ink erases it.
//!
//! A finished stroke counts as a scribble when it goes back and forth many
//! times along one direction (each pass covering most of its width) and is
//! far longer than the area it covers. Handwriting rarely does both: a
//! cursive "mmm" goes up and down often but moves steadily right, so its
//! passes are short compared with its width. On top of that, only ink that
//! lies mostly inside the scribble is erased, and a scribble over nothing is
//! kept as ink (it is shading, or a drawing).

use crate::document::Document;
use crate::eraser;
use crate::geom::{Rect, Vec2};
use crate::stroke::{Stroke, StrokeId};

/// Back-and-forth turns needed along one direction.
pub const MIN_TURNS: usize = 5;
/// A pass must cover this share of the scribble's extent in that direction.
pub const PASS_SHARE: f64 = 0.5;
/// Path length over the size of the area covered (width + height).
pub const MIN_DENSITY: f64 = 3.5;
/// Share of a stroke's samples that must lie under the scribble.
pub const COVERED_SHARE: f64 = 0.6;

/// Most a scribble may loop the same way round, in laps: a zigzag's turns
/// alternate and cancel out, a loop drawn round and round (circling a word,
/// cursive "eee") adds one lap each time.
pub const MAX_LAPS: f64 = 1.5;
/// A turn counts as a full half lap once the pass leaving it runs this far
/// (as a share of the shortest pass that counts) beside the pass that came
/// in, and in proportion below that: a reversal back along the same line
/// has no side at all.
pub const OPEN_TURN: f64 = 0.25;

/// The turns of a path along one axis.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Turns {
    /// Back-and-forth turns.
    count: usize,
    /// Net laps: each turn is half a lap one way or the other, by the side
    /// the pen left on.
    laps: f64,
}

/// Turns along an axis (`along` picks the coordinate, `across` the other
/// one) with hysteresis: a turn counts once the pen has come back by
/// `min_pass`. Passes are measured from the stroke's own extremes, so it
/// makes no difference where between them the pen first touched down.
///
/// Which way a turn goes round is read from the two passes that meet in it,
/// half a pass away from the turn itself, never from the angle at its tip:
/// a tight reversal's tip angle is close to 180 degrees, and whether that is
/// "left" or "right" there is decided by sampling and noise.
fn turns(points: &[Vec2], along: impl Fn(Vec2) -> f64, across: impl Fn(Vec2) -> f64, min_pass: f64) -> Turns {
    let mut out = Turns::default();
    if points.len() < 3 || min_pass <= 0.0 {
        return out;
    }
    let mut dir = 0.0f64; // +1 / -1 once moving
    let (mut lo, mut hi) = (along(points[0]), along(points[0]));
    let mut extreme = lo;
    let mut extreme_at = 0usize;
    for (i, p) in points.iter().enumerate().skip(1) {
        let v = along(*p);
        if dir == 0.0 {
            // Not moving yet: wait until the pen has covered a pass's worth
            // of ground, whichever way it wandered first.
            lo = lo.min(v);
            hi = hi.max(v);
            if hi - lo >= min_pass {
                dir = if v >= hi { 1.0 } else { -1.0 };
                extreme = v;
                extreme_at = i;
            }
        } else if (v - extreme) * dir > 0.0 {
            extreme = v;
            extreme_at = i;
        } else if (extreme - v) * dir >= min_pass {
            out.count += 1;
            // The pass in, at the same depth the pass out has reached now.
            let level = extreme - dir * min_pass;
            let before = points[..extreme_at].iter().rposition(|q| (along(*q) - level) * dir <= 0.0);
            if let Some(b) = before {
                // In proportion, not all or nothing: a zigzag's turns are
                // all about equally open, so they cancel whatever the size.
                let side = dir * (across(*p) - across(points[b]));
                out.laps += 0.5 * (side / (OPEN_TURN * min_pass)).clamp(-1.0, 1.0);
            }
            dir = -dir;
            extreme = v;
            extreme_at = i;
        }
    }
    out
}

fn ink_rect(points: &[Vec2]) -> Rect {
    points.iter().fold(Rect::EMPTY, |mut r, p| {
        r.include(*p);
        r
    })
}

/// Does this stroke look like a scribble?
pub fn is_scribble(stroke: &Stroke) -> bool {
    let pts: Vec<Vec2> = stroke.points.iter().map(|p| p.pos()).collect();
    if pts.len() < 8 {
        return false;
    }
    let r = ink_rect(&pts);
    let size = r.width() + r.height();
    if size <= 0.0 {
        return false;
    }
    let length: f64 = pts.windows(2).map(|w| w[0].distance(w[1])).sum();
    if length < size * MIN_DENSITY {
        return false;
    }
    let tx = turns(&pts, |p| p.x, |p| p.y, r.width() * PASS_SHARE);
    let ty = turns(&pts, |p| p.y, |p| p.x, r.height() * PASS_SHARE);
    let t = if tx.count >= ty.count { tx } else { ty };
    // Going round and round (circling something for emphasis, a row of
    // cursive loops) also turns back and forth along an axis, but always
    // the same way round.
    t.count >= MIN_TURNS && t.laps.abs() <= MAX_LAPS
}

/// The strokes a scribble erases: touched by it and mostly under it.
pub fn targets(doc: &Document, scribble: &Stroke) -> Vec<StrokeId> {
    let pts: Vec<Vec2> = scribble.points.iter().map(|p| p.pos()).collect();
    let radius = (scribble.brush.size as f64 * 0.5).max(1.0);
    let area = ink_rect(&pts).inflate(radius * 2.0);
    let mut hit: Vec<StrokeId> = Vec::new();
    for w in pts.windows(2) {
        for id in eraser::strokes_hit(doc.strokes(), w[0], w[1], radius) {
            if !hit.contains(&id) {
                hit.push(id);
            }
        }
    }
    doc.strokes()
        .iter()
        .filter(|s| hit.contains(&s.id) && s.id != scribble.id)
        .filter(|s| {
            let n = s.points.iter().filter(|p| area.contains(p.pos())).count();
            n as f64 >= s.points.len() as f64 * COVERED_SHARE
        })
        .map(|s| s.id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::Brush;
    use crate::input::InputPoint;
    use crate::stroke::InputDevice;

    fn stroke(doc: &mut Document, pts: &[(f64, f64)]) -> Stroke {
        let id = doc.next_id();
        Stroke::new(
            id,
            Brush::default(),
            0.0,
            InputDevice::Pen,
            pts.iter().map(|p| InputPoint::new(p.0, p.1, 0.5)).collect(),
        )
    }

    /// Back and forth over [x0, x1], drifting down from y0 to y1.
    fn zigzag(x0: f64, x1: f64, y0: f64, y1: f64, passes: usize) -> Vec<(f64, f64)> {
        let mut v = Vec::new();
        for i in 0..=passes {
            let y = y0 + (y1 - y0) * i as f64 / passes as f64;
            let x = if i % 2 == 0 { x0 } else { x1 };
            v.push((x, y));
            // Samples along the pass, as a real pen gives.
            if i < passes {
                let nx = if i % 2 == 0 { x1 } else { x0 };
                let ny = y0 + (y1 - y0) * (i + 1) as f64 / passes as f64;
                for k in 1..6 {
                    let f = k as f64 / 6.0;
                    v.push((x + (nx - x) * f, y + (ny - y) * f));
                }
            }
        }
        v
    }

    /// Cursive "m"s: up and down humps moving steadily right.
    fn cursive_ms(x0: f64, y: f64, humps: usize) -> Vec<(f64, f64)> {
        let mut v = Vec::new();
        for i in 0..humps * 8 {
            let t = i as f64 / 8.0;
            v.push((x0 + t * 10.0, y - (t * std::f64::consts::PI).sin().abs() * 20.0));
        }
        v
    }

    #[test]
    fn scribbles_are_recognised_and_writing_is_not() {
        let mut d = Document::new(1);
        assert!(is_scribble(&stroke(&mut d, &zigzag(0.0, 60.0, 0.0, 20.0, 8))));
        assert!(is_scribble(&stroke(&mut d, &zigzag(0.0, 60.0, 0.0, 6.0, 6))), "a flat one");
        // Up and down (vertical scribble).
        let vertical: Vec<_> = zigzag(0.0, 60.0, 0.0, 20.0, 8).into_iter().map(|(x, y)| (y, x)).collect();
        assert!(is_scribble(&stroke(&mut d, &vertical)));
        assert!(!is_scribble(&stroke(&mut d, &zigzag(0.0, 60.0, 0.0, 20.0, 3))), "too few passes");
        // Straight back and forth on one line (turns of exactly half a lap).
        assert!(is_scribble(&stroke(&mut d, &zigzag(0.0, 60.0, 10.0, 10.0, 8))));
        assert!(!is_scribble(&stroke(&mut d, &cursive_ms(0.0, 100.0, 8))), "cursive mmmm");
        let line: Vec<_> = (0..20).map(|i| (i as f64 * 5.0, 0.0)).collect();
        assert!(!is_scribble(&stroke(&mut d, &line)));
        // A loop drawn round and round (e.g. circling something).
        let circle: Vec<_> = (0..120)
            .map(|i| {
                let a = i as f64 / 20.0 * std::f64::consts::TAU;
                (50.0 + 40.0 * a.cos(), 50.0 + 40.0 * a.sin())
            })
            .collect();
        assert!(!is_scribble(&stroke(&mut d, &circle)), "circling is not scribbling");
    }

    /// A hand-like scribble at 240 Hz: a sine back and forth over
    /// `2 * half` units, drifting down, with digitiser jitter. `phase` 0
    /// starts in the middle of its width, a quarter turn starts at an edge.
    fn wavy(half: f64, rad_per_s: f64, secs: f64, jitter: f64, phase: f64) -> Vec<(f64, f64)> {
        (0..=(secs * 240.0) as usize)
            .map(|i| {
                let t = i as f64 / 240.0;
                (
                    300.0 + half * (t * rad_per_s + phase).sin() + (i as f64 * 0.37).sin() * jitter,
                    300.0 + t * 12.0 + (i as f64 * 0.91).cos() * jitter,
                )
            })
            .collect()
    }

    /// Bug: tight scribbles were missed at random. The side of each
    /// reversal was read from the angle at its tip (close to 180 degrees,
    /// so its sign was noise), and the sum drifted past the "going round in
    /// circles" limit: 41 of 400 of these were missed starting at an edge,
    /// 107 of 400 starting in the middle (where the first passes were not
    /// counted either).
    #[test]
    fn tight_scribbles_are_recognised_wherever_they_start() {
        let mut d = Document::new(1);
        let mut missed = Vec::new();
        for phase in [0.0, std::f64::consts::FRAC_PI_2] {
            for half in [15.0, 20.0, 30.0, 40.0, 60.0] {
                for speed in [20.0, 25.0, 30.0, 38.0] {
                    for secs in [1.5, 2.0, 2.5, 3.0, 4.0] {
                        for jitter in [0.0, 0.1, 0.2, 0.4] {
                            if !is_scribble(&stroke(&mut d, &wavy(half, speed, secs, jitter, phase))) {
                                missed.push((phase, half, speed, secs, jitter));
                            }
                        }
                    }
                }
            }
        }
        assert!(
            missed.is_empty(),
            "{} of 800 scribbles missed, e.g. {:?}",
            missed.len(),
            &missed[..missed.len().min(5)]
        );
    }

    /// Loops all drawn the same way round are writing or emphasis, not a
    /// scribble, however many there are and however noisy the pen.
    #[test]
    fn loops_are_not_scribbles() {
        let mut d = Document::new(1);
        for jitter in [0.0, 0.2, 0.4] {
            // A row of cursive "e" / "l" loops moving right.
            for (advance, w, h) in [(8.0, 6.0, 12.0), (6.0, 5.0, 24.0), (4.0, 8.0, 16.0)] {
                let loops: Vec<_> = (0..12 * 40)
                    .map(|i| {
                        let a = i as f64 / 40.0 * std::f64::consts::TAU;
                        (
                            100.0
                                + advance * a / std::f64::consts::TAU
                                + w * a.sin()
                                + (i as f64 * 0.37).sin() * jitter,
                            100.0 - h * (1.0 - a.cos()) * 0.5 + (i as f64 * 0.91).cos() * jitter,
                        )
                    })
                    .collect();
                assert!(!is_scribble(&stroke(&mut d, &loops)), "cursive loops {advance} {w} {h}, jitter {jitter}");
            }
            // Circling something several times, as an ellipse.
            let ring: Vec<_> = (0..200)
                .map(|i| {
                    let a = i as f64 / 40.0 * std::f64::consts::TAU;
                    (
                        50.0 + 60.0 * a.cos() + (i as f64 * 0.37).sin() * jitter,
                        50.0 + 20.0 * a.sin() + (i as f64 * 0.91).cos() * jitter,
                    )
                })
                .collect();
            assert!(!is_scribble(&stroke(&mut d, &ring)), "circling, jitter {jitter}");
        }
    }

    #[test]
    fn erases_only_ink_mostly_under_the_scribble() {
        let mut d = Document::new(1);
        let word = stroke(&mut d, &[(10.0, 10.0), (20.0, 15.0), (30.0, 10.0), (40.0, 15.0)]);
        let long = stroke(&mut d, &[(30.0, 12.0), (200.0, 12.0), (400.0, 12.0)]); // passes through
        let away = stroke(&mut d, &[(300.0, 300.0), (310.0, 300.0)]);
        let (w, l, a) = (word.id, long.id, away.id);
        for s in [word, long, away] {
            d.add_stroke(s);
        }
        let s = stroke(&mut d, &zigzag(5.0, 45.0, 5.0, 20.0, 8));
        assert_eq!(targets(&d, &s), vec![w]);
        assert!(!targets(&d, &s).contains(&l) && !targets(&d, &s).contains(&a));
    }
}
