//! Changes to a saved note made without opening it on a canvas: tags added
//! and the paper set, for many notes at once (the Obsidian plugin's
//! "Add tags…" and "Change paper…" in the file explorer's menu).
//!
//! The note is read and written by the same reader and writer as opening it
//! on the canvas, tagging it in "Tags and links…" and saving it
//! ([`format::load_bytes`], [`format::to_bedrock`]), so the file is exactly
//! what the canvas would save after the same change: no new format, and
//! notes of every earlier version are read (and saved in today's version,
//! as any edit saves them).

use crate::format::{self, FormatError};

/// Paper patterns a note can have (`paper` in note.json).
pub const PAPERS: [&str; 4] = ["grid", "dots", "lines", "plain"];

/// What to change. Empty `tags` and no `paper` change nothing.
#[derive(Debug, Default, Clone)]
pub struct NoteEdit {
    /// Tags to add, cleaned as the tag box cleans them
    /// ([`crate::document::clean_tag`]); a tag the note has in any case is
    /// not added again, and the note's own tags stay.
    pub tags: Vec<String>,
    /// The paper to set: one of [`PAPERS`].
    pub paper: Option<String>,
    /// When the change is made (Unix epoch ms): the note's `modified`.
    pub now: f64,
}

/// Apply `edit` to a saved note (`.bedrock`, Bedrock SVG or note JSON
/// bytes). `Ok(None)` when nothing would change (every tag there already,
/// the paper the same), so the file is left alone. `seed` gives ids to
/// strokes of very old notes saved without them, as opening does.
pub fn edit_note(bytes: &[u8], seed: u64, edit: &NoteEdit) -> Result<Option<Vec<u8>>, FormatError> {
    if let Some(p) = &edit.paper {
        if !PAPERS.contains(&p.as_str()) {
            return Err(FormatError::Invalid(format!("{p} is not a paper (grid, dots, lines or plain)")));
        }
    }
    let mut doc = format::load_bytes(bytes, seed)?.doc;
    let mut changed = false;
    for t in &edit.tags {
        changed |= doc.add_tag(t).is_some();
    }
    if let Some(p) = &edit.paper {
        if doc.paper != *p {
            doc.paper = p.clone();
            changed = true;
        }
    }
    if !changed {
        return Ok(None);
    }
    if edit.now > doc.modified {
        doc.modified = edit.now;
    }
    Ok(Some(format::to_bedrock(&doc)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::Document;
    use crate::input::InputPoint;

    fn note() -> Vec<u8> {
        let mut d = Document::new(7);
        d.title = "Forces".into();
        d.paper = "grid".into();
        d.modified = 1_000.0;
        d.add_tag("physics");
        let id = d.next_id();
        let pts = (0..6).map(|k| InputPoint::new(k as f64 * 4.0, k as f64, 0.5).at(k as f64 * 8.0)).collect();
        d.add_stroke(crate::stroke::Stroke::new(
            id,
            crate::brush::Brush::default(),
            0.0,
            crate::stroke::InputDevice::default(),
            pts,
        ));
        format::to_bedrock(&d)
    }

    fn load(bytes: &[u8]) -> Document {
        format::load_bytes(bytes, 1).unwrap().doc
    }

    #[test]
    fn edit_note_adds_tags_and_keeps_everything_else() {
        let before = note();
        let edit = NoteEdit {
            tags: vec!["#Exam prep".into(), "PHYSICS".into(), "mechanics".into()],
            paper: None,
            now: 5_000.0,
        };
        let after = edit_note(&before, 1, &edit).unwrap().expect("changed");
        let (a, b) = (load(&before), load(&after));
        assert_eq!(b.tags, vec!["physics", "Exam-prep", "mechanics"]);
        assert_eq!(b.paper, "grid");
        assert_eq!(b.title, a.title);
        assert_eq!(b.modified, 5_000.0);
        assert_eq!(b.strokes().len(), 1);
        assert_eq!(b.strokes()[0].id, a.strokes()[0].id);
        assert_eq!(b.strokes()[0].points, a.strokes()[0].points);
    }

    #[test]
    fn edit_note_sets_the_paper() {
        let after =
            edit_note(&note(), 1, &NoteEdit { paper: Some("lines".into()), now: 2_000.0, ..Default::default() })
                .unwrap()
                .expect("changed");
        let d = load(&after);
        assert_eq!(d.paper, "lines");
        assert_eq!(d.tags, vec!["physics"]);
    }

    #[test]
    fn edit_note_changing_nothing_leaves_the_file_alone() {
        let edit = NoteEdit { tags: vec!["Physics".into(), "#".into()], paper: Some("grid".into()), now: 9_000.0 };
        assert_eq!(edit_note(&note(), 1, &edit), Ok(None));
        assert_eq!(edit_note(&note(), 1, &NoteEdit::default()), Ok(None));
    }

    #[test]
    fn edit_note_refuses_an_unknown_paper_and_a_damaged_file() {
        let edit = NoteEdit { paper: Some("music".into()), ..Default::default() };
        assert!(edit_note(&note(), 1, &edit).is_err());
        let edit = NoteEdit { tags: vec!["x".into()], ..Default::default() };
        assert!(edit_note(b"not a note", 1, &edit).is_err());
    }

    #[test]
    fn edit_note_reads_a_note_saved_before_it() {
        // A frozen note from an earlier version: tagged and re-papered, it
        // keeps its ink.
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/old-formats");
        let mut tried = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("bedrock") {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let before = load(&bytes);
            let edit = NoteEdit { tags: vec!["bulk".into()], paper: Some("plain".into()), now: 0.0 };
            let after = load(&edit_note(&bytes, 1, &edit).unwrap().expect("changed"));
            assert!(after.tags.iter().any(|t| t == "bulk"), "{path:?}");
            assert_eq!(after.paper, "plain", "{path:?}");
            assert_eq!(after.strokes().len(), before.strokes().len(), "{path:?}");
            tried += 1;
        }
        assert!(tried > 0, "no old .bedrock fixtures in {dir}");
    }
}
