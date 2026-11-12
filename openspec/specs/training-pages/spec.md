# training-pages Specification

## Purpose
The `/train` pages, where people write prompts to teach the handwriting
reader: the handwriting trainer (words, sentences, paragraphs, maths) and the
scribble trainer. What they send, and when, is `training-data-sharing`.

## Data formats

- Prompts built into the app: `apps/web/train/prompts.js`. The backend can
  replace any list with `GET /v1/prompts`, answered as
  `{ "words": [], "sentences": [], "paragraphs": [] }`; an empty list keeps
  the built-in one.
- The last list fetched is kept in local storage under
  `bedrock.train.prompts` (same JSON), so the page works offline.
- Which prompt kinds are on is kept under `bedrock.train.options`.

## Requirements

### Requirement: The handwriting trainer SHALL show a prompt and turn the ink into a sample

#### Scenario: Write a prompt
- **GIVEN** the handwriting trainer at `/train/handwriting`
- **WHEN** the writer writes in the box and taps Done
- **THEN** Done waits for ink, a sample with the raw samples (six channels) and the prompt as its label is made, a formula is labelled with its LaTeX, no brush, colour or stroke id is kept, and the next prompt is shown
<!-- test-js: apps/web/tests/train.test.mjs :: the /train page links to both trainers -->
<!-- test-js: apps/web/tests/train.test.mjs :: handwriting trainer: shows a prompt, takes ink, Done makes a sample and shows the next prompt -->

#### Scenario: Prompt kinds
- **GIVEN** the four kinds (words, sentences, paragraphs, maths)
- **WHEN** the writer turns them on and off
- **THEN** any mix can be on but never none, all four are on at first, and maths prompts carry LaTeX
<!-- test-js: apps/web/tests/train.test.mjs :: handwriting trainer: any mix of words, sentences, paragraphs and maths, never none; maths prompts carry LaTeX -->

#### Scenario: Paragraphs keep their lines
- **GIVEN** a paragraph prompt
- **WHEN** it is shown on a narrow phone and written
- **THEN** it is shown in lines of at most 32 characters, and the sample's label has a line break where the shown text did
<!-- test-js: apps/web/tests/train.test.mjs :: handwriting trainer: every paragraph fits a narrow phone line for line, so the writer breaks lines where the label does -->
<!-- test-js: apps/web/tests/train.test.mjs :: handwriting trainer: a paragraph sample keeps its line breaks in the label -->

#### Scenario: Prompts from the backend
- **GIVEN** saving is on and the backend has its own lists
- **WHEN** the trainer opens
- **THEN** it asks for them with the invite code, uses each list that is not empty from the next prompt, wraps paragraphs into short lines, and keeps them for offline use
<!-- test-js: apps/web/tests/collect.test.mjs :: the training page uses the words, sentences and paragraphs set on the backend, and keeps them for offline use -->

### Requirement: The scribble trainer SHALL take one scribble over a word

#### Scenario: Scribble out a word
- **GIVEN** the scribble trainer
- **WHEN** the writer scribbles over the word in the box
- **THEN** only the one scribble stroke is taken, labelled as a scribble of that word
<!-- test-js: apps/web/tests/train.test.mjs :: scribble trainer: the word to scribble out is in the box, and only one stroke is taken -->
