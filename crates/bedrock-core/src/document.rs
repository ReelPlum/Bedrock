//! A note: ordered strokes (z-order = creation order), metadata, undo/redo,
//! recognised text, and a change feed.
//!
//! ## Change feed
//! Every mutation (including undo/redo) is reported as [`Change`] events,
//! drained with [`Document::take_changes`]. Renderers use it to update GPU
//! caches, autosave uses it to know when to write, and a future real-time
//! handwriting recogniser can subscribe to exactly the strokes that appeared
//! or disappeared instead of rescanning the page.

use crate::geom::{Rect, Vec2};
use crate::stroke::{Stroke, StrokeId};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Added(StrokeId),
    Removed(StrokeId),
}

/// Text recognised from a group of strokes. Reserved for handwriting
/// recognition: Bedrock stores and preserves it, and removes entries whose
/// strokes were erased so they never point at missing ink.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecognizedText {
    pub id: String,
    pub text: String,
    /// The strokes the text was recognised from, in writing order.
    pub strokes: Vec<StrokeId>,
    /// Optional alternatives, best first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alternatives: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    /// BCP 47 language tag, e.g. "en" or "da".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Which recogniser produced it, e.g. "apple-vision/1".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
}

/// A picture placed on the page. Its file (`images/<name>` in the note
/// bundle) is stored once in [`Document::assets`], so copies of one picture
/// share it. Pictures sit under all ink, in this order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Image {
    /// Same id space as strokes, so a selection can hold both.
    pub id: StrokeId,
    /// Path of the picture inside the bundle, e.g. `images/3f2a….png`.
    /// Empty for a text box.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub file: String,
    /// A text box (typed or pasted text) instead of a picture file. Its
    /// lines are `\n` separated and fill the box's height.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Top-left corner and size on the page, in world units.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Image {
    /// What its pixels are cached under: the file, or the text.
    pub fn texture_key(&self) -> String {
        match &self.text {
            Some(t) => format!("text:{t}"),
            None => self.file.clone(),
        }
    }

    pub fn rect(&self) -> Rect {
        Rect { min: Vec2::new(self.x, self.y), max: Vec2::new(self.x + self.w, self.y + self.h) }
    }
}

#[derive(Debug, Clone)]
enum Op {
    /// Strokes removed (index in the old list) and added (index in the new list).
    /// `renamed` pairs (old id, new id) for strokes that were moved: their
    /// recognised text, link and word grouping follow them to the new id.
    Replace { removed: Vec<(usize, Stroke)>, added: Vec<(usize, Stroke)>, renamed: Vec<(StrokeId, StrokeId)> },
    /// The pictures before and after (there are few, so whole lists).
    Images { before: Vec<Image>, after: Vec<Image> },
}

/// A link on handwriting: a group of strokes (usually one word) that points
/// somewhere. `kind` says how to read `target`:
///
/// * `"url"`: a web address, e.g. `https://example.com`.
/// * `"note"`: another note by name (an Obsidian note, `[[Name]]`), for later.
///
/// New kinds can be added without changing the file format: unknown kinds
/// are kept and written back. Links stay in the document while their ink is
/// erased (so undo brings them back) but are only saved while all their
/// strokes exist.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Link {
    pub strokes: Vec<StrokeId>,
    pub target: String,
    #[serde(rename = "type", default = "url_kind")]
    pub kind: String,
    /// The linked words as text (from recognition), for tools that show
    /// links without the ink, such as a note graph. Filled in when saving.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// The writer says which recogniser some ink is for ("text" or "math"),
/// overriding the guess. A word follows the override if any of its strokes
/// is in it, so writing more of a formula keeps it maths.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KindOverride {
    pub strokes: Vec<StrokeId>,
    pub kind: String,
}

fn url_kind() -> String {
    "url".to_string()
}

