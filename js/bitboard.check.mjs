// Correctness checks for js/bitboard.js — the app's simulation core.
//
//   node js/bitboard.check.mjs
//
// This is the reference implementation's own 37-check suite (tools/bench-bitboard.mjs)
// ported to load the *shipped* classic script instead of the benchmark's module, so
// CI checks the file the browser actually runs. The canonical patterns, the Map
// core and the reference stepper come from tools/bench-common.mjs so there is one
// source of truth for "what the app's patterns do".
//
// Exits non-zero on any failure.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  PATTERNS, RULE_LIFE, MapCore, parseRule, referenceStep, randomSoup, shapeSig,
} from '../tools/bench-common.mjs';

/** Load the classic script and return its global class. */
export function loadBitboard() {
  const src = readFileSync(new URL('./bitboard.js', import.meta.url), 'utf8');
  // The IIFE publishes `BitboardUniverse` on globalThis; the trailing expression
  // is runInThisContext's completion value, so we get the class back directly.
  return vm.runInThisContext(`${src}\n;BitboardUniverse`, { filename: 'js/bitboard.js' });
}

const BitboardUniverse = loadBitboard();
const { compress8, lastCountPlanes, encodeChunk, decodeChunk, MAX_COORD } = BitboardUniverse._internals;

/** Exhaustively verify the bit-sliced 8-input counter over all 256 inputs. */
function testCompress8() {
  const results = [];
  let bad = 0;
  for (let m = 0; m < 256; m++) {
    const bits = [];
    let want = 0;
    for (let i = 0; i < 8; i++) { const v = (m >> i) & 1; bits.push(v); want += v; }
    compress8(...bits);
    const [b0, b1, b2, b3] = lastCountPlanes();
    const got = (b0 & 1) | ((b1 & 1) << 1) | ((b2 & 1) << 2) | ((b3 & 1) << 3);
    if (got !== want) bad++;
  }
  results.push({ name: 'all 256 counter input combinations', ok: bad === 0, got: bad, want: 0 });
  return results;
}

