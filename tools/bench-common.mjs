// Shared helpers for the LifeLab performance benchmarks.
//
// Nothing here is shipped to the browser — these are measurement-only scripts
// run by `node tools/bench-*.mjs`. They deliberately do not import index.html:
// the app is a single static file with no module boundary, so the "current
// core" is replicated here exactly (see MapCore) and asserted against
// tools/verify-patterns.mjs, which is the repo's reference stepper.

import { performance } from 'node:perf_hooks';
import { parseRule } from './verify-patterns.mjs';

export { parseRule, parseRLE, step as referenceStep } from './verify-patterns.mjs';

// ---------------------------------------------------------------------------
// Canonical patterns. Copied from patterns/*.json (the cell lists the app
// ships) so a benchmark can never silently drift from the app's own data.
// ---------------------------------------------------------------------------

export const PATTERNS = {
  BLINKER: [[0, 1], [1, 1], [2, 1]],
  BLOCK: [[0, 0], [1, 0], [0, 1], [1, 1]],
  GLIDER: [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]],
  TOAD: [[1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2]],
  PULSAR: [[2, 0], [3, 0], [4, 0], [8, 0], [9, 0], [10, 0], [0, 2], [5, 2], [7, 2], [12, 2], [0, 3], [5, 3], [7, 3], [12, 3], [0, 4], [5, 4], [7, 4], [12, 4], [2, 5], [3, 5], [4, 5], [8, 5], [9, 5], [10, 5], [2, 7], [3, 7], [4, 7], [8, 7], [9, 7], [10, 7], [0, 8], [5, 8], [7, 8], [12, 8], [0, 9], [5, 9], [7, 9], [12, 9], [0, 10], [5, 10], [7, 10], [12, 10], [2, 12], [3, 12], [4, 12], [8, 12], [9, 12], [10, 12]],
  R_PENTOMINO: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
  DIEHARD: [[6, 0], [0, 1], [1, 1], [1, 2], [5, 2], [6, 2], [7, 2]],
  ACORN: [[1, 0], [3, 1], [0, 2], [1, 2], [4, 2], [5, 2], [6, 2]],
  GOSPER_GUN: [[24, 0], [22, 1], [24, 1], [12, 2], [13, 2], [20, 2], [21, 2], [34, 2], [35, 2], [11, 3], [15, 3], [20, 3], [21, 3], [34, 3], [35, 3], [0, 4], [1, 4], [10, 4], [16, 4], [20, 4], [21, 4], [0, 5], [1, 5], [10, 5], [14, 5], [16, 5], [17, 5], [22, 5], [24, 5], [10, 6], [16, 6], [24, 6], [11, 7], [15, 7], [12, 8], [13, 8]],
};

export const RULE_LIFE = 'B3/S23';

/** Deterministic PRNG so every run benches the identical soup. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random `width`x`height` soup with the given live-cell density. */
export function randomSoup(width, height, density = 0.5, seed = 12345) {
  const rnd = mulberry32(seed);
  const cells = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (rnd() < density) cells.push([x, y]);
  }
  return cells;
}

/** `side`x`side` non-interacting gliders, `spacing` cells apart. */
export function gliderGrid(side, spacing = 16) {
  const cells = [];
  for (let gy = 0; gy < side; gy++) {
    for (let gx = 0; gx < side; gx++) {
      const ox = gx * spacing, oy = gy * spacing;
      for (const [x, y] of PATTERNS.GLIDER) cells.push([x + ox, y + oy]);
    }
  }
  return cells;
}

/** `n`x`n` Gosper guns, `spacing` cells apart (parallel stream of gliders). */
export function gunArray(n = 3, spacing = 120) {
  const cells = [];
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const ox = gx * spacing, oy = gy * spacing;
      for (const [x, y] of PATTERNS.GOSPER_GUN) cells.push([x + ox, y + oy]);
    }
  }
  return cells;
}

export function boundingBox(cells) {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const [x, y] of cells) {
    if (x < mnx) mnx = x;
    if (y < mny) mny = y;
    if (x > mxx) mxx = x;
    if (y > mxy) mxy = y;
  }
  if (!cells.length) return { mnx: 0, mny: 0, mxx: -1, mxy: -1, w: 0, h: 0 };
  return { mnx, mny, mxx, mxy, w: mxx - mnx + 1, h: mxy - mny + 1 };
}

/** Translation-invariant signature: a state can be compared for "same shape". */
export function shapeSig(cells) {
  if (!cells.length) return '';
  const { mnx, mny } = boundingBox(cells);
  return cells.map(([x, y]) => `${x - mnx},${y - mny}`).sort().join(' ');
}

