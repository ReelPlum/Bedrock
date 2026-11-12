// Prompts for the training pages: common everyday words (lower case,
// capitalised, short phrases, numbers), whole sentences, short paragraphs
// written line by line, and short maths formulas, each with its LaTeX (the
// label a recogniser should produce) and a display form.

const WORDS = `the and you that was for are with his they this have from one had word
but not what all were when your can said there use each which she how their
will other about out many then them these some her would make like him into
time has look two more write see number way could people than first water been
call who its now find long down day did get come made may part over new sound
take only little work know place year live back give most very after thing our
just name good sentence man think say great where help through much before line
right too mean old any same tell boy follow came want show also around form three
small set put end does another well large must big even such because turn here
why ask went men read need land different home move try kind hand picture again
change off play spell air away animal house point page letter mother answer found
study still learn should world high every near add food between own below country
plant last school father keep tree never start city earth eye light thought head
under story saw left few while along might close something seem next hard open
example begin life always those both paper together got group often run important
until children side feet car mile night walk white sea began grow took river four
carry state once book hear stop without second later miss idea enough eat face
watch far really almost let above girl sometimes mountain cut young talk soon list
song being leave family quick brown jumps lazy dog notes pencil draw erase`.split(/\s+/).filter(Boolean);

const NAMES = ['Monday', 'Friday', 'London', 'Paris', 'Copenhagen', 'Anna', 'Oliver', 'Bedrock', 'iPad', 'Apple'];

// Whole sentences, mostly of common words, short enough for one line.
// Written as people write notes: capitals, commas, numbers, a question.
export const SENTENCES = `The cat sat on the mat.
I will call you after school.
We need more milk and bread.
Can you help me with this?
The meeting starts at 9:30.
It was a long day at work.
She found her keys under the bed.
Please read page 42 before Monday.
They walked home along the river.
My brother lives near the sea.
Remember to water the plants.
What time does the train leave?
The answer is in the first chapter.
He made a list of things to buy.
We had soup and bread for dinner.
The children played in the park.
Write down your ideas first.
This is the best book I have read.
Turn left at the old church.
The weather will be cold tomorrow.
I think we should start again.
Let me know if anything changes.
Our house is the white one.
The dog ran after the ball.
Bring a pencil and some paper.
It takes 20 minutes by bike.
Every morning she drinks tea.
Do not forget the meeting today.
The light in the kitchen is on.
Thank you for the lovely gift!
We moved here three years ago.
How many people are coming?
The shop closes at 6 on Sundays.
Ask the teacher for more time.
His idea was simple but good.
Put the books back on the shelf.
I could not find the right word.
There are four eggs left.
She laughed at the funny story.
The first test is next week.
Call Anna about the party.
My phone number has changed.
Look at the map before we go.
The water is too hot to drink.
We saw a big ship in the harbour.
Write your name at the top.
Each group should pick a leader.
The plan worked better than we thought.
I am not sure what you mean.
Open the window, it is warm.
He always forgets his umbrella.
The song was on the radio again.
Meet me outside the station.
Do you want coffee or tea?
The project is due on Friday.
Our team won the last game.
Keep the receipt just in case.
The road was closed for repairs.
She wrote a letter to her mother.
Check the numbers twice.
The garden needs some work.
We will talk about it later.
Bread, cheese, apples and jam.
Why is the sky blue?
Add a short note at the end.
The new office is very quiet.
Most of the work is already done.
He grew up in a small town.
Try to sleep before midnight.
The quick brown fox jumps over the lazy dog.
Pack light for the weekend trip.
Your order will arrive on Tuesday.
The price went up by 10%.
I hope you feel better soon.
Fold the paper in half.
The city looks different at night.
Leave the door open for the cat.
Two of the lamps are broken.
She asked a very good question.
Turn off the oven at 7 pm.
They sold the old car last year.
Draw a line under the title.
Nobody knew the answer.
Start with the easy questions.
The bus was late again today.
Read it out loud to the class.
We should plant a tree here.
Her voice was calm and clear.
Finish the report by Thursday.
I left my bag at home.`.split('\n');

