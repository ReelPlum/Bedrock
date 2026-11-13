import init, { Canvas, ZipBuilder, peek_title, import_pdf } from '../pkg/bedrock_web.js';
import { InputController } from './input.js';
import { Minimap } from './minimap.js';
import { Handwriting } from './handwriting.js';
import { RecognizerView } from './recognizer-view.js';
import { WordMenu } from './word-menu.js';
import { SelectionView } from './selection-view.js';
import { PictureLoader, preparePicture, measureText, tidyText, TEXT_SIZE_CSS } from './images.js';
import { NoteStore, randomSeed, newNoteId } from './storage.js';
import { saveFile, pickFile, safeFileName } from './files.js';
import { cleanName, folderContents, folderNameProblem, folderTrail, libraryFiles } from './library.js';
import { host } from './host.js';
import * as collect from './collect.js';
import { WordSharer } from './share-words.js';

const $ = (id) => document.getElementById(id);

const PALETTES = {
  ink: ['#1c1c1e', '#2f6bff', '#e53935', '#2e7d32', '#8e24aa'],
  highlighter: ['#ffe14d', '#9be37a', '#ff8fc8', '#7cc6ff', '#ffb35c'],
};
const DEFAULT_BRUSHES = {
  pen: { color: '#1c1c1e', size: 2.5, presets: [1.5, 2.5, 5], preset: 1 },
  pencil: { color: '#1c1c1e', size: 2, presets: [1, 2, 4], preset: 1 },
  fountain: { color: '#1c1c1e', size: 3, presets: [2, 3, 6], preset: 1 },
  marker: { color: '#2f6bff', size: 6, presets: [3, 6, 12], preset: 1 },
  highlighter: { color: '#ffe14d', size: 6, presets: [4, 6, 10], preset: 1 },
};
const DOCKS = ['bottom', 'top', 'left', 'right'];
const SETTINGS_KEY = 'bedrock.settings.v1';
const AUTOSAVE_MS = 400; // research target: every stroke saved locally within a second

// Pen feel: what each brush does when its tuning is left at "usual"
// (mirrors brush.rs). Values 0..100.
const TUNE_KEYS = ['taper_start', 'taper_end', 'taper_fade', 'pressure', 'speed'];
const TUNE_DEFAULTS = {
  pen: { taper_start: 50, taper_end: 50, taper_fade: 0, pressure: 100, speed: 50 },
  pencil: { taper_start: 50, taper_end: 50, taper_fade: 0, pressure: 100, speed: 25 },
  fountain: { taper_start: 50, taper_end: 50, taper_fade: 0, pressure: 100, speed: 38 },
  marker: { taper_start: 0, taper_end: 0, taper_fade: 0, pressure: 100, speed: 0 },
  highlighter: { taper_start: 0, taper_end: 0, taper_fade: 0, pressure: 100, speed: 0 },
};
const MAX_CURVE_POINTS = 6;

function validCurve(c) {
  if (!Array.isArray(c)) return null;
  const pts = c.filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
    .map(([x, y]) => [Math.min(0.98, Math.max(0.02, x)), Math.min(1, Math.max(0, y))])
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_CURVE_POINTS);
  return pts;
}

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (_) { /* private mode */ }
  return {
    brush: s.brush || 'pen',
    tool: s.tool || 'draw',
    eraserMode: s.eraserMode || 'erase-stroke',
    eraserSize: s.eraserSize || 16,
    brushes: Object.fromEntries(Object.entries(DEFAULT_BRUSHES).map(([k, d]) => {
      const b = { ...structuredClone(d), ...((s.brushes || {})[k] || {}) };
      if (!Array.isArray(b.presets) || b.presets.length !== 3) b.presets = [...d.presets];
      const tune = b.tune && typeof b.tune === 'object' ? b.tune : {};
      b.tune = Object.fromEntries(TUNE_KEYS.map((t) => [t, Number.isFinite(tune[t]) ? Math.max(0, Math.min(100, tune[t])) : null]));
      return [k, b];
    })),
    palettes: {
      ink: Array.isArray(s.palettes?.ink) && s.palettes.ink.length ? s.palettes.ink : [...PALETTES.ink],
      highlighter: Array.isArray(s.palettes?.highlighter) && s.palettes.highlighter.length ? s.palettes.highlighter : [...PALETTES.highlighter],
    },
    dock: DOCKS.includes(s.dock) ? s.dock : 'bottom',
    prevTool: s.prevTool || null,
    fingerDraw: !!s.fingerDraw,
    showLatency: !!s.showLatency,
    showMinimap: s.showMinimap !== false,
    hoverPreview: s.hoverPreview !== false,
    recognize: s.recognize !== false,
    recognizeMode: ['live', 'careful', 'both'].includes(s.recognizeMode) ? s.recognizeMode : 'both',
    spelling: s.spelling !== false,
    // Off unless the writer turns it on: sends every word written in notes
    // (from `shareWordsSince` on) to the training data backend, and again
    // when the writer confirms, corrects or says it is not a word.
    shareWords: s.shareWords === true,
    shareWordsSince: Number.isFinite(s.shareWordsSince) ? s.shareWordsSince : 0,
    scribbleErase: s.scribbleErase !== false,
    // Pressure feel, -100 (firm) .. 100 (soft); 0 is linear.
    pressure: Number.isFinite(s.pressure) ? Math.max(-100, Math.min(100, s.pressure)) : 0,
    // A hand-made pressure curve: inner points [[x, y], ...] in 0..1, or
    // null to follow the firm/soft slider.
    pressureCurve: validCurve(s.pressureCurve),
    // Steady-hand smoothing for every pen, 0..100.
    smoothing: Number.isFinite(s.smoothing) ? Math.max(0, Math.min(100, s.smoothing)) : 0,
    lastNote: s.lastNote || null,
    // The folder the notes list shows; new notes go there.
    libraryFolder: typeof s.libraryFolder === 'string' ? s.libraryFolder : null,
  };
}

const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* ignore */ }
}

/** A PDF file (it may have a few bytes before the header). */
const isPdf = (b) => new TextDecoder('latin1').decode(b.subarray(0, 1024)).includes('%PDF-');

function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function fatal(msg) {
  const f = $('fatal');
  f.textContent = msg;
  f.hidden = false;
}

