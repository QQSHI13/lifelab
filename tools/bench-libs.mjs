// Third-party HashLife libraries vs. LifeLab's own cores.
//
//   node tools/bench-libs.mjs                 # uses /tmp/opencode/hl-bench
//   node tools/bench-libs.mjs --dir <dir>     # scratch dir holding node_modules
//   node tools/bench-libs.mjs --npm-install   # install the pins into a scratch dir first
//
// WHY THIS FILE EXISTS: the owner asked whether there is an npm stdlib to
// depend on and build at ship time. This measures the two candidate packages
// against the app's current core and against tools/bench-bitboard.mjs.
//
// The libraries are NOT installed in this repo. They are installed in a scratch
// directory outside the repo (node_modules here would otherwise be published by
// GitHub Pages and picked up by Dependabot for a site with no build step).
//
// Findings that decide the shape of this script:
//   * ts-hashlife (BSD-2-Clause) works and can advance to an exact arbitrary
//     generation. Its ESM entry does not load under Node's resolver (the
//     published dist/esm/*.js files import "./life-universe" with no
//     extension), so this script loads its CJS entry.
//   * node-gol-hashlife (MIT, last publish 2015) ships no `main`, so it cannot
//     be required by package name at all, and its API can only answer "what
//     does the central quadrant of a fixed 2^n universe look like 2^k
//     generations from now?" — no arbitrary generation counts, no unbounded
//     universe. It is reported as not viable; no timing table is meaningful.

import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PATTERNS, RULE_LIFE, MapCore, parseRule, randomSoup, gliderGrid,
         gunArray, shapeSig, table, ms, memMB } from './bench-common.mjs';
import { BitboardUniverse } from './bench-bitboard.mjs';

// ---------------------------------------------------------------------------
// Locate the packages
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const dirArg = argv.indexOf('--dir');
let LIB_DIR = dirArg >= 0 ? argv[dirArg + 1] : (process.env.LIFELAB_LIB_DIR || '/tmp/opencode/hl-bench');

if (argv.includes('--npm-install')) {
  mkdirSync(LIB_DIR, { recursive: true });
  console.log(`installing pins into ${LIB_DIR} (needs network access to registry.npmjs.org)`);
  execFileSync('npm', ['install', '--no-audit', '--no-fund',
    'ts-hashlife@0.1.18', 'node-gol-hashlife@0.1.1'], { cwd: LIB_DIR, stdio: 'inherit' });
}

const requireFrom = createRequire(join(LIB_DIR, 'noop.cjs'));

function pkgInfo(name) {
  const p = join(LIB_DIR, 'node_modules', name, 'package.json');
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return { name, version: j.version, license: j.license || (j.licenses && j.licenses[0] && j.licenses[0].type), main: j.main, type: j.type, files: j.files };
}

const tsInfo = pkgInfo('ts-hashlife');
const golInfo = pkgInfo('node-gol-hashlife');

if (!tsInfo) {
  console.error(`ts-hashlife not found under ${LIB_DIR}/node_modules.`);
  console.error(`Install the pins first:  node tools/bench-libs.mjs --dir ${LIB_DIR} --npm-install`);
  process.exit(1);
}

// Node cannot resolve ts-hashlife's ESM entry (extensionless relative imports
// in dist/esm), so load the CJS build.
const { default: HashLife } = requireFrom('ts-hashlife');
const { LifeUniverse } = HashLife;
console.log('ts-hashlife loaded through its CJS entry '
  + '(its "import" entry throws ERR_MODULE_NOT_FOUND under Node — see PERF.md)');

// ---------------------------------------------------------------------------
// ts-hashlife helper: cells in, cells out
// ---------------------------------------------------------------------------

function ruleMasks(ruleStr) {
  const r = parseRule(ruleStr);
  let s = 0, b = 0;
  for (const d of r.survive) s |= 1 << d;
  for (const d of r.born) b |= 1 << d;
  return { s, b };
}

function hlLoad(cells, ruleStr = RULE_LIFE) {
  const fx = new Int32Array(cells.map(c => c[0]));
  const fy = new Int32Array(cells.map(c => c[1]));
  const life = new LifeUniverse();
  life.clear_pattern();
  const { s, b } = ruleMasks(ruleStr);
  life.set_rules(s, b);
  const bounds = life.get_bounds(fx, fy);
  life.make_center(fx, fy, bounds);
  life.setup_field(fx, fy, bounds);
  return life;
}

