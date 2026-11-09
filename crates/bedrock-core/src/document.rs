//! A note: ordered strokes (z-order = creation order), metadata, undo/redo,
//! recognised text, and a change feed.
//!
//! ## Change feed
//! Every mutation (including undo/redo) is reported as [`Change`] events,
//! drained with [`Document::take_changes`]. Renderers use it to update GPU
//! caches, autosave uses it to know when to write, and a future real-time
//! handwriting recogniser can subscribe to exactly the strokes that appeared
//! or disappeared instead of rescanning the page.

use crate::geom::Rect;
use crate::stroke::{Stroke, StrokeId};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

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

#[derive(Debug, Clone)]
enum Op {
    /// Strokes removed (index in the old list) and added (index in the new list).
    Replace { removed: Vec<(usize, Stroke)>, added: Vec<(usize, Stroke)> },
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
            if id.0 != 0 && self.find(id).is_none() {
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
        self.strokes.iter().fold(Rect::EMPTY, |r, s| r.union(&s.bounds()))
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
        self.apply_and_record(Op::Replace { removed: vec![], added: vec![(idx, stroke)] });
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
        self.apply_and_record(Op::Replace { removed, added });
    }

    fn apply_and_record(&mut self, op: Op) {
        self.apply(&op, false);
        match &mut self.group {
            Some(g) => g.push(op),
            None => self.undo.push(vec![op]),
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
        let Op::Replace { removed, added } = op;
        let (take, put) = if inverse { (added, removed) } else { (removed, added) };
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
                if let Some(r) = self.recognition.iter().find(|r| r.strokes == l.strokes) {
                    l.text = Some(r.text.clone());
                }
                l
            })
            .collect()
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