async function main() {
  await init();
  const stage = $('stage');
  let canvas;
  try {
    canvas = new Canvas($('base'), $('overlay'), ...randomSeed());
  } catch (e) {
    fatal(`Bedrock needs WebGL2, which this browser does not provide. (${e})`);
    return;
  }

  // Inside a host app (the Obsidian plugin) the note is the host's file.
  const store = await (host ? Promise.resolve(host.store()) : NoteStore.open()).catch((e) => {
    toast(`Local storage is unavailable, notes will not be saved: ${e}`, 8000);
    return null;
  });

  // ----- state -------------------------------------------------------------
  let note = { id: newNoteId(), created: Date.now(), folder: null };
  let savedRevision = -1;
  let saveTimer = null;
  let saving = Promise.resolve();
  const saveState = $('save-state');

  function setSaveState(text, error = false) {
    saveState.textContent = text;
    saveState.classList.toggle('error', error);
  }

  // ----- rendering & input -------------------------------------------------
  const hud = $('hud');
  let minimap = null;
  let handwriting = null;
  let recognizerView = null;
  let wordMenu = null;
  let selectionView = null;
  let pictures = null;
  let lastRevision = -1;
  let lastView = '';
  const frameStats = { full: 0, inkOnly: 0 }; // for the tests
  let scribbleToastShown = false;
  const input = new InputController(stage, canvas, {
    onFrame: () => {
      // While the pen is writing, a frame is only the stroke under it: the
      // page, the camera and everything drawn over them (underlines, the
      // minimap, the selection) are as they were, so none of it is redrawn.
      const view = canvas.camera().join();
      const rev = canvas.revision();
      const inkOnly = canvas.is_drawing() && rev === lastRevision && view === lastView;
      frameStats[inkOnly ? 'inkOnly' : 'full']++;
      if (!inkOnly) {
        lastView = view;
        pictures?.update();
        minimap?.update();
        if (handwriting) {
          if (rev !== lastRevision) { handwriting.schedule(); recognizerView?.update(); }
          handwriting.draw();
        }
        lastRevision = rev;
        selectionView?.draw();
        if (rev !== savedRevision) scheduleSave();
        updateUndo();
      }
      if (!hud.hidden) {
        const [, , zoom] = canvas.camera();
        const f = input.frames;
        hud.textContent = `input→frame ${input.latency.last.toFixed(1)} ms (avg ${input.latency.avg.toFixed(1)})\n`
          + (f.interval ? `frames ${(1000 / f.interval).toFixed(0)}/s (every ${f.interval.toFixed(1)} ms, slowest ${f.worst.toFixed(1)})  drawing ${f.work.toFixed(2)} ms\n` : '')
          + `strokes ${canvas.stroke_count()}  chunks ${canvas.chunk_count()}  zoom ${(zoom * 100).toFixed(0)}%`;
      }
    },
    onCommit: () => {
      scheduleSave();
      // One-finger double tap: eraser, and back to the tool before.
      if (canvas.take_gesture() === 'toggle-eraser') {
        const back = settings.prevTool && settings.prevTool !== 'eraser' ? settings.prevTool : settings.brush;
        selectTool(currentTool() === 'eraser' ? back : 'eraser', { noToggle: true });
      }
      // The first time a scribble erases something, say how to get it back.
      if (canvas.take_scribble_erased() && !scribbleToastShown) {
        scribbleToastShown = true;
        toast('Scribbled out. Undo brings it back; turn this off in the menu.', 4000);
      }
    },
    onHover: (p) => showHover(p),
    // Holding the selection opens its menu; holding a word opens the word's.
    onLongPress: (p) => wordMenu?.openSelectionAt(p.x, p.y) || wordMenu?.openAt(p.x, p.y) || false,
  });

  function resize() {
    const r = stage.getBoundingClientRect();
    canvas.resize(r.width, r.height, window.devicePixelRatio || 1);
    input.updateRect();
    input.requestFrame();
  }
  new ResizeObserver(resize).observe(stage);
  minimap = new Minimap($('minimap'), canvas, {
    onMove: () => { input.requestFrame(); clearTimeout(camTimer); camTimer = setTimeout(saveCamera, 800); },
    onFit: () => actions.fit(),
  });
  let modelToastShown = false;
  handwriting = new Handwriting(canvas, $('marks'), {
    onTextChanged: () => { savedRevision = -1; scheduleSave(); input.requestFrame(); recognizerView?.update(); },
    onWordStatus: () => recognizerView?.update(),
    onStatus: (m) => {
      if (m.status === 'loading' && !modelToastShown) {
        modelToastShown = true;
        toast('Downloading the handwriting model. This happens once; it then runs on this device.', 6000);
      } else if (m.error && !handwriting.errorShown) {
        handwriting.errorShown = true;
        toast(`Handwriting recognition is not available here (${m.error}).`, 8000);
      }
    },
  });
  handwriting.enabled = settings.recognize;
  handwriting.mode = settings.recognizeMode;
  handwriting.spelling = settings.spelling;
  handwriting.loadDictionary().then(() => input.requestFrame());
  const wordChanged = () => { savedRevision = -1; scheduleSave(); input.requestFrame(); recognizerView?.update(); };
  // "Send every word I write in notes": each word's ink, moved to 0,0, with
  // what the recogniser read as an unchecked label, and again when the
  // writer checks it (see share-words.js).
  const wordSharer = new WordSharer({
    canvas,
    noteId: () => note.id,
    enabled: () => settings.shareWords && collect.isReady(),
    since: () => settings.shareWordsSince,
    reading: () => settings.recognize,
  });
  const shareWordsNow = (force = false) => wordSharer.scan({ force }).catch(() => {});
  // Leaving a note or the app: what it held is sent now, not in a minute.
  const shareWordsAndSend = () => shareWordsNow(true).then(() => { collect.flush().catch(() => {}); });
  setInterval(() => { if (!document.hidden) shareWordsNow(); }, 5000);
  wordMenu = new WordMenu($('word-menu'), canvas, stage, {
    onChange: wordChanged,
    requestFrame: () => input.requestFrame(),
    onFeedback: (word, info) => wordSharer.checked(word, info).catch(() => {}),
    // What the recogniser made of a word, for the word's menu.
    describe: (w) => {
      if (w.text != null) {
        const by = w.engine === 'user' ? 'checked by you' : w.kind === 'math' ? 'formula model'
          : handwriting.isCareful(w) ? 'careful model' : 'quick model';
        return { text: w.text, by };
      }
      if (!handwriting.enabled) return { waiting: 'Not read: handwriting recognition is off' };
      return { waiting: handwriting.status.get(w.id) || 'Waiting to be read…' };
    },
  });
  selectionView = new SelectionView($('marks'), canvas);
  recognizerView = new RecognizerView($('recognizer-view'), handwriting, {
    onChange: () => { savedRevision = -1; scheduleSave(); input.requestFrame(); },
  });
  const redraw = () => { canvas.redraw(); input.requestFrame(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) redraw(); });
  window.addEventListener('pageshow', redraw);
  window.addEventListener('focus', redraw);
  resize();

  for (const c of [$('base'), $('overlay')]) {
    c.addEventListener('webglcontextlost', (e) => e.preventDefault());
    c.addEventListener('webglcontextrestored', () => {
      canvas.restore_gpu();
      pictures?.reset();
      input.requestFrame();
    });
  }

  // ----- notes: load / save -------------------------------------------------
  // ----- background saving --------------------------------------------------
  // The .bedrock file is written in a worker that keeps its own copy of the
  // note, updated with only the strokes that changed. Building the file on
  // the main thread took ~0.8 s for a 1500-stroke note and froze the pen.
  const saveStats = { background: 0, resyncs: 0, direct: 0 };
  const saver = (() => {
    let worker = null;
    let seq = 0;
    const waiting = new Map();
    const fail = () => {
      worker = null;
      for (const resolve of waiting.values()) resolve({ error: 'saver stopped' });
      waiting.clear();
    };
    try {
      worker = new Worker(new URL('./save-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const resolve = waiting.get(e.data.seq);
        waiting.delete(e.data.seq);
        resolve?.(e.data);
      };
      worker.onerror = fail;
    } catch (_) {
      worker = null; // no module workers: save on the main thread instead
    }
    const call = (msg, transfer = []) => new Promise((resolve) => {
      if (!worker) return resolve({ error: 'no saver' });
      msg.seq = ++seq;
      waiting.set(msg.seq, resolve);
      worker.postMessage(msg, transfer);
    });
    // Picture files the worker has (they are big: each is sent once).
    const sent = new Set();
    const newAssets = () => canvas.image_files().filter((f) => !sent.has(f)).map((file) => {
      sent.add(file);
      return { file, bytes: canvas.image_bytes(file) };
    });
    /** Send the whole note (after opening one, or if the copies disagree). */
    const reset = (withExport) => {
      canvas.take_changes();
      const hash = canvas.content_hash();
      const bytes = new TextEncoder().encode(canvas.export_json());
      sent.clear();
      const assets = newAssets();
      return call({ reset: bytes, assets, export: withExport }, [bytes.buffer, ...assets.map((a) => a.bytes.buffer)])
        .then((r) => ({ ...r, expected: hash }));
    };
    return {
      get available() { return !!worker; },
      reset,
      /** The .bedrock bytes of the current note, built off the main thread. */
      async build() {
        const touched = [...new Set(Array.from(canvas.take_changes(), (c) => c.id))];
        const added = [];
        const index = [];
        for (const id of touched) {
          const i = canvas.stroke_index(id);
          if (i >= 0) { added.push(canvas.stroke_json(id)); index.push(i); }
        }
        const expected = canvas.content_hash();
        const assets = newAssets();
        let r = await call({ ops: { meta: canvas.meta_json(), touched, added: `[${added.join(',')}]`, index }, assets, export: true }, assets.map((a) => a.bytes.buffer));
        if (!r.error && r.hash === expected) { saveStats.background++; return r.data; }
        saveStats.resyncs++;
        r = await reset(true);
        if (!r.error && r.hash === r.expected) return r.data;
        throw new Error(r.error || 'saved copy does not match');
      },
    };
  })();

  async function buildNoteFile() {
    if (saver.available) {
      try { return await saver.build(); } catch (e) { console.warn('background save failed, saving directly', e); }
    }
    saveStats.direct++;
    return canvas.export_bedrock();
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!store) return;
    if (canvas.is_drawing()) return scheduleSave();
    const rev = canvas.revision();
    const now = Date.now();
    note.modified = now;
    canvas.set_times(note.created, now);
    const id = note.id, created = note.created, title = canvas.title(), folder = note.folder || null;
    setSaveState('Saving…');
    saveCamera();
    saving = saving.then(async () => {
      const data = await buildNoteFile();
      // The folder is read when the write happens: a move made while this
      // save waited is kept.
      await store.put({ id, title, created, modified: now, folder: id === note.id ? note.folder || null : folder, data });
    }).then(() => {
      savedRevision = rev;
      setSaveState(canvas.revision() === rev ? 'Saved' : 'Saving…');
      settings.lastNote = note.id;
      saveSettings();
      // Not while a folder is being named: that would throw the name away.
      if (!$('library').hidden && !$('note-list').querySelector('.folder-name')) renderLibrary();
    }).catch((e) => {
      setSaveState('Not saved!', true);
      toast(`Could not save this note on this device: ${e && e.message ? e.message : e}. Use “Save to iCloud Drive / Files” to keep a copy.`, 10000);
    });
    return saving;
  }

  function scheduleSave() {
    if (saveTimer) return;
    setSaveState('Saving…');
    saveTimer = setTimeout(saveNow, AUTOSAVE_MS);
  }

  async function saveCamera() {
    if (store) await store.setKv(`camera:${note.id}`, Array.from(canvas.camera())).catch(() => {});
  }
  let camTimer = null;
  stage.addEventListener('wheel', () => { clearTimeout(camTimer); camTimer = setTimeout(saveCamera, 800); });
  stage.addEventListener('pointerup', () => { clearTimeout(camTimer); camTimer = setTimeout(saveCamera, 800); });

  function applyDocToUi() {
    $('title').value = canvas.title();
    $('paper').value = canvas.paper();
    if (saver.available) saver.reset(false); else canvas.take_changes();
    minimap?.reset();
    handwriting?.schedule();
    savedRevision = canvas.revision();
    setSaveState('Saved');
    updateUndo();
    input.requestFrame();
  }

  /** Bring strokes (ids) into view, each as its whole word, and flash a
   *  frame around them. False if none of them is on the page. */
  function showInk(strokes) {
    if (!Array.isArray(strokes) || !strokes.length) return false;
    const b = canvas.reveal_strokes(strokes.join(' '));
    if (b.length !== 4) return false;
    minimap?.update();
    input.requestFrame();
    saveCamera();
    const [ox, oy, zoom] = canvas.camera();
    const pad = 8;
    for (const old of stage.querySelectorAll('.jump-flash')) old.remove();
    const el = document.createElement('div');
    el.className = 'jump-flash';
    Object.assign(el.style, {
      left: `${(b[0] - ox) * zoom - pad}px`,
      top: `${(b[1] - oy) * zoom - pad}px`,
      width: `${(b[2] - b[0]) * zoom + 2 * pad}px`,
      height: `${(b[3] - b[1]) * zoom + 2 * pad}px`,
    });
    // It marks a spot on the page, so it goes when the page moves.
    const done = () => { el.remove(); stage.removeEventListener('pointerdown', done, true); stage.removeEventListener('wheel', done, true); };
    el.addEventListener('animationend', done);
    stage.addEventListener('pointerdown', done, true);
    stage.addEventListener('wheel', done, true);
    stage.append(el);
    return true;
  }

  async function openNote(id) {
    if (saveTimer) await saveNow();
    await shareWordsAndSend();
    const rec = store && (await store.get(id));
    if (!rec) return newNote();
    try {
      const warnings = canvas.load(rec.data, ...randomSeed());
      note = { id: rec.id, created: rec.created, folder: rec.folder || null };
      const cam = await store.getKv(`camera:${id}`).catch(() => null);
      if (cam && cam.length === 3) canvas.set_camera(cam[0], cam[1], cam[2]);
      if (warnings.length) toast(`Some damaged parts of this note were skipped: ${warnings.slice(0, 3).join('; ')}`, 8000);
    } catch (e) {
      toast(`This note could not be opened: ${e}`, 8000);
      return newNote();
    }
    settings.lastNote = id;
    saveSettings();
    applyDocToUi();
  }

  async function newNote() {
    if (saveTimer) await saveNow();
    await shareWordsAndSend();
    const folder = await libraryFolder();
    canvas.new_document(...randomSeed());
    note = { id: host ? host.noteId : newNoteId(), created: Date.now(), folder };
    canvas.set_paper('dots');
    applyDocToUi();
    savedRevision = -1; // a new note is saved on its first stroke
    setSaveState('New');
  }

  // ----- library -------------------------------------------------------------
  // Folders and notes, kept in IndexedDB (storage.js). The list shows one
  // folder at a time; new notes are made in the folder it shows.
  const hasFolders = () => !!store?.listFolders;
  const listFolders = async () => (hasFolders() ? store.listFolders() : []);

  /** The folder the list shows, if it still exists. */
  async function libraryFolder() {
    const id = settings.libraryFolder;
    if (!id) return null;
    return (await listFolders()).some((f) => f.id === id) ? id : null;
  }

  function showFolder(id) {
    settings.libraryFolder = id || null;
    saveSettings();
    renderLibrary();
  }

  /** A text field in the list for naming a folder. Resolves with the
   *  name, or null if it was left empty or cancelled. */
  function askName(li, value, label) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.className = 'folder-name';
      input.value = value;
      input.placeholder = 'Folder name';
      input.setAttribute('aria-label', label);
      input.enterKeyHint = 'done';
      let finished = false;
      const finish = (v) => { if (!finished) { finished = true; input.dataset.done = 'true'; resolve(v); } };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || null); }
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      };
      input.onblur = () => finish(input.value.trim() || null);
      li.replaceChildren(input);
      input.focus();
      input.select();
    });
  }

  async function nameFolder(li, { folder = null, parent = null } = {}) {
    for (let value = folder ? folder.name : ''; ;) {
      const name = await askName(li, value, folder ? `Rename ${folder.name}` : 'New folder name');
      if (name === null) return renderLibrary();
      const siblings = (await listFolders()).filter((f) => (f.parent || null) === (folder ? folder.parent || null : parent) && f.id !== folder?.id);
      const problem = folderNameProblem(name, siblings);
      if (!problem) {
        await store.putFolder(folder ? { ...folder, name: cleanName(name) } : { id: newNoteId(), name: cleanName(name), parent, created: Date.now() });
        return renderLibrary();
      }
      toast(problem);
      value = name;
    }
  }

  async function renderLibrary() {
    const list = $('note-list');
    const folders = await listFolders();
    const notes = store ? await store.list() : [];
    const current = await libraryFolder();
    if (current !== settings.libraryFolder) { settings.libraryFolder = current; saveSettings(); }
    const trails = folderTrail(folders);
    const trail = current ? trails.get(current) : [];
    const here = folderContents(folders, notes, current);

    // Heading: the folder's name and a way back up.
    const up = $('library-up');
    up.hidden = !current;
    const parent = trail.length > 1 ? trail[trail.length - 2] : null;
    up.textContent = `‹ ${parent ? parent.name : 'Notes'}`;
    up.setAttribute('aria-label', `Back to ${parent ? parent.name : 'all notes'}`);
    up.onclick = () => showFolder(parent ? parent.id : null);
    $('library-title').textContent = current ? trail[trail.length - 1].name : 'Notes';
    $('btn-new-folder').hidden = !hasFolders();

    // Where a note can be moved: the top and every folder, by path.
    const places = [{ id: '', label: 'Notes (top)' }, ...folders
      .map((f) => ({ id: f.id, label: trails.get(f.id).map((t) => t.name).join(' › ') }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))];

    const rows = here.folders.map((f) => {
      const li = document.createElement('li');
      li.className = 'folder';
      li.dataset.folder = f.id;
      const open = document.createElement('button');
      open.className = 'open';
      const strong = document.createElement('strong');
      strong.textContent = f.name;
      const inside = folderContents(folders, notes, f.id);
      const small = document.createElement('small');
      const count = inside.notes.length + inside.folders.length;
      small.textContent = count ? `${count} item${count === 1 ? '' : 's'}` : 'Empty';
      open.append(strong, small);
      open.onclick = () => showFolder(f.id);
      const rename = document.createElement('button');
      rename.className = 'rename';
      rename.textContent = 'Rename';
      rename.setAttribute('aria-label', `Rename ${f.name}`);
      rename.onclick = () => nameFolder(li, { folder: f });
      const del = document.createElement('button');
      del.className = 'delete';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', `Delete ${f.name}`);
      del.onclick = async () => {
        const all = trails;
        const below = folders.filter((g) => all.get(g.id).some((t) => t.id === f.id));
        const ids = new Set(below.map((g) => g.id));
        const n = notes.filter((x) => ids.has(x.folder)).length;
        const what = n ? ` and the ${n} note${n === 1 ? '' : 's'} in it` : '';
        if (!confirm(`Delete the folder “${f.name}”${what} from this device? Copies you saved to iCloud Drive are not affected.`)) return;
        await saving; // a save under way must not bring a deleted note back
        const deleted = await store.removeFolder(f.id);
        if (deleted.includes(note.id)) {
          clearTimeout(saveTimer);
          saveTimer = null;
          await newNote();
        }
        renderLibrary();
      };
      li.append(open, rename, del);
      return li;
    });

    rows.push(...here.notes.map((n) => {
      const li = document.createElement('li');
      if (n.id === note.id) li.className = 'current';
      li.dataset.note = n.id;
      const open = document.createElement('button');
      open.className = 'open';
      const strong = document.createElement('strong');
      strong.textContent = n.title || 'Untitled note';
      const small = document.createElement('small');
      small.textContent = new Date(n.modified).toLocaleString();
      open.append(strong, small);
      open.onclick = () => { openNote(n.id); $('library').hidden = true; };
      li.append(open);
      if (hasFolders() && folders.length) {
        // A native picker: on iPad it opens as a list over the button.
        const move = document.createElement('select');
        move.className = 'move';
        move.setAttribute('aria-label', `Move ${n.title || 'Untitled note'} to a folder`);
        const label = new Option('Move', '', true, true);
        label.disabled = true;
        move.append(label, ...places.filter((p) => p.id !== (n.folder || '')).map((p) => new Option(p.label, p.id)));
        move.onchange = async () => {
          const to = move.value || null;
          if (n.id === note.id) note.folder = to;
          await store.move(n.id, to);
          renderLibrary();
        };
        li.append(move);
      }
      const del = document.createElement('button');
      del.className = 'delete';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', `Delete ${n.title || 'Untitled note'}`);
      del.onclick = async () => {
        if (!confirm(`Delete “${n.title || 'Untitled note'}” from this device? Copies you saved to iCloud Drive are not affected.`)) return;
        await store.remove(n.id);
        if (n.id === note.id) await newNote();
        renderLibrary();
      };
      li.append(del);
      return li;
    }));
    // A folder being named keeps its row, untouched (moving or removing it
    // would lose the focus and the name being typed); the rest is redrawn
    // around it.
    const naming = list.querySelector('.folder-name:not([data-done])')?.closest('li');
    if (naming) {
      const id = naming.dataset.folder;
      const kept = rows.map((r) => (id && r.dataset.folder === id ? naming : r));
      if (!kept.includes(naming)) kept.unshift(naming);
      for (const c of [...list.children]) if (c !== naming) c.remove();
      const at = kept.indexOf(naming);
      naming.before(...kept.slice(0, at));
      naming.after(...kept.slice(at + 1));
      return;
    }
    list.replaceChildren(...rows);
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = current ? 'This folder is empty.' : 'No saved notes yet.';
      list.append(li);
    }
  }

  $('btn-new-folder').onclick = async () => {
    if (!hasFolders()) return;
    const li = document.createElement('li');
    li.className = 'folder editing';
    const list = $('note-list');
    list.querySelector('.empty')?.remove();
    list.prepend(li);
    await nameFolder(li, { parent: await libraryFolder() });
  };

  // ----- Pencil hover preview ---------------------------------------------------
  // With an Apple Pencil that hovers (Pencil Pro, Pencil 2 on M2 iPads and
  // later), show where the tool will land and how big it is: the brush's
  // full width in its colour, or the eraser's circle.
  const hoverEl = $('hover-cursor');
  let hoverTimer = null;
  function showHover(p) {
    clearTimeout(hoverTimer);
    if (!p || !settings.hoverPreview || (currentTool() === 'lasso' && !p.eraser)) { hoverEl.hidden = true; return; }
    const zoom = canvas.camera()[2];
    const erasing = p.eraser || currentTool() === 'eraser';
    let d;
    if (erasing) {
      d = settings.eraserSize;
      hoverEl.style.background = 'transparent';
    } else {
      const b = currentBrush();
      d = b.size * (settings.brush === 'highlighter' ? 4 : 1) * zoom;
      hoverEl.style.background = b.color;
    }
    d = Math.max(d, 4);
    hoverEl.classList.toggle('eraser', erasing);
    hoverEl.style.width = hoverEl.style.height = `${d}px`;
    hoverEl.style.transform = `translate(${p.x - d / 2}px, ${p.y - d / 2}px)`;
    hoverEl.hidden = false;
    // Backup for browsers that don't say when the Pencil leaves hover range.
    hoverTimer = setTimeout(() => { hoverEl.hidden = true; }, 500);
  }

  // ----- toolbar -------------------------------------------------------------
  const toolButtons = [...document.querySelectorAll('.tool[data-brush], .tool[data-tool]')];
  const colorsEl = $('colors');

  function currentBrush() {
    return settings.brushes[settings.brush];
  }
  function currentPalette() {
    return settings.palettes[settings.brush === 'highlighter' ? 'highlighter' : 'ink'];
  }
  function currentTool() {
    return settings.tool === 'draw' ? settings.brush : settings.tool;
  }

  /** Select a brush or the eraser. Tapping the tool that is already active
   * jumps back to the previous one (e.g. pen -> eraser -> tap -> pen). */
  function selectTool(name, { noToggle = false } = {}) {
    const cur = currentTool();
    if (name === cur) {
      if (noToggle || !settings.prevTool || settings.prevTool === cur) return;
      name = settings.prevTool;
    }
    settings.prevTool = cur;
    if (name === 'eraser' || name === 'lasso') {
      settings.tool = name;
    } else {
      settings.tool = 'draw';
      settings.brush = name;
    }
    setColorEditing(false);
    saveSettings();
    applyTool();
    input.requestFrame(); // the selection outline goes with the lasso
  }

  /** Calls `fn` when `el` is held for half a second (finger, pen or mouse),
   * or right-clicked; the click that follows a long press is marked. */
  function onLongPress(el, fn) {
    let timer = 0;
    const cancel = () => clearTimeout(timer);
    el.addEventListener('pointerdown', () => {
      cancel();
      timer = setTimeout(() => { el.dataset.longPressed = '1'; fn(); }, 500);
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); fn(); });
  }

  // ----- colour presets: + adds the current colour, long-press to delete -------
  function setColorEditing(on) {
    colorsEl.classList.toggle('editing', on);
  }
  $('color-add').addEventListener('click', () => {
    const c = currentBrush().color.toLowerCase();
    const palette = currentPalette();
    if (palette.some((p) => p.toLowerCase() === c)) {
      toast('That colour is already in your colours', 1500);
      return;
    }
    palette.push(c);
    saveSettings();
    applyTool();
  });

  // ----- size presets: three per brush; the slider edits the selected one ------
  function renderPresets(erasing, b) {
    const el = $('size-presets');
    el.hidden = erasing;
    if (erasing) return;
    const max = Math.max(...b.presets);
    el.replaceChildren(...b.presets.map((v, i) => {
      const btn = document.createElement('button');
      btn.className = 'preset';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', `Size preset ${i + 1}: ${v}`);
      btn.title = `Size ${v} (select, then use the slider to change it)`;
      btn.setAttribute('aria-checked', String(b.preset === i));
      const dot = document.createElement('span');
      const d = 5 + (13 * v) / max;
      dot.style.width = dot.style.height = `${d}px`;
      dot.style.setProperty('--c', b.color);
      btn.append(dot);
      btn.onclick = () => {
        b.preset = i;
        b.size = v;
        saveSettings();
        applyTool();
      };
      return btn;
    }));
  }

  function setSize(v) {
    if (!Number.isFinite(v)) return;
    if (settings.tool !== 'eraser') {
      const b = currentBrush();
      b.size = v;
      if (b.preset != null) b.presets[b.preset] = v;
    } else {
      settings.eraserSize = v;
    }
    saveSettings();
    applyTool();
  }

  // ----- dock: the toolbar can sit on any edge ----------------------------------
  const toolbar = $('toolbar');
  function applyDock() {
    toolbar.dataset.dock = settings.dock;
    $('stroke-pop').dataset.dock = settings.dock;
    $('dock').value = settings.dock;
  }
  function setDock(d) {
    if (!DOCKS.includes(d)) return;
    settings.dock = d;
    saveSettings();
    applyDock();
  }
  {
    const grip = $('dock-grip');
    let dragging = false;
    grip.addEventListener('pointerdown', (e) => {
      dragging = true;
      grip.setPointerCapture(e.pointerId);
      toolbar.classList.add('dragging');
      toolbar.style.setProperty('--x', `${e.clientX}px`);
      toolbar.style.setProperty('--y', `${e.clientY}px`);
    });
    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      toolbar.style.setProperty('--x', `${e.clientX}px`);
      toolbar.style.setProperty('--y', `${e.clientY}px`);
    });
    const drop = (e) => {
      if (!dragging) return;
      dragging = false;
      toolbar.classList.remove('dragging');
      // Snap to the nearest edge.
      const w = window.innerWidth, h = window.innerHeight;
      const d = { left: e.clientX / w, right: 1 - e.clientX / w, top: e.clientY / h, bottom: 1 - e.clientY / h };
      setDock(Object.entries(d).sort((a, b) => a[1] - b[1])[0][0]);
    };
    grip.addEventListener('pointerup', drop);
    grip.addEventListener('pointercancel', (e) => { dragging = false; toolbar.classList.remove('dragging'); });
  }
  $('dock').addEventListener('change', (e) => setDock(e.target.value));

  function applyTool() {
    const erasing = settings.tool === 'eraser';
    canvas.set_tool(settings.tool === 'lasso' ? 'lasso' : erasing ? settings.eraserMode : 'draw');
    stage.classList.toggle('lasso', settings.tool === 'lasso');
    const b = currentBrush();
    canvas.set_brush(settings.brush, b.color, b.size);
    canvas.set_brush_style(b.style || 'solid', (b.stabilizer || 0) / 100);
    canvas.set_brush_tuning(...TUNE_KEYS.map((t) => (b.tune[t] == null ? -1 : b.tune[t] / 100)));
    canvas.set_eraser_size(settings.eraserSize);
    for (const btn of toolButtons) {
      const on = settings.tool === 'draw' ? btn.dataset.brush === settings.brush : btn.dataset.tool === settings.tool;
      btn.setAttribute('aria-checked', String(on));
      btn.setAttribute('role', 'radio');
    }
    $('eraser-mode').textContent = { 'erase-stroke': 'S', 'erase-partial': 'P', 'erase-trim': 'T' }[settings.eraserMode] || 'S';
    const palette = currentPalette();
    colorsEl.replaceChildren(...palette.map((c, i) => {
      const sw = document.createElement('button');
      sw.className = 'swatch';
      sw.setAttribute('role', 'radio');
      sw.setAttribute('aria-label', `Color ${c}`);
      sw.setAttribute('aria-checked', String(!erasing && c.toLowerCase() === b.color.toLowerCase()));
      const dot = document.createElement('span');
      dot.style.background = c;
      sw.append(dot);
      onLongPress(sw, () => setColorEditing(true));
      sw.onclick = () => {
        if (sw.dataset.longPressed) { delete sw.dataset.longPressed; return; }
        if (colorsEl.classList.contains('editing')) {
          if (palette.length > 1) palette.splice(i, 1);
          else toast('Keep at least one colour', 1500);
          saveSettings();
          applyTool();
          return;
        }
        selectTool(settings.brush, { noToggle: true });
        b.color = c;
        saveSettings();
        applyTool();
      };
      return sw;
    }));
    $('color-add').hidden = erasing;
    renderPresets(erasing, b);
    $('color-input').value = b.color.slice(0, 7);
    const size = erasing ? settings.eraserSize : b.size;
    const slider = $('size');
    if (erasing) { slider.min = 4; slider.max = 80; slider.step = 1; } else { slider.min = 0.5; slider.max = 30; slider.step = 0.5; }
    slider.value = size;
    const dot = $('size-dot');
    dot.style.setProperty('--d', `${Math.max(3, Math.min(22, size))}px`);
    dot.style.setProperty('--c', erasing ? '#bbb' : b.color);
    renderStrokePop();
  }

  // ----- line style + stabiliser popover (per brush) ---------------------------
  const strokePop = $('stroke-pop');
  function stabilizerLabel(v) {
    return v ? `${v}%` : 'Off';
  }
  function renderStrokePop() {
    const b = currentBrush();
    const erasing = settings.tool === 'eraser';
    $('stroke-brush').textContent = erasing ? 'Eraser' : settings.brush;
    $('pop-brush').hidden = erasing;
    $('pop-eraser').hidden = !erasing;
    const ps = $('pop-size');
    if (erasing) { ps.min = 4; ps.max = 80; ps.step = 1; } else { ps.min = 0.5; ps.max = 30; ps.step = 0.5; }
    for (const btn of strokePop.querySelectorAll('[data-eraser]')) {
      btn.setAttribute('aria-checked', String(btn.dataset.eraser === settings.eraserMode));
    }
    for (const btn of strokePop.querySelectorAll('[data-style]')) {
      btn.setAttribute('aria-checked', String(btn.dataset.style === (b.style || 'solid')));
    }
    const size = erasing ? settings.eraserSize : b.size;
    ps.value = size;
    $('pop-size-value').textContent = size;
    $('stabilizer').value = b.stabilizer || 0;
    $('stabilizer-value').textContent = stabilizerLabel(b.stabilizer || 0);
    $('eraser-hint').textContent = {
      'erase-stroke': 'Removes whole strokes you touch.',
      'erase-partial': 'Rubs out only the ink under the eraser.',
      'erase-trim': 'Cuts a stroke back to where it crosses other lines, like trimming an overshoot.',
    }[settings.eraserMode] || '';
    const usual = TUNE_DEFAULTS[settings.brush] || TUNE_DEFAULTS.pen;
    for (const t of TUNE_KEYS) {
      const v = b.tune[t];
      $(`tune-${t}`).value = v == null ? usual[t] : v;
      $(`tune-${t}-value`).textContent = v == null ? `Usual (${usual[t]}%)` : `${v}%`;
    }
    $('tune-reset').disabled = TUNE_KEYS.every((t) => b.tune[t] == null);
  }
  function setStrokePop(open) {
    strokePop.hidden = !open;
    $('btn-stroke').setAttribute('aria-expanded', String(open));
    if (open) renderStrokePop();
  }
  $('btn-stroke').addEventListener('click', (e) => {
    e.stopPropagation();
    setStrokePop(strokePop.hidden);
  });
  for (const btn of strokePop.querySelectorAll('[data-eraser]')) {
    btn.addEventListener('click', () => {
      settings.eraserMode = btn.dataset.eraser;
      saveSettings();
      applyTool();
    });
  }
  for (const btn of strokePop.querySelectorAll('[data-style]')) {
    btn.addEventListener('click', () => {
      currentBrush().style = btn.dataset.style;
      saveSettings();
      applyTool();
    });
  }
  for (const el of strokePop.querySelectorAll('[data-tune]')) {
    el.addEventListener('input', () => {
      currentBrush().tune[el.dataset.tune] = parseInt(el.value, 10) || 0;
      saveSettings();
      applyTool();
    });
  }
  $('tune-reset').addEventListener('click', () => {
    const b = currentBrush();
    for (const t of TUNE_KEYS) b.tune[t] = null;
    saveSettings();
    applyTool();
  });
  $('stabilizer').addEventListener('input', (e) => {
    currentBrush().stabilizer = parseInt(e.target.value, 10) || 0;
    saveSettings();
    applyTool();
  });

  for (const btn of toolButtons) {
    const name = btn.dataset.tool || btn.dataset.brush;
    btn.addEventListener('click', () => selectTool(name));
  }
  $('color-input').addEventListener('input', (e) => {
    selectTool(settings.brush, { noToggle: true });
    currentBrush().color = e.target.value;
    saveSettings();
    applyTool();
  });
  $('size').addEventListener('input', (e) => setSize(parseFloat(e.target.value)));
  $('pop-size').addEventListener('input', (e) => setSize(parseFloat(e.target.value)));

  function updateUndo() {
    $('btn-undo').disabled = !canvas.can_undo();
    $('btn-redo').disabled = !canvas.can_redo();
  }
  $('btn-undo').onclick = () => { canvas.undo(); input.requestFrame(); };
  $('btn-redo').onclick = () => { canvas.redo(); input.requestFrame(); };

  $('title').addEventListener('input', (e) => {
    canvas.set_title(e.target.value);
    savedRevision = -1;
    scheduleSave();
  });
  $('title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  // ----- menu ------------------------------------------------------------------
  const menu = $('menu');
  $('btn-menu').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  $('btn-library').onclick = (e) => {
    e.stopPropagation();
    const lib = $('library');
    lib.hidden = !lib.hidden;
    if (!lib.hidden) renderLibrary();
  };
  document.addEventListener('pointerdown', (e) => {
    if (!menu.contains(e.target) && e.target !== $('btn-menu')) menu.hidden = true;
    if (!colorsEl.contains(e.target)) setColorEditing(false);
    if (!strokePop.hidden && !strokePop.contains(e.target) && !$('btn-stroke').contains(e.target)) setStrokePop(false);
    if (!$('library').contains(e.target) && !$('btn-library').contains(e.target)) $('library').hidden = true;
  });

  /** Each page of a PDF with handwriting (a GoodNotes export) becomes a
   *  note. With saving set up on /train, every word is also sent for
   *  training with the reading the PDF holds, for review. */
  async function importPdf(f) {
    toast(`Importing ${f.name}…`, 60000);
    await new Promise((r) => setTimeout(r, 30)); // let the message show first
    let pages;
    try {
      pages = import_pdf(f.bytes, ...randomSeed(), Date.now());
    } catch (e) {
      toast(`${f.name} could not be read (${e}).`, 6000);
      return;
    }
    if (!pages.length) {
      toast(`No handwriting found in ${f.name}.`, 6000);
      return;
    }
    const base = f.name.replace(/\.pdf$/i, '');
    const warnings = new Set();
    let sent = 0;
    for (const [i, page] of pages.entries()) {
      if (saveTimer) await saveNow();
      canvas.load(page.bedrock, ...randomSeed());
      note = { id: newNoteId(), created: Date.now() };
      canvas.set_title(pages.length > 1 ? `${base} (page ${i + 1})` : base);
      applyDocToUi();
      savedRevision = -1;
      await saveNow();
      page.warnings.forEach((w) => warnings.add(w));
      sent += await wordSharer.scan({ imported: true }).catch(() => 0);
    }
    const what = pages.length > 1 ? `${pages.length} pages` : f.name;
    const extra = [sent ? `${sent} words sent for training` : '', ...warnings].filter(Boolean).join('; ');
    toast(`Imported ${what}${extra ? ` (${extra})` : ''}.`, 6000);
    return pages.length;
  }

  const actions = {
    new: () => newNote(),
    'import-pdf': async () => {
      const f = await pickFile($('file-input'));
      if (f) await importPdf(f);
    },
    open: async () => {
      const f = await pickFile($('file-input'));
      if (!f) return;
      if (isPdf(f.bytes)) return importPdf(f);
      try {
        if (saveTimer) await saveNow();
        const warnings = canvas.load(f.bytes, ...randomSeed());
        note = { id: newNoteId(), created: Date.now(), folder: await libraryFolder() };
        if (!canvas.title()) canvas.set_title(f.name.replace(/\.(bedrock|svg|json)$/i, ''));
        applyDocToUi();
        savedRevision = -1;
        await saveNow();
        toast(warnings.length ? `Opened with repairs: ${warnings.slice(0, 3).join('; ')}` : `Opened ${f.name}`);
      } catch (e) {
        toast(`${f.name} is not a Bedrock note (${e}).`, 6000);
      }
    },
    save: async () => {
      const how = await saveFile(canvas.export_bedrock(), safeFileName(canvas.title(), 'bedrock'), 'application/zip',
        { handleKey: note.id, handleStore: store });
      if (how === 'download') toast('Saved to Downloads. On iPad you can move it to iCloud Drive in the Files app.');
      if (how === 'picker') toast('Saved.');
    },
    'export-svg': async () => {
      await saveFile(new TextEncoder().encode(canvas.export_svg()), safeFileName(canvas.title(), 'svg'), 'image/svg+xml');
    },
    // The whole library as a folder: notes in their folders, each with
    // its Markdown sidecar, ready to drop into an Obsidian vault.
    'export-all': async () => {
      if (!store) return;
      if (saveTimer) await saveNow();
      const notes = [];
      for (const meta of await store.list()) {
        const rec = await store.get(meta.id);
        if (rec) notes.push(rec);
      }
      const zip = new ZipBuilder();
      const files = await libraryFiles(await listFolders(), notes, { titleOf: (n) => n.title || peek_title(n.data) });
      for (const [name, bytes] of files) zip.add(name, bytes);
      const date = new Date().toISOString().slice(0, 10);
      await saveFile(zip.finish(), `Bedrock notes ${date}.zip`, 'application/zip');
    },
    fit: () => { canvas.fit_content(); input.requestFrame(); saveCamera(); },
  };
  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      menu.hidden = true;
      $('library').hidden = true;
      actions[el.dataset.action]?.();
    });
  });
  $('paper').addEventListener('change', (e) => {
    canvas.set_paper(e.target.value);
    savedRevision = -1;
    scheduleSave();
    input.requestFrame();
  });
  $('finger-draw').checked = settings.fingerDraw;
  canvas.set_finger_drawing(settings.fingerDraw);
  $('finger-draw').addEventListener('change', (e) => {
    settings.fingerDraw = e.target.checked;
    canvas.set_finger_drawing(settings.fingerDraw);
    saveSettings();
  });
  function pressureLabel(v) {
    if (Math.abs(v) < 5) return 'Normal';
    return v < 0 ? 'Firm' : 'Soft';
  }
  // The firm/soft slider sets a one-point curve; dragging the curve's
  // points makes a custom one ("Custom" until the slider is moved again).
  const curveEl = $('pressure-curve');
  function applyPressure() {
    if (settings.pressureCurve) canvas.set_pressure_points(new Float32Array(settings.pressureCurve.flat()));
    else canvas.set_pressure_softness(settings.pressure / 100);
    $('pressure').value = settings.pressure;
    $('pressure-value').textContent = settings.pressureCurve ? 'Custom' : pressureLabel(settings.pressure);
    drawCurve();
    input.requestFrame();
  }
  function curvePoints() {
    const flat = canvas.pressure_points();
    const pts = [];
    for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
    return pts;
  }
  function drawCurve() {
    const n = 48;
    const ys = canvas.pressure_curve_samples(n);
    let d = '';
    ys.forEach((y, i) => { d += `${i ? 'L' : 'M'}${(100 * i / (n - 1)).toFixed(2)} ${(100 - 100 * y).toFixed(2)}`; });
    $('pressure-curve-line').setAttribute('d', d);
    const g = $('pressure-curve-points');
    g.replaceChildren(...curvePoints().map(([x, y], i) => {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', 100 * x);
      c.setAttribute('cy', 100 - 100 * y);
      c.setAttribute('r', 4);
      c.dataset.index = i;
      return c;
    }));
  }
  function curveAt(e) {
    const r = curveEl.getBoundingClientRect();
    return [Math.min(0.98, Math.max(0.02, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  }
  let dragPoint = null;
  let lastTap = { i: -1, t: 0 };
  curveEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    let pts = curvePoints();
    let i = e.target.dataset?.index != null ? parseInt(e.target.dataset.index, 10) : -1;
    const now = performance.now();
    if (i >= 0 && lastTap.i === i && now - lastTap.t < 350) {
      pts.splice(i, 1); // double tap: remove the point
      settings.pressureCurve = pts;
      lastTap = { i: -1, t: 0 };
      saveSettings();
      applyPressure();
      return;
    }
    if (i < 0) {
      if (pts.length >= MAX_CURVE_POINTS) { toast(`At most ${MAX_CURVE_POINTS} points`, 1500); return; }
      pts.push(curveAt(e));
      pts.sort((a, b) => a[0] - b[0]);
      settings.pressureCurve = pts;
      applyPressure();
      pts = curvePoints();
      const [x] = curveAt(e);
      i = pts.reduce((best, p, k) => (Math.abs(p[0] - x) < Math.abs(pts[best][0] - x) ? k : best), 0);
    }
    lastTap = { i, t: now };
    dragPoint = i;
    curveEl.setPointerCapture(e.pointerId);
  });
  curveEl.addEventListener('pointermove', (e) => {
    if (dragPoint == null) return;
    const pts = curvePoints();
    if (!pts[dragPoint]) return;
    const [x, y] = curveAt(e);
    // Keep the points in order: a point can't pass its neighbours.
    const lo = dragPoint > 0 ? pts[dragPoint - 1][0] + 0.02 : 0.02;
    const hi = dragPoint < pts.length - 1 ? pts[dragPoint + 1][0] - 0.02 : 0.98;
    pts[dragPoint] = [Math.min(hi, Math.max(lo, x)), y];
    settings.pressureCurve = pts;
    applyPressure();
  });
  const endDrag = () => { if (dragPoint != null) { dragPoint = null; saveSettings(); } };
  curveEl.addEventListener('pointerup', endDrag);
  curveEl.addEventListener('pointercancel', endDrag);
  $('pressure-curve-reset').addEventListener('click', (e) => {
    e.stopPropagation();
    settings.pressureCurve = null;
    settings.pressure = 0;
    saveSettings();
    applyPressure();
  });
  applyPressure();
  $('pressure').addEventListener('input', (e) => {
    settings.pressure = parseInt(e.target.value, 10) || 0;
    settings.pressureCurve = null;
    saveSettings();
    applyPressure();
  });
  function smoothingLabel(v) { return v ? `${v}%` : 'Off'; }
  $('smoothing').value = settings.smoothing;
  $('smoothing-value').textContent = smoothingLabel(settings.smoothing);
  canvas.set_smoothing(settings.smoothing / 100);
  $('smoothing').addEventListener('input', (e) => {
    settings.smoothing = parseInt(e.target.value, 10) || 0;
    $('smoothing-value').textContent = smoothingLabel(settings.smoothing);
    canvas.set_smoothing(settings.smoothing / 100);
    saveSettings();
    input.requestFrame();
  });
  $('recognize-mode').value = settings.recognizeMode;
  $('recognize-mode').addEventListener('change', (e) => {
    settings.recognizeMode = e.target.value;
    handwriting.mode = settings.recognizeMode;
    saveSettings();
    handwriting.schedule();
  });
  $('recognize').checked = settings.recognize;
  $('recognize').addEventListener('change', (e) => {
    settings.recognize = e.target.checked;
    handwriting.enabled = settings.recognize;
    if (settings.recognize) handwriting.schedule();
    saveSettings();
  });
  $('show-recognizer').checked = false;
  $('show-recognizer').addEventListener('change', (e) => { recognizerView.visible = e.target.checked; });
  $('rv-close').addEventListener('click', () => { recognizerView.visible = false; $('show-recognizer').checked = false; });
  canvas.set_scribble_erase(settings.scribbleErase);
  $('scribble-erase').checked = settings.scribbleErase;
  $('scribble-erase').addEventListener('change', (e) => {
    settings.scribbleErase = e.target.checked;
    canvas.set_scribble_erase(settings.scribbleErase);
    saveSettings();
  });
  // Words go to the training data backend only when this is on, and only
  // after consent and an invite code (set up on /train).
  $('share-words').checked = settings.shareWords && collect.isReady();
  $('share-words').addEventListener('change', (e) => {
    if (e.target.checked && !collect.isReady()) {
      e.target.checked = false;
      toast('Set up saving on the Train page first (bedrock/train): it explains what is sent and needs your invite code.', 7000);
      return;
    }
    settings.shareWords = e.target.checked;
    // Only what is written from now on is sent by itself.
    if (settings.shareWords) settings.shareWordsSince = Date.now();
    saveSettings();
    if (settings.shareWords) collect.flush().catch(() => {});
  });
  $('spelling').checked = settings.spelling;
  $('spelling').addEventListener('change', (e) => {
    settings.spelling = e.target.checked;
    handwriting.spelling = settings.spelling;
    saveSettings();
    input.requestFrame();
  });
  $('hover-preview').checked = settings.hoverPreview;
  $('hover-preview').addEventListener('change', (e) => {
    settings.hoverPreview = e.target.checked;
    if (!settings.hoverPreview) showHover(null);
    saveSettings();
  });
  $('show-minimap').checked = settings.showMinimap;
  minimap.visible = settings.showMinimap;
  $('show-minimap').addEventListener('change', (e) => {
    settings.showMinimap = e.target.checked;
    minimap.visible = settings.showMinimap;
    saveSettings();
  });
  $('show-latency').checked = settings.showLatency;
  hud.hidden = !settings.showLatency;
  $('show-latency').addEventListener('change', (e) => {
    settings.showLatency = e.target.checked;
    hud.hidden = !settings.showLatency;
    saveSettings();
    input.requestFrame();
  });

  // Record a pen trace: everything the pen, fingers and mouse do, as the
  // engine receives it, saved as a file the engine's replay test can run.
  // Real traces are how a bug in the feel of the ink gets a test.
  const traceButton = $('record-trace');
  traceButton.addEventListener('click', async () => {
    if (!input.trace) {
      input.startTrace();
      traceButton.textContent = 'Stop and save the pen trace';
      toast('Recording the pen. Write, then choose “Stop and save the pen trace” in the menu.', 5000);
      return;
    }
    const trace = input.stopTrace();
    traceButton.textContent = 'Record a pen trace';
    if (!trace.events.length) return toast('Nothing was recorded.');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    await saveFile(new TextEncoder().encode(JSON.stringify(trace)), `bedrock-trace-${stamp}.json`, 'application/json');
  });

  // ----- pictures and text boxes ---------------------------------------------------
  // Insert from the menu (Photos, camera or Files on iPad), by pasting (as
  // the system does it: a picture pastes a picture, text pastes text), or by
  // dropping files. What was inserted is selected with the lasso, ready to
  // move or resize.
  pictures = new PictureLoader(canvas, () => input.requestFrame());
  function afterInsert() {
    selectTool('lasso', { noToggle: true });
    scheduleSave();
    input.requestFrame();
  }
  async function insertPictures(blobs) {
    let n = 0;
    for (const blob of blobs) {
      try {
        const p = await preparePicture(blob);
        if (settings.tool !== 'lasso') selectTool('lasso', { noToggle: true });
        canvas.insert_image(p.file, p.bytes, p.width, p.height);
        n++;
      } catch (e) {
        console.warn('picture not inserted', e);
        toast(`Could not insert ${blob.name || 'the picture'}: it is not a picture this browser can open.`, 4000);
      }
    }
    if (n) afterInsert();
    return n;
  }
  function insertText(raw) {
    const text = tidyText(raw);
    if (!text.trim()) return false;
    if (settings.tool !== 'lasso') selectTool('lasso', { noToggle: true });
    const m = measureText(text, TEXT_SIZE_CSS);
    canvas.insert_text(text, m.width, m.height);
    afterInsert();
    return true;
  }
  const pictureInput = document.createElement('input');
  pictureInput.type = 'file';
  pictureInput.accept = 'image/*';
  pictureInput.multiple = true;
  pictureInput.hidden = true;
  document.body.append(pictureInput);
  pictureInput.addEventListener('change', () => {
    insertPictures([...pictureInput.files]);
    pictureInput.value = '';
  });
  actions['insert-image'] = () => pictureInput.click();
  // The menu's Paste (touch screens have no paste shortcut on a canvas).
  actions.paste = async () => {
    try {
      const items = await navigator.clipboard.read();
      const pics = [];
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) pics.push(await item.getType(type));
      }
      if (pics.length) { await insertPictures(pics); return; }
      for (const item of items) {
        if (item.types.includes('text/plain') && insertText(await (await item.getType('text/plain')).text())) return;
      }
      toast('Nothing to paste', 1500);
    } catch (_) {
      try {
        if (!insertText(await navigator.clipboard.readText())) toast('Nothing to paste', 1500);
      } catch (e) {
        toast('Pasting needs permission to read the clipboard', 2500);
      }
    }
  };
  document.addEventListener('paste', (e) => {
    const t = e.target;
    // Text fields keep the system's own paste.
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
    const data = e.clipboardData;
    if (!data) return;
    const pics = [...data.files].filter((f) => f.type.startsWith('image/'));
    if (pics.length) {
      e.preventDefault();
      insertPictures(pics);
      return;
    }
    const text = data.getData('text/plain');
    if (text && insertText(text)) e.preventDefault();
  });
  stage.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file' || i.type === 'text/plain')) e.preventDefault();
  });
  stage.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); insertPictures(files); return; }
    const text = e.dataTransfer?.getData('text/plain');
    if (text) { e.preventDefault(); insertText(text); }
  });

  // ----- keyboard ----------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) canvas.redo(); else canvas.undo();
      input.requestFrame();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      canvas.redo();
      input.requestFrame();
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      actions.save();
    } else if (!mod && '12345'.includes(e.key) && e.key.length === 1) {
      selectTool(toolButtons[Number(e.key) - 1].dataset.brush, { noToggle: true });
    } else if (!mod && e.key.toLowerCase() === 'e') {
      selectTool('eraser', { noToggle: true });
    } else if (!mod && e.key.toLowerCase() === 'l') {
      selectTool('lasso', { noToggle: true });
    } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && settings.tool === 'lasso') {
      if (canvas.delete_selection()) input.requestFrame();
    } else if (e.key === 'Escape' && settings.tool === 'lasso') {
      canvas.clear_selection();
      input.requestFrame();
    }
  });

  // Flush pending saves when the app is backgrounded or closed (iPad
  // suspends hidden tabs without warning).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { saveNow(); saveCamera(); shareWordsAndSend(); }
  });
  window.addEventListener('pagehide', () => { saveNow(); saveCamera(); shareWordsAndSend(); });

  // ----- start ---------------------------------------------------------------------
  applyDock();
  applyTool();
  const startNote = host ? host.noteId : settings.lastNote;
  if (startNote && store && (await store.get(startNote))) await openNote(startNote);
  else await newNote();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Handy for debugging and for the automated browser tests.
  window.bedrock = { renderLibrary, collect, wordSharer, importPdf, settings, canvas, input, showInk, frameStats, minimap, pictures, insertPictures, insertText, handwriting, recognizerView, wordMenu, selectionView, store, saveNow, openNote, newNote, get backgroundSaving() { return saver.available; }, saveStats, get noteId() { return note.id; }, ready: true };
  document.documentElement.dataset.ready = 'true';
  if (host) {
    host.on('flush', async () => { await saveNow(); await saveCamera(); });
    // Changed elsewhere (sync, another window): that copy wins.
    host.on('reload', () => {
      clearTimeout(saveTimer);
      saveTimer = null;
      return openNote(host.noteId);
    });
    // A search hit or a link to a place in this note: go there and point
    // it out. True if that ink is still on the page.
    host.on('show', ({ strokes } = {}) => showInk(strokes));
    host.ready();
  }
}

main().catch((e) => {
  console.error(e);
  fatal(`Bedrock failed to start: ${e && e.message ? e.message : e}`);
});
