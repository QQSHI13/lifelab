// How fast can the browser actually paint 10k / 100k / 1M cells?
//
//   node tools/bench-render.mjs                 # all strategies, all scales
//   node tools/bench-render.mjs --quick         # 10k + 100k only
//   node tools/bench-render.mjs --shots         # also write PNGs to /tmp/opencode
//
// Runs a scratch copy of the site (tools/bench-render.html plus a snapshot of
// index.html) over `python3 -m http.server` and drives it with Playwright and
// the system Thorium build. Nothing under the repo is modified: the copy lives
// in /tmp/opencode/render-bench.
//
// The four renderers are described in tools/bench-render.html. Each is timed as
// N draws followed by one GPU sync (getImageData / readPixels), so the numbers
// include the GPU and the compositor rather than just the JS call overhead.

import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { table, ms } from './bench-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SCRATCH = join('/tmp/opencode', 'render-bench');
const PORT = Number(process.env.LIFELAB_BENCH_PORT || 18790) + Math.floor(Math.random() * 40);

const argv = process.argv.slice(2);
const quick = argv.includes('--quick');
const shots = argv.includes('--shots');

// ---------------------------------------------------------------------------
// Playwright, wherever it is installed (it is a global install on this box)
// ---------------------------------------------------------------------------

async function loadPlaywright() {
  const candidates = [
    'playwright',
    join(process.env.npm_config_prefix || '/home/qq/.npm-global', 'lib/node_modules/playwright'),
    '/usr/lib/node_modules/playwright',
  ];
  for (const c of candidates) {
    try {
      const mod = await import(c.startsWith('/') ? 'file://' + join(c, 'index.js') : c);
      return mod.default ?? mod;
    } catch { /* try the next candidate */ }
  }
  throw new Error('playwright not found; install it or set LIFELAB_PLAYWRIGHT to its path');
}

// ---------------------------------------------------------------------------
// Scratch copy + static server
// ---------------------------------------------------------------------------

function prepareScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(join(HERE, 'bench-render.html'), join(SCRATCH, 'bench-render.html'));
  // a snapshot of the real app, so the harness can cross-check its renderer
  for (const f of ['index.html', 'manifest.json']) {
    if (existsSync(join(REPO, f))) cpSync(join(REPO, f), join(SCRATCH, f));
  }
  let commit = 'unknown';
  try { commit = readFileSync(join(REPO, '.git/HEAD'), 'utf8').trim(); } catch { /* not a checkout */ }
  return commit;
}

function startServer() {
  const p = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: SCRATCH, stdio: ['ignore', 'ignore', 'ignore'],
  });
  return p;
}