/** The "must never regress" cases the app's own patterns are verified against. */
function testCorrectness() {
  const results = [];
  const check = (name, got, want) => results.push({ name, ok: got === want, got, want });

  // 1. Glider after 4 generations = the same shape translated (1,1).
  {
    const sim = new BitboardUniverse().load(PATTERNS.GLIDER);
    const before = shapeSig(sim.cells());
    sim.step(4);
    const after = sim.cells();
    check('glider 4 gens: same shape', shapeSig(after), before);
    const mnx = Math.min(...after.map(c => c[0])), mny = Math.min(...after.map(c => c[1]));
    const mnx0 = Math.min(...PATTERNS.GLIDER.map(c => c[0])), mny0 = Math.min(...PATTERNS.GLIDER.map(c => c[1]));
    check('glider 4 gens: translated (1,1)', `${mnx - mnx0},${mny - mny0}`, '1,1');
    check('glider 4 gens: population 5', sim.population, 5);
  }

  // 2. Blinker: period 2.
  {
    const sim = new BitboardUniverse().load(PATTERNS.BLINKER);
    const s0 = shapeSig(sim.cells());
    sim.step(1);
    const s1 = shapeSig(sim.cells());
    sim.step(1);
    check('blinker: changes at gen 1', s1 !== s0, true);
    check('blinker: period 2', shapeSig(sim.cells()), s0);
    check('blinker: population 3', sim.population, 3);
  }

  // 3. Block: still life.
  {
    const sim = new BitboardUniverse().load(PATTERNS.BLOCK);
    const s0 = shapeSig(sim.cells());
    sim.step(50);
    check('block: still life after 50 gens', shapeSig(sim.cells()), s0);
  }

  // 4. R-pentomino: exactly 116 cells at generation 1103.
  {
    const sim = new BitboardUniverse().load(PATTERNS.R_PENTOMINO);
    sim.step(1103);
    check('r-pentomino: generation', sim.generation, 1103);
    check('r-pentomino: 116 cells at gen 1103', sim.population, 116);
    check('r-pentomino: population == cell readback', sim.cells().length, 116);
  }

  // 5. Diehard: dies at generation 130.
  {
    const sim = new BitboardUniverse().load(PATTERNS.DIEHARD);
    sim.step(129);
    const before = sim.population;
    sim.step(1);
    check('diehard: alive at gen 129', before > 0, true);
    check('diehard: dead at gen 130', sim.population, 0);
  }

  // 6. Acorn: settles at generation 5206 with 633 cells.
  {
    const sim = new BitboardUniverse().load(PATTERNS.ACORN);
    sim.step(5206);
    check('acorn: generation', sim.generation, 5206);
    check('acorn: 633 cells at gen 5206', sim.population, 633);
  }

  // 7. Gosper gun: grows without bound, and agrees with the Map core exactly.
  {
    const sim = new BitboardUniverse().load(PATTERNS.GOSPER_GUN);
    sim.step(1000);
    const p1 = sim.population;
    sim.step(1000);
    check('gosper gun: population grows', sim.population > p1, true);
    const ref = new MapCore(RULE_LIFE).load(PATTERNS.GOSPER_GUN).step(2000);
    check('gosper gun: gen-2000 population == Map core', sim.population, ref.grid.size);
    check('gosper gun: shape == Map core', shapeSig(sim.cells()), shapeSig(ref.cells()));
  }

  // 8. Agreement with the repo's reference stepper, for every rule the app offers,
  //    on random soups wide enough to span several chunks in x and y so that every
  //    chunk seam gets exercised.
  {
    const cases = [
      ['B3/S23', 12], ['B36/S23', 10], ['B3678/S34678', 8], ['B2/S', 3],
    ];
    let mismatches = 0, checked = 0, firstBad = '';
    for (const [ruleStr, gens] of cases) {
      const rule = parseRule(ruleStr);
      for (const seed of [1, 2, 3]) {
        const cells = randomSoup(70, 70, 0.3, seed);
        let ref = cells.map(c => [...c]);
        const sim = new BitboardUniverse(ruleStr).load(cells);
        for (let g = 0; g < gens; g++) {
          ref = referenceStep(rule, ref);
          sim.step(1);
          checked++;
          if (ref.length !== sim.population || shapeSig(ref) !== shapeSig(sim.cells())) {
            mismatches++;
            if (!firstBad) firstBad = ` (${ruleStr} seed ${seed} gen ${g + 1}: ref ${ref.length} vs bitboard ${sim.population})`;
            break;
          }
        }
      }
    }
    check(`matches reference stepper, 4 rules (${checked} gen)${firstBad}`, mismatches, 0);
  }

  // 9. Chunk borders: a pattern deliberately straddling chunk seams in x and y.
  {
    const cells = [];
    for (let i = 0; i < 8; i++) cells.push([31 + i, 31 + i]); // diagonal across the (0,0)/(1,1) seam
    const sim = new BitboardUniverse().load(cells);
    const ref0 = cells.map(c => [...c]);
    let ref = referenceStep(parseRule(RULE_LIFE), ref0);
    sim.step(1);
    check('seam-straddling pattern: 1 gen', shapeSig(ref), shapeSig(sim.cells()));
    for (let g = 1; g < 10; g++) ref = referenceStep(parseRule(RULE_LIFE), ref);
    sim.step(9);
    check('seam-straddling pattern: 10 gens', shapeSig(ref), shapeSig(sim.cells()));
  }

  // 10. Patterns far from the origin (negative coordinates) stay correct.
  {
    const cells = PATTERNS.GLIDER.map(([x, y]) => [x - 5000, y - 5000]);
    const sim = new BitboardUniverse().load(cells);
    const readback = sim.cells();
    check('glider at (-5000,-5000): get() agrees with cells()',
      readback.every(([x, y]) => sim.get(x, y)) && !sim.get(0, 0), true);
    sim.step(4);
    check('glider at (-5000,-5000): population 5', sim.population, 5);
    check('glider at (-5000,-5000): same shape after 4 gens', shapeSig(sim.cells()), shapeSig(PATTERNS.GLIDER));
    check('glider at (-5000,-5000): cells() round-trips', sim.cells().every(([x, y]) => sim.get(x, y)), true);
  }

  // 11. Chunk key encoding round-trips across the whole supported range, and
  //     patterns far out on both axes still evolve correctly.
  {
    let roundTripOk = true;
    const probes = [-524287, -100000, -2, -1, 0, 1, 2, 100000, 524287];
    for (const cx of probes) {
      for (const cy of probes) {
        const [rx, ry] = decodeChunk(encodeChunk(cx, cy));
        if (rx !== cx || ry !== cy) roundTripOk = false;
      }
    }
    check('encode/decode round-trips at range extremes', roundTripOk, true);
    let threw = false;
    try { encodeChunk(1 << 19, 0); } catch { threw = true; }
    check('out-of-range chunk rejected', threw, true);

    const far = 900000;   // cells, not chunks: ~28k chunks out
    const sim = new BitboardUniverse().load(PATTERNS.GLIDER.map(([x, y]) => [x + far, y - far]));
    sim.step(4);
    check('glider at (+900k,-900k) still correct', shapeSig(sim.cells()), shapeSig(PATTERNS.GLIDER));
    check('glider at (+900k,-900k) population 5', sim.population, 5);
  }

  // 12. The helpers the app needs: clone / setRule / bounds.
  {
    const sim = new BitboardUniverse().load(PATTERNS.GLIDER);
    sim.step(5);
    const copy = sim.clone();
    check('clone: same population', copy.population, sim.population);
    check('clone: same shape', shapeSig(copy.cells()), shapeSig(sim.cells()));
    copy.set(0, 0, true);
    copy.step(3);
    check('clone: independent of the original', shapeSig(copy.cells()) !== shapeSig(sim.cells()), true);
    check('clone: original untouched', sim.population, 5);

    const b = sim.bounds();
    const cells = sim.cells();
    const bx = Math.min(...cells.map(c => c[0])), by = Math.min(...cells.map(c => c[1]));
    const bX = Math.max(...cells.map(c => c[0])), bY = Math.max(...cells.map(c => c[1]));
    check('bounds: matches cells()', `${b.minX},${b.minY},${b.maxX},${b.maxY}`, `${bx},${by},${bX},${bY}`);
    check('bounds: null when empty', new BitboardUniverse().bounds(), null);

    // setRule: same start, different rule -> different result
    const a = new BitboardUniverse('B3/S23').load(PATTERNS.R_PENTOMINO).step(20);
    const h = new BitboardUniverse('B36/S23').load(PATTERNS.R_PENTOMINO).step(20);
    const c = new BitboardUniverse('B3/S23').load(PATTERNS.R_PENTOMINO);
    c.setRule('B36/S23');
    c.step(20);
    check('setRule: matches a fresh HighLife universe', shapeSig(c.cells()), shapeSig(h.cells()));
    check('setRule: HighLife differs from Life here', shapeSig(c.cells()) !== shapeSig(a.cells()), true);
    let b0 = false;
    try { new BitboardUniverse('B0/S23'); } catch { b0 = true; }
    check('B0 rule rejected', b0, true);
  }

  return results;
}