#[derive(Debug, Clone)]
pub struct Document {
    pub title: String,
    /// Unix epoch ms.
    pub created: f64,
    pub modified: f64,
    pub background: crate::color::Rgba,
    /// Paper pattern: "plain", "dots", "grid" or "lines".
    pub paper: String,
    strokes: Vec<Stroke>,
    pub recognition: Vec<RecognizedText>,
    pub links: Vec<Link>,
    /// Strokes the writer made into one word (see [`Document::group`]).
    pub groups: Vec<Vec<StrokeId>>,
    /// Text or maths, as the writer set it (see [`Document::set_kind`]).
    pub kinds: Vec<KindOverride>,
    /// Pictures on the page, bottom first.
    images: Vec<Image>,
    /// Picture files by bundle path. Kept when a picture is removed (undo
    /// can bring it back); only files a picture uses are saved.
    pub assets: std::collections::BTreeMap<String, Vec<u8>>,
    /// Unknown top level fields from newer versions, written back unchanged.
    pub extra: serde_json::Map<String, serde_json::Value>,
    undo: Vec<Vec<Op>>,
    redo: Vec<Vec<Op>>,
    /// Open undo group: ops recorded while a gesture (e.g. erasing) runs.
    group: Option<Vec<Op>>,
    changes: Vec<Change>,
    revision: u64,
    id_state: u64,
}

impl Default for Document {
    fn default() -> Self {
        Document::new(0)
    }
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Document {
    /// `seed` should be random (the web app uses `crypto.getRandomValues`)
    /// so stroke ids from different devices never collide.
    pub fn new(seed: u64) -> Self {
        Document {
            title: String::new(),
            created: 0.0,
            modified: 0.0,
            background: crate::color::Rgba::rgb(0xfb, 0xfa, 0xf6),
            paper: "dots".to_string(),
            strokes: Vec::new(),
            recognition: Vec::new(),
            links: Vec::new(),
            groups: Vec::new(),
            kinds: Vec::new(),
            images: Vec::new(),
            assets: Default::default(),
            extra: Default::default(),
            undo: Vec::new(),
            redo: Vec::new(),
            group: None,
            changes: Vec::new(),
            revision: 0,
            id_state: seed,
        }
    }

    pub fn reseed(&mut self, seed: u64) {
        self.id_state ^= seed;
    }

    pub fn next_id(&mut self) -> StrokeId {
        loop {
            let id = StrokeId(splitmix64(&mut self.id_state));
            if id.0 != 0 && self.find(id).is_none() && self.image(id).is_none() {
                return id;
            }
        }
    }

    pub fn strokes(&self) -> &[Stroke] {
        &self.strokes
    }

    pub fn len(&self) -> usize {
        self.strokes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.strokes.is_empty()
    }

    pub fn find(&self, id: StrokeId) -> Option<&Stroke> {
        self.strokes.iter().find(|s| s.id == id)
    }

    /// Increments on every change; cheap "is my cache stale?" check.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn bounds(&self) -> Rect {
        let ink = self.strokes.iter().fold(Rect::EMPTY, |r, s| r.union(&s.bounds()));
        self.images.iter().fold(ink, |r, i| r.union(&i.rect()))
    }

    pub fn images(&self) -> &[Image] {
        &self.images
    }

    pub fn image(&self, id: StrokeId) -> Option<&Image> {
        self.images.iter().find(|i| i.id == id)
    }

    /// Load pictures without recording history (used when opening a file).
    pub fn set_images(&mut self, images: Vec<Image>) {
        self.images = images;
        self.revision += 1;
    }

    /// Place a picture on top of the others (under all ink), storing its
    /// file. One undo step. Returns its id.
    pub fn add_image(&mut self, file: &str, bytes: Option<Vec<u8>>, rect: Rect) -> StrokeId {
        if let Some(b) = bytes {
            self.assets.insert(file.to_string(), b);
        }
        let id = self.next_id();
        let mut after = self.images.clone();
        after.push(Image {
            id,
            file: file.to_string(),
            text: None,
            x: rect.min.x,
            y: rect.min.y,
            w: rect.width(),
            h: rect.height(),
        });
        self.apply_and_record(Op::Images { before: self.images.clone(), after });
        id
    }

    /// Place a text box on top of the pictures (under all ink). One undo
    /// step. Returns its id.
    pub fn add_text(&mut self, text: &str, rect: Rect) -> StrokeId {
        let id = self.next_id();
        let mut after = self.images.clone();
        after.push(Image {
            id,
            file: String::new(),
            text: Some(text.to_string()),
            x: rect.min.x,
            y: rect.min.y,
            w: rect.width(),
            h: rect.height(),
        });
        self.apply_and_record(Op::Images { before: self.images.clone(), after });
        id
    }

