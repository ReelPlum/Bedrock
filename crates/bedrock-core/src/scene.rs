//! Batches committed strokes into GPU-friendly chunks so a frame costs a
//! handful of draw calls even with 100 000 strokes, and so a change (a new
//! stroke, an erase) only rebuilds the chunks it touched.
//!
//! * Opaque strokes are merged into chunks; translucent strokes (pencil,
//!   highlighter) get a chunk each because the renderer blends every
//!   translucent stroke exactly once (stencil), like ink on paper.
//! * Chunk boundaries are content defined (they depend on stroke ids, not
//!   positions in the list), so inserting or erasing a stroke in the middle
//!   leaves almost all other chunks untouched.
//! * Highlighters are a separate first pass so they sit underneath ink.

use crate::brush::BrushKind;
use crate::document::Document;
use crate::geom::{Rect, Vec2};
use crate::stroke::{Stroke, StrokeId};
use crate::tessellate;
use std::collections::{HashMap, HashSet};

/// Stop growing a chunk beyond this many capsules.
const MAX_CHUNK_SEGMENTS: usize = 60_000;
/// Average strokes per chunk (content-defined boundary probability 1/N).
const BOUNDARY_EVERY: u64 = 48;
/// Keep vertex coordinates small for `f32` precision.
const MAX_ORIGIN_DISTANCE: f64 = 50_000.0;

/// Floats per capsule in [`ChunkMesh::segments`].
pub const SEGMENT_FLOATS: usize = 7;
/// Bytes per capsule in [`ChunkMesh::colors`].
pub const SEGMENT_COLOR_BYTES: usize = 8;

/// GPU-ready geometry: one instance per capsule (see [`tessellate::Segment`]).
/// * `segments`: ax, ay, bx, by (relative to `origin`), ra, rb (world
///   units) and the stroke's draw order within the chunk (0, 1, 2, ...),
/// * `colors`: r, g, b, alpha at a, alpha at b, then 3 bytes of padding.
#[derive(Debug, Clone, Default)]
pub struct ChunkMesh {
    pub origin: Vec2,
    pub segments: Vec<f32>,
    pub colors: Vec<u8>,
    /// Number of strokes appended (the draw order runs 0..strokes).
    pub strokes: u32,
}

