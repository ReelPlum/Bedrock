//! A second copy of a note, kept in sync from the change feed.
//!
//! The web app saves in a background worker: the worker holds a [`Mirror`]
//! and receives only what changed (new strokes as JSON, ids of removed ones,
//! the note's other fields), then writes the `.bedrock` file itself. The
//! main thread never serialises the whole note, so autosave can't stall the
//! pen however large the note gets. [`content_hash`] lets both sides check
//! that the copies still agree.

use crate::document::Document;
use crate::format::{self, CHANNELS, FORMAT_NAME, FORMAT_VERSION};
use crate::stroke::StrokeId;
use std::collections::HashSet;

/// Everything about a note except its strokes.
pub fn meta_only(d: &Document) -> Document {
    let mut m = Document::new(0);
    m.title = d.title.clone();
    m.created = d.created;
    m.modified = d.modified;
    m.background = d.background;
    m.paper = d.paper.clone();
    m.recognition = d.recognition.clone();
    m.links = d.links.clone();
    m.extra = d.extra.clone();
    // Links are only written while their strokes exist, and this copy has
    // none: carry them all as a raw field (read back into `links`).
    if !d.links.is_empty() {
        m.extra.insert("links".into(), serde_json::to_value(&d.links).expect("links serialise"));
    }
    m
}

/// Fingerprint of the strokes: ids, order and sample counts.
pub fn content_hash(d: &Document) -> String {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    let mut mix = |v: u64| {
        for b in v.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01B3);
        }
    };
    for s in d.strokes() {
        mix(s.id.0);
        mix(s.points.len() as u64);
    }
    format!("{h:016x}:{}", d.len())
}

#[derive(Debug, Default)]
pub struct Mirror {
    doc: Document,
}

impl Mirror {
    pub fn doc(&self) -> &Document {
        &self.doc
    }

    /// Replace the copy with a whole note (`.bedrock`, SVG or JSON bytes).
    pub fn reset(&mut self, bytes: &[u8]) -> Result<(), String> {
        let mut doc = format::load_bytes(bytes, 1).map_err(|e| e.to_string())?.doc;
        doc.take_changes();
        self.doc = doc;
        Ok(())
    }