    /// Move a picture to a new place and size. One undo step.
    pub fn place_image(&mut self, id: StrokeId, rect: Rect) -> bool {
        let ok = |v: f64| v.is_finite();
        if !(ok(rect.min.x) && ok(rect.min.y) && ok(rect.max.x) && ok(rect.max.y)) || rect.width() <= 0.0 {
            return false;
        }
        let mut after = self.images.clone();
        let Some(img) = after.iter_mut().find(|i| i.id == id) else { return false };
        (img.x, img.y, img.w, img.h) = (rect.min.x, rect.min.y, rect.width(), rect.height());
        self.apply_and_record(Op::Images { before: self.images.clone(), after });
        true
    }

    /// Remove pictures and strokes together, as one undo step.
    pub fn remove(&mut self, ids: &[StrokeId]) {
        let mine: HashSet<StrokeId> = ids.iter().copied().collect();
        let mut ops = Vec::new();
        if self.images.iter().any(|i| mine.contains(&i.id)) {
            let after = self.images.iter().filter(|i| !mine.contains(&i.id)).cloned().collect();
            ops.push(Op::Images { before: self.images.clone(), after });
        }
        let removed: Vec<(usize, Stroke)> = self
            .strokes
            .iter()
            .enumerate()
            .filter(|(_, s)| mine.contains(&s.id))
            .map(|(i, s)| (i, s.clone()))
            .collect();
        if !removed.is_empty() {
            ops.push(Op::Replace { removed, added: vec![], renamed: vec![] });
        }
        self.apply_and_record_all(ops);
    }

    /// The bundle files that pictures on the page use.
    pub fn used_assets(&self) -> Vec<(&str, &[u8])> {
        let mut seen = HashSet::new();
        self.images
            .iter()
            .filter(|i| !i.file.is_empty() && seen.insert(i.file.as_str()))
            .filter_map(|i| self.assets.get(&i.file).map(|b| (i.file.as_str(), b.as_slice())))
            .collect()
    }

