//! Handwriting from PDF files: GoodNotes exports and similar.
//!
//! Note apps export ink as vector paths, one path per pen stroke, in the
//! order it was written. GoodNotes draws each stroke as a filled outline
//! made of short pieces (one closed subpath per piece, out along one edge
//! and back along the other); other apps stroke the centre line instead.
//! Both become Bedrock strokes here: the centre line is the outward half of
//! each piece (the pen is thin next to the letters, so its edge is close
//! enough), and the width is the piece's area over its length.
//!
//! A PDF keeps no timing or pressure. Strokes get times as if written at an
//! even speed, in their order on the page, and a middle pressure. The
//! handwriting reader only uses shapes and order, so that is enough.
//!
//! GoodNotes also hides its own reading of the handwriting in the page as
//! invisible text. Each piece of it is matched to the word under it and kept
//! as that word's recognised text (engine [`ENGINE`]).
//!
//! Only what is needed is read: the page tree, content streams (Flate or
//! none), form XObjects, colours, transparency and text positions. Pictures
//! and visible text are left out and reported.

use std::collections::{HashMap, HashSet};

use crate::brush::{Brush, BrushKind};
use crate::color::Rgba;
use crate::document::{Document, RecognizedText};
use crate::geom::{Rect, Vec2};
use crate::input::InputPoint;
use crate::stroke::{InputDevice, Stroke};
use crate::words;

/// Engine name for readings taken from a PDF's text layer.
pub const ENGINE: &str = "pdf-text";
/// Assumed writing speed, page units (points) per millisecond.
const SPEED: f64 = 0.1;
/// Assumed pause between strokes, milliseconds.
const GAP_MS: f64 = 150.0;
/// A filled piece wider than this is a shape, not ink (points).
const MAX_INK_WIDTH: f64 = 40.0;
const MAX_STREAM: usize = 128 * 1024 * 1024;
const MAX_DEPTH: usize = 12;

/// One imported page.
#[derive(Debug)]
pub struct PdfPage {
    pub doc: Document,
    /// Readings from the text layer that were attached to words.
    pub readings: usize,
    /// What was left out, in plain words.
    pub warnings: Vec<String>,
}

/// True if `bytes` look like a PDF file.
pub fn is_pdf(bytes: &[u8]) -> bool {
    bytes.len() > 8 && bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-")
}

