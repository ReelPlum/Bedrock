//! Handwriting layout: which strokes form which words, on which lines.
//!
//! Runs on every change (it is fast: sorting plus one pass per line), so a
//! recogniser always gets whole words and a spell checker knows where to
//! draw its underline. Purely geometric and time based, so it works for any
//! script and any recogniser:
//!
//! 1. **Writing strokes.** Highlighters, and strokes much larger than the
//!    writing around them (drawings, underlines spanning a paragraph), are
//!    left out.
//! 2. **Lines.** Strokes are taken in writing order; each joins the line whose
//!    middle band it overlaps and that it continues horizontally, or starts a
//!    new line. So a word squeezed in later still joins its line.
//! 3. **Words.** Within a line, strokes are sorted left to right and merged
//!    while the gap to the word so far is small compared with the line's
//!    letter height. Overlapping strokes (the dot of an i, the bar of a t)
//!    always join.

use crate::brush::BrushKind;
use crate::document::Document;
use crate::geom::{Rect, Vec2};
use crate::stroke::{Stroke, StrokeId};

/// One handwritten word.
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    /// Stable while the word's strokes are unchanged (hash of their ids).
    pub id: u64,
    /// Strokes in writing order.
    pub strokes: Vec<StrokeId>,
    /// Bounds of the ink centre lines (without brush width).
    pub bounds: Rect,
    /// Index into the line list, top to bottom.
    pub line: usize,
}

/// A line of handwriting.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub bounds: Rect,
    /// Typical letter height on this line (world units).
    pub letter_height: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Layout {
    pub lines: Vec<Line>,
    pub words: Vec<Word>,
}

/// Centre-line bounds (brush width left out: a thick pen doesn't make
/// letters taller).
fn ink_bounds(s: &Stroke) -> Rect {
    let mut r = Rect::EMPTY;
    for p in &s.points {
        r.include(p.pos());
    }
    r
}

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

struct Building {
    bounds: Rect,
    /// Middle band: the y range where most strokes' centres sit.
    centre: f64,
    heights: Vec<f64>,
    members: Vec<usize>,
}

impl Building {
    fn letter_height(&self) -> f64 {
        let mut h = self.heights.clone();
        median(&mut h).max(1e-6)
    }
}

