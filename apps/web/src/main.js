import init, { Canvas, ZipBuilder, peek_title } from '../pkg/bedrock_web.js';
import { InputController } from './input.js';
import { NoteStore, randomSeed, newNoteId } from './storage.js';
import { saveFile, pickFile, safeFileName } from './files.js';

const $ = (id) => document.getElementById(id);

const PALETTES = {
  ink: ['#1c1c1e', '#2f6bff', '#e53935', '#2e7d32', '#8e24aa'],
  highlighter: ['#ffe14d', '#9be37a', '#ff8fc8', '#7cc6ff', '#ffb35c'],
};
const DEFAULT_BRUSHES = {
  pen: { color: '#1c1c1e', size: 2.5 },
  pencil: { color: '#1c1c1e', size: 2 },
  fountain: { color: '#1c1c1e', size: 3 },
  marker: { color: '#2f6bff', size: 6 },
  highlighter: { color: '#ffe14d', size: 6 },
};
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
    brushes: { ...structuredClone(DEFAULT_BRUSHES), ...(s.brushes || {}) },
    fingerDraw: !!s.fingerDraw,
    showLatency: !!s.showLatency,
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
  const input = new InputController(stage, canvas, {
    onFrame: () => {
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
  resize();

  for (const c of [$('base'), $('overlay')]) {
    c.addEventListener('webglcontextlost', (e) => e.preventDefault());
    c.addEventListener('webglcontextrestored', () => {
      canvas.restore_gpu();
      input.requestFrame();
    });
  }

  // ----- notes: load / save -------------------------------------------------
  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!store) return;
    if (canvas.is_drawing()) return scheduleSave();
    const rev = canvas.revision();
    const now = Date.now();
    note.modified = now;
    canvas.set_times(note.created, now);
    const data = canvas.export_bedrock();
    const record = { id: note.id, title: canvas.title(), created: note.created, modified: now, data };
    setSaveState('Saving…');
    saveCamera();
    saving = saving.then(() => store.put(record)).then(() => {
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
    canvas.take_changes();
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
    const palette = settings.brush === 'highlighter' ? PALETTES.highlighter : PALETTES.ink;
    colorsEl.replaceChildren(...palette.map((c) => {
      const sw = document.createElement('button');
      sw.className = 'swatch';
      sw.setAttribute('role', 'radio');
      sw.setAttribute('aria-label', `Color ${c}`);
      sw.setAttribute('aria-checked', String(!erasing && c.toLowerCase() === b.color.toLowerCase()));
      const dot = document.createElement('span');
      dot.style.background = c;
      sw.append(dot);
      sw.onclick = () => {
        b.color = c;
        settings.tool = 'draw';
        saveSettings();
        applyTool();
      };
      return sw;
    }));
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
    $('stroke-brush').textContent = settings.brush;
    for (const btn of strokePop.querySelectorAll('[data-style]')) {
      btn.setAttribute('aria-checked', String(btn.dataset.style === (b.style || 'solid')));
    }
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
    if (settings.tool !== 'draw') { settings.tool = 'draw'; saveSettings(); applyTool(); }
    setStrokePop(strokePop.hidden);
  });
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
    btn.addEventListener('click', () => {
      if (btn.dataset.tool === 'eraser') {
        if (settings.tool === 'eraser') {
          settings.eraserMode = settings.eraserMode === 'erase-stroke' ? 'erase-partial' : 'erase-stroke';
          toast(settings.eraserMode === 'erase-stroke' ? 'Eraser: whole strokes' : 'Eraser: partial', 1500);
        }
        settings.tool = 'eraser';
      } else {
        settings.tool = 'draw';
        settings.brush = btn.dataset.brush;
      }
      saveSettings();
      applyTool();
    });
  }
  $('color-input').addEventListener('input', (e) => {
    currentBrush().color = e.target.value;
    settings.tool = 'draw';
    saveSettings();
    applyTool();
  });
  $('size').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (settings.tool === 'draw') currentBrush().size = v; else settings.eraserSize = v;
    saveSettings();
    applyTool();
  });

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
      toolButtons[Number(e.key) - 1].click();
    } else if (!mod && e.key.toLowerCase() === 'e') {
      toolButtons[5].click();
    }
  });

  // Flush pending saves when the app is backgrounded or closed (iPad
  // suspends hidden tabs without warning).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { saveNow(); saveCamera(); }
  });
  window.addEventListener('pagehide', () => { saveNow(); saveCamera(); });

  // ----- start ---------------------------------------------------------------------
  applyTool();
  if (settings.lastNote && store && (await store.get(settings.lastNote))) await openNote(settings.lastNote);
  else await newNote();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Handy for debugging and for the automated browser tests.
  window.bedrock = { canvas, input, store, saveNow, openNote, newNote, get noteId() { return note.id; }, ready: true };
  document.documentElement.dataset.ready = 'true';
}

main().catch((e) => {
  console.error(e);
  fatal(`Bedrock failed to start: ${e && e.message ? e.message : e}`);
});