    /// Bring the copy up to date: drop every stroke whose id is in
    /// `touched`, then insert `added` (a JSON array of stroke objects in
    /// note.json form) at their final positions `index`. Removing first and
    /// inserting in ascending position reproduces the source order whatever
    /// happened in between (draws, erases, undo, redo). `meta` (note JSON;
    /// its strokes are ignored) replaces the title, paper, times and so on.
    pub fn apply(&mut self, meta: Option<&str>, touched: &[String], added: &str, index: &[u32]) -> Result<(), String> {
        let gone: HashSet<u64> = touched.iter().filter_map(|t| StrokeId::parse(t)).map(|i| i.0).collect();
        let mut strokes: Vec<_> = self.doc.strokes().iter().filter(|s| !gone.contains(&s.id.0)).cloned().collect();
        let channels = serde_json::to_string(&CHANNELS).expect("channels");
        let wrapper = format!(
            "{{\"format\":\"{FORMAT_NAME}\",\"version\":{FORMAT_VERSION},\"channels\":{channels},\"strokes\":{added}}}"
        );
        let parsed = format::from_json(&wrapper, 1).map_err(|e| e.to_string())?;
        let new = parsed.doc.strokes();
        if new.len() != index.len() {
            return Err(format!("{} strokes for {} positions", new.len(), index.len()));
        }
        // Every id must be new to the copy and appear once; anything else
        // means the two sides disagree and the caller should resend all.
        let mut seen: HashSet<u64> = strokes.iter().map(|s| s.id.0).collect();
        if parsed.warnings.iter().any(|w| w.contains("duplicate id")) || !new.iter().all(|s| seen.insert(s.id.0)) {
            return Err("stroke ids do not match the saved copy".into());
        }
        let mut order: Vec<usize> = (0..new.len()).collect();
        order.sort_by_key(|&i| index[i]);
        for i in order {
            let at = (index[i] as usize).min(strokes.len());
            strokes.insert(at, new[i].clone());
        }
        let mut doc = match meta {
            Some(m) => format::from_json(m, 1).map_err(|e| e.to_string())?.doc,
            None => meta_only(&self.doc),
        };
        doc.set_strokes(strokes);
        doc.take_changes();
        self.doc = doc;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::{Brush, BrushKind};
    use crate::color::Rgba;
    use crate::document::Change;
    use crate::input::InputPoint;
    use crate::stroke::{InputDevice, Stroke};

    fn stroke(doc: &mut Document, x: f64) -> StrokeId {
        let id = doc.next_id();
        let pts = (0..8).map(|i| InputPoint::new(x + i as f64, i as f64 * 0.5, 0.5).at(i as f64 * 4.0)).collect();
        doc.add_stroke(Stroke::new(id, Brush::new(BrushKind::Pen, Rgba::BLACK, 2.0), 0.0, InputDevice::Pen, pts));
        id
    }

    /// What the web app does at each save: send only what changed.
    fn sync(src: &mut Document, m: &mut Mirror) {
        let mut touched: Vec<String> = Vec::new();
        for c in src.take_changes() {
            let (Change::Added(id) | Change::Removed(id)) = c;
            // A stroke can change several times between saves (erase, undo).
            if !touched.contains(&id.to_string()) {
                touched.push(id.to_string());
            }
        }
        let mut added = Vec::new();
        let mut index = Vec::new();
        for t in &touched {
            let id = StrokeId::parse(t).unwrap();
            if let Some(i) = src.strokes().iter().position(|s| s.id == id) {
                let mut one = Document::new(0);
                one.set_strokes(vec![src.strokes()[i].clone()]);
                let v: serde_json::Value = serde_json::from_str(&format::to_json(&one)).unwrap();
                added.push(v["strokes"][0].clone());
                index.push(i as u32);
            }
        }
        let meta = format::to_json(&meta_only(src));
        m.apply(Some(&meta), &touched, &serde_json::Value::from(added).to_string(), &index).unwrap();
    }

    #[test]
    fn stays_identical_through_draws_erases_undo_and_redo() {
        let mut src = Document::new(7);
        let mut m = Mirror::default();
        m.reset(format::to_json(&src).as_bytes()).unwrap();
        src.take_changes();
        let a = stroke(&mut src, 0.0);
        let b = stroke(&mut src, 20.0);
        stroke(&mut src, 40.0);
        src.title = "Shopping".into();
        sync(&mut src, &mut m);
        assert_eq!(format::to_json(m.doc()), format::to_json(&src));

        // Erase the middle stroke into two pieces, delete another, then undo/redo.
        let piece = |doc: &mut Document, x: f64| {
            let id = doc.next_id();
            let pts = (0..3).map(|i| InputPoint::new(x + i as f64, 0.0, 0.5)).collect();
            Stroke::new(id, Brush::default(), 0.0, InputDevice::Pen, pts)
        };
        let p1 = piece(&mut src, 20.0);
        let p2 = piece(&mut src, 25.0);
        src.replace(&[b], vec![(b, p1), (b, p2)]);
        src.replace(&[a], vec![]);
        src.undo();
        sync(&mut src, &mut m);
        assert_eq!(format::to_json(m.doc()), format::to_json(&src));
        src.redo();
        src.undo();
        src.undo();
        stroke(&mut src, 60.0);
        sync(&mut src, &mut m);
        assert_eq!(format::to_json(m.doc()), format::to_json(&src));
        assert_eq!(content_hash(m.doc()), content_hash(&src));

        // Links ride along with the metadata (bug: the background save
        // dropped them, because the metadata copy has no strokes).
        let first = src.strokes()[0].id;
        src.links.push(crate::document::Link {
            strokes: vec![first],
            target: "https://example.com".into(),
            kind: "url".into(),
            text: None,
        });
        sync(&mut src, &mut m);
        assert_eq!(m.doc().links, src.links);
        assert_eq!(format::to_json(m.doc()), format::to_json(&src));
    }

    #[test]
    fn duplicate_or_clashing_strokes_are_rejected() {
        let mut src = Document::new(3);
        let mut m = Mirror::default();
        stroke(&mut src, 0.0);
        sync(&mut src, &mut m);
        let one = format::to_json(&src);
        let v: serde_json::Value = serde_json::from_str(&one).unwrap();
        let s = v["strokes"][0].to_string();
        // The same stroke again, without removing it first.
        assert!(m.apply(None, &[], &format!("[{s}]"), &[1]).is_err());
        // The same stroke twice in one batch.
        assert!(m.apply(None, &[src.strokes()[0].id.to_string()], &format!("[{s},{s}]"), &[0, 1]).is_err());
        assert_eq!(m.doc().len(), 1, "a rejected change leaves the copy as it was");
    }

    #[test]
    fn hash_notices_a_difference() {
        let mut a = Document::new(1);
        stroke(&mut a, 0.0);
        let mut b = Document::new(1);
        stroke(&mut b, 0.0);
        assert_eq!(content_hash(&a), content_hash(&b));
        stroke(&mut b, 5.0);
        assert_ne!(content_hash(&a), content_hash(&b));
    }

    #[test]
    fn bad_input_is_an_error_not_a_panic() {
        let mut m = Mirror::default();
        assert!(m.apply(None, &[], "not json", &[]).is_err());
        assert!(m.apply(None, &[], "[]", &[3]).is_err());
        assert!(m.reset(b"garbage").is_err());
    }
}
