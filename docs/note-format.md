# Bedrock note format (version 1)

Bedrock promises that your notes outlive the app. This document is the
complete description of a note file; anyone should be able to read one in an
afternoon without Bedrock's code. The machine readable schema for
`note.json` is [note.schema.json](note.schema.json).

## Files

| Extension | What it is |
|---|---|
| `.bedrock` | The normal note file: a ZIP archive (described below). |
| `.svg` | Export: a standalone SVG picture with the same note JSON embedded, so it can be opened in Bedrock again. |
| `.json` | The bare `note.json`. Bedrock opens it too. |

### `.bedrock` (ZIP archive)

| Entry | Content |
|---|---|
| `note.json` | All ink with raw pen samples. The source of truth. |
| `recognized.json` | Text recognised from handwriting, linked to stroke ids. Kept separate so recognition can never damage ink. |
| `links.md` | The note's links as Markdown (`[[Note]]`, `[text](https://…)`), for tools such as Obsidian's graph. Generated from `links` in `note.json`. |
| `preview.svg` | The note rendered as vector paths. Opens in any browser, forever. |
| `images/<hash>.<ext>` | Pictures placed on the page, as ordinary PNG, JPEG, WebP or GIF files (stored, not compressed again). Named by their content's SHA-256, so one picture used twice is stored once. |
| `README.txt` | A short human explanation of the above. |

Readers must ignore entries they do not know, so later versions can add
files (for example PDFs).

## `note.json`

```json
{
  "format": "bedrock-note",
  "version": 1,
  "title": "Physics",
  "created": 1794000000000,
  "modified": 1794000100000,
  "background": "#fbfaf6ff",
  "paper": "dots",
  "units": "px",
  "channels": ["x", "y", "pressure", "altitude", "azimuth", "t"],
  "strokes": [
    {
      "id": "9f2c4e1a7b3d5f60",
      "brush": { "kind": "pen", "color": "#1c1c1eff", "size": 2.5 },
      "device": "pen",
      "start": 1794000001234.5,
      "points": [100.5, 200.25, 0.42, 0.873, 2.301, 0,
                 101.75, 200.5, 0.45, 0.871, 2.302, 4.2]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `format` | Always `"bedrock-note"`. |
| `version` | Format version. Readers should still try to read newer versions and keep fields they do not understand. |
| `created`, `modified` | Unix time in milliseconds. |
| `background` | Paper colour, `#rrggbbaa`. |
| `paper` | `plain`, `dots`, `grid` or `lines`. |
| `units` | World units. `px` means 1 unit is one CSS pixel at 100% zoom (1/96 inch). The canvas is infinite; coordinates may be negative. Y points down, like SVG. |
| `channels` | Names of the numbers stored per sample in each stroke's `points`, in order. |
| `strokes` | Strokes in drawing order (later strokes are on top, highlighters are drawn underneath ink). |

### Channels

Channel names follow the spirit of W3C InkML so the data maps directly onto
it (`altitude` ↔ InkML `OE`, `azimuth` ↔ `OA`, `pressure` ↔ `F`).

| Channel | Unit | Meaning |
|---|---|---|
| `x`, `y` | world units | Pen position. Required. |
| `pressure` | 0 to 1 | Normalised force. Mice record 0.5. |
| `altitude` | radians | Pen angle to the glass: π/2 upright, 0 flat. |
| `azimuth` | radians | Direction the pen leans, clockwise from +x. |
| `t` | milliseconds | Time since the stroke's `start`. |

Writers may change the order or omit channels other than `x` and `y`; readers
must use `channels` and fall back to defaults (pressure 0.5, altitude π/2,
azimuth 0, t 0). Values are rounded to 2 decimals for positions, 3 for pressure
and angles, 1 for time.

### Strokes