/// Lay out all the handwriting in `doc`.
pub fn layout(doc: &Document) -> Layout {
    let strokes = doc.strokes();
    // 1. Writing strokes, with their bounds.
    let cand: Vec<(usize, Rect)> = strokes
        .iter()
        .enumerate()
        .filter(|(_, s)| s.brush.kind != BrushKind::Highlighter && !s.points.is_empty())
        .map(|(i, s)| (i, ink_bounds(s)))
        .collect();
    if cand.is_empty() {
        return Layout::default();
    }
    // Typical letter height across the page: the median stroke height,
    // ignoring dots and dashes (tiny strokes). Strokes far larger than that
    // are drawings, not writing.
    let mut hs: Vec<f64> = cand.iter().map(|(_, r)| r.height().max(r.width() * 0.25)).collect();
    let page_h = median(&mut hs).max(1e-6);
    let writing: Vec<(usize, Rect)> =
        cand.into_iter().filter(|(_, r)| r.height() <= page_h * 5.0 && r.width() <= page_h * 40.0).collect();

    // 2. Lines, in writing order (document order is drawing order).
    let mut lines: Vec<Building> = Vec::new();
    for &(i, r) in &writing {
        let cy = (r.min.y + r.max.y) * 0.5;
        let h = r.height().max(page_h * 0.3);
        let mut best: Option<(usize, f64)> = None;
        for (li, l) in lines.iter().enumerate() {
            let lh = l.letter_height();
            // Vertically: the stroke's centre near the line's centre. Small
            // marks (i dots, accents, commas) may sit a letter above the
            // line or just below it.
            let small = r.height() < page_h * 0.4 && r.width() < page_h;
            let dy = (cy - l.centre).abs();
            let near_band = cy >= l.bounds.min.y - lh && cy <= l.bounds.max.y + lh * 0.6;
            if dy > lh * 0.75 && !(small && near_band) {
                continue;
            }
            let dy = dy.min(lh * 0.75);
            // Horizontally: overlapping, or continuing it within a gap.
            let gap = (r.min.x - l.bounds.max.x).max(l.bounds.min.x - r.max.x).max(0.0);
            if gap > lh * 4.0 {
                continue;
            }
            let score = dy / lh + gap / (lh * 8.0);
            if best.is_none_or(|(_, s)| score < s) {
                best = Some((li, score));
            }
        }
        match best {
            Some((li, _)) => {
                let l = &mut lines[li];
                l.bounds = l.bounds.union(&r);
                l.members.push(i);
                // Small marks (dots, commas) don't move the line's centre.
                if r.height() >= page_h * 0.4 {
                    l.heights.push(h);
                    let n = l.heights.len() as f64;
                    l.centre += (cy - l.centre) / n;
                }
            }
            None => lines.push(Building { bounds: r, centre: cy, heights: vec![h], members: vec![i] }),
        }
    }
    // Fractions: a numerator and denominator sit above and below a bar, far
    // from the line's middle, so they start lines of their own. Pull ink that
    // lies over or under a bar (within its width, about a letter away) into
    // the bar's line, so the whole fraction becomes one word.
    let rect_of = |i: usize| writing.iter().find(|w| w.0 == i).unwrap().1;
    let mut moves: Vec<(usize, usize, usize)> = Vec::new(); // (from line, member, to line)
    for (bl, l) in lines.iter().enumerate() {
        // A bar on its own has no letters to measure: use the page's.
        let lh = l.letter_height().max(page_h);
        for &bi in &l.members {
            let b = rect_of(bi);
            if b.width() < lh * 1.2 || b.height() > lh * 0.35 {
                continue;
            }
            let cy = (b.min.y + b.max.y) * 0.5;
            for (ol, o) in lines.iter().enumerate() {
                if ol == bl {
                    continue;
                }
                for &m in &o.members {
                    let r = rect_of(m);
                    let inside = r.min.x >= b.min.x - lh * 0.3 && r.max.x <= b.max.x + lh * 0.3;
                    let gap = (r.min.y - cy).max(cy - r.max.y);
                    if inside && gap >= 0.0 && gap < lh * 1.2 {
                        moves.push((ol, m, bl));
                    }
                }
            }
        }
    }
    for (from, m, to) in moves {
        if let Some(k) = lines[from].members.iter().position(|&x| x == m) {
            lines[from].members.remove(k);
            let r = rect_of(m);
            lines[to].members.push(m);
            lines[to].bounds = lines[to].bounds.union(&r);
        }
    }
    lines.retain(|l| !l.members.is_empty());
    for l in &mut lines {
        l.bounds = l.members.iter().fold(Rect::EMPTY, |acc, &m| acc.union(&rect_of(m)));
    }
    lines.sort_by(|a, b| a.centre.total_cmp(&b.centre));

    // 3. Words within each line.
    let mut out = Layout::default();
    for (li, l) in lines.iter().enumerate() {
        let lh = l.letter_height();
        out.lines.push(Line { bounds: l.bounds, letter_height: lh });
        let mut members: Vec<(usize, Rect)> =
            l.members.iter().map(|&i| (i, writing.iter().find(|w| w.0 == i).unwrap().1)).collect();
        members.sort_by(|a, b| a.1.min.x.total_cmp(&b.1.min.x));
        // Gap that separates words: letters within a word sit closer than
        // about 0.45 letter heights in typical handwriting, word gaps wider.
        let split = lh * 0.45;
        let mut current: Vec<usize> = Vec::new();
        let mut cur_bounds = Rect::EMPTY;
        let flush = |current: &mut Vec<usize>, cur_bounds: &mut Rect, out: &mut Layout| {
            if current.is_empty() {
                return;
            }
            current.sort_unstable(); // writing order
            let ids: Vec<StrokeId> = current.iter().map(|&i| strokes[i].id).collect();
            let mut h = 0xcbf2_9ce4_8422_2325u64;
            for id in &ids {
                for b in id.0.to_le_bytes() {
                    h ^= b as u64;
                    h = h.wrapping_mul(0x0000_0100_0000_01B3);
                }
            }
            out.words.push(Word { id: h, strokes: ids, bounds: *cur_bounds, line: li });
            current.clear();
            *cur_bounds = Rect::EMPTY;
        };
        for (i, r) in members {
            if !current.is_empty() && r.min.x - cur_bounds.max.x > split {
                flush(&mut current, &mut cur_bounds, &mut out);
            }
            current.push(i);
            cur_bounds = cur_bounds.union(&r);
        }
        flush(&mut current, &mut cur_bounds, &mut out);
    }
    out
}

