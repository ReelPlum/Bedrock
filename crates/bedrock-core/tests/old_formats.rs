//! Old note files must keep opening. Every file in `tests/fixtures/old-formats`
//! was written by an earlier Bedrock and is never regenerated: if a change to
//! the reader stops one of them opening with all its content, that change
//! breaks notes people already have.
//!
//! When the note format changes, add a fixture written by the version just
//! before the change (see `openspec/specs/data-format-changes/spec.md`).
//!
//! | Fixture | Written by |
//! |---|---|
//! | `v1-first-release` | commit dc1b86b, the first note format |
//! | `v1-before-pictures` | commit 46539c1: links, word groups, text/maths, line styles, stabiliser |
//! | `v1-pictures-and-text-boxes` | Nov 12 2026: pictures, text boxes and per-stroke pen tuning |

use bedrock_core::brush::{BrushKind, LineStyle};
use bedrock_core::document::Document;
use bedrock_core::format;
use bedrock_core::stroke::InputDevice;
use std::path::Path;

const FORMATS: [&str; 3] = ["json", "svg", "bedrock"];

fn open(name: &str, ext: &str) -> Document {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/old-formats/{name}.{ext}"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let loaded = format::load_bytes(&bytes, 1).unwrap_or_else(|e| panic!("{name}.{ext} does not open: {e}"));
    assert!(loaded.warnings.is_empty(), "{name}.{ext} opened with warnings: {:?}", loaded.warnings);
    loaded.doc
}

/// What every fixture has: five strokes, one per brush, the fourth drawn
/// with a finger, and the first two read as "hello".
fn check_common(d: &Document, what: &str) {
    let kinds: Vec<BrushKind> = d.strokes().iter().map(|s| s.brush.kind).collect();
    assert_eq!(
        kinds,
        [BrushKind::Pen, BrushKind::Pencil, BrushKind::Fountain, BrushKind::Marker, BrushKind::Highlighter],
        "{what}"
    );
    for (i, s) in d.strokes().iter().enumerate() {
        assert_eq!(s.points.len(), 12, "{what}: every raw sample is kept");
        let p = &s.points[11];
        assert!((p.x - (40.0 + i as f64 * 40.0)).abs() < 0.01, "{what}: x of the last sample, got {}", p.x);
        assert!((p.pressure - 0.85).abs() < 0.01, "{what}: pressure, got {}", p.pressure);
        assert!((p.t - 88.0).abs() < 0.01, "{what}: time, got {}", p.t);
        let device = if i == 3 { InputDevice::Touch } else { InputDevice::Pen };
        assert_eq!(s.device, device, "{what}");
    }
    assert_eq!(d.strokes()[4].brush.color.a, 110, "{what}: the highlighter stays translucent");
    assert_eq!(d.recognition.len(), 1, "{what}");
    assert_eq!(d.recognition[0].text, "hello", "{what}");
    assert_eq!(d.recognition[0].strokes, [d.strokes()[0].id, d.strokes()[1].id], "{what}");
}

/// Saving an old note with today's Bedrock and opening it again keeps
/// everything the old file had.
fn resave(d: &Document) -> Document {
    let loaded = format::load_bytes(&format::to_bedrock(d), 2).expect("a re-saved old note opens");
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    loaded.doc
}

#[test]
fn the_first_note_format_still_opens() {
    for ext in FORMATS {
        let what = format!("v1-first-release.{ext}");
        let d = open("v1-first-release", ext);
        assert_eq!(d.title, "First format", "{what}");
        assert_eq!(d.paper, "lines", "{what}");
        check_common(&d, &what);
        check_common(&resave(&d), &format!("{what}, saved again"));
    }
}

#[test]
fn notes_from_before_pictures_still_open() {
    for ext in FORMATS {
        let what = format!("v1-before-pictures.{ext}");
        for d in [open("v1-before-pictures", ext), resave(&open("v1-before-pictures", ext))] {
            assert_eq!(d.title, "Before pictures", "{what}");
            check_common(&d, &what);
            let s = d.strokes();
            assert_eq!(s[0].brush.style, LineStyle::Dashed, "{what}");
            assert!((s[1].brush.stabilizer - 0.4).abs() < 1e-6, "{what}");
            assert_eq!(d.links.len(), 1, "{what}");
            assert_eq!(d.links[0].target, "https://example.com/", "{what}");
            assert_eq!(d.links[0].strokes, [s[0].id, s[1].id], "{what}");
            assert_eq!(d.live_groups(), [vec![s[0].id, s[1].id]], "{what}");
            assert_eq!(d.kinds.len(), 1, "{what}");
            assert_eq!((d.kinds[0].kind.as_str(), d.kinds[0].strokes.as_slice()), ("math", &[s[2].id][..]), "{what}");
            assert!(d.images().is_empty(), "{what}");
        }
    }
}

#[test]
fn notes_with_pictures_and_text_boxes_still_open() {
    for ext in FORMATS {
        let what = format!("v1-pictures-and-text-boxes.{ext}");
        let first = open("v1-pictures-and-text-boxes", ext);
        // Only a `.bedrock` file carries the picture's own file; `.json` and
        // `.svg` exports keep where it is but not its bytes, so only the
        // `.bedrock` file is saved again here.
        let again = (ext == "bedrock").then(|| resave(&first));
        for d in std::iter::once(first).chain(again) {
            check_common(&d, &what);
            let s = d.strokes();
            assert_eq!(s[0].brush.pressure, Some(0.5), "{what}: pen tuning");
            assert_eq!(s[1].brush.taper_start, Some(0.2), "{what}: pen tuning");
            assert_eq!(d.links.len(), 1, "{what}");
            let images = d.images();
            assert_eq!(images.len(), 2, "{what}: a picture and a text box");
            let pic = images.iter().find(|i| i.text.is_none()).expect("the picture");
            assert_eq!((pic.x, pic.y, pic.w, pic.h), (300.0, 10.0, 100.0, 50.0), "{what}");
            let text = images.iter().find(|i| i.text.is_some()).expect("the text box");
            assert_eq!(text.text.as_deref(), Some("Shopping list\nmilk"), "{what}");
            assert_eq!((text.x, text.y, text.w, text.h), (10.0, 100.0, 120.0, 47.0), "{what}");
            assert_eq!(pic.file, "images/abc.png", "{what}");
            if ext == "bedrock" {
                let png = vec![0x89, b'P', b'N', b'G', 1, 2, 3, 4];
                assert_eq!(d.assets.get(&pic.file), Some(&png), "{what}: the picture file");
            }
        }
    }
}
