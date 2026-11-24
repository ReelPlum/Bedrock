# training-data-sharing

## ADDED Requirements

### Requirement: A note SHALL be sent one line at a time, with where it was cut into words

A sample from a note is `bedrock-training` version 3: version 2 plus
`words`, `[{ "strokes": [index], "kind": "text|math|drawing", "label",
"label_source": "unchecked|confirmed|corrected", "model_reading"? }]`, each
word naming its strokes by their place in the line's `strokes` (writing
order). The line's `kind` is `text`, its `label` the non-empty word texts
joined by single spaces, its `label_source` `unchecked` if any word is,
else `corrected` if any is, else `confirmed`. A line longer than 800
strokes or 50,000 points is sent in pieces of whole words. Samples from the
training pages stay version 2.

On the device, `bedrock.sharedLines.v1` remembers each line sent (the
newest 3000).

#### Scenario: Words on one line
- **GIVEN** "Send every word" on and two words written on one line, with readings
- **WHEN** they are sent
- **THEN** one sample holds both, cut into its two words, moved to 0,0
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: two words written on one line are sent as one line, cut into its words -->
<!-- test-js: apps/web/tests/share-words.test.mjs :: a line is sent whole, with where it was cut into words -->
<!-- test-js: apps/web/tests/share-words.test.mjs :: a line of only a drawing has no text -->
<!-- test: each_word_says_which_line_it_is_on -->

#### Scenario: Long lines
- **GIVEN** a line of more than 800 strokes
- **WHEN** it is sent
- **THEN** it goes in pieces of whole words, each within the limits
<!-- test-js: apps/web/tests/share-words.test.mjs :: a line too long for one sample is sent in pieces of whole words -->

### Requirement: A changed line SHALL replace every earlier sample of its strokes

When a line's words, readings or checks change, it is sent again, and
`supersedes` names every earlier sample of the same note that holds any of
its strokes, and any word of it sent alone by an earlier version. A word
that was sent checked is never sent unchecked again.

#### Scenario: Regrouped and growing lines
- **GIVEN** a line that was sent
- **WHEN** its words are regrouped, or a word is added to it
- **THEN** it is sent again replacing the earlier sample, and only the newest is remembered
<!-- test-js: apps/web/tests/share-words.test.mjs :: a line is sent again when its words are regrouped, replacing the earlier sample -->

#### Scenario: Checks and settling
- **GIVEN** a line with unchecked readings
- **WHEN** the readings are new, and then the writer checks a word
- **THEN** the line waits until the readings settle, but is sent at once when a word is checked, and a checked word keeps its check
<!-- test-js: apps/web/tests/share-words.test.mjs :: checking a word sends its line at once; an unchecked reading waits until it settles -->
<!-- test-js: apps/web/tests/share-words.test.mjs :: a checked word is never sent unchecked again -->
<!-- test-js: apps/web/tests/share-words.test.mjs :: a line waits for words not read yet, unless the app is being hidden -->
<!-- test-js: apps/web/tests/share-words.test.mjs :: words written before the setting was on stay out of the line -->

#### Scenario: Words sent alone by an earlier version
- **GIVEN** `bedrock.sharedWords.v1` as earlier versions wrote it (frozen fixture `crates/bedrock-core/tests/fixtures/old-formats/shared-words-v1.json`)
- **WHEN** the line holding those words is sent
- **THEN** it supersedes them, a word checked before keeps its text, their records are removed and the others kept
<!-- test-js: apps/web/tests/share-words.test.mjs :: words sent alone by an earlier version are replaced by their line -->

## MODIFIED Requirements

### Requirement: Words from notes SHALL be sent only with the setting on, and checked words SHALL replace unchecked ones

#### Scenario: Checked words
- **GIVEN** the setting on
- **WHEN** the writer confirms or corrects a word
- **THEN** the line holding it is sent moved to 0,0, the word labelled with the confirmed or corrected text and the reading alongside
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: with the setting on, a confirmed word is sent as its line, moved to 0,0 -->
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: a correction is sent with the writer's text as the label and the reading alongside -->

#### Scenario: Unchecked words
- **GIVEN** "Send every word" on
- **WHEN** a new word is read
- **THEN** its line is sent once its reading settles (or at once when the app is hidden) as `unchecked`, then replaced through `supersedes` when the writer checks it; words from before the setting are not sent by themselves; with the recogniser off they are sent without text
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: with "Send every word" on, a new word is sent unchecked, then replaced when the writer checks it -->
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: an unchecked reading waits until it settles, and is sent at once when the app is hidden -->
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: words written before the setting was on are not sent by themselves -->
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: with the recogniser off, words are sent without text -->