// Short paragraphs, written line by line. Each is wrapped into lines of
// about LINE_CHARS characters when shown; the label keeps those line breaks.
export const PARAGRAPHS = [
  'Today we started the new project. Everyone had a different idea, so we made a list and voted. We begin with the simplest one.',
  'Remember to buy milk, eggs and bread on the way home. The shop closes at six, so do not leave it too late.',
  'The river was high after the rain. We walked along the path until it ended, then turned back and had tea in the old mill.',
  'Notes for Monday: call the bank, send the report to Oliver, and book a table for four at seven.',
  'My grandmother kept a small garden behind her house. Every summer it was full of beans, peas and tall yellow flowers.',
  'The train was twenty minutes late. I used the time to read the first chapter of the book Anna gave me.',
  'We need to decide on a date for the meeting. Thursday works for most people, but two of us are away that week.',
  'Water the plants twice a week. The big one by the window likes more light, so turn it now and then.',
  'Last night the power went out for an hour. We lit candles, played cards and nobody missed the screens at all.',
  'The answer to question three is wrong. Check the second line again: the sign changes when you move it across.',
  'Paris was cold and grey, but the museums were warm. We saw more paintings in one day than in a whole year.',
  'Ideas for the weekend: a walk in the forest, a long breakfast, and finally fixing the bike that has a flat tyre.',
  'Thank you for the lovely dinner. The soup was perfect, and I still think about that chocolate cake.',
  'The children built a tower of boxes in the hall. It was taller than their father before it fell over.',
  'Start each answer with a short sentence. Then give one example, and end by saying why it matters.',
  'Our team has three goals this year: fewer meetings, clearer notes, and more time for real work.',
  'The first snow came early. By morning the whole street was white, and the cars moved very slowly.',
  'Please bring your own cup to the office. We are trying to use less paper and plastic this month.',
  'I tried to write every day this week. Some days it was only a few lines, but it still felt good.',
  'The map shows two roads to the lake. The short one is steep, so we will take the long way round.',
  'Copenhagen has more bikes than cars. On a sunny day the bike lanes are busier than the roads.',
  'Read the text once quickly, then again slowly. Mark the words you do not know and look them up later.',
  'The old clock in the hall stopped at ten past four. Nobody has wound it since my uncle moved away.',
  'Lunch is at noon in the small room. There will be sandwiches, fruit and coffee for everyone.',
  'She opened the letter, read it twice, and smiled. It was the answer she had waited for all spring.',
];

/** Wraps `text` into lines of at most `width` characters, on spaces. */
export function wrap(text, width = LINE_CHARS) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}
export const LINE_CHARS = 32;

// The lists in use: the built-in ones above, or those set from the backend
// (`setLists`). Each list the backend sends that is not empty replaces the
// built-in one; an empty one keeps it.
let words = WORDS;
let names = NAMES;
let sentences = SENTENCES;
let paragraphs = PARAGRAPHS;

const tidyList = (a) => (Array.isArray(a) ? a : [])
  .filter((x) => typeof x === 'string')
  .map((x) => x.trim().replace(/\s+/g, ' '))
  .filter(Boolean);

/** Uses `{ words, sentences, paragraphs }` from the backend. Words that are
 *  all lower case get the usual variations (capitalised, phrases); the
 *  others (names) are shown as they are. Anything missing or empty falls
 *  back to the built-in list. */
export function setLists(p) {
  const w = tidyList(p?.words);
  if (w.length) {
    const lower = w.filter((x) => x === x.toLowerCase());
    const other = w.filter((x) => x !== x.toLowerCase());
    words = lower.length ? lower : w;
    names = other.length ? other : words;
  } else {
    words = WORDS;
    names = NAMES;
  }
  const s = tidyList(p?.sentences);
  sentences = s.length ? s : SENTENCES;
  const para = tidyList(p?.paragraphs);
  paragraphs = para.length ? para : PARAGRAPHS;
}

