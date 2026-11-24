# Import many PDFs at once from the Obsidian plugin's settings

## Why

Frederik (2026-11-24): "For the plugin I want in the settings a place where I
can just drag PDFs into and then it creates bedrock files automatically for
me a inserts them into Obsidian at the root where I can then drag them to
where I want the files. I want to be able to just drag my whole Goodnotes
library converted into PDFS into here :)"

Today a PDF can only be imported into a note that is already open, one PDF at
a time. A GoodNotes library exported as PDFs is hundreds of files.

## What changes

- **A drop zone in the settings.** "Import PDFs" in Bedrock's settings has a
  box to drop PDFs (and folders of PDFs) on, and a "Choose PDFs…" button for
  where dragging is awkward (the iPad's Files app). Each PDF becomes a
  `.bedrock` note at the vault's root, named after the PDF, made exactly as
  importing into an open note makes it (`import_pdf_as_one_note`: every page
  with ink or pictures, one below another, with the PDF's hidden reading of
  the handwriting).
- **Hundreds of files.** The PDFs are read one at a time (only the one being
  imported is in memory), converted in a worker so Obsidian never freezes,
  and the settings show "12 of 340" with a bar and a Stop button. The import
  keeps going when the settings are closed, and a notice says when it is
  done. A reader that hangs on one PDF (2 minutes) or crashes is stopped and
  started afresh for the next.
- **Names and failures per file.** A name already taken at the root (in any
  letter case, as macOS and iPadOS file names ignore case) gets " 1", " 2"…
  as new notes do; nothing is overwritten. A file that is not a PDF, is
  locked, damaged, has no handwriting or pictures, or cannot be written is
  listed with its reason, and the others are still imported.
- Each new note gets its index note (when "Make handwriting searchable" is
  on), so search finds the handwriting at once.
- Words of bulk-imported notes are **not** sent for training: that needs the
  canvas's consent check and review, and the settings are not the canvas.

## Data format

No data format changes. The notes are written by the existing writer
(`bedrock_core::format::to_bedrock` through `import_pdf_as_one_note`), the
index notes by the existing indexer, and nothing new goes into the plugin's
`data.json` (the import's progress lives in memory only).

## Open source used

No new library. Looked at:

- **Drop zones:** Dropzone.js (MIT), FilePond (MIT) and Uppy (MIT). All three
  are built around uploading to a server, bring their own styles and widgets,
  and would add 30 to 150 kB to a plugin whose settings use Obsidian's own
  look. What is needed here is the browser's own drag and drop
  (`DataTransfer` and, for dropped folders, `webkitGetAsEntry`, supported by
  Obsidian's Electron and by iPadOS's WebKit), about 60 lines.
- **Queues:** p-queue (MIT, widely used). With one file at a time the queue is
  a loop; p-queue would not give the timeout-and-restart of a worker that the
  reader needs, which is the part that takes care.
- **PDF reading:** the existing `bedrock-pdf` WebAssembly (`hayro-syntax`,
  recorded in `import-pdf`), the same as importing into an open note.
