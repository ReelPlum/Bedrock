# Design

## Which words go into a line sample

`WordSharer.scan` groups the words of `words_json` by `line`. A word is
left out when it was written before the setting was turned on (unless the
writer checks it now, or the note was imported). A line waits while any of
its words is not read yet, unless the scan is forced (the app is hidden or
the note closed): then it is sent with the words read so far.

A line is due when the writer has just checked a word in it, or when its
words and readings have not changed for `SETTLE_MS` (20 s), or at once when
forced. Its signature is the sorted list of each word's strokes, kind,
label source and text; a line whose signature matches the one sample sent
for those strokes is not sent again.

A line longer than the backend takes in one sample (800 strokes or 50,000
points) is sent in pieces of whole words.

## Replacing what was sent

`bedrock.sharedLines.v1` holds, per sent sample id, the note, the stroke
ids it held, its signature, and each word's strokes, kind, text and label
source (the newest 3000 lines). A new line sample supersedes every
remembered sample of the same note that shares a stroke with it, and those
are forgotten. Words sent alone by earlier versions (`bedrock.sharedWords.v1`,
keyed by note and word id) are superseded when a line holds the same word,
and their record is removed. At most 50 ids go in `supersedes`.

A word that was sent checked is never sent unchecked again: if the
recogniser later reads the same strokes again, the line keeps the checked
text and label source.

## The sample

`collect.fromLine` puts the words' strokes in writing order (by start
time), numbers them, and gives each word the indices of its strokes. Each
word's text is NFC and on one line; a drawing has none. The line's label
is the non-empty word texts joined by single spaces, its label source
`unchecked` if any word is, else `corrected` if any is, else `confirmed`,
and `model_engine` the first word's engine. The ink is moved to 0,0, as
for a single word.

## Open source used

None. Grouping the app's own words into lines and the backend's sample
format are Bedrock's own; no library does either.