/// Every page with ink as a note. `start_ms` is the time given to the first
/// stroke (Unix ms); `seed` makes the stroke ids (see [`Document::new`]).
pub fn import(bytes: &[u8], seed: u64, start_ms: f64) -> Result<Vec<PdfPage>, String> {
    if !is_pdf(bytes) {
        return Err("not a PDF file".into());
    }
    let file = File::read(bytes);
    let pages = file.pages();
    if pages.is_empty() {
        return Err("no pages found in this PDF".into());
    }
    let mut out = Vec::new();
    let mut t = start_ms;
    for (i, page) in pages.iter().enumerate() {
        let mut ink = Ink::default();
        let content = file.page_content(page);
        let res = page.resources.clone();
        run(&file, &content, &res, IDENTITY, &mut ink, 0);
        let seed = seed.wrapping_add((i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let mut p = build_page(&ink, page.media, seed, &mut t);
        if !p.doc.is_empty() {
            p.doc.created = start_ms;
            p.doc.modified = start_ms;
            out.push(p);
        }
    }
    Ok(out)
}

// ---- Objects ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Obj {
    Null,
    Bool(bool),
    Num(f64),
    Name(String),
    Str(Vec<u8>),
    Arr(Vec<Obj>),
    Dict(Dict),
    Ref(u32),
    /// A bare keyword: an operator in a content stream.
    Op(String),
}
type Dict = HashMap<String, Obj>;

impl Obj {
    fn num(&self) -> Option<f64> {
        match self {
            Obj::Num(n) => Some(*n),
            _ => None,
        }
    }
    fn name(&self) -> Option<&str> {
        match self {
            Obj::Name(n) => Some(n),
            _ => None,
        }
    }
}

fn is_white(c: u8) -> bool {
    matches!(c, 0 | 9 | 10 | 12 | 13 | 32)
}
fn is_delim(c: u8) -> bool {
    matches!(c, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

/// A tokenizer and parser over a byte slice.
struct Lexer<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Lexer<'a> {
    fn new(b: &'a [u8], pos: usize) -> Self {
        Lexer { b, pos }
    }

    fn skip(&mut self) {
        while self.pos < self.b.len() {
            let c = self.b[self.pos];
            if is_white(c) {
                self.pos += 1;
            } else if c == b'%' {
                while self.pos < self.b.len() && !matches!(self.b[self.pos], b'\n' | b'\r') {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    fn word(&mut self) -> &'a [u8] {
        let s = self.pos;
        while self.pos < self.b.len() && !is_white(self.b[self.pos]) && !is_delim(self.b[self.pos]) {
            self.pos += 1;
        }
        &self.b[s..self.pos]
    }

    /// The next value, or None at the end (or on bytes that make no sense,
    /// which are skipped).
    fn next(&mut self, depth: usize) -> Option<Obj> {
        self.skip();
        let c = *self.b.get(self.pos)?;
        if depth > 64 {
            self.pos += 1;
            return Some(Obj::Null);
        }
        match c {
            b'/' => {
                self.pos += 1;
                let w = self.word();
                let mut name = Vec::with_capacity(w.len());
                let mut i = 0;
                while i < w.len() {
                    if w[i] == b'#' && i + 2 < w.len() {
                        if let Ok(v) = u8::from_str_radix(&String::from_utf8_lossy(&w[i + 1..i + 3]), 16) {
                            name.push(v);
                            i += 3;
                            continue;
                        }
                    }
                    name.push(w[i]);
                    i += 1;
                }
                Some(Obj::Name(String::from_utf8_lossy(&name).into_owned()))
            }
            b'(' => Some(Obj::Str(self.literal())),
            b'<' if self.b.get(self.pos + 1) == Some(&b'<') => {
                self.pos += 2;
                let mut d = Dict::new();
                loop {
                    self.skip();
                    if self.b.get(self.pos..self.pos + 2) == Some(b">>") {
                        self.pos += 2;
                        break;
                    }
                    match self.next(depth + 1)? {
                        Obj::Name(k) => {
                            let v = self.next(depth + 1)?;
                            d.insert(k, v);
                        }
                        Obj::Op(_) if self.pos >= self.b.len() => return None,
                        _ => {}
                    }
                }
                Some(Obj::Dict(d))
            }
            b'<' => {
                self.pos += 1;
                let mut hex = Vec::new();
                while let Some(&c) = self.b.get(self.pos) {
                    self.pos += 1;
                    if c == b'>' {
                        break;
                    }
                    if c.is_ascii_hexdigit() {
                        hex.push(c);
                    }
                }
                if hex.len() % 2 == 1 {
                    hex.push(b'0');
                }
                Some(Obj::Str(
                    hex.chunks(2).filter_map(|p| u8::from_str_radix(std::str::from_utf8(p).ok()?, 16).ok()).collect(),
                ))
            }
            b'[' => {
                self.pos += 1;
                let mut a = Vec::new();
                loop {
                    self.skip();
                    match self.b.get(self.pos) {
                        None => break,
                        Some(b']') => {
                            self.pos += 1;
                            break;
                        }
                        _ => a.push(self.next(depth + 1)?),
                    }
                }
                Some(Obj::Arr(a))
            }
            b']' | b'>' | b')' | b'{' | b'}' => {
                self.pos += 1;
                Some(Obj::Op(String::from(c as char)))
            }
            b'0'..=b'9' | b'+' | b'-' | b'.' => {
                let w = self.word();
                let n: f64 = std::str::from_utf8(w).ok().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                // "12 0 R" is a reference.
                if w.iter().all(u8::is_ascii_digit) {
                    let save = self.pos;
                    self.skip();
                    let g = self.word();
                    if !g.is_empty() && g.iter().all(u8::is_ascii_digit) {
                        self.skip();
                        if self.b.get(self.pos) == Some(&b'R')
                            && self.b.get(self.pos + 1).is_none_or(|&c| is_white(c) || is_delim(c))
                        {
                            self.pos += 1;
                            return Some(Obj::Ref(n as u32));
                        }
                    }
                    self.pos = save;
                }
                Some(Obj::Num(n))
            }
            _ => {
                let w = self.word();
                if w.is_empty() {
                    self.pos += 1;
                    return Some(Obj::Op(String::from(c as char)));
                }
                Some(match w {
                    b"true" => Obj::Bool(true),
                    b"false" => Obj::Bool(false),
                    b"null" => Obj::Null,
                    _ => Obj::Op(String::from_utf8_lossy(w).into_owned()),
                })
            }
        }
    }

    fn literal(&mut self) -> Vec<u8> {
        self.pos += 1;
        let mut out = Vec::new();
        let mut depth = 1;
        while let Some(&c) = self.b.get(self.pos) {
            self.pos += 1;
            match c {
                b'\\' => {
                    let Some(&e) = self.b.get(self.pos) else { break };
                    self.pos += 1;
                    match e {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'0'..=b'7' => {
                            let mut v = (e - b'0') as u32;
                            for _ in 0..2 {
                                match self.b.get(self.pos) {
                                    Some(&d @ b'0'..=b'7') => {
                                        v = v * 8 + (d - b'0') as u32;
                                        self.pos += 1;
                                    }
                                    _ => break,
                                }
                            }
                            out.push(v as u8);
                        }
                        b'\r' => {
                            if self.b.get(self.pos) == Some(&b'\n') {
                                self.pos += 1;
                            }
                        }
                        b'\n' => {}
                        _ => out.push(e),
                    }
                }
                b'(' => {
                    depth += 1;
                    out.push(c);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    out.push(c);
                }
                _ => out.push(c),
            }
        }
        out
    }
}

/// An object as stored: its value, and its stream data if it has one.
#[derive(Clone)]
struct Stored {
    value: Obj,
    stream: Option<Vec<u8>>,
}

struct File {
    objects: HashMap<u32, Stored>,
    order: Vec<u32>,
}

struct Page {
    contents: Obj,
    resources: Dict,
    media: Rect,
}

impl File {
    /// Finds every `n g obj` in the file. Damaged cross-reference tables
    /// (common in exports) do not matter this way; a later copy of an
    /// object replaces an earlier one, as an incremental update would.
    fn read(b: &[u8]) -> File {
        let mut objects = HashMap::new();
        let mut order = Vec::new();
        let mut i = 0;
        while let Some(off) = find(b, b"obj", i) {
            i = off + 3;
            if b.get(off + 3).is_some_and(|&c| !is_white(c) && !is_delim(c)) {
                continue;
            }
            let Some(num) = obj_header(b, off) else { continue };
            let mut lx = Lexer::new(b, off + 3);
            let Some(value) = lx.next(0) else { continue };
            lx.skip();
            let mut stream = None;
            if b[lx.pos..].starts_with(b"stream") {
                let mut s = lx.pos + 6;
                if b.get(s) == Some(&b'\r') {
                    s += 1;
                }
                if b.get(s) == Some(&b'\n') {
                    s += 1;
                }
                let len = match &value {
                    Obj::Dict(d) => match d.get("Length") {
                        Some(Obj::Num(n)) => Some(*n as usize),
                        _ => None,
                    },
                    _ => None,
                };
                let end = match len {
                    Some(n) if s + n <= b.len() && find(b, b"endstream", s + n).is_some_and(|e| e - (s + n) < 4) => {
                        s + n
                    }
                    _ => {
                        let mut e = find(b, b"endstream", s).unwrap_or(b.len());
                        while e > s && matches!(b[e - 1], b'\r' | b'\n') {
                            e -= 1;
                        }
                        e
                    }
                };
                stream = Some(b[s..end].to_vec());
                i = end;
            } else {
                i = lx.pos.max(i);
            }
            if objects.insert(num, Stored { value, stream }).is_none() {
                order.push(num);
            }
        }
        let mut f = File { objects, order };
        f.unpack_object_streams();
        f
    }

    /// Objects kept compressed inside object streams.
    fn unpack_object_streams(&mut self) {
        let streams: Vec<u32> = self
            .order
            .iter()
            .copied()
            .filter(|n| match &self.objects[n].value {
                Obj::Dict(d) => d.get("Type").and_then(Obj::name) == Some("ObjStm"),
                _ => false,
            })
            .collect();
        for n in streams {
            let Some(data) = self.decoded(n) else { continue };
            let Obj::Dict(d) = &self.objects[&n].value else { continue };
            let count = d.get("N").and_then(Obj::num).unwrap_or(0.0) as usize;
            let first = d.get("First").and_then(Obj::num).unwrap_or(0.0) as usize;
            let mut head = Lexer::new(&data, 0);
            let mut entries = Vec::new();
            for _ in 0..count.min(100_000) {
                match (head.next(0), head.next(0)) {
                    (Some(Obj::Num(a)), Some(Obj::Num(o))) => entries.push((a as u32, first + o as usize)),
                    _ => break,
                }
            }
            for (num, off) in entries {
                if self.objects.contains_key(&num) || off >= data.len() {
                    continue;
                }
                if let Some(value) = Lexer::new(&data, off).next(0) {
                    self.objects.insert(num, Stored { value, stream: None });
                    self.order.push(num);
                }
            }
        }
    }

    fn get<'b>(&'b self, o: &'b Obj) -> &'b Obj {
        let mut o = o;
        for _ in 0..8 {
            match o {
                Obj::Ref(n) => match self.objects.get(n) {
                    Some(s) => o = &s.value,
                    None => return &Obj::Null,
                },
                _ => return o,
            }
        }
        &Obj::Null
    }

    fn dict<'b>(&'b self, o: &'b Obj) -> Option<&'b Dict> {
        match self.get(o) {
            Obj::Dict(d) => Some(d),
            _ => None,
        }
    }

    /// A stream's data with its filters undone, or None if a filter is not
    /// supported.
    fn decoded(&self, n: u32) -> Option<Vec<u8>> {
        let s = self.objects.get(&n)?;
        let raw = s.stream.as_ref()?;
        let filters: Vec<String> = match &s.value {
            Obj::Dict(d) => match d.get("Filter").map(|f| self.get(f)) {
                Some(Obj::Name(f)) => vec![f.clone()],
                Some(Obj::Arr(a)) => a.iter().filter_map(|f| self.get(f).name().map(String::from)).collect(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        };
        let mut data = raw.clone();
        for f in filters {
            data = match f.as_str() {
                "FlateDecode" | "Fl" => miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(&data, MAX_STREAM)
                    .or_else(|_| miniz_oxide::inflate::decompress_to_vec_with_limit(&data, MAX_STREAM))
                    .ok()?,
                _ => return None,
            };
        }
        Some(data)
    }

    /// Pages in reading order, from the page tree (or, if it is damaged,
    /// every page object in file order).
    fn pages(&self) -> Vec<Page> {
        let mut out = Vec::new();
        let root = self.order.iter().rev().find_map(|n| match &self.objects[n].value {
            Obj::Dict(d) if d.get("Type").and_then(Obj::name) == Some("Catalog") => d.get("Pages").cloned(),
            _ => None,
        });
        let mut seen = HashSet::new();
        if let Some(root) = root {
            self.walk(&root, &Dict::new(), None, &mut out, &mut seen, 0);
        }
        if out.is_empty() {
            for n in &self.order {
                let v = Obj::Ref(*n);
                if self.dict(&v).and_then(|d| d.get("Type")).and_then(Obj::name) == Some("Page") {
                    self.walk(&v, &Dict::new(), None, &mut out, &mut seen, 0);
                }
            }
        }
        out
    }

    fn walk(
        &self,
        node: &Obj,
        res: &Dict,
        media: Option<Rect>,
        out: &mut Vec<Page>,
        seen: &mut HashSet<u32>,
        depth: usize,
    ) {
        if depth > 64 {
            return;
        }
        if let Obj::Ref(n) = node {
            if !seen.insert(*n) {
                return;
            }
        }
        let Some(d) = self.dict(node) else { return };
        let res = d.get("Resources").and_then(|r| self.dict(r)).cloned().unwrap_or_else(|| res.clone());
        let media = d.get("MediaBox").and_then(|m| self.rect(m)).or(media);
        if let Some(Obj::Arr(kids)) = d.get("Kids").map(|k| self.get(k)) {
            for k in kids {
                self.walk(k, &res, media, out, seen, depth + 1);
            }
        } else if d.get("Type").and_then(Obj::name) != Some("Pages") {
            let media = media.unwrap_or(Rect::new(Vec2::ZERO, Vec2::new(612.0, 792.0)));
            out.push(Page { contents: d.get("Contents").cloned().unwrap_or(Obj::Null), resources: res, media });
        }
    }

    fn rect(&self, o: &Obj) -> Option<Rect> {
        let Obj::Arr(a) = self.get(o) else { return None };
        let v: Vec<f64> = a.iter().filter_map(|x| self.get(x).num()).collect();
        (v.len() == 4)
            .then(|| Rect::new(Vec2::new(v[0].min(v[2]), v[1].min(v[3])), Vec2::new(v[0].max(v[2]), v[1].max(v[3]))))
    }

    fn page_content(&self, p: &Page) -> Vec<u8> {
        let refs: Vec<u32> = match &p.contents {
            Obj::Ref(n) => match self.get(&p.contents) {
                Obj::Arr(a) => a.iter().filter_map(|x| if let Obj::Ref(n) = x { Some(*n) } else { None }).collect(),
                _ => vec![*n],
            },
            Obj::Arr(a) => a.iter().filter_map(|x| if let Obj::Ref(n) = x { Some(*n) } else { None }).collect(),
            _ => Vec::new(),
        };
        let mut out = Vec::new();
        for n in refs {
            if let Some(d) = self.decoded(n) {
                out.extend_from_slice(&d);
                out.push(b'\n');
            }
        }
        out
    }
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

/// `12 0 obj`: the object number before `obj` at `off`.
fn obj_header(b: &[u8], off: usize) -> Option<u32> {
    let mut i = off;
    let back_ws = |i: &mut usize| {
        while *i > 0 && is_white(b[*i - 1]) {
            *i -= 1;
        }
    };
    let back_digits = |i: &mut usize| -> Option<usize> {
        let e = *i;
        while *i > 0 && b[*i - 1].is_ascii_digit() {
            *i -= 1;
        }
        (e > *i).then_some(e)
    };
    back_ws(&mut i);
    if i == off {
        return None;
    }
    back_digits(&mut i)?;
    let ws = i;
    back_ws(&mut i);
    if i == ws {
        return None;
    }
    let e = back_digits(&mut i)?;
    if i > 0 && !is_white(b[i - 1]) && !is_delim(b[i - 1]) {
        return None;
    }
    std::str::from_utf8(&b[i..e]).ok()?.parse().ok()
}

// ---- Content streams ----------------------------------------------------------

type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn mul(m: &Matrix, n: &Matrix) -> Matrix {
    [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ]
}
fn apply(m: &Matrix, x: f64, y: f64) -> Vec2 {
    Vec2::new(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

/// A filled or stroked path, in page space (PDF units, y up).
#[derive(Debug, Clone)]
struct InkPath {
    pieces: Vec<Vec<Vec2>>,
    color: [f64; 3],
    alpha: f64,
    /// Line width for a stroked path; None for a filled outline.
    line: Option<f64>,
}

#[derive(Debug, Clone)]
struct Span {
    at: Vec2,
    size: f64,
    text: String,
    invisible: bool,
}

#[derive(Default)]
struct Ink {
    paths: Vec<InkPath>,
    spans: Vec<Span>,
    images: usize,
}

#[derive(Clone)]
struct GState {
    ctm: Matrix,
    fill: [f64; 3],
    stroke: [f64; 3],
    fill_alpha: f64,
    stroke_alpha: f64,
    line_width: f64,
}

fn color_of(args: &[f64]) -> Option<[f64; 3]> {
    match args.len() {
        1 => Some([args[0]; 3]),
        3 => Some([args[0], args[1], args[2]]),
        4 => {
            let k = 1.0 - args[3];
            Some([(1.0 - args[0]) * k, (1.0 - args[1]) * k, (1.0 - args[2]) * k])
        }
        _ => None,
    }
}

fn run(file: &File, content: &[u8], res: &Dict, ctm: Matrix, ink: &mut Ink, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    let mut gs = GState { ctm, fill: [0.0; 3], stroke: [0.0; 3], fill_alpha: 1.0, stroke_alpha: 1.0, line_width: 1.0 };
    let mut stack: Vec<GState> = Vec::new();
    let mut args: Vec<Obj> = Vec::new();
    let mut path: Vec<Vec<Vec2>> = Vec::new();
    let mut has_rect = false;
    let mut cur = Vec2::ZERO;
    // Text state.
    let (mut tm, mut tlm) = (IDENTITY, IDENTITY);
    let (mut size, mut leading, mut mode) = (1.0, 0.0, 0.0);
    let mut lx = Lexer::new(content, 0);
    let nums = |args: &[Obj]| -> Vec<f64> { args.iter().filter_map(Obj::num).collect() };
    while let Some(tok) = lx.next(0) {
        let Obj::Op(op) = tok else {
            args.push(tok);
            continue;
        };
        let n = nums(&args);
        let last = |k: usize| -> Option<&[f64]> { (n.len() >= k).then(|| &n[n.len() - k..]) };
        match op.as_str() {
            "q" => stack.push(gs.clone()),
            "Q" => {
                if let Some(s) = stack.pop() {
                    gs = s;
                }
            }
            "cm" => {
                if let Some(m) = last(6) {
                    gs.ctm = mul(&[m[0], m[1], m[2], m[3], m[4], m[5]], &gs.ctm);
                }
            }
            "w" => {
                if let Some(v) = last(1) {
                    gs.line_width = v[0];
                }
            }
            "g" | "rg" | "k" | "sc" | "scn" => {
                if let Some(c) = color_of(&n) {
                    gs.fill = c;
                }
            }
            "G" | "RG" | "K" | "SC" | "SCN" => {
                if let Some(c) = color_of(&n) {
                    gs.stroke = c;
                }
            }
            "cs" => gs.fill = [0.0; 3],
            "CS" => gs.stroke = [0.0; 3],
            "gs" => {
                if let Some(Obj::Name(name)) = args.last() {
                    let ext = res.get("ExtGState").and_then(|e| file.dict(e)).and_then(|e| e.get(name.as_str()));
                    if let Some(d) = ext.and_then(|e| file.dict(e)) {
                        if let Some(a) = d.get("ca").and_then(|a| file.get(a).num()) {
                            gs.fill_alpha = a;
                        }
                        if let Some(a) = d.get("CA").and_then(|a| file.get(a).num()) {
                            gs.stroke_alpha = a;
                        }
                        if let Some(w) = d.get("LW").and_then(|a| file.get(a).num()) {
                            gs.line_width = w;
                        }
                    }
                }
            }
            "m" => {
                if let Some(p) = last(2) {
                    cur = apply(&gs.ctm, p[0], p[1]);
                    path.push(vec![cur]);
                }
            }
            "l" => {
                if let (Some(p), Some(sub)) = (last(2), path.last_mut()) {
                    cur = apply(&gs.ctm, p[0], p[1]);
                    sub.push(cur);
                }
            }
            "c" | "v" | "y" => {
                let need = if op == "c" { 6 } else { 4 };
                if let (Some(p), Some(sub)) = (last(need), path.last_mut()) {
                    let pts: Vec<Vec2> = p.chunks(2).map(|c| apply(&gs.ctm, c[0], c[1])).collect();
                    let (c1, c2, end) = match op.as_str() {
                        "c" => (pts[0], pts[1], pts[2]),
                        "v" => (cur, pts[0], pts[1]),
                        _ => (pts[0], pts[1], pts[1]),
                    };
                    // The curve's middle, then its end.
                    let mid = (cur + c1 * 3.0 + c2 * 3.0 + end) * 0.125;
                    sub.push(mid);
                    sub.push(end);
                    cur = end;
                }
            }
            "re" => {
                has_rect = true;
                path.push(Vec::new());
            }
            "h" => {}
            "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => {
                if !has_rect && !path.is_empty() {
                    ink.paths.push(InkPath {
                        pieces: std::mem::take(&mut path),
                        color: gs.fill,
                        alpha: gs.fill_alpha,
                        line: None,
                    });
                }
                path.clear();
                has_rect = false;
            }
            "S" | "s" => {
                if !has_rect && !path.is_empty() {
                    let scale = (gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]).abs().sqrt();
                    ink.paths.push(InkPath {
                        pieces: std::mem::take(&mut path),
                        color: gs.stroke,
                        alpha: gs.stroke_alpha,
                        line: Some((gs.line_width * scale).max(0.1)),
                    });
                }
                path.clear();
                has_rect = false;
            }
            "n" | "W" | "W*" => {
                if op == "n" {
                    path.clear();
                    has_rect = false;
                }
            }
            "BT" => {
                tm = IDENTITY;
                tlm = IDENTITY;
            }
            "Tf" => {
                if let Some(v) = last(1) {
                    size = v[0];
                }
            }
            "Tr" => {
                if let Some(v) = last(1) {
                    mode = v[0];
                }
            }
            "TL" => {
                if let Some(v) = last(1) {
                    leading = v[0];
                }
            }
            "Tm" => {
                if let Some(m) = last(6) {
                    tm = [m[0], m[1], m[2], m[3], m[4], m[5]];
                    tlm = tm;
                }
            }
            "Td" | "TD" => {
                if let Some(v) = last(2) {
                    if op == "TD" {
                        leading = -v[1];
                    }
                    tlm = mul(&[1.0, 0.0, 0.0, 1.0, v[0], v[1]], &tlm);
                    tm = tlm;
                }
            }
            "T*" => {
                tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -leading], &tlm);
                tm = tlm;
            }
            "Tj" | "TJ" | "'" | "\"" => {
                if op == "'" || op == "\"" {
                    tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -leading], &tlm);
                    tm = tlm;
                }
                let mut bytes = Vec::new();
                for a in &args {
                    match a {
                        Obj::Str(s) => bytes.extend_from_slice(s),
                        Obj::Arr(items) => {
                            for i in items {
                                if let Obj::Str(s) = i {
                                    bytes.extend_from_slice(s);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                let text: String =
                    bytes.iter().filter(|b| b.is_ascii_graphic() || **b == b' ').map(|&b| b as char).collect();
                let m = mul(&tm, &gs.ctm);
                let h = (m[2] * m[2] + m[3] * m[3]).sqrt() * size.abs();
                if !text.trim().is_empty() {
                    ink.spans.push(Span {
                        at: apply(&m, 0.0, 0.0),
                        size: h,
                        text: text.trim().to_string(),
                        invisible: mode == 3.0 || mode == 7.0,
                    });
                }
            }
            "Do" => {
                if let Some(Obj::Name(name)) = args.last() {
                    let xo = res.get("XObject").and_then(|x| file.dict(x)).and_then(|x| x.get(name.as_str())).cloned();
                    if let Some(Obj::Ref(n)) = xo {
                        if let Some(d) = file.dict(&Obj::Ref(n)) {
                            match d.get("Subtype").and_then(Obj::name) {
                                Some("Form") => {
                                    let m = d
                                        .get("Matrix")
                                        .and_then(|m| match file.get(m) {
                                            Obj::Arr(a) => {
                                                let v: Vec<f64> = a.iter().filter_map(|x| file.get(x).num()).collect();
                                                (v.len() == 6).then(|| [v[0], v[1], v[2], v[3], v[4], v[5]])
                                            }
                                            _ => None,
                                        })
                                        .unwrap_or(IDENTITY);
                                    let sub_res = d
                                        .get("Resources")
                                        .and_then(|r| file.dict(r))
                                        .cloned()
                                        .unwrap_or_else(|| res.clone());
                                    if let Some(data) = file.decoded(n) {
                                        run(file, &data, &sub_res, mul(&m, &gs.ctm), ink, depth + 1);
                                    }
                                }
                                Some("Image") => ink.images += 1,
                                _ => {}
                            }
                        }
                    }
                }
            }
            "BI" => {
                // Inline image: skip to EI.
                if let Some(e) = find(content, b"EI", lx.pos) {
                    lx.pos = e + 2;
                }
                ink.images += 1;
            }
            _ => {}
        }
        args.clear();
    }
}

// ---- Ink to strokes -------------------------------------------------------------

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

fn area(poly: &[Vec2]) -> f64 {
    let mut a = 0.0;
    for i in 0..poly.len() {
        let (p, q) = (poly[i], poly[(i + 1) % poly.len()]);
        a += p.x * q.y - q.x * p.y;
    }
    (a * 0.5).abs()
}

/// The centre line and width of one filled stroke outline, in page space.
fn centre_line(pieces: &[Vec<Vec2>]) -> Option<(Vec<Vec2>, f64)> {
    let mut line: Vec<Vec2> = Vec::new();
    let mut widths = Vec::new();
    for piece in pieces {
        if piece.is_empty() {
            continue;
        }
        let start = piece[0];
        let (k, far) =
            piece
                .iter()
                .enumerate()
                .map(|(i, p)| (i, p.distance(start)))
                .fold((0, 0.0), |a, b| if b.1 > a.1 { b } else { a });
        if far > 1e-9 {
            widths.push(area(piece) / far);
        }
        for &p in &piece[..=k] {
            if line.last().is_none_or(|l| l.distance(p) > 0.05) {
                line.push(p);
            }
        }
    }
    if line.is_empty() {
        return None;
    }
    let mut w = median(&mut widths);
    if widths.is_empty() {
        // A dot: as wide as it is.
        let mut r = Rect::EMPTY;
        for p in pieces.iter().flatten() {
            r.include(*p);
        }
        w = r.width().max(r.height());
    }
    Some((line, w))
}

fn build_page(ink: &Ink, media: Rect, seed: u64, t: &mut f64) -> PdfPage {
    let mut doc = Document::new(seed);
    doc.paper = "plain".into();
    let to_page = |p: Vec2| Vec2::new(p.x - media.min.x, media.max.y - p.y);
    let mut strokes = Vec::new();
    let mut warnings = Vec::new();
    let mut shapes = 0;
    for path in &ink.paths {
        if path.color.iter().all(|c| *c > 0.97) {
            continue; // white: paper or an eraser trace
        }
        let lines: Vec<(Vec<Vec2>, f64)> = match path.line {
            None => match centre_line(&path.pieces) {
                Some((l, w)) if w <= MAX_INK_WIDTH => vec![(l, w)],
                _ => {
                    shapes += 1;
                    continue;
                }
            },
            Some(w) => path.pieces.iter().filter(|p| !p.is_empty()).map(|p| (p.clone(), w)).collect(),
        };
        for (line, w) in lines {
            let pts: Vec<Vec2> = line.into_iter().map(to_page).collect();
            let mut points = Vec::with_capacity(pts.len());
            let mut along = 0.0;
            for (i, p) in pts.iter().enumerate() {
                if i > 0 {
                    along += p.distance(pts[i - 1]);
                }
                points.push(InputPoint {
                    x: p.x,
                    y: p.y,
                    pressure: 0.5,
                    altitude: std::f32::consts::FRAC_PI_2,
                    azimuth: 0.0,
                    t: (along / SPEED).round(),
                });
            }
            let c = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
            let kind = if path.alpha < 0.95 { BrushKind::Highlighter } else { BrushKind::Pen };
            let brush = Brush::new(kind, Rgba::rgb(c(path.color[0]), c(path.color[1]), c(path.color[2])), w as f32);
            let id = doc.next_id();
            let duration = along / SPEED;
            strokes.push(Stroke::new(id, brush, t.round(), InputDevice::Pen, points));
            *t += duration + GAP_MS;
        }
    }
    doc.set_strokes(strokes);
    let readings = attach_readings(&mut doc, &ink.spans, &to_page);
    if ink.images > 0 {
        warnings.push(format!("{} picture{} left out", ink.images, if ink.images == 1 { "" } else { "s" }));
    }
    let typed = ink.spans.iter().filter(|s| !s.invisible).count();
    if typed > 0 {
        warnings.push(format!("{typed} piece{} of typed text left out", if typed == 1 { "" } else { "s" }));
    }
    if shapes > 0 {
        warnings.push(format!("{shapes} filled shape{} left out", if shapes == 1 { "" } else { "s" }));
    }
    PdfPage { doc, readings, warnings }
}

/// Finds where the text layer sits on the ink. GoodNotes places it with a
/// large offset, so the two are lined up: first by their bounds, then by
/// moving the text towards the ink under it until it settles.
fn align(spans: &[Vec2], ink: &[Vec2]) -> Option<Vec2> {
    if spans.is_empty() || ink.is_empty() {
        return None;
    }
    let bounds = |ps: &[Vec2]| {
        let mut r = Rect::EMPTY;
        for p in ps {
            r.include(*p);
        }
        r
    };
    let (sb, ib) = (bounds(spans), bounds(ink));
    let mut off = sb.min - ib.min;
    const CELL: f64 = 64.0;
    let mut grid: HashMap<(i64, i64), Vec<Vec2>> = HashMap::new();
    for p in ink {
        grid.entry(((p.x / CELL).floor() as i64, (p.y / CELL).floor() as i64)).or_default().push(*p);
    }
    let nearest = |q: Vec2| -> Option<Vec2> {
        let (cx, cy) = ((q.x / CELL).floor() as i64, (q.y / CELL).floor() as i64);
        let mut best: Option<(f64, Vec2)> = None;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for p in grid.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                    let d = p.distance(q);
                    if best.is_none_or(|b| d < b.0) {
                        best = Some((d, *p));
                    }
                }
            }
        }
        best.map(|b| b.1)
    };
    let mut matched = 0;
    for _ in 0..6 {
        let (mut dx, mut dy) = (Vec::new(), Vec::new());
        for s in spans {
            let q = *s - off;
            if let Some(p) = nearest(q) {
                dx.push(q.x - p.x);
                dy.push(q.y - p.y);
            }
        }
        matched = dx.len();
        if matched == 0 {
            return None;
        }
        off = off + Vec2::new(median(&mut dx), median(&mut dy));
    }
    (matched * 10 >= spans.len() * 3).then_some(off)
}

/// Keeps the hidden text layer's readings as the words' recognised text.
/// Returns how many words got one.
fn attach_readings(doc: &mut Document, spans: &[Span], to_page: &dyn Fn(Vec2) -> Vec2) -> usize {
    let hidden: Vec<Span> =
        spans.iter().filter(|s| s.invisible).map(|s| Span { at: to_page(s.at), ..s.clone() }).collect();
    let ink: Vec<Vec2> = doc.strokes().iter().flat_map(|s| s.points.iter().map(|p| p.pos())).collect();
    // A span's anchor: a little above its baseline, inside the letters.
    let anchor = |s: &Span| s.at - Vec2::new(0.0, s.size * 0.3);
    let anchors: Vec<Vec2> = hidden.iter().map(anchor).collect();
    let Some(off) = align(&anchors, &ink) else { return 0 };
    let layout = words::layout(doc);
    let mut per_word: HashMap<usize, Vec<(f64, &Span)>> = HashMap::new();
    for (s, a) in hidden.iter().zip(&anchors) {
        let q = *a - off;
        let mut best: Option<(f64, usize)> = None;
        for (i, w) in layout.words.iter().enumerate() {
            let lh = layout.lines[w.line].letter_height;
            let r = w.bounds.inflate(lh * 0.4);
            if r.contains(q) {
                let a = r.width() * r.height();
                if best.is_none_or(|b| a < b.0) {
                    best = Some((a, i));
                }
            }
        }
        if let Some((_, i)) = best {
            per_word.entry(i).or_default().push((q.x, s));
        }
    }
    let mut n = 0;
    for (i, mut parts) in per_word {
        parts.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut text = String::new();
        let mut end = f64::NEG_INFINITY;
        let mut prev: f64 = 0.0;
        for (x, s) in parts {
            // Pieces far apart are two words the layout put together.
            if !text.is_empty() && x - end > s.size.max(prev) * 0.6 {
                text.push(' ');
            }
            text.push_str(&s.text);
            end = x + s.text.chars().count() as f64 * s.size * 0.5;
            prev = s.size;
        }
        let w = &layout.words[i];
        doc.recognition.push(RecognizedText {
            id: format!("{:016x}", w.id),
            text,
            strokes: w.strokes.clone(),
            alternatives: Vec::new(),
            confidence: None,
            language: Some("en".into()),
            engine: Some(ENGINE.into()),
        });
        n += 1;
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small PDF like a GoodNotes export: each stroke a filled outline of
    /// pieces, plus an invisible text layer placed with a large offset.
    pub(crate) fn sample_pdf(compress: bool) -> Vec<u8> {
        let mut c = String::new();
        c.push_str("q 1 1 1 sc 0 0 600 400 re f Q\n");
        // Three "letters": short strokes 20 units tall, at x = 100, 130, 160
        // (one word), and one at x = 300 (another word). y up in the PDF.
        let mut stroke = |x: f64, y: f64, color: &str| {
            c.push_str(&format!("{color} sc\n"));
            // Two pieces from (x, y) to (x+5, y+10) to (x+10, y+20), each a thin
            // closed outline 2 units wide.
            for (a, b) in [((x, y), (x + 5.0, y + 10.0)), ((x + 5.0, y + 10.0), (x + 10.0, y + 20.0))] {
                c.push_str(&format!(
                    "{} {} m {} {} l {} {} l {} {} l h ",
                    a.0,
                    a.1,
                    b.0,
                    b.1,
                    b.0 + 2.0,
                    b.1,
                    a.0 + 2.0,
                    a.1
                ));
            }
            c.push_str("f\n");
        };
        stroke(100.0, 300.0, "0.1 0.1 0.1");
        stroke(115.0, 300.0, "0.1 0.1 0.1");
        stroke(130.0, 300.0, "0.1 0.1 0.1");
        stroke(300.0, 300.0, "0.8 0.1 0.1");
        // Hidden text, 5000 units away, as GoodNotes does.
        c.push_str("3 Tr q 1 0 0 1 5100 5302 cm BT 20 0 0 20 0 0 Tm /F1 1 Tf (h\\151) Tj ET Q\n");
        c.push_str("q 1 0 0 1 5300 5302 cm BT 20 0 0 20 0 0 Tm /F1 1 Tf [(o) -5 (k)] TJ ET Q\n");
        c.push_str("0 Tr BT 12 0 0 12 50 50 Tm /F1 1 Tf (typed) Tj ET\n");
        let (data, filter) = if compress {
            (miniz_oxide::deflate::compress_to_vec_zlib(c.as_bytes(), 6), " /Filter /FlateDecode")
        } else {
            (c.into_bytes(), "")
        };
        let mut pdf = b"%PDF-1.4\n".to_vec();
        pdf.extend_from_slice(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
        pdf.extend_from_slice(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 600 400] >> endobj\n");
        pdf.extend_from_slice(b"3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> >> endobj\n");
        pdf.extend_from_slice(format!("4 0 obj << /Length 5 0 R{filter} >>\nstream\n").as_bytes());
        pdf.extend_from_slice(&data);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");
        pdf.extend_from_slice(format!("5 0 obj {} endobj\n", data.len()).as_bytes());
        pdf.extend_from_slice(b"trailer << /Root 1 0 R >>\n%%EOF\n");
        pdf
    }

    #[test]
    fn pdf_strokes_become_note_strokes_in_writing_order() {
        for compress in [false, true] {
            let pages = import(&sample_pdf(compress), 7, 1_000.0).unwrap();
            assert_eq!(pages.len(), 1);
            let doc = &pages[0].doc;
            assert_eq!(doc.len(), 4, "the white background is not ink");
            let s = &doc.strokes()[0];
            // Centre line from (100, 300) up to (110, 320) in PDF space: y is
            // flipped (page height 400), so it runs from y = 100 to y = 80.
            let first = s.points.first().unwrap();
            let last = s.points.last().unwrap();
            assert!((first.x - 100.0).abs() < 0.5 && (first.y - 100.0).abs() < 0.5, "{first:?}");
            assert!((last.x - 110.0).abs() < 2.5 && (last.y - 80.0).abs() < 2.5, "{last:?}");
            assert!((s.brush.size - 2.0).abs() < 0.6, "width {}", s.brush.size);
            assert_eq!(doc.strokes()[3].brush.color, Rgba::rgb(204, 26, 26));
            // Times: in order, as if written at an even speed.
            let starts: Vec<f64> = doc.strokes().iter().map(|s| s.start_time).collect();
            assert!(starts.windows(2).all(|w| w[1] > w[0]));
            assert_eq!(starts[0], 1_000.0);
            assert!(s.points.windows(2).all(|w| w[1].t >= w[0].t));
        }
    }

    #[test]
    fn pdf_hidden_text_becomes_the_words_reading() {
        let pages = import(&sample_pdf(true), 7, 0.0).unwrap();
        let p = &pages[0];
        assert_eq!(p.readings, 2);
        let mut texts: Vec<(&str, usize)> =
            p.doc.recognition.iter().map(|r| (r.text.as_str(), r.strokes.len())).collect();
        texts.sort();
        assert_eq!(texts, [("hi", 3), ("ok", 1)]);
        assert!(p.doc.recognition.iter().all(|r| r.engine.as_deref() == Some(ENGINE)));
        assert!(p.warnings.iter().any(|w| w.contains("typed text")), "{:?}", p.warnings);
    }

    #[test]
    fn pdf_damaged_or_not_a_pdf_is_refused_without_panicking() {
        assert!(import(b"hello", 0, 0.0).is_err());
        assert!(import(b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj", 0, 0.0).unwrap_err().contains("no pages"));
        let full = sample_pdf(true);
        for cut in [20, 100, 200, full.len() / 2, full.len() - 30] {
            let _ = import(&full[..cut], 0, 0.0);
        }
        let mut junk = full.clone();
        for i in (300..junk.len()).step_by(7) {
            junk[i] = b'(';
        }
        let _ = import(&junk, 0, 0.0);
    }

    #[test]
    fn pdf_stroked_paths_and_form_xobjects_are_read_too() {
        let c = b"q 2 w 0 0 1 RG 10 10 m 20 30 l 30 10 l S Q /Fm1 Do";
        let form = b"0 g 50 50 m 55 60 l 57 60 l 52 50 l h f";
        let mut pdf = b"%PDF-1.7\n".to_vec();
        pdf.extend_from_slice(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
        pdf.extend_from_slice(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n");
        pdf.extend_from_slice(b"3 0 obj << /Type /Page /MediaBox [0 0 100 100] /Contents [4 0 R] /Resources << /XObject << /Fm1 6 0 R >> >> >> endobj\n");
        pdf.extend_from_slice(format!("4 0 obj << /Length {} >>\nstream\n", c.len()).as_bytes());
        pdf.extend_from_slice(c);
        pdf.extend_from_slice(b"\nendstream endobj\n");
        pdf.extend_from_slice(
            format!(
                "6 0 obj << /Type /XObject /Subtype /Form /Matrix [1 0 0 1 10 0] /Length {} >>\nstream\n",
                form.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(form);
        pdf.extend_from_slice(b"\nendstream endobj\n");
        let doc = &import(&pdf, 1, 0.0).unwrap()[0].doc;
        assert_eq!(doc.len(), 2);
        let s = &doc.strokes()[0];
        assert_eq!(s.points.len(), 3);
        assert_eq!((s.points[1].x, s.points[1].y), (20.0, 70.0));
        assert_eq!(s.brush.size, 2.0);
        assert_eq!(s.brush.color, Rgba::rgb(0, 0, 255));
        assert!((doc.strokes()[1].points[0].x - 60.0).abs() < 0.01, "the form's matrix moves it");
    }
}