/**
 * Checks specific to this port: the app edits through set()/toggle() and then
 * reads population without a recount, so the incremental counter must be exact,
 * and the app's rule string round-trip must survive the parser.
 */
function testPortSurface() {
  const results = [];
  const check = (name, got, want) => results.push({ name, ok: got === want, got, want });

  // set() maintains the population counter; clear() empties the chunk map.
  {
    const sim = new BitboardUniverse();
    sim.set(1, 1);
    sim.set(1, 1);            // setting an already-live cell is a no-op
    sim.set(2, 2, true);
    check('set(): population counts new cells once', sim.population, 2);
    sim.set(1, 1, false);
    check('set(): erasing decrements', sim.population, 1);
    sim.set(2, 2, false);      // last cell in the chunk
    check('set(): empty chunk is dropped', sim.occupiedChunks, 0);
    check('set(): population back to zero', sim.population, 0);
    check('get(): dead cell is false', sim.get(2, 2), false);
    sim.toggle(5, 5);
    sim.toggle(5, 5);
    check('toggle(): twice is a no-op', sim.population, 0);
  }

  // setRule must not half-apply a rejected rule.
  {
    const sim = new BitboardUniverse('B3/S23');
    let threw = false;
    try { sim.setRule('B0/S8'); } catch { threw = true; }
    check('setRule: B0 throws', threw, true);
    check('setRule: previous rule kept on failure', sim.rule, 'B3/S23');
    sim.load(PATTERNS.BLINKER).step(1);
    check('setRule: still stepping after a rejected rule', sim.population, 3);
  }

  // The parser has to accept everything the app can build (see ruleKey()).
  {
    const cases = [['B3/S23', [3], [2, 3]], ['B2/S', [2], []], ['b3678/s34678', [3, 6, 7, 8], [3, 4, 6, 7, 8]], ['23/3', [3], [2, 3]]];
    let ok = true;
    for (const [str, born, survive] of cases) {
      const sim = new BitboardUniverse(str);
      if (String(sim.bornCounts) !== String(born) || String(sim.surviveCounts) !== String(survive)) ok = false;
    }
    check('parseRule: B/S, S/B, bare and lowercase all parse', ok, true);
  }

  // The documented domain limit.
  {
    check('MAX_COORD is the +/-16.7M cell limit', MAX_COORD, 16777215);
    let threw = false;
    try { new BitboardUniverse().set(MAX_COORD + 1, 0); } catch (e) { threw = e instanceof RangeError; }
    check('set() past the domain limit throws a RangeError', threw, true);
  }

  return results;
}

function report(title, results) {
  console.log(`\n== ${title} ==`);
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(52)}${r.ok ? '' : ` got ${r.got}, want ${r.want}`}`);
  }
  const passed = results.filter(r => r.ok).length;
  console.log(`  ${passed}/${results.length} checks passed`);
  return results.every(r => r.ok);
}

export function runChecks() {
  console.log('== js/bitboard.js correctness ==');
  const a = report('bit-sliced 8-input counter', testCompress8());
  const b = report("the app's known-good cases", testCorrectness());
  const c = report('port surface (stats, setRule, parser, domain limit)', testPortSurface());
  return a && b && c;
}

if (process.argv[1] && process.argv[1].endsWith('bitboard.check.mjs')) {
  process.exit(runChecks() ? 0 : 1);
}