    /// Drain pending change events.
    pub fn take_changes(&mut self) -> Vec<Change> {
        std::mem::take(&mut self.changes)
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Load strokes without recording history (used when opening a file).
    pub fn set_strokes(&mut self, strokes: Vec<Stroke>) {
        for s in self.strokes.drain(..) {
            self.changes.push(Change::Removed(s.id));
        }
        for s in &strokes {
            self.changes.push(Change::Added(s.id));
        }
        self.strokes = strokes;
        self.undo.clear();
        self.redo.clear();
        self.group = None;
        self.revision += 1;
    }

    pub fn add_stroke(&mut self, stroke: Stroke) {
        let idx = self.strokes.len();
        self.apply_and_record(Op::Replace { removed: vec![], added: vec![(idx, stroke)], renamed: vec![] });
    }

    /// Remove `remove` and insert each `(parent, piece)` where its parent was
    /// (pieces whose parent is not removed are appended). One undo step.
    pub fn replace(&mut self, remove: &[StrokeId], pieces: Vec<(StrokeId, Stroke)>) {
        if remove.is_empty() && pieces.is_empty() {
            return;
        }
        let remove_set: HashSet<StrokeId> = remove.iter().copied().collect();
        let mut removed = Vec::new();
        let mut added = Vec::new();
        let mut new_index = 0usize;
        let mut pieces = pieces;
        for (i, s) in self.strokes.iter().enumerate() {
            if remove_set.contains(&s.id) {
                removed.push((i, s.clone()));
                let (mine, rest): (Vec<_>, Vec<_>) = pieces.into_iter().partition(|(p, _)| *p == s.id);
                pieces = rest;
                for (_, piece) in mine {
                    added.push((new_index, piece));
                    new_index += 1;
                }
            } else {
                new_index += 1;
            }
        }
        for (_, piece) in pieces {
            added.push((new_index, piece));
            new_index += 1;
        }
        self.apply_and_record(Op::Replace { removed, added, renamed: vec![] });
    }

    /// Move strokes by `delta`, as one undo step. Moved strokes get new ids
    /// (so every cache keyed by id, such as the GPU chunks, sees them as new)
    /// and keep their place in the stacking order; their recognised text,
    /// link and word grouping move with them. Returns the new ids, in the
    /// order of `ids` (unknown ids are skipped).
    pub fn translate(&mut self, ids: &[StrokeId], delta: Vec2) -> Vec<StrokeId> {
        let wanted: HashSet<StrokeId> = ids.iter().copied().collect();
        if wanted.is_empty() || !(delta.x.is_finite() && delta.y.is_finite()) {
            return Vec::new();
        }
        let mut removed = Vec::new();
        let mut added = Vec::new();
        let mut renamed = Vec::new();
        let olds: Vec<(usize, Stroke)> = self
            .strokes
            .iter()
            .enumerate()
            .filter(|(_, s)| wanted.contains(&s.id))
            .map(|(i, s)| (i, s.clone()))
            .collect();
        for (i, old) in olds {
            let mut moved = old.clone();
            moved.id = self.next_id();
            for p in &mut moved.points {
                p.x += delta.x;
                p.y += delta.y;
            }
            moved.recompute_bounds();
            renamed.push((old.id, moved.id));
            removed.push((i, old));
            added.push((i, moved));
        }
        let mut ops = Vec::new();
        let moves_images = self.images.iter().any(|i| wanted.contains(&i.id));
        if moves_images {
            let mut after = self.images.clone();
            for i in after.iter_mut().filter(|i| wanted.contains(&i.id)) {
                i.x += delta.x;
                i.y += delta.y;
            }
            ops.push(Op::Images { before: self.images.clone(), after });
        }
        if removed.is_empty() && !moves_images {
            return Vec::new();
        }
        if !removed.is_empty() {
            ops.push(Op::Replace { removed, added, renamed: renamed.clone() });
        }
        self.apply_and_record_all(ops);
        // Pictures keep their ids.
        let map: HashMap<StrokeId, StrokeId> = renamed.into_iter().collect();
        ids.iter().filter_map(|id| map.get(id).copied().or_else(|| self.image(*id).map(|i| i.id))).collect()
    }

    /// Make these strokes one word, whatever the automatic word splitting
    /// says. Strokes leave any group they were in. Not an undo step (like
    /// recognised text), but it is saved with the note.
    pub fn group(&mut self, ids: &[StrokeId]) {
        let mine: HashSet<StrokeId> = ids.iter().copied().collect();
        if mine.is_empty() {
            return;
        }
        for g in &mut self.groups {
            g.retain(|s| !mine.contains(s));
        }
        self.groups.retain(|g| g.len() > 1);
        let ordered: Vec<StrokeId> = self.strokes.iter().map(|s| s.id).filter(|id| mine.contains(id)).collect();
        if !ordered.is_empty() {
            self.groups.push(ordered);
        }
        self.revision += 1;
    }

    /// Undo [`Document::group`] for every group that shares a stroke with
    /// `ids`: their strokes are split into words automatically again.
    pub fn ungroup(&mut self, ids: &[StrokeId]) -> bool {
        let mine: HashSet<StrokeId> = ids.iter().copied().collect();
        let before = self.groups.len();
        self.groups.retain(|g| !g.iter().any(|s| mine.contains(s)));
        let changed = self.groups.len() != before;
        if changed {
            self.revision += 1;
        }
        changed
    }

    /// Say these strokes are `kind` ("text" or "math"), replacing any
    /// earlier say on them. What a recogniser read for them is dropped, so
    /// they are read again by the right one; the writer's own text stays.
    pub fn set_kind(&mut self, ids: &[StrokeId], kind: &str) {
        let mine: HashSet<StrokeId> = ids.iter().copied().collect();
        if mine.is_empty() {
            return;
        }
        self.kinds.retain(|k| !k.strokes.iter().any(|s| mine.contains(s)));
        self.kinds.push(KindOverride { strokes: ids.to_vec(), kind: kind.to_string() });
        self.recognition.retain(|r| {
            r.engine.as_deref() == Some(crate::handwriting::USER) || !r.strokes.iter().any(|s| mine.contains(s))
        });
        self.revision += 1;
    }

    /// The writer's say on what kind some strokes are, if any.
    pub fn kind_of(&self, ids: &[StrokeId]) -> Option<&str> {
        self.kinds.iter().rev().find(|k| k.strokes.iter().any(|s| ids.contains(s))).map(|k| k.kind.as_str())
    }

    /// Kind overrides, limited to strokes that still exist (what is saved).
    pub fn live_kinds(&self) -> Vec<KindOverride> {
        let ids: HashSet<StrokeId> = self.strokes.iter().map(|s| s.id).collect();
        self.kinds
            .iter()
            .map(|k| KindOverride {
                strokes: k.strokes.iter().copied().filter(|s| ids.contains(s)).collect(),
                kind: k.kind.clone(),
            })
            .filter(|k| !k.strokes.is_empty())
            .collect()
    }

    /// Word groups whose strokes all still exist (what is saved).
    pub fn live_groups(&self) -> Vec<Vec<StrokeId>> {
        let ids: HashSet<StrokeId> = self.strokes.iter().map(|s| s.id).collect();
        self.groups.iter().filter(|g| !g.is_empty() && g.iter().all(|s| ids.contains(s))).cloned().collect()
    }

    fn apply_and_record(&mut self, op: Op) {
        self.apply_and_record_all(vec![op]);
    }

    /// Several ops as one undo step.
    fn apply_and_record_all(&mut self, ops: Vec<Op>) {
        if ops.is_empty() {
            return;
        }
        for op in &ops {
            self.apply(op, false);
        }
        match &mut self.group {
            Some(g) => g.extend(ops),
            None => self.undo.push(ops),
        }
        self.redo.clear();
    }

    /// Start collecting changes into a single undo step.
    pub fn begin_group(&mut self) {
        self.end_group();
        self.group = Some(Vec::new());
    }

    /// Close the current undo group (no-op if none or empty).
    pub fn end_group(&mut self) {
        if let Some(g) = self.group.take() {
            if !g.is_empty() {
                self.undo.push(g);
            }
        }
    }

    fn apply(&mut self, op: &Op, inverse: bool) {
        let (removed, added, renamed) = match op {
            Op::Replace { removed, added, renamed } => (removed, added, renamed),
            Op::Images { before, after } => {
                self.images = if inverse { before.clone() } else { after.clone() };
                self.revision += 1;
                return;
            }
        };
        let (take, put) = if inverse { (added, removed) } else { (removed, added) };
        if !renamed.is_empty() {
            let map: HashMap<StrokeId, StrokeId> =
                renamed.iter().map(|&(a, b)| if inverse { (b, a) } else { (a, b) }).collect();
            let rename = |v: &mut Vec<StrokeId>| {
                for id in v.iter_mut() {
                    if let Some(n) = map.get(id) {
                        *id = *n;
                    }
                }
            };
            for r in &mut self.recognition {
                rename(&mut r.strokes);
            }
            for l in &mut self.links {
                rename(&mut l.strokes);
            }
            for g in &mut self.groups {
                rename(g);
            }
            for k in &mut self.kinds {
                rename(&mut k.strokes);
            }
        }
        for (i, s) in take.iter().rev() {
            debug_assert_eq!(self.strokes[*i].id, s.id);
            self.strokes.remove(*i);
            self.changes.push(Change::Removed(s.id));
        }
        for (i, s) in put {
            self.strokes.insert(*i, s.clone());
            self.changes.push(Change::Added(s.id));
        }
        if !take.is_empty() {
            let gone: HashSet<StrokeId> = take.iter().map(|(_, s)| s.id).collect();
            self.recognition.retain(|r| !r.strokes.iter().any(|id| gone.contains(id)));
        }
        self.revision += 1;
    }

    /// Links whose strokes all exist, with their text from recognition.
    pub fn live_links(&self) -> Vec<Link> {
        let ids: HashSet<StrokeId> = self.strokes.iter().map(|s| s.id).collect();
        self.links
            .iter()
            .filter(|l| !l.strokes.is_empty() && l.strokes.iter().all(|s| ids.contains(s)))
            .map(|l| {
                let mut l = l.clone();
                if let Some(t) = self.text_of(&l.strokes) {
                    l.text = Some(t);
                }
                l
            })
            .collect()
    }

    /// Recognised text of some strokes: the words read from them, in
    /// writing order, joined by spaces. None if nothing was read.
    pub fn text_of(&self, strokes: &[StrokeId]) -> Option<String> {
        let mine: HashSet<StrokeId> = strokes.iter().copied().collect();
        let index: HashMap<StrokeId, usize> = self.strokes.iter().enumerate().map(|(i, s)| (s.id, i)).collect();
        let mut parts: Vec<(usize, &str)> = self
            .recognition
            .iter()
            .filter(|r| !r.strokes.is_empty() && r.strokes.iter().all(|s| mine.contains(s)))
            .map(|r| {
                (r.strokes.iter().filter_map(|s| index.get(s)).copied().min().unwrap_or(usize::MAX), r.text.as_str())
            })
            .collect();
        if parts.is_empty() {
            return None;
        }
        parts.sort_by_key(|p| p.0);
        Some(parts.iter().map(|p| p.1).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" "))
    }

