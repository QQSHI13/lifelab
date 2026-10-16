// Before/after measurement for the bitboard integration, using the same
// methodology as docs/PERF.md: a warm-up pass, then best of 3, on the app's real
// code paths where possible.
//
//   node tools/bench-after.mjs
//
// "before" is the old Map<"x,y", 1> core, replicated exactly in
// tools/bench-common.mjs (MapCore) with the same 6 s per-run budget the PERF
// report used. "after" is the shipped app loaded through js/app.check.mjs's stub
// DOM — so it is the actual index.html + js/bitboard.js, not a copy. The stub
// canvas makes render() CPU-bound only, which is the right comparison for the
// per-generation work (docs/PERF.md §4.2b caveat: rasterisation is not measured).

import { performance } from 'node:perf_hooks';
import {
  PATTERNS, RULE_LIFE, MapCore, randomSoup, bench, ms, table, memMB,
} from './bench-common.mjs';
import { createApp } from '../js/app.check.mjs';
import { loadBitboard } from '../js/bitboard.check.mjs';

const QUICK = process.argv.includes('--quick');
const WARMUP = 1;
const RUNS = 3;
const MAP_BUDGET_MS = QUICK ? 1500 : 6000;   // 6 s cap as in docs/PERF.md §2.1

const WORKLOADS = [
  { name: 'r-pentomino (5 cells)', cells: PATTERNS.R_PENTOMINO, gens: 1103 },
  { name: 'acorn (7 cells)', cells: PATTERNS.ACORN, gens: 5206 },
  { name: 'random 100x100 soup (~5k)', cells: randomSoup(100, 100, 0.5), gens: 500 },
  { name: 'random 450x450 soup (~100k)', cells: randomSoup(450, 450, 0.5), gens: 100 },
];

/** The old core, capped at `budgetMs` per run. Returns best/median of `runs`. */
function benchMapCore(cells, gens, budgetMs) {
  const samples = [];
  const run = () => {
    const sim = new MapCore(RULE_LIFE).load(cells);
    const t0 = performance.now();
    let g = 0;
    while (g < gens && performance.now() - t0 <= budgetMs) { sim.stepCore(); g++; }
    return { ms: performance.now() - t0, gens: g, population: sim.grid.size };
  };
  let last = null;
  for (let i = 0; i < WARMUP + RUNS; i++) {
    last = run();
    if (i >= WARMUP) samples.push(last.ms);
  }
  samples.sort((a, b) => a - b);
  return { best: samples[0], median: samples[samples.length >> 1], gens: last.gens, truncated: last.gens < gens };
}

/**
 * Time an app call: `fn` runs once per sample, with `reset` (untimed) putting the
 * app back into the same starting state. Warm-up pass, then best of 3.
 */
function benchApp(fn, reset) {
  const samples = [];
  let loaded = 0;
  for (let i = 0; i < WARMUP + RUNS; i++) {
    reset();
    const t0 = performance.now();
    const out = fn();
    const ms = performance.now() - t0;
    if (out !== undefined) loaded = out;
    if (i >= WARMUP) samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  return { best: samples[0], median: samples[samples.length >> 1], out: loaded };
}

/** The cost of one undo snapshot: bitboard clone vs a full Map clone. */
function benchHistory(app, cells) {
  // After: exactly what saveHistory() does — universe.clone() — measured on the
  // shipped class directly, so it is not a noisy subtraction of two big timings.
  const BitboardUniverse = loadBitboard();
  const universe = new BitboardUniverse(RULE_LIFE);
  for (const [x, y] of cells) universe.set(x, y, true);
  const after = bench(() => { universe.clone(); }, { runs: 5, warmup: 2 });

  // Before: the old saveHistory() was `new Map(grid)` over every string key.
  const map = new Map();
  for (const [x, y] of cells) map.set(`${x},${y}`, 1);
  const before = bench(() => { void new Map(map); }, { runs: 5, warmup: 2 });

  // And the two app paths it sits in: step() (snapshot + stepper + stats + render)
  // vs stepN(1) (the same without the snapshot).
  const withHistory = benchApp(
    () => { app.api.step(); },
    () => { app.api.clear(); app.api.placeCells(cells); },
  );
  const withoutHistory = benchApp(
    () => { app.api.stepN(1); },
    () => { app.api.clear(); app.api.placeCells(cells); },
  );

  return { after: after.best, before: before.best, withHistory: withHistory.best, withoutHistory: withoutHistory.best };
}

async function main() {
  const app = await createApp();
  if (app.api.patterns().length !== 25) throw new Error('pattern library did not load');

  const rows = [];
  for (const w of WORKLOADS) {
    const live = w.cells.length;
    const before = benchMapCore(w.cells, w.gens, MAP_BUDGET_MS);
    const core = benchApp(
      () => { app.api.stepN(w.gens); },
      () => { app.api.setRule('B3/S23'); app.api.clear(); app.api.placeCells(w.cells); },
    );
    // Sanity: the after-run must agree with the map core's cached expectation.
    if (w.name.startsWith('r-pentomino') && app.api.population() !== 116) {
      throw new Error(`r-pentomino after-run has ${app.api.population()} cells, want 116`);
    }
    const beforeCell = before.truncated
      ? `${ms(before.best)} @${before.gens}g (capped)`
      : ms(before.best);
    const ratio = before.truncated
      ? `> ${((before.best / (before.gens / w.gens)) / core.best).toFixed(0)}x`
      : `${(before.best / core.best).toFixed(1)}x`;
    rows.push([
      w.name, live.toLocaleString(), w.gens.toLocaleString(),
      beforeCell, ms(core.best), ms(core.median), ratio,
    ]);
  }

  console.log('== before (Map core) vs after (app on the bitboard) ==');
  console.log(table(
    ['workload', 'live', 'gens', 'before: Map core', 'after: best', 'after: median', 'speed-up'],
    rows,
  ));

  // The full app path, including history snapshots and the render CPU pass.
  const fullRows = [];
  for (const w of WORKLOADS) {
    const r = benchApp(
      () => { for (let i = 0; i < w.gens; i++) app.api.step(); },
      () => { app.api.setRule('B3/S23'); app.api.clear(); app.api.placeCells(w.cells); },
    );
    fullRows.push([w.name, w.gens.toLocaleString(), ms(r.best), (r.best / w.gens).toFixed(2)]);
  }
  console.log('\n== after: the app\'s full step() (clone + stepper + stats + render CPU), per generation ==');
  console.log(table(['workload', 'gens', 'total', 'ms/generation'], fullRows));

  // History snapshot cost at ~100k cells, the number that decides the approach.
  const soup = randomSoup(450, 450, 0.5);
  const h = benchHistory(app, soup);
  console.log('\n== undo snapshot cost at ~100k cells (101,075 live cells) ==');
  console.log(table(
    ['snapshot', 'best of 5', 'vs before'],
    [
      ['before: new Map(grid) over 101k string keys', ms(h.before), '1x'],
      ['after: universe.clone() (what saveHistory() does)', ms(h.after), `${(h.before / h.after).toFixed(0)}x cheaper`],
      ['after: app step() incl. snapshot + render', ms(h.withHistory), ''],
      ['after: app stepN(1), no snapshot or history', ms(h.withoutHistory), ''],
    ],
  ));

  const m = memMB();
  console.log(`\nnode ${process.version}, heap ${m.heap} MB, rss ${m.rss} MB`);
  console.log(`methodology: warm-up 1 pass, then best/median of ${RUNS} runs; Map core capped at ${MAP_BUDGET_MS / 1000} s/run.`);
}

await main();
