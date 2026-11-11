# Sending training samples

Bedrock can send handwriting samples to a private training data backend, so
its handwriting recognition can learn from real writing. Nothing is sent
unless the writer agrees.

## When something is sent

| Where | What | When |
|---|---|---|
| The training pages (`/train`) | The ink written in the box and the prompt it answers. | After agreeing on the consent card on `/train` and entering an invite code. |
| A note | One word: its ink, moved to 0,0, and its checked text. | Only with "Send my corrections to improve recognition" turned on (it is off by default), and only when the writer taps "This is right" or corrects a reading. |

A reading nobody checked is never sent, and never becomes a label. The rest
of a note is never sent.

## What a sample holds

`bedrock-training` version 2: the label and how we know it (`prompt`,
`confirmed` or `corrected`), what the recogniser read (if anything), the
language, a coarse device class (for example `ipad`, never the full user
agent), pen, finger or mouse, and the raw pen samples. No stroke ids, brushes
or colours, no note title, no name or email. The writer is a random id made
on the device.

## How it is sent

`apps/web/src/collect.js`. Samples wait in a queue in IndexedDB and are sent
five at a time. A sample leaves the queue only when the server has stored
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
