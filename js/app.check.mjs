// js/app.check.mjs — run the real LifeLab app under a stub DOM, in Node, with no
// browser and no Playwright.
//
//   node js/app.check.mjs
//
// It extracts the inline script from index.html, loads js/bitboard.js and that
// script into a `node:vm` context whose `document`/`canvas`/`navigator` are
// minimal stubs, then drives the app through `window.LifeLab` and asserts the
// behaviour the app promises. The canvas stub's 2d context answers every method
// with a no-op (via a Proxy), but createImageData returns a real buffer so the
// ImageData render path can be inspected pixel by pixel.
//
// Exits non-zero on any failure.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { PATTERNS } from '../tools/bench-common.mjs';

const INDEX_URL = new URL('../index.html', import.meta.url);
const ROOT_URL = new URL('../', import.meta.url);

const BG_PIXEL = 0xff17110d;
const CELL_PIXEL = 0xffffa658;

// ---------------------------------------------------------------------------
// DOM / canvas stubs
// ---------------------------------------------------------------------------

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => { c.forEach(x => set.add(x)); },
    remove: (...c) => { c.forEach(x => set.delete(x)); },
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    contains: (c) => set.has(c),
  };
}

function makeElement(tag, view) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    textContent: '',
    innerHTML: '',
    disabled: false,
    value: '',
    options: [],
    width: 0,
    height: 0,
    classList: null,
    appendChild(c) { el.children.push(c); return c; },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: view.width, bottom: view.height, width: view.width, height: view.height }; },
    requestFullscreen() {},
    click() {},
    focus() {},
    remove() {},
  };
  el.classList = makeClassList();
  return el;
}

