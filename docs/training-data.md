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
Agreeing turns on "Mirror the handwriting of my notes", which then cannot
be turned off in the settings: "Stop saving" on `/train` stops sending at
once, and the app asks again before it can be used.

This is one switch, `LAUNCH_GATE` in `apps/web/src/collect.js`. It only
takes effect once a server address is built in. Consent that is a condition
of using an app is not "freely given" under GDPR article 7(4), so before a
public release the switch should be turned off (sharing is then optional,
as in the table below) or the legal basis reviewed. What is sent and why
is the website's Terms of Service (`/terms`, `apps/web/terms/index.html`);
the launch window and `/train` ask people to agree to it with a link.

## When something is sent

| Where | What | When |
|---|---|---|
| The training pages (`/train`) | The ink written in the box and the prompt it answers: a common word, a whole sentence, a short paragraph (its label keeps the line breaks it was shown with), or a formula. | After agreeing on the consent card on `/train` and entering an invite code. |
| Notes, and PDFs imported as notes | A copy of the handwriting of every note, kept up to date (below). | With "Mirror the handwriting of my notes" on. |

Since consent version 4 (24 November 2026) nothing from a note is sent as
a sample: "Send every word I write in notes" is gone, and so is sending a
word's line when the writer checks or corrects it, and sending the words
of an imported PDF. Notes are kept whole instead, and where paragraphs and
words are and what each word says is marked in review (`bedrock-data
review`, Notes tab). Earlier apps sent `bedrock-training` version 3 lines
from notes; the backend still takes them, and they stay in the data.

## Mirror my notes

"Mirror the handwriting of my notes, to improve recognition" keeps a copy
of the handwriting of every note in the backend, up to date as the writer
adds and erases strokes. While the launch gate is on, agreeing at launch
(or on `/train`) turns it on, and it cannot be turned off in the settings.
Without the gate it is off by default and asks first when ticked. Turning
it on sends every note already in the library in full, whatever version of
the note format it was saved in. After that only changes are sent: strokes
written since, and the ids of strokes erased since (the backend then
deletes their ink). An erase that is undone sends the stroke again.
Deleting a note deletes its copy.

Only ink leaves the device: each stroke's id, start time and raw pen
samples (times raised where an old note has them going backwards), under a
random id for the note made on this device. No title, typed text,
pictures, file name, folder, brush, colour or highlighter strokes. Uploads
wait in IndexedDB `bedrock-mirror` while offline and go up once a minute,
or at once when the app is hidden.

Mirrors need a contributor secret: 64 random hex digits made on the
device (`secret` in `bedrock.collect.v1`) and sent only in the
`X-Contributor-Secret` header, so only this device can change or delete
its mirrors. "Delete my contributions" on `/train` deletes them too, and
the device forgets what it mirrored and turns mirroring off. The logic is
in `apps/web/src/mirror-notes.js`; the formats are in the `note-mirrors`
spec.

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
notes in apps before consent version 4 (version 2 plus `words`: which strokes make each word, each word's
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
use a stored address instead. The address is
`https://bedrock-collect.reelplum.workers.dev`. With an empty `DEFAULT_API`,
`/train` says saving is not available yet and the pages are practice only.

The browser tests never reach the real backend: every page they open sets
`bedrockNoBuiltInApi` (honoured only on this computer), which acts as if no
address were built in, and a test that needs a backend stores the address
of a pretend one.

## Tests

`apps/web/tests/collect.test.mjs` plays the backend in the browser.
`apps/web/tests/e2e-backend.manual.mjs` runs the app against the real
backend on this computer (it needs the private backend repository).
