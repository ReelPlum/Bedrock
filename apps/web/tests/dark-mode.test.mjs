// Dark mode for the chrome (openspec/specs/dark-mode): the bars, menus and
// panels follow the system's light or dark setting, or a host's theme
// (`data-theme` on <html>); the page, its paper and its ink, never change.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launch, openApp } from './helpers.mjs';
import { darkCss, isDark } from '../src/theme.js';

let env;
before(async () => { env = await launch(); });
after(async () => { await env?.close(); });

const open = async (colorScheme) => {
  const context = await env.browser.newContext({ viewport: { width: 1024, height: 768 }, colorScheme });
  return { ...(await openApp(env, { context })), context };
};

/** What the chrome looks like now: the toolbar's colour over the page, its
 *  text, and the page's own paper and ink as drawn on the canvas. */
const look = (page) => page.evaluate(() => {
  const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  const bar = getComputedStyle(document.querySelector('.toolbar'));
  const [r, g, b, a = 1] = rgb(bar.backgroundColor);
  // The brightest of a few points, so a grid line is never taken for the paper.
  const points = [0, 7, 13, 19, 25].map((d) => window.bedrock.canvas.pixel_at(innerWidth / 2 + d, innerHeight / 2 + d));
  const [pr, pg, pb] = points.reduce((m, p) => (p[0] + p[1] + p[2] > m[0] + m[1] + m[2] ? p : m));
  // The chrome is see-through: its colour as it shows over the page.
  const over = [r, g, b].map((c, i) => Math.round(c * a + [pr, pg, pb][i] * (1 - a)));
  return {
    bar: over, text: rgb(getComputedStyle(document.body).color),
    paper: [pr, pg, pb], scheme: getComputedStyle(document.documentElement).colorScheme,
  };
});
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

test('the chrome follows the system dark setting, and the page stays white', async () => {
  const light = await open('light');
  const dark = await open('dark');
  try {
    await dark.page.evaluate(() => t.line(300, 300, 600, 300));
    const l = await look(light.page);
    const d = await look(dark.page);
    assert.ok(lum(l.bar) > 0.85 && lum(l.text) < 0.2, `light chrome: ${l.bar} with dark text`);
    assert.ok(lum(d.bar) < 0.25 && lum(d.text) > 0.85, `dark chrome: ${d.bar} with light text`);
    assert.equal(l.scheme, 'light');
    assert.equal(d.scheme, 'dark', 'native controls (selects, sliders, scroll bars) go dark too');
    assert.deepEqual(d.paper, l.paper, 'the paper is the same colour in dark mode');
    assert.ok(lum(d.paper) > 0.9, `the paper stays white: ${d.paper}`);
    assert.ok(await dark.page.evaluate(() => t.isInk(450, 300)), 'ink keeps its colour on the page');
    assert.deepEqual([...light.errors, ...dark.errors], []);
  } finally {
    await light.context.close();
    await dark.context.close();
  }
});

test('a host can say light or dark over the system setting (Obsidian theme)', async () => {
  const sys = await open('dark');
  try {
    const { page } = sys;
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    const l = await look(page);
    assert.ok(lum(l.bar) > 0.85, 'Obsidian light on a dark system: light chrome');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    assert.ok(lum((await look(page)).bar) < 0.25, 'and back to dark at once, without a reload');
  } finally { await sys.context.close(); }
  const lightSys = await open('light');
  try {
    await lightSys.page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    assert.ok(lum((await look(lightSys.page)).bar) < 0.25, 'Obsidian dark on a light system: dark chrome');
  } finally { await lightSys.context.close(); }
});

// WCAG 2.2 contrast: 4.5:1 for text (AA), 3:1 for icons and outlines.
const channel = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const relLum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => { const [x, y] = [relLum(a), relLum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test('text on the chrome has accessible contrast in light and dark', async () => {
  for (const scheme of ['light', 'dark']) {
    const s = await open(scheme);
    try {
      const pairs = await s.page.evaluate(() => {
        const probe = document.createElement('div');
        document.body.append(probe);
        const color = (v) => {
          probe.style.color = `var(${v})`;
          const m = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
          return { rgb: m.slice(0, 3), a: m[3] ?? 1 };
        };
        const flat = (top, under) => top.rgb.map((c, i) => c * top.a + under[i] * (1 - top.a));
        const paper = color('--paper').rgb;
        const backdrop = color('--backdrop').rgb;
        // The chrome is see-through: over the white page is its lightest.
        const chrome = flat(color('--chrome'), paper);
        const field = color('--field').rgb;
        const out = {};
        for (const v of ['--ink', '--muted', '--accent', '--danger']) out[`${v} on the chrome`] = [color(v).rgb, chrome];
        for (const v of ['--ink', '--muted']) out[`${v} on the loading screen`] = [color(v).rgb, backdrop];
        out['--ink in a text box'] = [color('--ink').rgb, field];
        out['--on-ink on the chosen tool'] = [color('--on-ink').rgb, color('--ink').rgb];
        out['white on a filled button'] = [[255, 255, 255], color('--accent-fill').rgb];
        out['white on a toast'] = [[255, 255, 255], color('--toast').rgb];
        probe.remove();
        return out;
      });
      for (const [what, [fg, bg]] of Object.entries(pairs)) {
        const c = contrast(fg, bg);
        assert.ok(c >= 4.5, `${scheme}: ${what} is ${c.toFixed(2)}:1, under 4.5:1`);
      }
    } finally { await s.context.close(); }
  }
});

test('the minimap keeps the paper colour inside its dark frame', async () => {
  const s = await open('dark');
  try {
    const bg = await s.page.evaluate(() => getComputedStyle(document.querySelector('.minimap canvas')).backgroundColor);
    const [r, g, b] = bg.match(/[\d.]+/g).map(Number);
    assert.ok(lum([r, g, b]) > 0.9, `black ink stays visible in the minimap: ${bg}`);
  } finally { await s.context.close(); }
});

test('the dark colours for the system and for a host are the same', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const system = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/)[1];
  const host = css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)[1];
  const tokens = (s) => s.split(';').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(tokens(host), tokens(system));
});

test('panels with their own styles go dark the same way', () => {
  const css = darkCss('.a, .b { color: #eee; }\n.c { background: #111; }');
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n:root:not\(\[data-theme="light"\]\) \.a, :root:not\(\[data-theme="light"\]\) \.b \{ color: #eee; \}/);
  assert.match(css, /\n:root\[data-theme="dark"\] \.c \{ background: #111; \}/);
  const doc = (theme, dark) => ({ documentElement: { dataset: theme ? { theme } : {} }, defaultView: { matchMedia: () => ({ matches: dark }) } });
  assert.equal(isDark(doc(null, true)), true);
  assert.equal(isDark(doc('light', true)), false);
  assert.equal(isDark(doc('dark', false)), true);
  assert.equal(isDark(doc(null, false)), false);
});