/** A 2d context where every method is a no-op, but draws are counted. */
function makeCtx(canvas, log) {
  const target = {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px sans-serif',
    globalAlpha: 1,
    createImageData(w, h) {
      const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      log.imageData = img;
      return img;
    },
    getImageData(x, y, w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    measureText(t) { return { width: String(t).length * 6 }; },
    putImageData() { log.putImageData++; },
    fillRect() { log.fillRect++; },
    clearRect() { log.clearRect++; },
    rect() { log.rect++; },
    fill() { log.fill++; },
    stroke() { log.stroke++; },
    beginPath() { log.beginPath++; },
    moveTo() {}, lineTo() {}, closePath() {}, arc() {},
    save() {}, restore() {}, translate() {}, scale() {}, setTransform() {},
    drawImage() { log.drawImage++; },
  };
  // Anything the app calls that is not listed above is a no-op too.
  return new Proxy(target, {
    get(t, p) {
      if (typeof p === 'symbol' || p in t) return t[p];
      const fn = () => {};
      t[p] = fn;
      return fn;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function makeCanvas(log, view) {
  const el = makeElement('canvas', view);
  el._ctx = null;
  el.getContext = (type) => {
    if (type !== '2d') return null;
    if (!el._ctx) el._ctx = makeCtx(el, log);
    return el._ctx;
  };
  el.toBlob = (cb) => cb(new Blob(['png-bytes']));
  return el;
}

const TAB_CATEGORIES = ['guns', 'ships', 'osc', 'still', 'meth', 'seeds'];
const BRUSH_SIZES = ['1', '2', '3', '5'];

/**
 * Build one app instance. Returns the vm sandbox, the app's `window.LifeLab`
 * API, the stub document and the draw log.
 */
export async function createApp({ width = 1020, height = 847, hash = '' } = {}) {
  const html = readFileSync(INDEX_URL, 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1])
    .filter(src => src.includes('window.LifeLab'));
  if (blocks.length !== 1) throw new Error(`expected one app inline script, found ${blocks.length}`);
  const bitboardSrc = readFileSync(new URL('./bitboard.js', import.meta.url), 'utf8');

  const log = { rect: 0, fillRect: 0, fill: 0, stroke: 0, beginPath: 0, putImageData: 0, drawImage: 0, clearRect: 0, imageData: null };
  const warnings = [];
  const errors = [];
  const view = { width, height };

  const registry = new Map();
  const tabs = TAB_CATEGORIES.map(cat => { const t = makeElement('button', view); t.dataset.cat = cat; return t; });
  tabs[0].classList.add('active');
  const brushButtons = BRUSH_SIZES.map(n => { const b = makeElement('button', view); b.dataset.brush = n; return b; });
  const toolIds = ['tool-draw', 'tool-erase', 'tool-pan'];

  const getElementById = (id) => {
    if (!registry.has(id)) {
      if (id === 'gridCanvas') {
        const c = makeCanvas(log, view);
        c.width = width; c.height = height;
        registry.set(id, c);
      } else if (id === 'pop-chart') {
        const c = makeCanvas(log, view);
        c.width = 248; c.height = 44;
        registry.set(id, c);
      } else if (id === 'container') {
        const c = makeElement('div', view);
        c.clientWidth = width;
        c.clientHeight = height;
        registry.set(id, c);
      } else if (id === 'rule-select') {
        const s = makeElement('select', view);
        s.value = 'B3/S23';
        s.options = ['B3/S23', 'B36/S23', 'B2/S', 'B3678/S34678'].map(v => ({ value: v }));
        registry.set(id, s);
      } else {
        registry.set(id, makeElement('div', view));
      }
    }
    return registry.get(id);
  };

  const document = {
    getElementById,
    querySelector(sel) {
      if (sel === '.tab.active') return tabs[0];
      if (sel === '.modal-overlay.active') return null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.tab') return tabs;
      if (sel === '.brush-btn') return brushButtons;
      if (sel === '.tool-btn') return toolIds.map(getElementById);
      return [];
    },
    createElement(tag) { return tag === 'canvas' ? makeCanvas(log, view) : makeElement(tag, view); },
    addEventListener() {},
    removeEventListener() {},
    fullscreenElement: null,
    exitFullscreen() {},
    body: makeElement('body', view),
    documentElement: makeElement('html', view),
  };

  const sandbox = {
    console: {
      log: () => {},
      warn: (...a) => warnings.push(a.join(' ')),
      error: (...a) => errors.push(a.join(' ')),
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
    fetch: async (url) => {
      const path = new URL(String(url), INDEX_URL);
      const text = readFileSync(path, 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    },
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    location: { hash, origin: 'http://localhost', pathname: '/index.html' },    history: { replaceState() {}, pushState() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    confirm: () => true,
    alert: () => {},
    prompt: () => null,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    scrollTo() {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URL,
    Blob,
  };
  vm.createContext(sandbox);
  vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', sandbox);

  vm.runInContext(bitboardSrc, sandbox, { filename: 'js/bitboard.js' });
  vm.runInContext(blocks[0], sandbox, { filename: 'index.html#inline' });

  // `init()` kicked off loadPatterns(); let its fetches settle.
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));

  const api = sandbox.window.LifeLab;
  if (!api) throw new Error('the inline script did not publish window.LifeLab');
  const canvas = getElementById('gridCanvas');

  return {
    sandbox, api, document, canvas, log, warnings, errors,
    /** Clear the draw counters between assertions. */
    resetLog() { for (const k of Object.keys(log)) if (typeof log[k] === 'number') log[k] = 0; log.imageData = null; },
    /** Draw calls seen since the last resetLog(). */
    makeElement: (tag) => makeElement(tag, view),
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** Translation-invariant shape signature, so "same shape" ignores position. */
export function shapeSig(cells) {
  if (!cells.length) return { sig: '', minX: 0, minY: 0 };
  let minX = Infinity, minY = Infinity;
  for (const [x, y] of cells) { if (x < minX) minX = x; if (y < minY) minY = y; }
  return { sig: cells.map(([x, y]) => `${x - minX},${y - minY}`).sort().join(' '), minX, minY };
}

export async function runChecks() {
  const app = await createApp();
  const { api, canvas, log } = app;
  const results = [];
  const check = (name, got, want) => results.push({ name, ok: got === want, got, want });

  // -- public surface -------------------------------------------------------
  {
    const expected = ['clear', 'setCell', 'getCell', 'placeCells', 'place', 'cells', 'population',
      'generation', 'step', 'stepN', 'setRule', 'rule', 'encodeRLE', 'loadRLE', 'exportPNG',
      'copyRLE', 'shareURL', 'zoomToFit', 'toggleGrid', 'toggleFullscreen', 'setBrush', 'setTurbo',
      'view', 'setView'];
    const missing = expected.filter(k => typeof api[k] !== 'function');
    check('window.LifeLab exposes the whole public surface', missing.join(',') || 'ok', 'ok');
    check('pattern library loaded from patterns/*.json', api.patterns().length, 25);
  }

  // -- classic patterns, through the app's own API --------------------------
  const sig = () => shapeSig(api.cells());

  {
    api.clear(); api.placeCells(PATTERNS.BLINKER);
    const s0 = sig().sig;
    api.stepN(1);
    const s1 = sig().sig;
    api.stepN(1);
    check('blinker: changes at gen 1', s1 !== s0, true);
    check('blinker: period 2', sig().sig, s0);
    check('blinker: 3 cells', api.population(), 3);
  }

  {
    api.clear(); api.placeCells(PATTERNS.BLOCK);
    const s0 = sig().sig;
    api.stepN(50);
    check('block: still life after 50 generations', sig().sig, s0);
    check('block: 4 cells', api.population(), 4);
  }

  {
    api.clear(); api.placeCells(PATTERNS.GLIDER);
    const before = sig();
    api.stepN(4);
    const after = sig();
    check('glider: same shape after 4 generations', after.sig, before.sig);
    check('glider: translated (1,1)', `${after.minX - before.minX},${after.minY - before.minY}`, '1,1');
    check('glider: 5 cells', api.population(), 5);
  }

  {
    api.clear(); api.placeCells(PATTERNS.R_PENTOMINO);
    api.stepN(1103);
    check('r-pentomino: generation 1103', api.generation(), 1103);
    check('r-pentomino: exactly 116 cells at gen 1103', api.population(), 116);
    check('r-pentomino: cells() agrees', api.cells().length, 116);
  }

  {
    api.clear(); api.placeCells(PATTERNS.DIEHARD);
    api.stepN(129);
    const alive = api.population();
    api.stepN(1);
    check('diehard: alive at gen 129', alive > 0, true);
    check('diehard: dies at generation 130', api.population(), 0);
    check('diehard: generation 130', api.generation(), 130);
  }

  {
    api.clear(); api.placeCells(PATTERNS.ACORN);
    api.stepN(5206);
    check('acorn: generation 5206', api.generation(), 5206);
    check('acorn: settles at 633 cells', api.population(), 633);
  }

  {
    api.clear(); api.placeCells(PATTERNS.GOSPER_GUN);
    api.stepN(1000);
    const p1 = api.population();
    api.stepN(1000);
    check('gosper gun: still grows at gen 2000', api.population() > p1, true);
  }

  // -- pattern library: place -> right cell count ---------------------------
  {
    const spot = [['Gosper Gun', 36], ['Pulsar', 48], ['Honey Farm', 24]];
    for (const [name, count] of spot) {
      api.clear();
      api.setRule('B3/S23');
      const placed = api.place(name);
      check(`library: place('${name}') returns true`, placed, true);
      check(`library: '${name}' lands with ${count} cells`, api.population(), count);
      const b = api.bounds();
      check(`library: '${name}' has a real bounding box`,
        !!b && b.maxX >= b.minX && b.maxY >= b.minY, true);
    }
  }

  // -- RLE round-trip -------------------------------------------------------
  for (const name of ['Glider', 'Pulsar']) {
    api.setRule('B3/S23');
    api.clear();
    api.place(name);
    const before = sig().sig;
    const rle = api.encodeRLE();
    check(`RLE export '${name}': has an x = header`, /^x = \d+, y = \d+, rule = B3\/S23/.test(rle), true);
    api.clear();
    const loaded = api.loadRLE(rle);
    check(`RLE round-trip '${name}': loadRLE returns true`, loaded, true);
    check(`RLE round-trip '${name}': same shape`, sig().sig, before);
  }

  // -- brush painting -------------------------------------------------------
  {
    api.clear();
    api.setView(1, 0, 0);          // cellSize 10, zoom 1 -> 10px cells at the origin
    api.setBrush(1);
    canvas.onmousedown({ clientX: 5, clientY: 5, button: 0, buttons: 1 });
    canvas.onmouseup({});
    check('brush 1: paints the cell under the cursor', api.getCell(0, 0), 1);
    check('brush 1: paints exactly one cell', api.population(), 1);

    api.clear();
    api.setBrush(3);               // disc: r = 2, dx*dx + dy*dy <= 4.8
    canvas.onmousedown({ clientX: 105, clientY: 105, button: 0, buttons: 1 });
    canvas.onmouseup({});
    // The app's brush 3 is a radius-2 disc without the (2,2) corners: the 3x3
    // block plus the four axial cells at distance 2 = 13 cells.
    let allThere = true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!api.getCell(10 + dx, 10 + dy)) allThere = false;
    for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) if (!api.getCell(10 + dx, 10 + dy)) allThere = false;
    check('brush 3: every cell of the disc is set', allThere, true);
    check('brush 3: the diagonal corners are not', api.getCell(12, 12) + api.getCell(8, 8), 0);
    check('brush 3: paints a 13-cell disc', api.population(), 13);

    api.clear();
    api.setBrush(1);
    canvas.onmousedown({ clientX: 5, clientY: 5, button: 2, buttons: 2 });   // right-drag erases
    canvas.onmouseup({});
    check('right mouse button erases', api.population(), 0);
    api.setBrush(1);
  }

  // -- step back / forward --------------------------------------------------
  {
    api.clear();
    api.placeCells(PATTERNS.BLINKER);
    const before = { sig: sig().sig, pop: api.population() };
    api.step();                       // pushes the pre-step state onto `history`
    check('step(): advances a generation', api.generation(), 1);
    check('step(): the blinker rotated', sig().sig !== before.sig, true);
    api.stepBack();
    check('stepBack(): generation restored', api.generation(), 0);
    check('stepBack(): shape restored', sig().sig, before.sig);
    check('stepBack(): population restored', api.population(), before.pop);
    api.stepForward();
    check('stepForward(): generation restored', api.generation(), 1);
    check('stepForward(): back to the stepped shape', sig().sig !== before.sig, true);
    api.stepBack(); api.stepBack();
    check('stepBack(): empty history is a no-op', api.generation(), 0);
  }

  // -- renderer: which path, and does it batch runs? ------------------------
  {
    api.clear();
    api.placeCells(PATTERNS.BLINKER);
    api.setView(1, 0, 0);                       // 10px cells
    app.resetLog();
    api.setView(1, 0, 0);                       // force a render
    check('render: >=3px uses the run-batched canvas path', api.renderMode(), 'runs');
    check('render: one rect for a 3-cell run (not 3)', log.rect, 1);
    check('render: canvas path does not touch ImageData', log.putImageData, 0);

    app.resetLog();
    api.setView(0.1, 0, 0);                     // 1px cells
    check('render: <3px switches to the ImageData path', api.renderMode(), 'imagedata');
    check('render: ImageData path does one putImageData', log.putImageData, 1);
    check('render: ImageData path draws no rects', log.rect, 0);
    {
      const img = log.imageData;
      const u32 = new Uint32Array(img.data.buffer);
      let alive = 0, bg = 0;
      for (let i = 0; i < u32.length; i++) { if (u32[i] === CELL_PIXEL) alive++; else if (u32[i] === BG_PIXEL) bg++; }
      check('render: one pixel written per visible cell', alive, 3);
      check('render: the rest of the buffer is background', bg, u32.length - 3);
    }

    api.setView(0.3, 0, 0);                     // exactly 3px
    check('render: 3px cells are still the canvas path', api.renderMode(), 'runs');
    api.setView(0.299, 0, 0);                   // 2.99px
    check('render: 2.99px cells switch to ImageData', api.renderMode(), 'imagedata');

    api.setView(1, 0, 0);
    check('render: zoomToFit works', (api.zoomToFit(), api.view().zoom > 0), true);
  }

  // -- grid lines + view ----------------------------------------------------
  {
    api.setView(1, 0, 0);
    app.resetLog();
    api.toggleGrid();                           // grid off
    check('toggleGrid(): hides the grid lines', log.stroke, 0);
    api.toggleGrid();                           // grid on, cells >= 4px
    check('toggleGrid(): shows the grid lines again', log.stroke, 1);
  }

  // -- rules ----------------------------------------------------------------
  {
    api.setRule('B36/S23');
    check('setRule(): rule key round-trips', api.rule(), 'B36/S23');
    api.clear(); api.placeCells(PATTERNS.R_PENTOMINO);
    api.stepN(20);
    const highLife = sig().sig;
    api.setRule('B3/S23');
    api.clear(); api.placeCells(PATTERNS.R_PENTOMINO);
    api.stepN(20);
    check('setRule(): HighLife differs from Life here', sig().sig !== highLife, true);
    check('setRule(): back to B3/S23', api.rule(), 'B3/S23');
  }

  // -- stats panel ----------------------------------------------------------
  {
    api.setRule('B3/S23');
    api.clear(); api.placeCells(PATTERNS.BLINKER);
    api.stepN(1);
    check('stats: population panel matches the universe', app.document.getElementById('pop').textContent, api.population());
    check('stats: generation panel matches', app.document.getElementById('gen').textContent, api.generation());
  }

  // -- exports and the share path ------------------------------------------
  {
    api.setRule('B3/S23');
    api.clear();
    api.placeCells(PATTERNS.GLIDER);
    app.resetLog();
    api.exportPNG();
    // The export canvas is drawn with one fillRect per run of set bits plus the
    // background: a glider is 3 runs (1 + 1 + 3 cells).
    check('exportPNG(): draws the glider as 3 runs', log.fillRect, 4);
    check('exportPNG(): no errors', app.errors.length, 0);

    let shared = true;
    try { api.shareURL(); } catch { shared = false; }
    check('shareURL(): builds a link without throwing', shared, true);
  }

  // -- #rle= share links load on startup ------------------------------------
  {
    const rle = 'x = 3, y = 3, rule = B3/S23\nbo$2bo$3o!';
    const linked = await createApp({ hash: '#rle=' + encodeURIComponent(rle) });
    check('#rle=: the shared pattern is loaded at startup', linked.api.population(), 5);
    check('#rle=: the rule from the link is applied', linked.api.rule(), 'B3/S23');
    check('#rle=: no console errors', linked.errors.length, 0);
  }

  // Report
  const pad = Math.max(...results.map(r => r.name.length));
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(pad)}${r.ok ? '' : `  got ${JSON.stringify(r.got)}, want ${JSON.stringify(r.want)}`}`);
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} app checks passed`);
  if (app.errors.length) console.log(`(console.error from the app: ${app.errors.join(' | ')})`);
  return { results, ok: failed.length === 0 };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { ok } = await runChecks();
  process.exit(ok ? 0 : 1);
}