async function waitForServer(url, timeoutMs = 8000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Run one scale through every renderer
// ---------------------------------------------------------------------------

const SCALES = quick
  ? [{ label: '10k', target: 10000 }, { label: '100k', target: 100000 }]
  : [{ label: '10k', target: 10000 }, { label: '100k', target: 100000 }, { label: '1M', target: 1000000 }];

const ZOOMS = [
  { name: 'in (8px)', cw: 8 },
  { name: 'out (1px)', cw: 1 },
];

const NAMES = {
  A: 'canvas path',
  B: 'ImageData @canvas',
  C: 'WebGL points',
  D: 'offscreen + drawImage',
};

async function main() {
  const commit = prepareScratch();
  const server = startServer();
  const url = `http://127.0.0.1:${PORT}/bench-render.html`;
  let browser;
  try {
    if (!(await waitForServer(`http://127.0.0.1:${PORT}/`))) throw new Error('python3 http.server did not come up');
    const playwright = await loadPlaywright();
    const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
    if (!chromium) throw new Error('playwright has no chromium export');

    browser = await chromium.launch({
      executablePath: '/usr/bin/thorium-browser',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('console', m => { if (m.type() === 'error') console.error('  [page]', m.text()); });
    page.on('pageerror', e => console.error('  [page error]', String(e)));

    console.log(`scratch copy: ${SCRATCH}`);
    console.log(`app snapshot: ${commit} (index.html is copied, never modified)`);
    console.log(`browser: Thorium via Playwright, canvas 1200x800\n`);

    await page.goto(url + (shots ? '?preserve=1' : ''), { waitUntil: 'load' });
    const glInfo = await page.evaluate(() => window.__bench.init());
    console.log(`webgl: ${glInfo.gl.ok ? glInfo.gl.renderer : 'unavailable'}`
      + (glInfo.gl.ok ? ` (point size ${glInfo.gl.pointSizeRange[0]}..${glInfo.gl.pointSizeRange[1]})` : ''));
    if (glInfo.gl.ok && glInfo.gl.software) {
      console.log('NOTE: that is a SOFTWARE rasteriser. Every GPU-bound number below is a lower');
      console.log('      bound; real hardware would be far faster, and the CPU-bound ones (canvas');
      console.log('      path building, ImageData fill, buffer upload) are unaffected.');
    }
    console.log('');

    const rows = [];
    const upload = [];
    for (const s of SCALES) {
      const built = await page.evaluate(t => window.__bench.build(t), s.target);
      const results = await page.evaluate(z => window.__bench.runAll(z), ZOOMS);
      const up = await page.evaluate(() => window.__bench.uploadCost());
      upload.push([s.label, built.live.toLocaleString(), `${built.mb} MB`, ms(up)]);

      for (const z of ZOOMS) {
        const perZoom = results.filter(r => r.zoom === z.name);
        for (const r of perZoom) {
          rows.push([
            s.label, String(built.live), z.name,
            NAMES[r.strategy], r.strategy === 'C' ? `${r.drawn.toLocaleString()} / ${r.submitted.toLocaleString()} pts` : r.visible.toLocaleString(),
            ms(r.perFrame), r.fps.toFixed(0) + ' fps', ms(r.median),
          ]);
        }
      }
      if (shots) {
        for (const st of ['A', 'B', 'C', 'D']) {
          await page.evaluate(x => window.__bench.show(x), st);
          await page.screenshot({ path: `/tmp/opencode/render-${s.label}-${st}.png` });
        }
      }
    }

    console.log('== frames per second by renderer (1200x800 canvas, whole draw synced) ==');
    console.log(table(
      ['cells', 'live', 'zoom', 'renderer', 'drawn / submitted', 'per frame', 'max fps', 'cpu-only med'],
      rows,
    ));

    console.log('\n== cost of refreshing the WebGL point buffer each generation ==');
    console.log(table(['cells', 'points', 'buffer', 're-upload'], upload));

    // ---- cross-check against the real app -----------------------------------
    // tools/bench-render.html's "A" is a transcription of index.html's render()
    // but iterates a typed array of coordinates. The app iterates a Map with
    // "x,y" string keys and parses each key. Measure the real thing so the
    // difference is on the record.
    if (existsSync(join(SCRATCH, 'index.html'))) {
      try {
        const app = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await app.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
        const appRows = [];
        for (const s of SCALES) {
          const info = await app.evaluate((target) => {
            // stop the animation loop so only our renders run
            if (typeof isPlaying !== 'undefined' && isPlaying) togglePlay();
            const mulberry32 = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
            const side = Math.ceil(Math.sqrt(target / 0.5));
            const rnd = mulberry32(12345);
            grid.clear();
            for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) if (rnd() < 0.5) grid.set(x + ',' + y, 1);
            return { live: grid.size, side, w: canvas.width, h: canvas.height };
          }, s.target);
          const out = [];
          for (const z of ZOOMS) {
            const t = await app.evaluate(({ cw, side }) => {
              cellSize = 10;
              zoom = cw / cellSize;
              offsetX = canvas.width / 2 - (side / 2) * cw;
              offsetY = canvas.height / 2 - (side / 2) * cw;
              render(); ctx.getImageData(0, 0, 1, 1);
              const frames = 3;
              const t0 = performance.now();
              for (let i = 0; i < frames; i++) render();
              ctx.getImageData(0, 0, 1, 1);
              return (performance.now() - t0) / frames;
            }, { cw: z.cw, side: info.side });
            out.push([s.label, z.name, ms(t), (1000 / t).toFixed(0) + ' fps']);
          }
          appRows.push([s.label, info.live.toLocaleString(), `${info.w}x${info.h}`, ...out[0].slice(2), ...out[1].slice(2)]);
        }
        console.log(`\n== the real app (index.html render(), canvas ${app ? '' : ''}per its own layout) ==`);
        console.log(table(['cells', 'live in Map', 'canvas', 'in 8px', 'fps', 'out 1px', 'fps'], appRows));
        console.log('   the app iterates grid.forEach and parses each "x,y" key, so it is slower');
        console.log('   than renderer "A" above, which reads a coordinate array.');

        // How much of a generation is the stepper and how much is everything
        // else (render + stats + history)? This is the owner's "blinker 2000
        // generations: 173 ms, render-bound" measurement, in pieces.
        const stepRows = [];
        for (const probe of [{ label: 'blinker', kind: 'blinker', steps: 2000 },
                             { label: '10k soup', kind: 'soup', target: 10000, steps: 2000 },
                             { label: '100k soup', kind: 'soup', target: 100000, steps: 5 }]) {
          const r = await app.evaluate((p) => {
            if (typeof isPlaying !== 'undefined' && isPlaying) togglePlay();
            const mulberry32 = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
            grid.clear();
            if (p.kind === 'blinker') { grid.set('0,0', 1); grid.set('1,0', 1); grid.set('2,0', 1); }
            else {
              const side = Math.ceil(Math.sqrt(p.target / 0.5));
              const rnd = mulberry32(12345);
              for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) if (rnd() < 0.5) grid.set(x + ',' + y, 1);
            }
            const live = grid.size;
            step();                                    // warm up
            const t0 = performance.now();
            for (let i = 0; i < p.steps; i++) step();   // saveHistory + stepCore + updateStats + render
            const total = performance.now() - t0;
            // and the stepper alone, same starting state
            grid.clear();
            if (p.kind === 'blinker') { grid.set('0,0', 1); grid.set('1,0', 1); grid.set('2,0', 1); }
            else {
              const side = Math.ceil(Math.sqrt(p.target / 0.5));
              const rnd = mulberry32(12345);
              for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) if (rnd() < 0.5) grid.set(x + ',' + y, 1);
            }
            stepCore();
            const t1 = performance.now();
            for (let i = 0; i < p.steps; i++) stepCore();
            const core = performance.now() - t1;
            // the other three pieces of step(), individually
            const n = Math.min(p.steps, 20);
            let snap = new Map(grid);                  // exactly what saveHistory() stores
            const t2 = performance.now();
            for (let i = 0; i < n; i++) snap = new Map(grid);
            const clone = (performance.now() - t2) / n;
            const t3 = performance.now();
            for (let i = 0; i < n; i++) updateStats();
            const stats = (performance.now() - t3) / n;
            const t4 = performance.now();
            for (let i = 0; i < n; i++) render();
            const renderOnly = (performance.now() - t4) / n;
            ctx.getImageData(0, 0, 1, 1);      // sync *after* timing, not inside it
            void snap;
            return { live, steps: p.steps, total, core, clone, stats, renderOnly };
          }, probe);
          stepRows.push([
            probe.label, r.live.toLocaleString(), r.steps.toLocaleString(),
            ms(r.total), (r.total / r.steps).toFixed(3) + ' ms',
            ms(r.core), (r.core / r.steps).toFixed(3) + ' ms',
            r.clone.toFixed(2) + ' ms', ms(r.stats), ms(r.renderOnly),
          ]);
        }
        console.log('\n== the real app\'s step(): stepper vs everything else ==');
        console.log(table(['workload', 'live', 'steps', 'step() total', 'per generation', 'stepCore() only', 'per generation', 'saveHistory clone', 'updateStats()', 'render()'], stepRows));
        console.log('   step() = saveHistory (full Map clone) + stepCore + updateStats (DOM) + render.');
        console.log('   This is the breakdown behind the owner\'s "blinker 2000 gens: 173 ms".');
        await app.close();
      } catch (e) {
        console.log(`\n(real-app cross-check skipped: ${e.message})`);
      }
    }

    console.log('\nnotes: "per frame" is the average of N draws with one GPU sync');
    console.log('       (getImageData / readPixels) at the end, so it includes GPU time.');
    console.log('       "cpu-only med" is the median of individual unsynced draws.');
    if (glInfo.gl.ok && glInfo.gl.pointSizeRange[1] < 8) {
      console.log('       WARNING: this driver clamps gl_PointSize below 8px, which would force');
      console.log('       the WebGL point path to a quad-per-cell shader at high zoom.');
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
  }
}

await main();