/// The word containing `p`, if any (e.g. for tapping a misspelling).
pub fn word_at(layout: &Layout, p: Vec2, slop: f64) -> Option<&Word> {
    layout.words.iter().find(|w| w.bounds.inflate(slop).contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::Brush;
    use crate::color::Rgba;
    use crate::input::InputPoint;
    use crate::stroke::InputDevice;

    /// A fake letter: a small zigzag `w` wide and `h` tall at (x, y).
    fn letter(doc: &mut Document, x: f64, y: f64, w: f64, h: f64) -> StrokeId {
        let pts = (0..=8)
            .map(|k| InputPoint::new(x + w * k as f64 / 8.0, y + if k % 2 == 0 { 0.0 } else { -h }, 0.5))
            .collect();
        let id = doc.next_id();
        doc.add_stroke(Stroke::new(id, Brush::new(BrushKind::Pen, Rgba::BLACK, 2.0), 0.0, InputDevice::Pen, pts));
        id
    }

    /// Writes words of `n` letters (16 wide, 4 apart) with 30 between words.
    fn write_line(doc: &mut Document, x: f64, y: f64, words: &[usize]) -> Vec<Vec<StrokeId>> {
        let mut out = Vec::new();
        let mut cx = x;
        for &n in words {
            let mut w = Vec::new();
            for _ in 0..n {
                w.push(letter(doc, cx, y, 16.0, 30.0));
                cx += 20.0;
            }
            cx += 30.0;
            out.push(w);
        }
        out
    }

    #[test]
    fn groups_letters_into_words_and_lines() {
        let mut doc = Document::new(1);
        let l1 = write_line(&mut doc, 0.0, 100.0, &[3, 1, 5]);
        let l2 = write_line(&mut doc, 0.0, 180.0, &[2, 4]);
        let lay = layout(&doc);
        assert_eq!(lay.lines.len(), 2);
        let got: Vec<Vec<StrokeId>> = lay.words.iter().map(|w| w.strokes.clone()).collect();
        let want: Vec<Vec<StrokeId>> = l1.into_iter().chain(l2).collect();
        assert_eq!(got, want);
        assert!(lay.words[..3].iter().all(|w| w.line == 0) && lay.words[3..].iter().all(|w| w.line == 1));
    }

    #[test]
    fn dots_and_crossbars_join_their_word() {
        let mut doc = Document::new(2);
        let w = write_line(&mut doc, 0.0, 100.0, &[3]);
        // The dot of an i above the second letter, drawn last.
        let id = doc.next_id();
        doc.add_stroke(Stroke::new(
            id,
            Brush::default(),
            0.0,
            InputDevice::Pen,
            vec![InputPoint::new(28.0, 55.0, 0.5), InputPoint::new(28.5, 55.5, 0.5)],
        ));
        let lay = layout(&doc);
        assert_eq!(lay.words.len(), 1, "{:?}", lay.words);
        assert_eq!(lay.words[0].strokes.len(), w[0].len() + 1);
    }

    #[test]
    fn a_word_added_later_joins_its_line() {
        let mut doc = Document::new(3);
        write_line(&mut doc, 0.0, 100.0, &[2]);
        write_line(&mut doc, 0.0, 200.0, &[2]);
        // Back on the first line, after its first word.
        write_line(&mut doc, 70.0, 101.0, &[3]);
        let lay = layout(&doc);
        assert_eq!(lay.lines.len(), 2);
        assert_eq!(lay.words.iter().filter(|w| w.line == 0).count(), 2);
    }

    #[test]
    fn drawings_and_highlights_are_not_words() {
        let mut doc = Document::new(4);
        write_line(&mut doc, 0.0, 100.0, &[3, 3]);
        // A big circle drawn around it, and a highlighter pass.
        let id = doc.next_id();
        let circle = (0..64)
            .map(|k| {
                let a = k as f64 / 63.0 * std::f64::consts::TAU;
                InputPoint::new(80.0 + 200.0 * a.cos(), 85.0 + 200.0 * a.sin(), 0.5)
            })
            .collect();
        doc.add_stroke(Stroke::new(id, Brush::default(), 0.0, InputDevice::Pen, circle));
        let id = doc.next_id();
        doc.add_stroke(Stroke::new(
            id,
            Brush::new(BrushKind::Highlighter, Rgba::rgb(255, 230, 0), 6.0),
            0.0,
            InputDevice::Pen,
            vec![InputPoint::new(0.0, 85.0, 0.5), InputPoint::new(150.0, 85.0, 0.5)],
        ));
        let lay = layout(&doc);
        assert_eq!(lay.words.len(), 2, "{:?}", lay.words.iter().map(|w| w.strokes.len()).collect::<Vec<_>>());
    }

    #[test]
    fn word_ids_are_stable_and_lookup_works() {
        let mut doc = Document::new(5);
        write_line(&mut doc, 0.0, 100.0, &[3, 2]);
        let a = layout(&doc);
        write_line(&mut doc, 0.0, 300.0, &[4]);
        let b = layout(&doc);
        assert_eq!(a.words[0].id, b.words[0].id);
        assert_eq!(a.words[1].id, b.words[1].id);
        assert_eq!(word_at(&b, Vec2::new(10.0, 90.0), 2.0).map(|w| w.id), Some(a.words[0].id));
        assert!(word_at(&b, Vec2::new(10.0, 250.0), 2.0).is_none());
    }

    #[test]
    fn layout_of_a_full_page_is_fast() {
        let mut doc = Document::new(6);
        for line in 0..40 {
            write_line(&mut doc, 0.0, 100.0 + line as f64 * 60.0, &[4, 3, 6, 2, 5, 3]);
        }
        let t = std::time::Instant::now();
        let lay = layout(&doc);
        assert_eq!(lay.words.len(), 240);
        assert!(t.elapsed().as_millis() < 200, "{:?}", t.elapsed());
    }
}
