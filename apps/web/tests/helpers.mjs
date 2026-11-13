// Shared helpers for the browser tests (node:test + Playwright Chromium).
import { createRequire } from 'node:module';
import { startServer } from '../serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export async function launch() {
  const server = await startServer(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  // SwiftShader gives headless Chromium a software WebGL2 implementation.
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
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
      /** Draw a straight pen line in `steps` moves. */
      async line(x0, y0, x1, y1, { id = 1, type = 'pen', pressure = 0.5, steps = 20, tiltX = 0 } = {}) {
        ev('pointerdown', id, type, x0, y0, { pressure, tiltX });
        for (let i = 1; i <= steps; i++) {
          const f = i / steps;
          ev('pointermove', id, type, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, { pressure, tiltX });
        }
        ev('pointerup', id, type, x1, y1, { pressure: 0 });
        await frame();
      },
      /** Count dark-ish pixels along a vertical scanline at x between y0..y1. */
      thickness(x, y0, y1, threshold = 700) {
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
