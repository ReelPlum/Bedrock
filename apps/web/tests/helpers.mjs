// Shared helpers for the browser tests (node:test + Playwright Chromium).
import { createRequire } from 'node:module';
import { startServer } from '../serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

/** Every page these tests open acts as if no backend address were built
 *  in (`bedrockNoBuiltInApi`, honoured only on this computer), so no test
 *  can reach the real backend. A test points the app at a pretend backend
 *  by storing an address, as before. */
export function withoutBuiltInApi(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const ctx = await newContext(...args);
    await ctx.addInitScript(() => { window.bedrockNoBuiltInApi = true; });
    return ctx;
  };
  return browser;
}

export async function launch() {
  const server = await startServer(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  // SwiftShader gives headless Chromium a software WebGL2 implementation.
  const browser = withoutBuiltInApi(await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  }));
  return {
    url,
    browser,
    async close() {
      await browser.close();
      server.close();
    },
  };
}

export async function openApp(env, { context, viewport = { width: 1024, height: 768 } } = {}) {
  const ctx = context || (await env.browser.newContext({ viewport }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(env.url);
  await page.waitForFunction(() => window.bedrock && window.bedrock.ready, null, { timeout: 20000 });
  await installPointerHelpers(page);
  return { page, ctx, errors };
}

/** Adds window.t.* helpers that dispatch realistic PointerEvents on the stage. */
export async function installPointerHelpers(page) {
  await page.evaluate(() => {
    const stage = document.getElementById('stage');
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    function ev(type, id, pointerType, x, y, opts = {}) {
      const e = new PointerEvent(type, {
        pointerId: id, pointerType, clientX: x, clientY: y, bubbles: true, cancelable: true,
        pressure: opts.pressure ?? (type === 'pointerup' ? 0 : 0.5),
        tiltX: opts.tiltX ?? 0, tiltY: opts.tiltY ?? 0,
        buttons: type === 'pointerup' ? 0 : (opts.buttons ?? 1), button: opts.button ?? 0,
        isPrimary: true,
      });
      // Events made in a script all carry about the same time; a real pen
      // reports one every few milliseconds (`time`, like e.timeStamp).
      if (opts.time != null) Object.defineProperty(e, 'timeStamp', { value: opts.time });
      if (opts.coalesced) Object.defineProperty(e, 'getCoalescedEvents', { value: () => opts.coalesced });
      if (opts.predicted) Object.defineProperty(e, 'getPredictedEvents', { value: () => opts.predicted });
      stage.dispatchEvent(e);
      return e;
    }
    window.t = {
      ev,
      frame,
      /** Draw a straight pen line in `steps` moves, `stepMs` apart.
       *  Every event carries a time it was given, never the time the
       *  browser happened to make it: with those, a slow computer spread
       *  the samples over enough milliseconds for the app to judge the
       *  line timed (and very fast, so thinner) where a fast one did not
       *  (CI: "pressure changes the line width"). The default, 0, is a
       *  line without timing, as the tests were written against. */
      async line(x0, y0, x1, y1, { id = 1, type = 'pen', pressure = 0.5, steps = 20, tiltX = 0, stepMs = 0 } = {}) {
        const t0 = performance.now();
        ev('pointerdown', id, type, x0, y0, { pressure, tiltX, time: t0 });
        for (let i = 1; i <= steps; i++) {
          const f = i / steps;
          ev('pointermove', id, type, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, { pressure, tiltX, time: t0 + i * stepMs });
        }
        ev('pointerup', id, type, x1, y1, { pressure: 0, time: t0 + steps * stepMs });
        await frame();
      },
      /** Count ink pixels along a vertical scanline at x between y0..y1.
       *  The threshold sits below the lines of grid paper (670 here), the
       *  paper of new notes, which were otherwise counted as ink too. */
      thickness(x, y0, y1, threshold = 600) {
        const c = window.bedrock.canvas;
        let n = 0;
        for (let y = y0; y <= y1; y++) {
          const [r, g, b] = c.pixel_at(x, y);
          if (r + g + b < threshold) n++;
        }
        return n;
      },
      isInk(x, y) {
        const [r, g, b] = window.bedrock.canvas.pixel_at(x, y);
        return r + g + b < 400;
      },
    };
  });
}

/** A two page PDF written like GoodNotes writes one, as bytes: page 1 has
 *  four strokes ("hi" and "ok" in its hidden text), page 2 one. */
export function goodnotesLikePdf() {
  const stroke = (x, y) => {
    let c = '';
    for (const [a, b] of [[[x, y], [x + 5, y + 10]], [[x + 5, y + 10], [x + 10, y + 20]]]) {
      c += `${a[0]} ${a[1]} m ${b[0]} ${b[1]} l ${b[0] + 2} ${b[1]} l ${a[0] + 2} ${a[1]} l h `;
    }
    return `${c}f\n`;
  };
  const page1 = '0.1 0.1 0.1 sc\n' + stroke(100, 300) + stroke(115, 300) + stroke(130, 300) + stroke(300, 300)
    + '3 Tr q 1 0 0 1 5100 5302 cm BT 20 0 0 20 0 0 Tm /F1 1 Tf (hi) Tj ET Q\n'
    + 'q 1 0 0 1 5300 5302 cm BT 20 0 0 20 0 0 Tm /F1 1 Tf (ok) Tj ET Q\n';
  const page2 = '0 0 1 sc\n' + stroke(200, 200);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [0 0 600 400] >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    `<< /Length ${page1.length} >>\nstream\n${page1}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>',
    `<< /Length ${page2.length} >>\nstream\n${page2}\nendstream`,
  ];
  const text = `%PDF-1.4\n${objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('')}trailer << /Root 1 0 R >>\n%%EOF\n`;
  return [...text].map((c) => c.charCodeAt(0));
}