fn unorm(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

impl ChunkMesh {
    pub fn segment_count(&self) -> usize {
        self.segments.len() / SEGMENT_FLOATS
    }

    /// Append a stroke's capsules with its colour.
    pub fn append(&mut self, stroke: &Stroke) {
        let m = tessellate::mesh(stroke);
        self.append_mesh(&m, stroke);
    }

    pub fn append_mesh(&mut self, m: &tessellate::Mesh, stroke: &Stroke) {
        if self.segments.is_empty() {
            self.origin = m.origin;
        }
        let dx = (m.origin.x - self.origin.x) as f32;
        let dy = (m.origin.y - self.origin.y) as f32;
        let c = stroke.brush.color;
        let order = self.strokes as f32;
        for g in &m.segments {
            self.segments.extend_from_slice(&[g.a[0] + dx, g.a[1] + dy, g.b[0] + dx, g.b[1] + dy, g.ra, g.rb, order]);
            self.colors.extend_from_slice(&[c.r, c.g, c.b, unorm(g.alpha_a), unorm(g.alpha_b), 0, 0, 0]);
        }
        self.strokes += 1;
    }

    /// Append a stroke's capsules in another colour, `alpha` times as
    /// opaque (e.g. a veil in the paper's colour over ink about to go).
    pub fn append_tinted(&mut self, m: &tessellate::Mesh, color: crate::color::Rgba, alpha: f32) {
        if self.segments.is_empty() {
            self.origin = m.origin;
        }
        let dx = (m.origin.x - self.origin.x) as f32;
        let dy = (m.origin.y - self.origin.y) as f32;
        let order = self.strokes as f32;
        for g in &m.segments {
            self.segments.extend_from_slice(&[g.a[0] + dx, g.a[1] + dy, g.b[0] + dx, g.b[1] + dy, g.ra, g.rb, order]);
            self.colors.extend_from_slice(&[color.r, color.g, color.b, unorm(alpha), unorm(alpha), 0, 0, 0]);
        }
        self.strokes += 1;
    }

    /// World-space bounds of everything in the chunk.
    pub fn bounds(&self) -> Rect {
        let mut r = Rect::EMPTY;
        for g in self.segments.as_chunks::<SEGMENT_FLOATS>().0 {
            for (x, y, rad) in [(g[0], g[1], g[4]), (g[2], g[3], g[5])] {
                let c = Vec2::new(x as f64 + self.origin.x, y as f64 + self.origin.y);
                let rad = rad as f64;
                r.include(c - Vec2::new(rad, rad));
                r.include(c + Vec2::new(rad, rad));
            }
        }
        r
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChunkInfo {
    pub key: u64,
    pub bounds: Rect,
    /// Draw with per-stroke "blend once" stencil.
    pub translucent: bool,
    pub stroke_count: usize,
}

/// Result of [`Scene::sync`]: what the renderer must upload and free.
#[derive(Debug, Default)]
pub struct SceneDiff {
    pub added: Vec<(ChunkInfo, ChunkMesh)>,
    pub removed: Vec<u64>,
}

#[derive(Debug, Default)]
pub struct Scene {
    chunks: HashMap<u64, ChunkInfo>,
    order: Vec<u64>,
    /// Document revision and hash of the hidden strokes last synced.
    revision: Option<(u64, u64)>,
    /// Geometry of strokes in recently rebuilt chunks. Strokes never change
    /// once committed (erasing makes new ones), so finishing a stroke only
    /// tessellates that stroke; the rest of its chunk comes from here.
    cache: HashMap<StrokeId, tessellate::Mesh>,
}

/// Keep at most this many strokes' geometry cached between syncs.
const CACHE_STROKES: usize = 4096;

fn fnv(hash: &mut u64, v: u64) {
    for b in v.to_le_bytes() {
        *hash ^= b as u64;
        *hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
    }
}

fn is_translucent(s: &Stroke) -> bool {
    s.brush.kind == BrushKind::Pencil || s.brush.stroke_alpha() < 0.999
}

impl Scene {
    pub fn new() -> Self {
        Self::default()
    }

    /// Chunks in draw order.
    pub fn chunks(&self) -> impl Iterator<Item = &ChunkInfo> {
        self.order.iter().filter_map(|k| self.chunks.get(k))
    }

    pub fn chunk_count(&self) -> usize {
        self.order.len()
    }

    /// Chunks intersecting `view`, in draw order.
    pub fn visible<'a>(&'a self, view: &'a Rect) -> impl Iterator<Item = &'a ChunkInfo> + 'a {
        self.chunks().filter(move |c| c.bounds.intersects(view))
    }

    /// Bring the scene up to date with `doc`. Cheap when nothing changed.
    pub fn sync(&mut self, doc: &Document) -> SceneDiff {
        self.sync_hiding(doc, &[])
    }

    /// Like [`Scene::sync`], leaving out `hidden` strokes (e.g. a selection
    /// being dragged, which is drawn elsewhere meanwhile).
    pub fn sync_hiding(&mut self, doc: &Document, hidden: &[StrokeId]) -> SceneDiff {
        let mut hidden_key = 0xcbf2_9ce4_8422_2325u64;
        for id in hidden {
            fnv(&mut hidden_key, id.0);
        }
        if self.revision == Some((doc.revision(), hidden_key)) {
            return SceneDiff::default();
        }
        self.revision = Some((doc.revision(), hidden_key));
        let hidden: HashSet<StrokeId> = hidden.iter().copied().collect();
        let strokes = doc.strokes();
        let mut groups: Vec<(u64, bool, Vec<usize>)> = Vec::new();
        for highlight_pass in [true, false] {
            let mut current: Vec<usize> = Vec::new();
            let mut hash = 0xcbf2_9ce4_8422_2325u64;
            let mut verts = 0usize;
            let mut origin = Vec2::ZERO;
            let close = |current: &mut Vec<usize>, hash: &mut u64, verts: &mut usize, groups: &mut Vec<_>| {
                if !current.is_empty() {
                    groups.push((*hash, false, std::mem::take(current)));
                }
                *hash = 0xcbf2_9ce4_8422_2325;
                *verts = 0;
            };
            for (i, s) in strokes.iter().enumerate() {
                if (s.brush.kind == BrushKind::Highlighter) != highlight_pass
                    || s.points.is_empty()
                    || hidden.contains(&s.id)
                {
                    continue;
                }
                if is_translucent(s) {
                    close(&mut current, &mut hash, &mut verts, &mut groups);
                    let mut h = 0x9e37_79b9_7f4a_7c15u64;
                    fnv(&mut h, s.id.0);
                    groups.push((h, true, vec![i]));
                    continue;
                }
                let p0 = s.points[0].pos();
                if !current.is_empty() && p0.distance(origin) > MAX_ORIGIN_DISTANCE {
                    close(&mut current, &mut hash, &mut verts, &mut groups);
                }
                if current.is_empty() {
                    origin = p0;
                }
                current.push(i);
                fnv(&mut hash, s.id.0);
                verts += s.points.len() + 1;
                if s.id.0 % BOUNDARY_EVERY == 0 || verts > MAX_CHUNK_SEGMENTS {
                    close(&mut current, &mut hash, &mut verts, &mut groups);
                }
            }
            close(&mut current, &mut hash, &mut verts, &mut groups);
        }

        let mut diff = SceneDiff::default();
        let mut new_order = Vec::with_capacity(groups.len());
        let mut live: HashSet<u64> = HashSet::with_capacity(groups.len());
        for (key, translucent, idxs) in groups {
            // The same id list can't occur twice, but stay safe.
            if !live.insert(key) {
                continue;
            }
            new_order.push(key);
            if self.chunks.contains_key(&key) {
                continue;
            }
            let mut mesh = ChunkMesh::default();
            let mut bounds = Rect::EMPTY;
            for &i in &idxs {
                let s = &strokes[i];
                match self.cache.get(&s.id) {
                    Some(m) => mesh.append_mesh(m, s),
                    None => {
                        let m = tessellate::mesh(s);
                        mesh.append_mesh(&m, s);
                        // Cache the newest strokes: that is where writing happens.
                        if i + CACHE_STROKES >= strokes.len() {
                            self.cache.insert(s.id, m);
                        }
                    }
                }
                bounds = bounds.union(&s.bounds());
            }
            let info = ChunkInfo { key, bounds, translucent, stroke_count: idxs.len() };
            self.chunks.insert(key, info.clone());
            diff.added.push((info, mesh));
        }
        self.chunks.retain(|k, _| {
            let keep = live.contains(k);
            if !keep {
                diff.removed.push(*k);
            }
            keep
        });
        self.order = new_order;
        if self.cache.len() > CACHE_STROKES {
            // Drop strokes that are no longer among the newest (or are gone).
            let keep: HashSet<StrokeId> =
                strokes[strokes.len().saturating_sub(CACHE_STROKES)..].iter().map(|s| s.id).collect();
            self.cache.retain(|id, _| keep.contains(id));
        }
        diff
    }

    /// Strokes with cached geometry (for tests).
    pub fn cached_strokes(&self) -> usize {
        self.cache.len()
    }

    /// Ids drawn per chunk is not stored (only geometry); this helper is for tests.
    #[cfg(test)]
    fn total_strokes(&self) -> usize {
        self.chunks().map(|c| c.stroke_count).sum()
    }
}

/// Convenience used by tests and tools: strokes intersecting `view`.
pub fn visible_strokes<'a>(doc: &'a Document, view: &'a Rect) -> impl Iterator<Item = StrokeId> + 'a {
    doc.strokes().iter().filter(move |s| s.bounds().intersects(view)).map(|s| s.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::Brush;
    use crate::color::Rgba;
    use crate::input::InputPoint;
    use crate::stroke::InputDevice;

    fn add(doc: &mut Document, kind: BrushKind, x: f64) -> StrokeId {
        let id = doc.next_id();
        let pts = (0..5).map(|i| InputPoint::new(x + i as f64, 0.0, 0.5)).collect();
        doc.add_stroke(Stroke::new(id, Brush::new(kind, Rgba::BLACK, 2.0), 0.0, InputDevice::Pen, pts));
        id
    }

    #[test]
    fn opaque_strokes_are_batched() {
        let mut d = Document::new(1);
        for i in 0..500 {
            add(&mut d, BrushKind::Pen, i as f64 * 10.0);
        }
        let mut sc = Scene::new();
        let diff = sc.sync(&d);
        assert_eq!(sc.total_strokes(), 500);
        assert!(sc.chunk_count() < 60, "{} chunks", sc.chunk_count());
        assert_eq!(diff.added.len(), sc.chunk_count());
        for (_, m) in &diff.added {
            assert_eq!(m.segments.len() % SEGMENT_FLOATS, 0);
            assert_eq!(m.colors.len(), m.segment_count() * SEGMENT_COLOR_BYTES);
            assert!(m.segment_count() >= m.strokes as usize);
            assert!(m.segments.iter().all(|v| v.is_finite()));
        }
    }

    #[test]
    fn sync_is_incremental() {
        let mut d = Document::new(2);
        let ids: Vec<_> = (0..400).map(|i| add(&mut d, BrushKind::Pen, i as f64 * 10.0)).collect();
        let mut sc = Scene::new();
        sc.sync(&d);
        assert!(sc.sync(&d).added.is_empty(), "no change, no work");
        let before = sc.chunk_count();
        // Erase one stroke in the middle: only its chunk is rebuilt.
        d.replace(&[ids[200]], vec![]);
        let diff = sc.sync(&d);
        assert_eq!(diff.removed.len(), 1);
        assert_eq!(diff.added.len(), 1);
        assert_eq!(sc.chunk_count(), before);
        assert_eq!(sc.total_strokes(), 399);
        // Add a stroke at the end: at most the last chunk changes.
        add(&mut d, BrushKind::Pen, 9999.0);
        let diff = sc.sync(&d);
        assert!(diff.added.len() <= 1 && diff.removed.len() <= 1);
    }

    #[test]
    fn translucent_strokes_get_own_chunks_and_highlighters_go_first() {
        let mut d = Document::new(3);
        add(&mut d, BrushKind::Pen, 0.0);
        add(&mut d, BrushKind::Pencil, 10.0);
        add(&mut d, BrushKind::Pen, 20.0);
        add(&mut d, BrushKind::Highlighter, 30.0);
        let mut sc = Scene::new();
        sc.sync(&d);
        let chunks: Vec<_> = sc.chunks().cloned().collect();
        assert!(chunks[0].translucent, "highlighter first");
        assert_eq!(chunks.iter().filter(|c| c.translucent).count(), 2);
        assert_eq!(sc.total_strokes(), 4);
    }

    #[test]
    fn finishing_a_stroke_reuses_the_rest_of_its_chunk() {
        let mut d = Document::new(5);
        for i in 0..30 {
            add(&mut d, BrushKind::Pen, i as f64 * 10.0);
        }
        let mut sc = Scene::new();
        let first: Vec<_> = sc.sync(&d).added.into_iter().map(|(_, m)| m.segments).collect();
        assert_eq!(sc.cached_strokes(), 30);
        // A rebuilt chunk from cached geometry is identical to a fresh one.
        add(&mut d, BrushKind::Pen, 999.0);
        sc.sync(&d);
        let mut fresh = Scene::new();
        let a: Vec<f32> = fresh.sync(&d).added.into_iter().flat_map(|(_, m)| m.segments).collect();
        let mut again = Scene::new();
        again.cache = sc.cache.clone();
        let b: Vec<f32> = again.sync(&d).added.into_iter().flat_map(|(_, m)| m.segments).collect();
        assert_eq!(a, b);
        assert!(!first.is_empty());
    }

    #[test]
    fn cache_stays_bounded() {
        let mut d = Document::new(6);
        for i in 0..(CACHE_STROKES + 500) {
            add(&mut d, BrushKind::Pen, i as f64 * 3.0);
        }
        let mut sc = Scene::new();
        sc.sync(&d);
        assert!(sc.cached_strokes() <= CACHE_STROKES, "{}", sc.cached_strokes());
    }

    #[test]
    fn culling() {
        let mut d = Document::new(4);
        add(&mut d, BrushKind::Pen, 0.0);
        add(&mut d, BrushKind::Pen, 100_000.0);
        let mut sc = Scene::new();
        sc.sync(&d);
        let view = Rect::new(Vec2::new(-50.0, -50.0), Vec2::new(50.0, 50.0));
        assert_eq!(visible_strokes(&d, &view).count(), 1);
        let vis: Vec<_> = sc.visible(&view).collect();
        assert_eq!(vis.iter().map(|c| c.stroke_count).sum::<usize>(), 1, "far stroke is in another chunk");
    }
}