function hlCells(life) {
  const out = [];
  const off = -life.pow2(life.root.level - 1);
  life.node_get_field(life.root, off, off, out);
  return out.map(c => [c.x, c.y]);
}

/**
 * Advance exactly `n` generations. `next_generation(true)` at step k advances
 * 2^k generations, so binary-decompose n. Each set_step() invalidates
 * ts-hashlife's memoisation, which is why the "coarse" mode below exists.
 */
function hlStepExact(life, n) {
  let remaining = n;
  while (remaining > 0) {
    let k = 0;
    while (k + 1 < 24 && (1 << (k + 1)) <= remaining) k++;
    life.set_step(k);
    life.next_generation(true);
    remaining -= 1 << k;
  }
  return life;
}

/** Advance to (at least) `n` generations with one fixed step size. */
function hlStepCoarse(life, n) {
  let k = 0;
  while (k + 1 < 24 && (1 << (k + 1)) <= n) k++;
  life.set_step(k);
  while (life.generation < n) life.next_generation(true);
  return life;
}

/** The app's interactive path: one generation per call, memoisation intact. */
function hlStepSingle(life, n) {
  for (let i = 0; i < n; i++) life.next_generation(true);
  return life;
}

function hlBench(make, stepper, runs = 3) {
  const times = [];
  let life = null;
  for (let i = 0; i <= runs; i++) {     // first pass is warm-up, discarded
    globalThis.gc?.();
    const t0 = performance.now();
    life = stepper(make());
    const t = performance.now() - t0;
    if (i > 0) times.push(t);
  }
  times.sort((a, b) => a - b);
  return { best: times[0], median: times[times.length >> 1], life };
}

