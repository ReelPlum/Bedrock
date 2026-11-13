# Sending training samples

Bedrock can send handwriting samples to a private training data backend, so
its handwriting recognition can learn from real writing. Nothing is sent
unless the writer agrees.

## Asked at launch, while Bedrock is invite-only

While Bedrock is a small invite-only test, sharing handwriting is part of
using it. When the web app starts, and when Obsidian starts with the
plugin, a window asks for the invite code and consent before anything
else, and cannot be closed without agreeing. The code is checked with the
server first; with no connection it is kept and checked when samples are
next sent, and a code the server turns down brings the window back.
Agreeing turns on "Send every word I write in notes", which then cannot be
turned off in the settings: "Stop saving" on `/train` stops sending at
once, and the app asks again before it can be used.

This is one switch, `LAUNCH_GATE` in `apps/web/src/collect.js`. It only
takes effect once a server address is built in. Consent that is a condition
of using an app is not "freely given" under GDPR article 7(4), so before a
public release the switch should be turned off (sharing is then optional,
as in the table below) or the legal basis reviewed. What is sent and why
is the website's Terms of service (`/terms`, `apps/web/terms/index.html`);
the launch window and `/train` ask people to agree to it with a link.

## When something is sent

| Where | What | When |
|---|---|---|
| The training pages (`/train`) | The ink written in the box and the prompt it answers: a common word, a whole sentence, a short paragraph (its label keeps the line breaks it was shown with), or a formula. | After agreeing on the consent card on `/train` and entering an invite code. |
| A note | Every handwritten word written after the setting was turned on, one sample per line of handwriting: the line's ink, moved to 0,0, where the app cut it into words, and what the recogniser read for each word, marked `unchecked`. | Only with "Send every word I write in notes, to improve recognition" turned on (it is off by default, and needs the consent on `/train`). A line is sent once its readings have not changed for 20 seconds, or at once when the app is hidden or another note is opened. With recognition off, words are sent without text. |
| An imported PDF | Every handwritten word of every page, one sample per line, marked `unchecked`, with the reading the PDF itself holds (GoodNotes hides its own handwriting recognition in the page) as each word's `model_reading` and `model_engine: "pdf-text"`, or no text where it has none. | When a PDF is imported (Open or "Import PDF" in the menu) with saving set up on `/train`, even with "Send every word" off: importing is the writer's own act, as checking a word is. |
| A note | The word's line again, with the word's checked text. | When the writer taps "This is right" (`confirmed`), corrects a reading (`corrected`), or chooses "Not a word" (kind `drawing`, no text). This also covers words written before the setting was on. |

Whenever a line changes (a new reading, a word checked, words added or
regrouped), it is sent again, naming in `supersedes` every earlier sample
that holds any of the same strokes, and the backend keeps only the newest.
Sending whole lines keeps the line in one piece, so a wrong word split can
be fixed in review, and the reader can learn where words end. A checked
word is never replaced by an unchecked reading. An unchecked reading is never trained on until the
writer or a reviewer checks it (`bedrock-data review` in the backend). The
rest of a note (typed text, pictures, the title, where words are on the
page) is never sent.

The logic is in `apps/web/src/share-words.js`. It remembers which sample it
sent for each line, with its strokes and words (local storage
`bedrock.sharedLines.v1`, the newest 3000), so a line is sent once per
change. Earlier versions sent one sample per word and remembered them in
`bedrock.sharedWords.v1`; those words are replaced by their lines the next
time their note is open. A line longer than the backend takes in one sample
(800 strokes or 50,000 points) is sent in pieces of whole words.

The backend must accept version 3 before an app that sends it goes live: an
older backend refuses it, and the app drops samples the server refuses.

## What the training pages ask for

The words, sentences and paragraphs are built into `apps/web/train/prompts.js`.
They can also be set on the backend (`bedrock-data prompts` there). With
saving on, the handwriting page asks the backend for them with the invite
code when it opens (`GET /v1/prompts`) and keeps the answer in local storage
(`bedrock.train.prompts`), so they also work offline. Each list the backend
sends that is not empty replaces the built-in one, from the next prompt; an
empty list, no backend, or practice without saving keeps the built-in one.
Words that are all lower case still get their variations (capitalised, in
short phrases); the others are shown as they are. Paragraphs are shown in
lines of 32 characters, as before.

## What a sample holds

`bedrock-training` version 2 from the training pages, version 3 from
notes (version 2 plus `words`: which strokes make each word, each word's
text and how we know it): the label and how we know it (`prompt`,
`unchecked`, `confirmed` or `corrected`), what the recogniser read (if anything), the
language, a coarse device class (for example `ipad`, never the full user
agent), pen, finger or mouse, and the raw pen samples. No stroke ids, brushes
or colours, no note title, no name or email. The writer is a random id made
on the device.

## How it is sent

`apps/web/src/collect.js`. Samples wait in a queue in IndexedDB and are sent
once a minute, five per request (several requests back to back if more are
waiting), and at once when the page is hidden or closed, when another note
is opened, and when a page opens. Five per request keeps each request well
inside the free plan's CPU limit; it can go up to the backend's 20 once
that is measured on real Cloudflare. A sample leaves the queue only when the server has stored
it or has refused it for good, so writing offline works and a lost
connection loses nothing. The server address must be `https`.

"Delete my contributions" on `/train` removes everything the writer sent
and everything still waiting. "Stop saving" withdraws consent on the device.

The consent text has a version (`CONSENT_VERSION` in `collect.js`). It was
2 when imported PDFs were added to what is sent, and is 3 since every word
written in notes is sent and agreeing is asked at launch; consent given to
an older text is asked for again, with the code filled in and the same
contributor id.

## The server address

The address is built into the app (`DEFAULT_API` in
`apps/web/src/collect.js`) and people cannot change it: `/train` has no
field for it, and a stored address is ignored. Only a page served from this
computer (`localhost` or `127.0.0.1`, for development and the tests) may
use a stored address instead. `DEFAULT_API` is empty until the backend is
deployed, and until then `/train` says saving is not available yet and the
pages are practice only.

## Tests

`apps/web/tests/collect.test.mjs` plays the backend in the browser.
`apps/web/tests/e2e-backend.manual.mjs` runs the app against the real
backend on this computer (it needs the private backend repository).