// ---------------------------------------------------------------------------
// The current app core, replicated.
//
// index.html's stepCore() keeps `grid` as a Map<string "x,y", 1> and tallies
// neighbour counts in a second Map keyed by the same strings, then decides
// every candidate in one pass. This is that code, factored into a class so a
// benchmark can drive it.
// ---------------------------------------------------------------------------

export class MapCore {
  constructor(rule = 'B3/S23') {
    this.rule = parseRule(rule);
    this.born = [...this.rule.born];
    this.survive = [...this.rule.survive];
    this.grid = new Map();
    this.generation = 0;
    this.population = 0;
    this.births = 0;
    this.deaths = 0;
  }

  set(x, y, alive = true) {
    const k = `${x},${y}`;
    if (alive) this.grid.set(k, 1);
    else this.grid.delete(k);
    return this;
  }

  get(x, y) {
    return this.grid.has(`${x},${y}`);
  }

  load(cells) {
    this.grid.clear();
    for (const [x, y] of cells) this.grid.set(`${x},${y}`, 1);
    this.population = this.grid.size;
    return this;
  }

  stepCore() {
    const counts = new Map();
    this.grid.forEach((_, key) => {
      const comma = key.indexOf(',');
      const x = +key.slice(0, comma);
      const y = +key.slice(comma + 1);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nk = x + dx + ',' + (y + dy);
          counts.set(nk, (counts.get(nk) || 0) + 1);
        }
      }
    });
    this.grid.forEach((_, key) => {
      if (!counts.has(key)) counts.set(key, 0);
    });

    const newGrid = new Map();
    let newBirths = 0, newDeaths = 0;
    counts.forEach((n, key) => {
      const alive = this.grid.has(key);
      if (alive ? this.survive.includes(n) : this.born.includes(n)) {
        newGrid.set(key, 1);
        if (!alive) newBirths++;
      } else if (alive) {
        newDeaths++;
      }
    });

    this.grid = newGrid;
    this.births = newBirths;
    this.deaths = newDeaths;
    this.population = newGrid.size;
    this.generation++;
  }

  step(n = 1) {
    for (let i = 0; i < n; i++) this.stepCore();
    return this;
  }

  cells() {
    const out = [];
    this.grid.forEach((_, key) => {
      const c = key.indexOf(',');
      out.push([+key.slice(0, c), +key.slice(c + 1)]);
    });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Median and best wall-clock ms over `runs` timings of `fn`. */
export function time(fn) {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

/**
 * Run `fn` `warmup` times, then `runs` times; report best and median.
 * `fn` must be idempotent-safe to call repeatedly (benchmarks rebuild state
 * inside the closure).
 */
export function bench(fn, { runs = 5, warmup = 1 } = {}) {
  for (let i = 0; i < warmup; i++) time(fn);
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(time(fn));
  samples.sort((a, b) => a - b);
  return { best: samples[0], median: samples[samples.length >> 1], samples };
}

export function ms(x) {
  if (x >= 1000) return (x / 1000).toFixed(2) + ' s';
  if (x >= 100) return x.toFixed(1) + ' ms';
  if (x >= 10) return x.toFixed(2) + ' ms';
  return x.toFixed(3) + ' ms';
}

export function cellsPerSec(cells, gens, ms) {
  if (!ms) return '—';
  const cps = (cells * gens) / (ms / 1000);
  if (cps >= 1e9) return (cps / 1e9).toFixed(2) + 'G cell-gen/s';
  if (cps >= 1e6) return (cps / 1e6).toFixed(1) + 'M cell-gen/s';
  if (cps >= 1e3) return (cps / 1e3).toFixed(1) + 'k cell-gen/s';
  return cps.toFixed(0) + ' cell-gen/s';
}

/** Fixed-width text table (no deps). */
export function table(headers, rows) {
  const all = [headers, ...rows].map(r => r.map(v => String(v)));
  const w = headers.map((_, i) => Math.max(...all.map(r => (r[i] ?? '').length)));
  const line = (r) => r.map((v, i) => (v ?? '').padEnd(w[i])).join('  ');
  const bar = w.map(x => '-'.repeat(x)).join('  ');
  return [line(headers), bar, ...rows.map(line)].join('\n');
}

export function memMB() {
  globalThis.gc?.();
  const m = process.memoryUsage();
  return { heap: +(m.heapUsed / 1048576).toFixed(1), rss: +(m.rss / 1048576).toFixed(1) };
}