/** The lists in use now, and whether each came from the backend. */
export function lists() {
  return {
    words, names, sentences, paragraphs,
    fromBackend: { words: words !== WORDS, sentences: sentences !== SENTENCES, paragraphs: paragraphs !== PARAGRAPHS },
  };
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const int = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** A word or short phrase: `{ kind: 'text', text, html }`. */
export function wordPrompt() {
  const r = Math.random();
  let text;
  if (r < 0.55) text = pick(words);
  else if (r < 0.7) { const w = pick(words); text = w[0].toUpperCase() + w.slice(1); }
  else if (r < 0.8) text = pick(names);
  else if (r < 0.92) text = `${pick(words)} ${pick(words)}`;
  else text = pick([String(int(2, 999)), `${int(1, 28)}/${int(1, 12)}`, `${int(1, 99)}%`, `${pick(words)}?`, `${pick(words)}!`]);
  return { kind: 'text', shape: 'word', text, latex: null, html: esc(text) };
}

const VARS = ['x', 'y', 'a', 'n', 't'];
const sup = (b, e) => `${b}<sup>${e}</sup>`;
const frac = (a, b) => `<span class="frac"><span>${a}</span><span>${b}</span></span>`;

// Each returns [latex, html].
const FORMULAS = [
  () => { const v = pick(VARS), a = int(2, 9), b = int(1, 20), c = int(1, 50); return [`${a}${v} + ${b} = ${c}`, `${a}<i>${v}</i> + ${b} = ${c}`]; },
  () => { const b = int(1, 9), c = int(1, 20); return [`x^2 + ${b}x - ${c} = 0`, `${sup('<i>x</i>', 2)} + ${b}<i>x</i> − ${c} = 0`]; },
  () => { const [a, b, c, d] = [int(1, 9), int(2, 9), int(1, 9), int(2, 9)]; return [`\\frac{${a}}{${b}} + \\frac{${c}}{${d}}`, `${frac(a, b)} + ${frac(c, d)}`]; },
  () => { const n = int(2, 5); return [`\\sqrt{x^${n} + 1}`, `√<span class="sqrt">${sup('<i>x</i>', n)} + 1</span>`]; },
  () => { const k = int(1, 4), n = int(1, 9); return [`\\int_0^{${n}} x^${k} \\, dx`, `∫<sub>0</sub><sup>${n}</sup> ${sup('<i>x</i>', k)} d<i>x</i>`]; },
  () => { const n = pick(['n', '10', '100']); return [`\\sum_{i=1}^{${n}} i`, `∑<sub><i>i</i>=1</sub><sup>${n}</sup> <i>i</i>`]; },
  () => { const n = int(2, 6); return [`\\frac{d}{dx} x^${n} = ${n}x^${n - 1}`, `${frac('d', 'd<i>x</i>')} ${sup('<i>x</i>', n)} = ${n}${n - 1 === 1 ? '<i>x</i>' : sup('<i>x</i>', n - 1)}`]; },
  () => ['\\sin^2\\theta + \\cos^2\\theta = 1', 'sin<sup>2</sup><i>θ</i> + cos<sup>2</sup><i>θ</i> = 1'],
  () => ['E = mc^2', `<i>E</i> = <i>m</i>${sup('<i>c</i>', 2)}`],
  () => ['a^2 + b^2 = c^2', `${sup('<i>a</i>', 2)} + ${sup('<i>b</i>', 2)} = ${sup('<i>c</i>', 2)}`],
  () => { const a = int(2, 9); return [`f(x) = ${a}x - 1`, `<i>f</i>(<i>x</i>) = ${a}<i>x</i> − 1`]; },
  () => ['\\alpha + \\beta = \\gamma', '<i>α</i> + <i>β</i> = <i>γ</i>'],
  () => ['\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1', `lim<sub><i>x</i>→0</sub> ${frac('sin <i>x</i>', '<i>x</i>')} = 1`],
  () => { const a = int(2, 12), b = int(2, 12); return [`${a} \\times ${b} = ${a * b}`, `${a} × ${b} = ${a * b}`]; },
  () => ['x_1 + x_2', `<i>x</i><sub>1</sub> + <i>x</i><sub>2</sub>`],
  () => ['(a + b)^2', `(<i>a</i> + <i>b</i>)<sup>2</sup>`],
];

/** A whole sentence, written on one line. */
export function sentencePrompt() {
  const text = pick(sentences);
  return { kind: 'text', shape: 'sentence', text, latex: null, html: esc(text) };
}

/** A short paragraph, shown in lines that are written as shown. The label
 *  keeps the line breaks, so training can learn it line by line. */
export function paragraphPrompt() {
  const lines = wrap(pick(paragraphs));
  return { kind: 'text', shape: 'paragraph', text: lines.join('\n'), latex: null, html: lines.map((l) => `<span class="line">${esc(l)}</span>`).join('') };
}

/** A short formula: `{ kind: 'math', text (LaTeX), latex, html }`. */
export function mathPrompt() {
  const [latex, html] = pick(FORMULAS)();
  return { kind: 'math', text: latex, latex, html };
}

/** A word to scribble out (shown in the box). */
export function scribblePrompt() {
  const w = Math.random() < 0.8 ? pick(words) : `${pick(words)} ${pick(words)}`;
  return { kind: 'scribble', text: w, latex: null, html: esc(w) };
}