/** Heap held by the data structure after a run (needs --expose-gc to be exact). */
function heapOf(make, stepper) {
  if (!globalThis.gc) return { heap: null, note: 'run with --expose-gc' };
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const state = stepper(make());
  globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  const kb = (after - before) / 1024;
  void state;
  return { heap: kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB` };
}

// ---------------------------------------------------------------------------
// Correctness of the library, against the app's known-good cases
// ---------------------------------------------------------------------------

function testTsHashlife() {
  const out = [];
  const check = (name, got, want) => out.push({ name, ok: got === want, got, want });

  // glider 4 gens -> same shape translated (1,1)
  {
    const life = hlStepExact(hlLoad(PATTERNS.GLIDER), 4);
    check('glider 4 gens: shape', shapeSig(hlCells(life)), shapeSig(PATTERNS.GLIDER));
    check('glider 4 gens: generation counter', life.generation, 4);
    check('glider 4 gens: population', life.root.population, 5);
  }
  // blinker: period 2
  {
    const life = hlStepExact(hlLoad(PATTERNS.BLINKER), 2);
    check('blinker: period 2', shapeSig(hlCells(life)), shapeSig(PATTERNS.BLINKER));
  }
  // r-pentomino: 1103 gens -> 116 cells
  {
    const life = hlStepExact(hlLoad(PATTERNS.R_PENTOMINO), 1103);
    check('r-pentomino: generation counter', life.generation, 1103);
    check('r-pentomino: 116 cells at gen 1103', life.root.population, 116);
  }
  // r-pentomino at gen 1024 in one 2^10 jump, compared with the bitboard
  {
    const life = hlLoad(PATTERNS.R_PENTOMINO);
    life.set_step(10);
    life.next_generation(true);
    const ref = new BitboardUniverse().load(PATTERNS.R_PENTOMINO).step(1024);
    check('r-pentomino: 1x2^10 jump == bitboard shape', shapeSig(hlCells(life)), shapeSig(ref.cells()));
  }
  // gosper gun grows
  {
    const life = hlStepExact(hlLoad(PATTERNS.GOSPER_GUN), 3000);
    const ref = new BitboardUniverse().load(PATTERNS.GOSPER_GUN).step(3000);
    check('gosper gun: gen-3000 population == bitboard', life.root.population, ref.population);
    check('gosper gun: gen-3000 shape == bitboard', shapeSig(hlCells(life)), shapeSig(ref.cells()));
  }
  // diehard dies at 130
  {
    const life = hlStepExact(hlLoad(PATTERNS.DIEHARD), 130);
    check('diehard: 0 cells at gen 130', life.root.population, 0);
  }
  // acorn settles at 5206 with 633 cells
  {
    const life = hlStepExact(hlLoad(PATTERNS.ACORN), 5206);
    check('acorn: 633 cells at gen 5206', life.root.population, 633);
  }
  // a random soup, chaotic: hashlife's worst case for compression but must
  // still agree with the reference stepper
  {
    const cells = randomSoup(70, 70, 0.3, 7);
    const life = hlStepExact(hlLoad(cells), 30);
    const ref = new BitboardUniverse().load(cells).step(30);
    check('random 70x70 soup: 30 gen shape == bitboard', shapeSig(hlCells(life)), shapeSig(ref.cells()));
  }
  return out;
}

function testGolHashlife() {
  const out = [];
  let lib = null;
  try {
    lib = requireFrom('node-gol-hashlife');
  } catch (e) {
    out.push({ name: 'require("node-gol-hashlife")', ok: false, got: e.code, want: 'a module' });
    return { out, lib: null };
  }
  return { out, lib };
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

const CASES = [
  { name: 'r-pentomino 1103 gen (5 cells)', cells: PATTERNS.R_PENTOMINO, gens: 1103, rule: RULE_LIFE },
  { name: 'gosper gun 10000 gen (36 cells)', cells: PATTERNS.GOSPER_GUN, gens: 10000, rule: RULE_LIFE },
  { name: 'random 100x100 soup 500 gen', cells: randomSoup(100, 100, 0.5), gens: 500, rule: RULE_LIFE },
  { name: 'glider grid 60x60, 1000 gen (18k)', cells: gliderGrid(60, 16), gens: 1000, rule: RULE_LIFE },
  { name: 'gun 3x3 array, 3000 gen (324)', cells: gunArray(3, 150), gens: 3000, rule: RULE_LIFE },
];

export function runComparison({ budgetMs = 5000, runs = 3 } = {}) {
  const rows = [];
  for (const c of CASES) {
    const live = c.cells.length;

    // --- the app's current core (budgeted; it OOMs/slogs past ~150k live) ---
    let mapCell = 'skipped';
    if (live <= 150000) {
      let best = Infinity, truncated = false, gen = 0;
      for (let i = 0; i < runs; i++) {
        const sim = new MapCore(c.rule).load(c.cells);
        const t0 = performance.now();
        gen = 0;
        while (gen < c.gens && performance.now() - t0 < budgetMs) { sim.stepCore(); gen++; }
        const t = performance.now() - t0;
        if (gen < c.gens) { truncated = true; best = Math.min(best, t); break; }
        best = Math.min(best, t);
      }
      mapCell = truncated ? `${ms(best)} @${gen}g` : ms(best);
    }

    // --- bitboard ---
    const bb = hlBench(() => new BitboardUniverse(c.rule).load(c.cells), sim => sim.step(c.gens), runs);

    // --- ts-hashlife, three usage modes ---
    const hlSingle = hlBench(() => hlLoad(c.cells, c.rule), life => hlStepSingle(life, c.gens), runs);
    const hlExact = hlBench(() => hlLoad(c.cells, c.rule), life => hlStepExact(life, c.gens), runs);
    const hlCoarse = hlBench(() => hlLoad(c.cells, c.rule), life => hlStepCoarse(life, c.gens), runs);

    rows.push([
      c.name, live.toLocaleString(), c.gens.toLocaleString(),
      mapCell,
      ms(bb.best),
      ms(hlSingle.best),
      ms(hlExact.best),
      ms(hlCoarse.best) + (hlCoarse.life.generation !== c.gens ? ` (${hlCoarse.life.generation}g)` : ''),
    ]);
  }
  return table(
    ['workload', 'live', 'gens', 'Map core', 'bitboard', 'hashlife 1/gen', 'hashlife exact', 'hashlife coarse'],
    rows,
  );
}

export function runMemory() {
  const rows = [];
  for (const c of CASES) {
    const hl = heapOf(() => hlLoad(c.cells, c.rule), life => hlStepExact(life, c.gens));
    const bb = heapOf(() => new BitboardUniverse(c.rule).load(c.cells), sim => sim.step(c.gens));
    const live = new Set(c.cells.map(k => k.join(','))).size;
    rows.push([c.name, live.toLocaleString(), hl.heap ?? hl.note, bb.heap ?? bb.note]);
  }
  return table(['workload', 'initial live', 'ts-hashlife heap', 'bitboard heap'], rows);
}

/**
 * The app must feel instant while someone drags a brush across the canvas.
 * That path is: mutate a cell, then show the next generation. Measure both
 * halves for each engine.
 */
export function runEditCost() {
  const rows = [];
  for (const n of [1000, 18000]) {
    const cells = gliderGrid(Math.round(Math.sqrt(n / 5)), 16).slice(0, n);

    // ts-hashlife: rebuild the field (there is no cheap incremental edit)
    let t0 = performance.now();
    for (let i = 0; i < 10; i++) hlLoad(cells);
    const hlRebuild = (performance.now() - t0) / 10;

    // ts-hashlife: set_bit / get_bit on a live universe
    const life = hlLoad(cells);
    t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < cells.length; i++) {
      const [x, y] = cells[i];
      life.set_bit(x + 1, y, true);
      acc += life.get_bit(x, y) ? 1 : 0;
    }
    const hlSetBit = (performance.now() - t0) / cells.length;

    // ts-hashlife: one generation after all that editing
    t0 = performance.now();
    life.next_generation(true);
    const hlStep = performance.now() - t0;

    // bitboard: set() the same cells
    const sim = new BitboardUniverse().load(cells);
    t0 = performance.now();
    for (const [x, y] of cells) sim.set(x + 1, y, true);
    const bbSet = (performance.now() - t0) / cells.length;
    t0 = performance.now();
    sim.stepOnce();
    const bbStep = performance.now() - t0;

    rows.push([
      n.toLocaleString(),
      ms(hlRebuild), `${(hlSetBit * 1000).toFixed(0)} ns`, ms(hlStep),
      `${(bbSet * 1000).toFixed(0)} ns`, ms(bbStep),
      acc,
    ]);
  }
  return table(
    ['cells edited', 'hashlife rebuild', 'hashlife set_bit', 'hashlife 1 gen', 'bitboard set', 'bitboard 1 gen', ''],
    rows.map(r => r.slice(0, 6)),
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && /bench-libs\.mjs$/.test(process.argv[1]);
if (isMain) {
  console.log('== package facts (from the scratch install) ==');
  console.log(table(['package', 'version', 'license', 'main', 'type', 'files'],
    [[tsInfo.name, tsInfo.version, tsInfo.license, tsInfo.main || '(none)', tsInfo.type || '(cjs)', (tsInfo.files || []).join(' ')],
     golInfo ? [golInfo.name, golInfo.version, golInfo.license, (golInfo.main || '(none)'), golInfo.type || '(cjs)', (golInfo.files || []).join(' ')] : ['node-gol-hashlife', 'not installed', '', '', '', '']]));

  console.log('\n== ts-hashlife correctness (vs the app\'s known-good cases) ==');
  const results = testTsHashlife();
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(44)} ${r.ok ? '' : `got ${r.got}, want ${r.want}`}`);

  console.log('\n== node-gol-hashlife viability ==');
  const { out, lib } = testGolHashlife();
  for (const r of out) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}: ${r.got}`);
  if (lib) {
    const t0 = performance.now();
    const sim = new lib.Simulation(14);           // 16384 x 16384 universe
    for (const [x, y] of PATTERNS.R_PENTOMINO) sim.set(x, y);
    const cells = sim.get(10);                    // 2^10 = 1024 generations ahead
    console.log(`  it can answer "central quadrant 2^10 generations ahead": ${cells.length} cells in ${ms(performance.now() - t0)}`);
    const ref = new BitboardUniverse().load(PATTERNS.R_PENTOMINO).step(1024);
    console.log(`  bitboard at exactly gen 1024 has ${ref.population} cells (same shape: ${shapeSig(cells.map(c => [c.x, c.y])) === shapeSig(ref.cells())})`);
    console.log('  but it cannot report generation 1103, nor step one generation at a time,');
    console.log('  nor grow an unbounded universe: not usable for this app.');
  }

  console.log('\n== wall clock: third-party HashLife vs the app\'s own cores ==');
  console.log(runComparison());

  console.log('\n== memory held after the run ==');
  console.log(runMemory());
  if (!globalThis.gc) console.log('(re-run with --expose-gc for exact memory numbers)');

  console.log('\n== interactive-edit cost ==');
  console.log(runEditCost());

  const m = memMB();
  console.log(`\nheap: ${m.heap} MB (rss ${m.rss} MB)`);
  const allOk = results.every(r => r.ok);
  console.log(allOk ? '\nts-hashlife agrees with the app on every known-good case.' : '\nSOME ts-hashlife CHECKS FAILED');
  if (!allOk) process.exit(1);
}
