// Training pages: show a prompt (a word, a formula, or a word to scribble
// out), take ink in a box drawn by Bedrock's own engine, and on Done turn it
// into a sample with the raw pen data, exactly as notes store it. Samples
// are not saved yet: they are kept for this visit only, and the last one is
// shown so it can be checked.
import init, { Canvas } from '../pkg/bedrock_web.js';
import { InputController } from '../src/input.js';
import { randomSeed } from '../src/storage.js';
import { wordPrompt, mathPrompt, scribblePrompt } from './prompts.js';

const $ = (id) => document.getElementById(id);
const mode = document.body.dataset.mode; // 'handwriting' | 'scribble'
const OPTIONS_KEY = 'bedrock.train.options';

async function main() {
  await init();
  const stage = $('stage');
  let canvas;
  try {
    canvas = new Canvas($('base'), $('overlay'), ...randomSeed());
  } catch (e) {
    $('fatal').textContent = `Training needs WebGL2, which this browser does not provide. (${e})`;
    $('fatal').hidden = false;
    return;
  }
  canvas.set_paper(mode === 'handwriting' ? 'lines' : 'plain');
  canvas.set_finger_drawing(true); // phones and laptops can take part too
  canvas.set_scribble_erase(false); // a scribble here is the sample itself
  canvas.set_tool('draw');
  canvas.set_brush('pen', '#1c1c1e', 2.5);

  const samples = [];
  let prompt = null;
  let shownAt = 0;
  let what = { words: true, maths: true };
  try { what = { ...what, ...JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}') }; } catch (_) { /* private mode */ }

  const input = new InputController(stage, canvas, { onFrame: update, onCommit: update });
  function resize() {
    const r = stage.getBoundingClientRect();
    canvas.resize(r.width, r.height, window.devicePixelRatio || 1);
    input.updateRect();
    input.requestFrame();
  }
  new ResizeObserver(resize).observe(stage);

  // Scribble: one stroke only. A second pen-down is turned away before the
  // engine sees it (Undo or Clear to try again).
  if (mode === 'scribble') {
    stage.addEventListener('pointerdown', (e) => {
      if (canvas.stroke_count() >= 1 && e.isPrimary) {
        e.stopImmediatePropagation();
        e.preventDefault();
        hint('One stroke only: Undo to try again.', true);
      }
    }, { capture: true });
  }

  function hint(text, warn = false) {
    $('hint').textContent = text;
    $('hint').classList.toggle('warn', warn);
  }

  function next() {
    canvas.new_document(...randomSeed());
    canvas.set_paper(mode === 'handwriting' ? 'lines' : 'plain');
    if (mode === 'scribble') {
      prompt = scribblePrompt();
      $('prompt-kind').textContent = 'Scribble it out';
      $('prompt-text').innerHTML = prompt.html;
      $('target').innerHTML = prompt.html;
      hint('Scribble out the word in one stroke, then tap Done.');
    } else {
      const useMaths = what.maths && (!what.words || Math.random() < 0.35);
      prompt = useMaths ? mathPrompt() : wordPrompt();
      $('prompt-kind').textContent = useMaths ? 'Write this formula' : 'Write this';
      $('prompt-text').innerHTML = prompt.html;
      $('target').textContent = '';
      hint('Write what you see, then tap Done.');
    }
    shownAt = Date.now();
    input.requestFrame();
    update();
  }

  function update() {
    const n = canvas.stroke_count();
    $('done').disabled = n === 0;
    $('undo').disabled = n === 0;
    $('clear').disabled = n === 0;
  }

  /** The sample a backend would store (not saved yet). */
  function sample() {
    const note = JSON.parse(canvas.export_json());
    const r = stage.getBoundingClientRect();
    return {
      format: 'bedrock-training',
      version: 1,
      task: mode,
      prompt: { kind: prompt.kind, text: prompt.text, latex: prompt.latex },
      box: { width: Math.round(r.width), height: Math.round(r.height) },
      channels: note.channels,
      strokes: note.strokes,
      shown: shownAt,
      done: Date.now(),
    };
  }

  $('done').addEventListener('click', () => {
    if (!canvas.stroke_count()) return;
    const s = sample();
    samples.push(s);
    $('count').textContent = `${samples.length} done`;
    $('last').hidden = false;
    $('last-json').textContent = JSON.stringify(s, null, 1).slice(0, 4000);
    next();
  });
  $('skip').addEventListener('click', next);
  $('undo').addEventListener('click', () => { canvas.undo(); hint(mode === 'scribble' ? 'Scribble out the word in one stroke, then tap Done.' : 'Write what you see, then tap Done.'); input.requestFrame(); update(); });
  $('clear').addEventListener('click', () => { canvas.new_document(...randomSeed()); canvas.set_paper(mode === 'handwriting' ? 'lines' : 'plain'); input.requestFrame(); update(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('done').disabled) $('done').click();
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('undo').click(); }
  });

  // Handwriting: words, maths, or both.
  if (mode === 'handwriting') {
    const opts = $('options');
    for (const [key, label] of [['words', 'Words'], ['maths', 'Maths']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(what[key]));
      b.addEventListener('click', () => {
        const nextWhat = { ...what, [key]: !what[key] };
        if (!nextWhat.words && !nextWhat.maths) return; // keep one on
        what = nextWhat;
        b.setAttribute('aria-pressed', String(what[key]));
        try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(what)); } catch (_) { /* private mode */ }
        if (!canvas.stroke_count()) next();
      });
      opts.append(b);
    }
  }

  resize();
  next();
  window.trainer = { canvas, input, samples, get prompt() { return prompt; }, next, ready: true };
}

main().catch((e) => {
  $('fatal').textContent = `Could not start: ${e && e.message ? e.message : e}`;
  $('fatal').hidden = false;
});
