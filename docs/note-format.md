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
| `README.txt` | A short human explanation of the above. |

Readers must ignore entries they do not know, so later versions can add
files (for example `assets/` for images and PDFs).

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
A `kinds` entry says some strokes are `text` or `math` (LaTeX), overriding the
guess: a word follows it when any of its strokes is listed, so writing more
onto a formula keeps it maths. Moving strokes gives them new ids; both lists,
`links` and `recognition` follow the new ids.

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

## Robustness

Readers should recover what they can from a damaged file instead of failing:
Bedrock skips strokes it cannot parse, drops incomplete samples, replaces
duplicate ids, ignores a damaged `recognized.json`, falls back to the data in
an SVG if `note.json` is missing, and reports what it repaired. This is
covered by fuzz-style tests in `crates/bedrock-core/src/format.rs`.

## Versioning

Any change to this format bumps `version`, updates this document and the
JSON Schema, and adds a migration test that reads files of every earlier
version.