    /// Make these strokes (any number of words) a link, replacing links on
    /// any of them; an empty target removes those links.
    pub fn set_link(&mut self, strokes: &[StrokeId], target: &str, kind: &str) {
        let mine: HashSet<StrokeId> = strokes.iter().copied().collect();
        self.links.retain(|l| !l.strokes.iter().any(|s| mine.contains(s)));
        let target = target.trim();
        if !target.is_empty() && !strokes.is_empty() {
            self.links.push(Link {
                strokes: strokes.to_vec(),
                target: target.to_string(),
                kind: kind.to_string(),
                text: None,
            });
        }
        self.revision += 1;
    }

    /// The link a word belongs to (all its strokes are in the link).
    pub fn link_of(&self, word: &[StrokeId]) -> Option<&Link> {
        if word.is_empty() {
            return None;
        }
        self.links.iter().rev().find(|l| word.iter().all(|s| l.strokes.contains(s)))
    }

    pub fn undo(&mut self) -> bool {
        self.end_group();
        match self.undo.pop() {
            Some(ops) => {
                for op in ops.iter().rev() {
                    self.apply(op, true);
                }
                self.redo.push(ops);
                true
            }
            None => false,
        }
    }

    pub fn redo(&mut self) -> bool {
        self.end_group();
        match self.redo.pop() {
            Some(ops) => {
                for op in &ops {
                    self.apply(op, false);
                }
                self.undo.push(ops);
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::Brush;
    use crate::input::InputPoint;
    use crate::stroke::InputDevice;

    fn stroke(doc: &mut Document, x: f64) -> Stroke {
        let id = doc.next_id();
        Stroke::new(id, Brush::default(), 0.0, InputDevice::Pen, vec![InputPoint::new(x, 0.0, 0.5)])
    }

    #[test]
    fn ids_are_unique_and_deterministic_per_seed() {
        let mut a = Document::new(42);
        let mut b = Document::new(42);
        let ids: Vec<_> = (0..1000).map(|_| a.next_id()).collect();
        let set: HashSet<_> = ids.iter().collect();
        assert_eq!(set.len(), ids.len());
        assert_eq!(ids[0], b.next_id());
        assert_ne!(Document::new(43).next_id(), ids[0]);
    }

    #[test]
    fn add_undo_redo_with_change_feed() {
        let mut d = Document::new(1);
        let s = stroke(&mut d, 0.0);
        let id = s.id;
        d.add_stroke(s);
        assert_eq!(d.take_changes(), vec![Change::Added(id)]);
        assert!(d.undo());
        assert!(d.is_empty());
        assert_eq!(d.take_changes(), vec![Change::Removed(id)]);
        assert!(d.redo());
        assert_eq!(d.len(), 1);
        assert_eq!(d.take_changes(), vec![Change::Added(id)]);
        assert!(!d.redo());
    }

    #[test]
    fn moving_strokes_keeps_their_text_link_and_group_through_undo() {
        let mut d = Document::new(1);
        let a = stroke(&mut d, 0.0);
        let b = stroke(&mut d, 5.0);
        let (ia, ib) = (a.id, b.id);
        d.add_stroke(a);
        d.add_stroke(b);
        d.recognition.push(RecognizedText {
            id: "w".into(),
            text: "hi".into(),
            strokes: vec![ia, ib],
            alternatives: vec![],
            confidence: None,
            language: None,
            engine: None,
        });
        d.links.push(Link {
            strokes: vec![ia, ib],
            target: "https://example.com".into(),
            kind: "url".into(),
            text: None,
        });
        d.group(&[ia, ib]);
        d.take_changes();
        let new = d.translate(&[ia, ib], Vec2::new(10.0, 0.0));
        assert_eq!(new.len(), 2);
        assert_eq!(d.strokes()[0].points[0].x, 10.0);
        assert_eq!(d.recognition[0].strokes, new);
        assert_eq!(d.links[0].strokes, new);
        assert_eq!(d.live_groups(), vec![new.clone()]);
        assert_eq!(d.live_links()[0].text.as_deref(), Some("hi"));
        assert_eq!(d.take_changes().len(), 4, "two removed, two added");
        d.undo();
        assert_eq!(d.recognition[0].strokes, vec![ia, ib]);
        assert_eq!(d.links[0].strokes, vec![ia, ib]);
        assert_eq!(d.live_groups(), vec![vec![ia, ib]]);
        d.redo();
        assert_eq!(d.recognition[0].strokes, new);
    }

    #[test]
    fn grouping_moves_strokes_out_of_older_groups() {
        let mut d = Document::new(1);
        let ids: Vec<_> = (0..3)
            .map(|i| {
                let s = stroke(&mut d, i as f64);
                let id = s.id;
                d.add_stroke(s);
                id
            })
            .collect();
        d.group(&[ids[2], ids[0], ids[1]]);
        assert_eq!(d.groups, vec![ids.clone()], "kept in stacking order");
        let r = d.revision();
        d.group(&[ids[1], ids[2]]);
        assert!(d.revision() > r, "the layout must be redone");
        assert_eq!(d.groups, vec![vec![ids[1], ids[2]]], "a group of one is no group");
        assert!(d.ungroup(&[ids[2]]));
        assert!(d.groups.is_empty());
    }

    #[test]
    fn new_action_clears_redo() {
        let mut d = Document::new(1);
        let a = stroke(&mut d, 0.0);
        d.add_stroke(a);
        d.undo();
        let b = stroke(&mut d, 1.0);
        d.add_stroke(b);
        assert!(!d.can_redo());
    }

    #[test]
    fn replace_keeps_z_order_and_undoes() {
        let mut d = Document::new(7);
        let strokes: Vec<_> = (0..3).map(|i| stroke(&mut d, i as f64)).collect();
        let ids: Vec<_> = strokes.iter().map(|s| s.id).collect();
        for s in strokes {
            d.add_stroke(s);
        }
        let p1 = stroke(&mut d, 10.0);
        let p2 = stroke(&mut d, 11.0);
        let (p1id, p2id) = (p1.id, p2.id);
        d.replace(&[ids[1]], vec![(ids[1], p1), (ids[1], p2)]);
        let order: Vec<_> = d.strokes().iter().map(|s| s.id).collect();
        assert_eq!(order, vec![ids[0], p1id, p2id, ids[2]]);
        d.undo();
        let order: Vec<_> = d.strokes().iter().map(|s| s.id).collect();
        assert_eq!(order, ids);
        d.redo();
        let order: Vec<_> = d.strokes().iter().map(|s| s.id).collect();
        assert_eq!(order, vec![ids[0], p1id, p2id, ids[2]]);
    }

    #[test]
    fn erasing_ink_drops_its_recognised_text() {
        let mut d = Document::new(3);
        let a = stroke(&mut d, 0.0);
        let b = stroke(&mut d, 1.0);
        let (aid, bid) = (a.id, b.id);
        d.add_stroke(a);
        d.add_stroke(b);
        d.recognition.push(RecognizedText {
            id: "r1".into(),
            text: "hi".into(),
            strokes: vec![aid],
            alternatives: vec![],
            confidence: Some(0.9),
            language: Some("en".into()),
            engine: None,
        });
        d.replace(&[bid], vec![]);
        assert_eq!(d.recognition.len(), 1, "unrelated text survives");
        d.replace(&[aid], vec![]);
        assert!(d.recognition.is_empty());
    }

    #[test]
    fn grouped_changes_undo_together() {
        let mut d = Document::new(9);
        let strokes: Vec<_> = (0..3).map(|i| stroke(&mut d, i as f64)).collect();
        let ids: Vec<_> = strokes.iter().map(|s| s.id).collect();
        for s in strokes {
            d.add_stroke(s);
        }
        d.begin_group();
        d.replace(&[ids[0]], vec![]);
        d.replace(&[ids[2]], vec![]);
        d.end_group();
        assert_eq!(d.len(), 1);
        d.undo();
        assert_eq!(d.len(), 3);
        d.redo();
        assert_eq!(d.len(), 1);
        d.undo();
        d.undo();
        assert_eq!(d.len(), 2, "second undo removes the third added stroke");
    }

    #[test]
    fn revision_increases() {
        let mut d = Document::new(1);
        let r0 = d.revision();
        let s = stroke(&mut d, 0.0);
        d.add_stroke(s);
        assert!(d.revision() > r0);
    }
}
