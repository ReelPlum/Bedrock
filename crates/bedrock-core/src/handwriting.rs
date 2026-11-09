//! Glue between the page layout, a recogniser and the spell checker.
//!
//! The recogniser itself runs outside the core (in the web app: TrOCR for
//! text and Pix2Text's formula model for maths, in a worker). This module
//! decides *what* to recognise and keeps the results:
//!
//! * [`Handwriting::words`] lays out the page (cached per document revision)
//!   and says which words still need recognising (new, or their strokes
//!   changed) and whether each looks like maths.
//! * [`Handwriting::set_text`] stores a result in the document's
//!   `recognition` list, tied to the exact strokes, replacing anything older
//!   for those strokes. The note file keeps it (`recognized.json`), which is
//!   also the start of a dataset of real handwriting with its text.
//! * [`Handwriting::misspelled`] lists the words to underline.

use crate::document::{Document, RecognizedText};
use crate::geom::Rect;
use crate::spell::Dictionary;
use crate::stroke::StrokeId;
use crate::words::{self, Layout, Word};
use std::collections::HashSet;

/// Language tag used for formulas (the text is LaTeX).
pub const LATEX: &str = "latex";

/// Engine name for text the writer typed in themselves: the ground truth
/// for these strokes (never re-read, never spell-checked), with what the
/// recogniser had read kept in `alternatives`.
pub const USER: &str = "user";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Math,
}

/// A word as the recogniser sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct WordInfo {
    pub id: u64,
    pub strokes: Vec<StrokeId>,
    pub bounds: Rect,
    pub letter_height: f64,
    pub kind: Kind,
    /// Recognised text for exactly these strokes, if any.
    pub text: Option<String>,
    /// The recogniser that produced `text` (so a slower, better one can
    /// re-read words a fast one did).
    pub engine: Option<String>,
    /// Earlier readings, e.g. what the recogniser read before a correction.
    pub alternatives: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Handwriting {
    revision: Option<u64>,
    layout: Layout,
    dict: Option<Dictionary>,
}

/// Formulas are laid out in tiers (fractions, exponents, limits): taller than
/// the line's letters and with strokes stacked above each other.
fn looks_like_math(doc: &Document, w: &Word, letter_height: f64) -> bool {
    if w.bounds.height() > letter_height * 2.2 {
        return true;
    }
    // A fraction bar: a long flat stroke with ink both above and below it.
    let strokes: Vec<_> = w.strokes.iter().filter_map(|id| doc.strokes().iter().find(|s| s.id == *id)).collect();
    strokes.iter().any(|bar| {
        let b = bar.bounds();
        let flat = b.width() > letter_height * 1.2 && b.height() < letter_height * 0.35;
        let cy = (b.min.y + b.max.y) * 0.5;
        let over = |s: &&&crate::stroke::Stroke| {
            let r = s.bounds();
            r.min.x < b.max.x && r.max.x > b.min.x
        };
        flat && strokes.iter().filter(over).any(|s| s.bounds().max.y < cy)
            && strokes.iter().filter(over).any(|s| s.bounds().min.y > cy)
    })
}

impl Handwriting {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_dictionary(&mut self, d: Dictionary) {
        self.dict = Some(d);
    }

    pub fn has_dictionary(&self) -> bool {
        self.dict.as_ref().is_some_and(|d| !d.is_empty())
    }

    fn refresh(&mut self, doc: &Document) {
        if self.revision != Some(doc.revision()) {
            self.layout = words::layout(doc);
            self.revision = Some(doc.revision());
        }
    }

    pub fn layout(&mut self, doc: &Document) -> &Layout {
        self.refresh(doc);
        &self.layout
    }

