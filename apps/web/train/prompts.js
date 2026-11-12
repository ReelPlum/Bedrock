// Prompts for the training pages: everyday words in a few shapes (lower
// case, capitalised, short phrases, numbers) and short maths formulas, each
// with its LaTeX (the label a recogniser should produce) and a display form.

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

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const int = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** A word or short phrase: `{ kind: 'text', text, html }`. */
export function wordPrompt() {
  const r = Math.random();
  let text;
  if (r < 0.55) text = pick(WORDS);
  else if (r < 0.7) { const w = pick(WORDS); text = w[0].toUpperCase() + w.slice(1); }
  else if (r < 0.8) text = pick(NAMES);
  else if (r < 0.92) text = `${pick(WORDS)} ${pick(WORDS)}`;
  else text = pick([String(int(2, 999)), `${int(1, 28)}/${int(1, 12)}`, `${int(1, 99)}%`, `${pick(WORDS)}?`, `${pick(WORDS)}!`]);
  return { kind: 'text', text, latex: null, html: esc(text) };
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

/** A short formula: `{ kind: 'math', text (LaTeX), latex, html }`. */
export function mathPrompt() {
  const [latex, html] = pick(FORMULAS)();
  return { kind: 'math', text: latex, latex, html };
}

/** A word to scribble out (shown in the box). */
export function scribblePrompt() {
  const w = Math.random() < 0.8 ? pick(WORDS) : `${pick(WORDS)} ${pick(WORDS)}`;
  return { kind: 'scribble', text: w, latex: null, html: esc(w) };
}
