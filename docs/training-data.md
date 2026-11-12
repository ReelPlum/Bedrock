# Sending training samples

Bedrock can send handwriting samples to a private training data backend, so
its handwriting recognition can learn from real writing. Nothing is sent
unless the writer agrees.

## When something is sent

| Where | What | When |
|---|---|---|
| The training pages (`/train`) | The ink written in the box and the prompt it answers: a common word, a whole sentence, a short paragraph (its label keeps the line breaks it was shown with), or a formula. | After agreeing on the consent card on `/train` and entering an invite code. |
| A note | Every handwritten word written after the setting was turned on, one sample per word: its ink, moved to 0,0, and what the recogniser read, marked `unchecked`. | Only with "Send every word I write in notes, to improve recognition" turned on (it is off by default, and needs the consent on `/train`). A word is sent once its reading has not changed for 20 seconds, or at once when the app is hidden or another note is opened. With recognition off, words are sent without text. |
| A note | A word again, with its checked text. | When the writer taps "This is right" (`confirmed`), corrects a reading (`corrected`), or chooses "Not a word" (kind `drawing`, no text). This also covers words written before the setting was on. |

A checked sample names the earlier sample of the same ink in `supersedes`,
and the backend keeps only the newest. A checked word is never replaced by
an unchecked reading. An unchecked reading is never trained on until the
writer or a reviewer checks it (`bedrock-data review` in the backend). The
rest of a note (typed text, pictures, the title, where words are on the
page) is never sent.

The logic is in `apps/web/src/share-words.js`. It remembers which sample it
sent for each word (in local storage, the newest 5000), so a word is sent
once per change.

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

`bedrock-training` version 2: the label and how we know it (`prompt`,
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

## Setting the server address

`DEFAULT_API` in `apps/web/src/collect.js` is empty until the backend is
deployed. Until then the address can be typed under "Server address" on
`/train`.

## Tests

`apps/web/tests/collect.test.mjs` plays the backend in the browser.
`apps/web/tests/e2e-backend.manual.mjs` runs the app against the real
backend on this computer (it needs the private backend repository).
