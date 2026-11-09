import init, { Canvas, ZipBuilder, peek_title } from '../pkg/bedrock_web.js';
import { InputController } from './input.js';
import { Minimap } from './minimap.js';
import { Handwriting } from './handwriting.js';
import { NoteStore, randomSeed, newNoteId } from './storage.js';
import { saveFile, pickFile, safeFileName } from './files.js';

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
    recognize: s.recognize !== false,
    spelling: s.spelling !== false,
    // Pressure feel, -100 (firm) .. 100 (soft); 0 is linear.
    pressure: Number.isFinite(s.pressure) ? Math.max(-100, Math.min(100, s.pressure)) : 0,
    lastNote: s.lastNote || null,
  };
}

const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* ignore */ }
}

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

  const store = await NoteStore.open().catch((e) => {
    toast(`Local storage is unavailable, notes will not be saved: ${e}`, 8000);
    return null;
  });

  // ----- state -------------------------------------------------------------
  let note = { id: newNoteId(), created: Date.now() };
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
  let lastRevision = -1;
  const input = new InputController(stage, canvas, {
    onFrame: () => {
      minimap?.update();
      if (handwriting) {
        const rev = canvas.revision();
        if (rev !== lastRevision) { lastRevision = rev; handwriting.schedule(); }
        handwriting.draw();
      }
      if (canvas.revision() !== savedRevision) scheduleSave();
      updateUndo();
      if (!hud.hidden) {
        const [, , zoom] = canvas.camera();
        hud.textContent = `input→frame ${input.latency.last.toFixed(1)} ms (avg ${input.latency.avg.toFixed(1)})\n`
          + `strokes ${canvas.stroke_count()}  chunks ${canvas.chunk_count()}  zoom ${(zoom * 100).toFixed(0)}%`;
      }
    },
    onCommit: () => scheduleSave(),
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
    onTextChanged: () => { savedRevision = -1; scheduleSave(); input.requestFrame(); },
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
  handwriting.spelling = settings.spelling;
  handwriting.loadDictionary().then(() => input.requestFrame());
  const redraw = () => { canvas.redraw(); input.requestFrame(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) redraw(); });
  window.addEventListener('pageshow', redraw);
  window.addEventListener('focus', redraw);
  resize();

  for (const c of [$('base'), $('overlay')]) {
    c.addEventListener('webglcontextlost', (e) => e.preventDefault());
    c.addEventListener('webglcontextrestored', () => {
      canvas.restore_gpu();
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
    /** Send the whole note (after opening one, or if the copies disagree). */
    const reset = (withExport) => {
      canvas.take_changes();
      const hash = canvas.content_hash();
      const bytes = new TextEncoder().encode(canvas.export_json());
      return call({ reset: bytes, export: withExport }, [bytes.buffer]).then((r) => ({ ...r, expected: hash }));
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
        let r = await call({ ops: { meta: canvas.meta_json(), touched, added: `[${added.join(',')}]`, index }, export: true });
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
    const id = note.id, created = note.created, title = canvas.title();
    setSaveState('Saving…');
    saveCamera();
    saving = saving.then(async () => {
      const data = await buildNoteFile();
      await store.put({ id, title, created, modified: now, data });
    }).then(() => {
      savedRevision = rev;
      setSaveState(canvas.revision() === rev ? 'Saved' : 'Saving…');
      settings.lastNote = note.id;
      saveSettings();
      if (!$('library').hidden) renderLibrary();
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

  async function openNote(id) {
    if (saveTimer) await saveNow();
    const rec = store && (await store.get(id));
    if (!rec) return newNote();
    try {
      const warnings = canvas.load(rec.data, ...randomSeed());
      note = { id: rec.id, created: rec.created };
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
    canvas.new_document(...randomSeed());
    note = { id: newNoteId(), created: Date.now() };
    canvas.set_paper('dots');
    applyDocToUi();
    savedRevision = -1; // a new note is saved on its first stroke
    setSaveState('New');
  }

  // ----- library -------------------------------------------------------------
  async function renderLibrary() {
    const list = $('note-list');
    const notes = store ? await store.list() : [];
    list.replaceChildren(...notes.map((n) => {
      const li = document.createElement('li');
      if (n.id === note.id) li.className = 'current';
      const open = document.createElement('button');
      open.className = 'open';
      const strong = document.createElement('strong');
      strong.textContent = n.title || 'Untitled note';
      const small = document.createElement('small');
      small.textContent = new Date(n.modified).toLocaleString();
      open.append(strong, small);
      open.onclick = () => { openNote(n.id); $('library').hidden = true; };
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
      li.append(open, del);
      return li;
    }));
    if (!notes.length) {
      const li = document.createElement('li');
      li.textContent = 'No saved notes yet.';
      li.style.padding = '10px';
      list.append(li);
    }
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
    return settings.tool === 'draw' ? settings.brush : 'eraser';
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
    if (name === 'eraser') {
      settings.tool = 'eraser';
    } else {
      settings.tool = 'draw';
      settings.brush = name;
    }
    setColorEditing(false);
    saveSettings();
    applyTool();
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
    if (settings.tool === 'draw') {
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
    const erasing = settings.tool !== 'draw';
    canvas.set_tool(erasing ? settings.eraserMode : 'draw');
    const b = currentBrush();
    canvas.set_brush(settings.brush, b.color, b.size);
    canvas.set_brush_style(b.style || 'solid', (b.stabilizer || 0) / 100);
    canvas.set_eraser_size(settings.eraserSize);
    for (const btn of toolButtons) {
      const on = erasing ? btn.dataset.tool === 'eraser' : btn.dataset.brush === settings.brush;
      btn.setAttribute('aria-checked', String(on));
      btn.setAttribute('role', 'radio');
    }
    $('eraser-mode').textContent = settings.eraserMode === 'erase-stroke' ? 'S' : 'P';
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
    const erasing = settings.tool !== 'draw';
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
  $('stabilizer').addEventListener('input', (e) => {
    currentBrush().stabilizer = parseInt(e.target.value, 10) || 0;
    saveSettings();
    applyTool();
  });

  for (const btn of toolButtons) {
    const name = btn.dataset.tool === 'eraser' ? 'eraser' : btn.dataset.brush;
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

  const actions = {
    new: () => newNote(),
    open: async () => {
      const f = await pickFile($('file-input'));
      if (!f) return;
      try {
        if (saveTimer) await saveNow();
        const warnings = canvas.load(f.bytes, ...randomSeed());
        note = { id: newNoteId(), created: Date.now() };
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
    'export-all': async () => {
      if (!store) return;
      if (saveTimer) await saveNow();
      const zip = new ZipBuilder();
      const used = new Set();
      for (const meta of await store.list()) {
        const rec = await store.get(meta.id);
        let name = safeFileName(rec.title || peek_title(rec.data) || 'Untitled note', 'bedrock');
        while (used.has(name)) name = name.replace(/(\.bedrock)$/, ` ${rec.id.slice(0, 4)}$1`);
        used.add(name);
        zip.add(name, rec.data);
      }
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
  $('pressure').value = settings.pressure;
  $('pressure-value').textContent = pressureLabel(settings.pressure);
  canvas.set_pressure_softness(settings.pressure / 100);
  $('pressure').addEventListener('input', (e) => {
    settings.pressure = parseInt(e.target.value, 10) || 0;
    $('pressure-value').textContent = pressureLabel(settings.pressure);
    canvas.set_pressure_softness(settings.pressure / 100);
    saveSettings();
    input.requestFrame();
  });
  $('recognize').checked = settings.recognize;
  $('recognize').addEventListener('change', (e) => {
    settings.recognize = e.target.checked;
    handwriting.enabled = settings.recognize;
    if (settings.recognize) handwriting.schedule();
    saveSettings();
  });
  $('spelling').checked = settings.spelling;
  $('spelling').addEventListener('change', (e) => {
    settings.spelling = e.target.checked;
    handwriting.spelling = settings.spelling;
    saveSettings();
    input.requestFrame();
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
    }
  });

  // Flush pending saves when the app is backgrounded or closed (iPad
  // suspends hidden tabs without warning).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { saveNow(); saveCamera(); }
  });
  window.addEventListener('pagehide', () => { saveNow(); saveCamera(); });

  // ----- start ---------------------------------------------------------------------
  applyDock();
  applyTool();
  if (settings.lastNote && store && (await store.get(settings.lastNote))) await openNote(settings.lastNote);
  else await newNote();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Handy for debugging and for the automated browser tests.
  window.bedrock = { canvas, input, minimap, handwriting, store, saveNow, openNote, newNote, get backgroundSaving() { return saver.available; }, saveStats, get noteId() { return note.id; }, ready: true };
  document.documentElement.dataset.ready = 'true';
}

main().catch((e) => {
  console.error(e);
  fatal(`Bedrock failed to start: ${e && e.message ? e.message : e}`);
});