| Field | Meaning |
|---|---|
| `id` | 16 hex characters (64 random bits). Stable forever; recognition and sync refer to strokes by id. Random ids mean notes edited on two devices can be merged by stroke. |
| `brush.kind` | `pen`, `pencil`, `fountain`, `marker` or `highlighter`. |
| `brush.color` | `#rrggbbaa`. |
| `brush.size` | Nominal width in world units at full pressure. |
| `brush.style` | Optional: `solid` (default, omitted), `dashed` or `dotted`. Dash and dot spacing scale with `size`. Readers that don't know a style draw the line solid. |
| `brush.stabilizer` | Optional, 0 to 1 (default 0, omitted). How strongly rendering smooths shaky lines. It is applied when drawing, so `points` always hold the raw samples and the setting can be changed later without losing data. |
| `brush.taper_start` | Optional, 0 to 1. How strongly the start of the stroke thins. Omitted means the pen's usual feel (0.5 for pen, pencil and fountain pen, 0 for marker and highlighter), so old notes keep their look while defaults improve. |
| `brush.taper_end` | Optional, 0 to 1. How strongly the end thins; quick lifts thin more. Omitted: as `taper_start`. |
| `brush.taper_fade` | Optional, 0 to 1 (default 0). How much tapered ends also fade out. |
| `brush.pressure` | Optional, 0 to 1 (default 1). How much pressure changes the line: 0 draws like a ballpoint at a fixed width. |
| `brush.speed` | Optional, 0 to 1. How much faster strokes get thinner. Omitted: the pen's usual amount. |

The device's pressure curve and steady-hand smoothing are reader settings, not saved in the note: they change how the raw `pressure` and `points` are drawn on that device.
| `device` | `pen`, `mouse` or `touch`. |
| `start` | Unix time in milliseconds of the first sample. With `t` this gives the absolute time of every sample, which preserves writing order and pauses for handwriting recognition. |
| `derivedFrom` | Optional. Ids of the original strokes this one was cut from by the eraser. |
| `points` | Flat number array, `channels.length` numbers per sample. Raw samples, not smoothed, so rendering and recognition can improve later without data loss. |

How brushes turn samples into shapes is a rendering choice, not part of the
format. `preview.svg` shows exactly how Bedrock drew the note when it was saved.

## `recognized.json`

```json
{
  "format": "bedrock-recognition",
  "version": 1,
  "items": [
    {
      "id": "r1",
      "text": "Newton",
      "strokes": ["9f2c4e1a7b3d5f60", "0a11b2c3d4e5f607"],
      "alternatives": ["Newtons"],
      "confidence": 0.93,
      "language": "en",
      "engine": "example-recognizer/1"
    }
  ]
}
```

Each item names the strokes it was recognised from, in writing order. When
any of those strokes is erased, Bedrock drops the item so text never points at
missing ink; a recogniser then re-reads the remaining strokes.

`engine: "user"` marks text the writer typed in themselves: the ground truth
for those strokes, with confidence 1. What the recogniser had read is kept in
`alternatives`, so notes double as a dataset of real handwriting with checked
labels.

## Links (`links` in `note.json`)

```json
"links": [
  { "strokes": ["9f2c4e1a7b3d5f60"], "target": "https://example.com", "type": "url", "text": "Newton" },
  { "strokes": ["0a11b2c3d4e5f607"], "target": "Ideas", "type": "note", "text": "ideas" }
]
```

A link makes a group of strokes (usually one handwritten word) point
somewhere. `type` says how to read `target`: `url` is a web address, `note` is
another note by name (an Obsidian note, `[[Ideas]]`). Readers keep link types
they don't know. `text` is the linked words as recognised text, filled in when
saving, so a graph can label the link without the ink. Links are saved only
while all their strokes exist. `links.md` in the archive lists the same links
as Markdown.

## The writer's words and maths (`groups`, `kinds` in `note.json`)

```json
"groups": [["9f2c4e1a7b3d5f60", "0a11b2c3d4e5f607"]],
"kinds": [{ "strokes": ["9f2c4e1a7b3d5f60"], "kind": "math" }]
```

Words are normally found automatically from the gaps between strokes. A
`groups` entry is strokes the writer made into one word with the lasso; it
overrides the automatic split, and is saved only while all its strokes exist.
A `kinds` entry says some strokes are `text`, `math` (LaTeX) or `drawing`
(not writing: never read or spell-checked), overriding the
guess: a word follows it when any of its strokes is listed, so writing more
onto a formula keeps it maths. Moving strokes gives them new ids; both lists,
`links` and `recognition` follow the new ids.