    fn text_for<'a>(doc: &'a Document, w: &Word) -> Option<&'a RecognizedText> {
        doc.recognition.iter().find(|r| r.strokes == w.strokes)
    }

    /// Every word on the page, with its recognised text if it has one.
    pub fn words(&mut self, doc: &Document) -> Vec<WordInfo> {
        self.refresh(doc);
        self.layout
            .words
            .iter()
            .map(|w| {
                let lh = self.layout.lines[w.line].letter_height;
                WordInfo {
                    id: w.id,
                    strokes: w.strokes.clone(),
                    bounds: w.bounds,
                    letter_height: lh,
                    kind: if looks_like_math(doc, w, lh) { Kind::Math } else { Kind::Text },
                    text: Self::text_for(doc, w).map(|r| r.text.clone()),
                    engine: Self::text_for(doc, w).and_then(|r| r.engine.clone()),
                    alternatives: Self::text_for(doc, w).map(|r| r.alternatives.clone()).unwrap_or_default(),
                }
            })
            .collect()
    }

    /// Store the recogniser's answer for word `id`. Returns false if the word
    /// no longer exists (its strokes changed while it was being recognised).
    pub fn set_text(
        &mut self,
        doc: &mut Document,
        id: u64,
        text: &str,
        kind: Kind,
        engine: &str,
        confidence: Option<f32>,
    ) -> bool {
        self.refresh(doc);
        let Some(w) = self.layout.words.iter().find(|w| w.id == id) else { return false };
        let mine: HashSet<StrokeId> = w.strokes.iter().copied().collect();
        doc.recognition.retain(|r| !r.strokes.iter().any(|s| mine.contains(s)));
        doc.recognition.push(RecognizedText {
            id: format!("{id:016x}"),
            text: text.trim().to_string(),
            strokes: w.strokes.clone(),
            alternatives: Vec::new(),
            confidence: confidence.filter(|c| c.is_finite()),
            language: Some(if kind == Kind::Math { LATEX.to_string() } else { "en".to_string() }),
            engine: Some(engine.to_string()),
        });
        true
    }

    /// The writer says what word `id` actually says. Stored as the word's
    /// text with engine [`USER`]; what the recogniser had read is kept in
    /// `alternatives` (model guess + truth: a training example). Returns
    /// false if the word no longer exists.
    pub fn correct(&mut self, doc: &mut Document, id: u64, text: &str, kind: Kind) -> bool {
        self.refresh(doc);
        let Some(w) = self.layout.words.iter().find(|w| w.id == id) else { return false };
        let text = text.trim().to_string();
        let mut alternatives = Vec::new();
        if let Some(prev) = Self::text_for(doc, w) {
            let read = std::iter::once(&prev.text).chain(&prev.alternatives);
            for a in read {
                if !a.is_empty() && *a != text && !alternatives.contains(a) {
                    alternatives.push(a.clone());
                }
            }
        }
        let strokes = w.strokes.clone();
        if !self.set_text(doc, id, &text, kind, USER, Some(1.0)) {
            return false;
        }
        if let Some(r) = doc.recognition.iter_mut().find(|r| r.strokes == strokes) {
            r.alternatives = alternatives;
        }
        true
    }

    /// Bounds of words whose recognised text is misspelled (formulas are
    /// never checked). Empty without a dictionary.
    pub fn misspelled(&mut self, doc: &Document) -> Vec<Rect> {
        self.refresh(doc);
        let Some(dict) = self.dict.as_ref() else { return Vec::new() };
        self.layout
            .words
            .iter()
            .filter(|w| {
                Self::text_for(doc, w).is_some_and(|r| {
                    r.language.as_deref() != Some(LATEX)
                        && r.engine.as_deref() != Some(USER)
                        && r.text.split_whitespace().any(|t| !dict.check(t))
                })
            })
            .map(|w| w.bounds)
            .collect()
    }

    /// Spelling suggestions for word `id`'s recognised text.
    pub fn suggestions(&mut self, doc: &Document, id: u64, max: usize) -> Vec<String> {
        self.refresh(doc);
        let (Some(dict), Some(w)) = (self.dict.as_ref(), self.layout.words.iter().find(|w| w.id == id)) else {
            return Vec::new();
        };
        Self::text_for(doc, w).map(|r| dict.suggest(&r.text, max)).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::{Brush, BrushKind};
    use crate::color::Rgba;
    use crate::input::InputPoint;
    use crate::stroke::{InputDevice, Stroke};

    fn letter(doc: &mut Document, x: f64, y: f64) -> StrokeId {
        let pts = (0..=8)
            .map(|k| InputPoint::new(x + 2.0 * k as f64, y - if k % 2 == 0 { 0.0 } else { 30.0 }, 0.5))
            .collect();
        let id = doc.next_id();
        doc.add_stroke(Stroke::new(id, Brush::new(BrushKind::Pen, Rgba::BLACK, 2.0), 0.0, InputDevice::Pen, pts));
        id
    }

    fn line(doc: &mut Document, from: f64, y: f64, n: usize) -> f64 {
        let mut x = from;
        for _ in 0..n {
            letter(doc, x, y);
            x += 20.0;
        }
        x + 30.0
    }

    #[test]
    fn stores_text_marks_misspellings_and_forgets_changed_words() {
        let mut doc = Document::new(1);
        let x = line(&mut doc, 0.0, 100.0, 3);
        line(&mut doc, x, 100.0, 4);
        let mut hw = Handwriting::new();
        hw.set_dictionary(Dictionary::from_list("the\nquick\n"));
        let w = hw.words(&doc);
        assert_eq!(w.len(), 2);
        assert!(w.iter().all(|w| w.text.is_none() && w.kind == Kind::Text));
        assert!(hw.set_text(&mut doc, w[0].id, "the", Kind::Text, "test", Some(0.9)));
        assert!(hw.set_text(&mut doc, w[1].id, "qiuck", Kind::Text, "test", None));
        assert_eq!(hw.words(&doc)[0].text.as_deref(), Some("the"));
        assert_eq!(hw.words(&doc)[0].engine.as_deref(), Some("test"));
        let bad = hw.misspelled(&doc);
        assert_eq!(bad, vec![w[1].bounds]);
        assert_eq!(hw.suggestions(&doc, w[1].id, 1), vec!["quick".to_string()]);
        // Re-recognising replaces the old answer.
        assert!(hw.set_text(&mut doc, w[1].id, "quick", Kind::Text, "test", None));
        assert!(hw.misspelled(&doc).is_empty());
        assert_eq!(doc.recognition.len(), 2);
        // Adding a letter to the second word makes it a new word: its old
        // text no longer applies, and an answer for the old id is refused.
        letter(&mut doc, x + 80.0, 100.0);
        let w2 = hw.words(&doc);
        assert!(w2[1].text.is_none());
        assert!(!hw.set_text(&mut doc, w[1].id, "late", Kind::Text, "test", None));
    }

    #[test]
    fn corrections_are_kept_with_what_was_read_and_not_spell_checked() {
        let mut doc = Document::new(3);
        line(&mut doc, 0.0, 100.0, 4);
        let mut hw = Handwriting::new();
        hw.set_dictionary(Dictionary::from_list("the\n"));
        let w = hw.words(&doc);
        assert!(hw.set_text(&mut doc, w[0].id, "Bedrok", Kind::Text, "trocr", None));
        assert_eq!(hw.misspelled(&doc).len(), 1);
        // The writer says it reads "Bedrock" (not in the word list).
        assert!(hw.correct(&mut doc, w[0].id, " Bedrock ", Kind::Text));
        let info = &hw.words(&doc)[0];
        assert_eq!(info.text.as_deref(), Some("Bedrock"));
        assert_eq!(info.engine.as_deref(), Some(USER));
        assert_eq!(info.alternatives, vec!["Bedrok".to_string()]);
        assert!(hw.misspelled(&doc).is_empty(), "their own word is not underlined");
        assert_eq!(doc.recognition.len(), 1);
        assert_eq!(doc.recognition[0].confidence, Some(1.0));
        // Correcting again keeps the model's reading, without duplicates.
        assert!(hw.correct(&mut doc, w[0].id, "Bedrock!", Kind::Text));
        assert_eq!(hw.words(&doc)[0].alternatives, vec!["Bedrock".to_string(), "Bedrok".to_string()]);
        // Confirming the reading as it is: no alternative needed.
        assert!(hw.correct(&mut doc, w[0].id, "Bedrock!", Kind::Text));
        assert!(hw.words(&doc)[0].alternatives.contains(&"Bedrok".to_string()));
        assert!(!hw.correct(&mut doc, 12345, "x", Kind::Text), "unknown word");
    }

    #[test]
    fn fractions_and_tall_formulas_count_as_math_and_are_not_spell_checked() {
        let mut doc = Document::new(2);
        line(&mut doc, 0.0, 100.0, 3); // ordinary text sets the letter height
                                       // A fraction: numerator, bar, denominator.
        letter(&mut doc, 210.0, 60.0);
        let bar = doc.next_id();
        doc.add_stroke(Stroke::new(
            bar,
            Brush::default(),
            0.0,
            InputDevice::Pen,
            vec![InputPoint::new(200.0, 80.0, 0.5), InputPoint::new(245.0, 80.0, 0.5)],
        ));
        letter(&mut doc, 210.0, 125.0);
        let mut hw = Handwriting::new();
        hw.set_dictionary(Dictionary::from_list("the\n"));
        let w = hw.words(&doc);
        let math = w.iter().find(|w| w.strokes.contains(&bar)).expect("fraction is one word");
        assert_eq!(math.kind, Kind::Math);
        assert_eq!(w.iter().filter(|w| w.kind == Kind::Text).count(), 1);
        hw.set_text(&mut doc, math.id, "\\frac{a}{b}", Kind::Math, "test", None);
        assert!(hw.misspelled(&doc).is_empty());
        assert_eq!(doc.recognition[0].language.as_deref(), Some(LATEX));
    }
}