## Pictures and text boxes (`images`, `texts` in `note.json`)

```json
"images": [{ "id": "4b1e0c9d2a7f3e58", "file": "images/9a3f…c1.png", "x": 120, "y": 80, "w": 400, "h": 300 }],
"texts": [{ "id": "7d2a9c4e1b0f6a35", "text": "Shopping list\nmilk", "x": 120, "y": 420, "w": 118, "h": 47 }]
```

A picture is a file in the bundle placed at `x`, `y` (top-left) with size
`w` × `h` in world units; it is stretched to that box. A text box holds
typed or pasted text: its lines (`\n` separated) fill the box's height
evenly, each line `h / lines` tall with the font size 1/1.3 of that, in the
system's sans-serif font, so resizing the box scales the text. Both lie
under all ink, in list order (pictures, then text boxes). Ids share the
stroke id space and, unlike moved strokes, keep their id when moved or
resized. A note whose picture file is missing still opens, with a warning,
and shows a placeholder card.

## Designed for real-time handwriting recognition

- Every raw sample is kept with its timestamp (`start` + `t`), plus pressure
  and tilt: the input online recognisers expect.
- Strokes have stable random ids, and erasing records `derivedFrom`, so a
  recogniser can invalidate exactly the words that changed.
- The canvas engine publishes a live change feed (`added` / `removed`
  stroke ids, `Canvas.take_changes()` in the web app) and
  `Canvas.stroke_json(id)` returns a stroke in this format, so a recogniser
  can follow writing as it happens instead of rescanning the page.
- Results live in `recognized.json`, separate from ink.

## Markdown sidecar (`Name.bedrock.md`)

Beside a note, a Markdown file with the same name plus `.md` makes the
handwriting searchable in tools that only read Markdown, such as Obsidian.
The Bedrock Obsidian plugin keeps one for each note (its "index note") and
the web app writes them when it exports the library. Both make the same
bytes (`apps/web/src/sidecar.js`), from `recognized.json` and `links.md`:

```markdown
---
bedrock: "School/Physics/Forces.bedrock"
tags: [bedrock]
---
> Handwritten note: [[School/Physics/Forces.bedrock|Forces]]. This index is written by the Bedrock plugin from the handwriting; changes made here are replaced.

## Text

Newton Hooke

## Links

- [[Ideas]]
```

`bedrock` is the note's path from the vault (or export) root. The text is
the recognised items in saved order, separated by spaces, with `[` and `]`
escaped so handwriting never becomes a link; `_Nothing read yet._` when
there is none. `## Links` is present only when the note has links, and is
the list from `links.md`. A sidecar is derived data: it is rewritten from
the note, and losing it loses nothing.

## An exported library

"Export all notes" in the web app writes a ZIP whose layout is a folder an
Obsidian vault can take as it is:

```
School/                       one directory per folder, empty ones too
School/Physics/Forces.bedrock
School/Physics/Forces.bedrock.md
Shopping.bedrock              notes outside any folder at the top
Shopping.bedrock.md
```

A note's folder is not stored in the note: it is where its file is. Names
drop characters file systems refuse (`\ / : * ? " < > |`), leading dots and
trailing dots or spaces; two notes with the same name in one folder get the
start of their id added.

## Robustness

Readers should recover what they can from a damaged file instead of failing:
Bedrock skips strokes it cannot parse, drops incomplete samples, replaces
duplicate ids, ignores a damaged `recognized.json`, falls back to the data in
an SVG if `note.json` is missing, and reports what it repaired. This is
covered by fuzz-style tests in `crates/bedrock-core/src/format.rs`.

## Versioning

`version` is bumped only by a breaking change: removing a field, or changing
what an existing field means. A new optional field that older readers can
ignore (they keep fields they do not know, see above) keeps the version;
pictures, text boxes, word groups, `kinds` and pen tuning were all added this
way within version 1. Either way, a change to this format is agreed with the
project owner first, updates this document and the JSON Schema, and adds a
test that reads files written before the change
(`crates/bedrock-core/tests/old_formats.rs`). Readers keep reading every
earlier version.
